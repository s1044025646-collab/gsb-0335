import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALGORITHM_VERSION, ApiError, prepareGraph, normalizePersonalization,
  validateDamping, validateTolerance, validateBudget, advance,
} from "./pagerank.ts";
import type { PreparedGraph, Contribution, AdvanceResult } from "./pagerank.ts";

export interface RunRecord {
  id: number; graphId: number; damping: number; tolerance: number;
  algorithm: string; iterations: number; lastDiff: number | null;
  scoreSum: number | null; converged: number; stopReason: string | null;
  createdAt: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS graphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  nodes TEXT NOT NULL,          -- JSON array of node ids
  edges TEXT NOT NULL,          -- JSON array of {source,target,weight}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS personalizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id INTEGER NOT NULL REFERENCES graphs(id),
  name TEXT NOT NULL,
  vector TEXT,                  -- JSON object or NULL = uniform
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id INTEGER NOT NULL REFERENCES graphs(id),
  personalization_id INTEGER NOT NULL REFERENCES personalizations(id),
  damping REAL NOT NULL,
  tolerance REAL NOT NULL,
  algorithm TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 0,
  last_diff REAL,
  score_sum REAL,
  converged INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS scores (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  round INTEGER NOT NULL,       -- 0 = 初始分布
  node_id TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (run_id, round, node_id)
);
CREATE TABLE IF NOT EXISTS contributions (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  round INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  edge REAL NOT NULL,
  dangling REAL NOT NULL,
  teleport REAL NOT NULL,
  total REAL NOT NULL,
  in_edges TEXT NOT NULL,       -- JSON
  PRIMARY KEY (run_id, round, node_id)
);
`;

export class Service {
  private db: DatabaseSync;
  private graphCache = new Map<number, PreparedGraph>();

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  importGraph(name: string, nodes: string[], edges: { source: string; target: string; weight: number }[]) {
    const g = prepareGraph(nodes, edges); // 校验
    const r = this.db.prepare("INSERT INTO graphs (name, nodes, edges) VALUES (?,?,?)")
      .run(name ?? "graph", JSON.stringify(nodes), JSON.stringify(edges));
    return { graphId: Number(r.lastInsertRowid), nodeCount: nodes.length, edgeCount: edges.length };
  }

  setPersonalization(graphId: number, name: string, vector: Record<string, number> | null) {
    const g = this.getGraph(graphId);
    if (vector != null) normalizePersonalization(g.nodeIds, vector, g.index); // 校验
    const r = this.db.prepare("INSERT INTO personalizations (graph_id, name, vector) VALUES (?,?,?)")
      .run(graphId, name ?? "personalization", vector == null ? null : JSON.stringify(vector));
    return { personalizationId: Number(r.lastInsertRowid) };
  }

  createRun(graphId: number, personalizationId: number, damping = 0.85, tolerance = 1e-10) {
    validateDamping(damping); validateTolerance(tolerance);
    const g = this.getGraph(graphId);
    const p = this.getPersonalization(personalizationId);
    if (p.graph_id !== graphId) throw new ApiError("MISMATCHED_PARAMS", "个性化向量不属于该图");
    const pv = normalizePersonalization(g.nodeIds, p.vector ? JSON.parse(p.vector) : null, g.index);
    const r = this.db.prepare(
      "INSERT INTO runs (graph_id, personalization_id, damping, tolerance, algorithm) VALUES (?,?,?,?,?)")
      .run(graphId, personalizationId, damping, tolerance, ALGORITHM_VERSION);
    const runId = Number(r.lastInsertRowid);
    const ins = this.db.prepare("INSERT INTO scores (run_id, round, node_id, score) VALUES (?,?,?,?)");
    this.db.exec("BEGIN");
    try {
      g.nodeIds.forEach((id, i) => ins.run(runId, 0, id, pv[i]));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return { runId, algorithm: ALGORITHM_VERSION };
  }

  advanceRun(runId: number, budget: number, saveContributions = false): AdvanceResult & { runId: number } {
    validateBudget(budget);
    const run = this.getRun(runId);
    if (run.converged) throw new ApiError("ALREADY_CONVERGED", "该运行已收敛，无需继续推进", 409);
    const g = this.getGraph(run.graphId);
    const p = this.getPersonalization(run.personalizationId);
    const pv = normalizePersonalization(g.nodeIds, p.vector ? JSON.parse(p.vector) : null, g.index);
    const start = this.loadScores(runId, run.iterations, g);

    const scoreIns = this.db.prepare("INSERT INTO scores (run_id, round, node_id, score) VALUES (?,?,?,?)");
    const contribIns = this.db.prepare(
      "INSERT INTO contributions (run_id, round, node_id, edge, dangling, teleport, total, in_edges) VALUES (?,?,?,?,?,?,?,?)");
    type Pending = { round: number; scores: number[]; contribs: Contribution[] };
    const pending: Pending[] = [];
    const result = advance(g, start, pv, run.damping, run.tolerance, budget,
      (round, scores, contribs) => pending.push({ round, scores, contribs }), run.iterations);

    // 原子提交：分数、轮次、运行状态同事务，失败整体回滚
    this.db.exec("BEGIN");
    try {
      for (const { round, scores, contribs } of pending) {
        for (let i = 0; i < scores.length; i++) scoreIns.run(runId, round, g.nodeIds[i], scores[i]);
        if (saveContributions) {
          for (const c of contribs)
            contribIns.run(runId, round, c.nodeId, c.edge, c.dangling, c.teleport, c.total, JSON.stringify(c.inEdges));
        }
      }
      this.db.prepare(
        "UPDATE runs SET iterations=?, last_diff=?, score_sum=?, converged=?, stop_reason=? WHERE id=?")
        .run(result.totalIterations, result.lastDiff, result.scoreSum, result.converged ? 1 : 0, result.stopReason, runId);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return { runId, ...result };
  }

  getRanking(runId: number, limit = 50) {
    const run = this.getRun(runId);
    const rows = this.db.prepare(
      "SELECT node_id AS nodeId, score FROM scores WHERE run_id=? AND round=? ORDER BY score DESC, node_id ASC LIMIT ?")
      .all(runId, run.iterations, limit) as { nodeId: string; score: number }[];
    return { runId, round: run.iterations, converged: !!run.converged, ranking: rows };
  }

  getContributions(runId: number, nodeId: string, round?: number) {
    const run = this.getRun(runId);
    const r = round ?? run.iterations;
    const row = this.db.prepare(
      "SELECT * FROM contributions WHERE run_id=? AND round=? AND node_id=?").get(runId, r, nodeId) as any;
    if (!row) throw new ApiError("CONTRIBUTIONS_NOT_FOUND", `未保存第 ${r} 轮节点 ${nodeId} 的贡献明细（推进时使用 saveContributions）`, 404);
    return { runId, round: r, nodeId, edge: row.edge, dangling: row.dangling, teleport: row.teleport, total: row.total, inEdges: JSON.parse(row.in_edges) };
  }

  compare(runIds: number[], limit = 20) {
    return runIds.map((id) => {
      const run = this.getRun(id);
      return { runId: id, graphId: run.graphId, damping: run.damping, tolerance: run.tolerance,
        iterations: run.iterations, converged: !!run.converged, ranking: this.getRanking(id, limit).ranking };
    });
  }

  exportRun(runId: number) {
    const run = this.getRun(runId);
    const p = this.getPersonalization(run.personalizationId);
    const g = this.getGraphRow(run.graphId);
    const scores = this.db.prepare("SELECT round, node_id AS nodeId, score FROM scores WHERE run_id=? ORDER BY round, nodeId").all(runId);
    return { run: { ...run, algorithm: ALGORITHM_VERSION }, graph: { name: g.name, nodes: JSON.parse(g.nodes), edges: JSON.parse(g.edges) },
      personalization: p.vector ? JSON.parse(p.vector) : "uniform", scores,
      disclaimer: "高排名仅表示图结构上的访问频率，不代表内容正确性、社会影响或因果关系。" };
  }

  getRun(runId: number): RunRecord & { graphId: number; personalizationId: number } {
    const r = this.db.prepare("SELECT *, graph_id AS graphId, personalization_id AS personalizationId FROM runs WHERE id=?").get(runId) as any;
    if (!r) throw new ApiError("RUN_NOT_FOUND", `运行不存在: ${runId}`, 404);
    return r;
  }

  private getGraphRow(graphId: number) {
    const r = this.db.prepare("SELECT * FROM graphs WHERE id=?").get(graphId) as any;
    if (!r) throw new ApiError("GRAPH_NOT_FOUND", `图不存在: ${graphId}`, 404);
    return r;
  }

  private getGraph(graphId: number): PreparedGraph {
    let g = this.graphCache.get(graphId);
    if (!g) {
      const row = this.getGraphRow(graphId);
      g = prepareGraph(JSON.parse(row.nodes), JSON.parse(row.edges));
      this.graphCache.set(graphId, g);
    }
    return g;
  }

  private getPersonalization(id: number) {
    const r = this.db.prepare("SELECT * FROM personalizations WHERE id=?").get(id) as any;
    if (!r) throw new ApiError("PERSONALIZATION_NOT_FOUND", `个性化向量不存在: ${id}`, 404);
    return { graph_id: r.graph_id as number, vector: r.vector as string | null };
  }

  private loadScores(runId: number, round: number, g: PreparedGraph): number[] {
    const rows = this.db.prepare("SELECT node_id AS id, score FROM scores WHERE run_id=? AND round=?").all(runId, round) as { id: string; score: number }[];
    if (rows.length !== g.nodeIds.length) throw new ApiError("STATE_CORRUPT", "已保存状态不完整", 500);
    const v = new Array<number>(g.nodeIds.length).fill(0);
    for (const r of rows) v[g.index.get(r.id)!] = r.score;
    return v;
  }
}



import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALGORITHM_VERSION,
  EdgeInput,
  NormalizedGraph,
  PprError,
  buildGraph,
  explainNode,
  iterateOnce,
  normalizePersonalization,
  rankNodes,
  validateBudget,
  validateDamping,
  validateTolerance,
} from "./core/pagerank";

export type RunStatus = "running" | "converged" | "budget_exhausted";

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graphs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        nodes_json TEXT NOT NULL,
        edges_json TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        graph_id INTEGER NOT NULL REFERENCES graphs(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        damping REAL NOT NULL,
        tolerance REAL NOT NULL,
        max_iterations INTEGER NOT NULL,
        personalization_json TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        last_l1 REAL,
        status TEXT NOT NULL DEFAULT 'running',
        stop_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS iterations (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        iteration INTEGER NOT NULL,
        l1 REAL,
        score_sum REAL NOT NULL,
        scores_json TEXT NOT NULL,
        contributions_json TEXT,
        PRIMARY KEY (run_id, iteration)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  importGraph(nodes: string[], edges: EdgeInput[]): { graphId: number; nodeCount: number; edgeCount: number } {
    const g = buildGraph(nodes, edges);
    const stmt = this.db.prepare(
      "INSERT INTO graphs (nodes_json, edges_json, node_count, edge_count) VALUES (?, ?, ?, ?)",
    );
    const r = stmt.run(JSON.stringify(nodes), JSON.stringify(edges), nodes.length, g.edgeCount);
    return { graphId: Number(r.lastInsertRowid), nodeCount: nodes.length, edgeCount: g.edgeCount };
  }

  private loadGraph(graphId: number): NormalizedGraph {
    const row = this.db.prepare("SELECT nodes_json, edges_json FROM graphs WHERE id = ?").get(graphId) as
      | { nodes_json: string; edges_json: string }
      | undefined;
    if (!row) throw new PprError("GRAPH_NOT_FOUND", `图不存在: ${graphId}`);
    return buildGraph(JSON.parse(row.nodes_json), JSON.parse(row.edges_json));
  }

  /** Validate a personalization vector against a graph without creating a run. */
  checkPersonalization(graphId: number, weights: Record<string, number> | null): Record<string, number> {
    const g = this.loadGraph(graphId);
    const vec = normalizePersonalization(g, weights);
    const out: Record<string, number> = {};
    g.nodeIds.forEach((id, i) => (out[id] = vec[i]));
    return out;
  }

  createRun(opts: {
    graphId: number;
    damping?: number;
    tolerance?: number;
    maxIterations?: number;
    personalization?: Record<string, number> | null;
    saveContributions?: boolean;
  }): { runId: number } {
    const damping = validateDamping(opts.damping ?? 0.85);
    const tolerance = validateTolerance(opts.tolerance ?? 1e-10);
    const maxIterations = validateBudget(opts.maxIterations ?? 100);
    const g = this.loadGraph(opts.graphId);
    const vec = normalizePersonalization(g, opts.personalization ?? null);
    const persObj: Record<string, number> = {};
    g.nodeIds.forEach((id, i) => (persObj[id] = vec[i]));
    const r = this.db
      .prepare(
        `INSERT INTO runs (graph_id, damping, tolerance, max_iterations, personalization_json, algorithm_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(opts.graphId, damping, tolerance, maxIterations, JSON.stringify(persObj), ALGORITHM_VERSION);
    const runId = Number(r.lastInsertRowid);
    // iteration 0: initial scores = personalization distribution
    const scoresObj: Record<string, number> = {};
    g.nodeIds.forEach((id, i) => (scoresObj[id] = vec[i]));
    const sum = vec.reduce((a, b) => a + b, 0);
    this.db
      .prepare("INSERT INTO iterations (run_id, iteration, l1, score_sum, scores_json) VALUES (?, 0, NULL, ?, ?)")
      .run(runId, sum, JSON.stringify(scoresObj));
    return { runId };
  }

  private getRun(runId: number): {
    id: number;
    graph_id: number;
    damping: number;
    tolerance: number;
    max_iterations: number;
    personalization_json: string;
    iteration: number;
    last_l1: number | null;
    status: RunStatus;
    stop_reason: string | null;
    algorithm_version: string;
  } {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
    if (!row) throw new PprError("RUN_NOT_FOUND", `运行不存在: ${runId}`);
    return row;
  }

  private getScores(runId: number, iteration: number): Record<string, number> {
    const row = this.db
      .prepare("SELECT scores_json FROM iterations WHERE run_id = ? AND iteration = ?")
      .get(runId, iteration) as { scores_json: string } | undefined;
    if (!row) throw new PprError("ITERATION_NOT_FOUND", `运行 ${runId} 没有第 ${iteration} 轮`);
    return JSON.parse(row.scores_json);
  }

  /**
   * Advance a run by up to `budget` iterations. All iterations of this call
   * commit atomically; a failure leaves the previous full-round state intact.
   */
  advance(runId: number, budget: number, saveContributions = false): {
    runId: number;
    fromIteration: number;
    toIteration: number;
    lastL1: number | null;
    scoreSum: number;
    status: RunStatus;
    stopReason: string | null;
  } {
    validateBudget(budget);
    const run = this.getRun(runId);
    if (run.status === "converged") {
      throw new PprError("ALREADY_CONVERGED", `运行 ${runId} 已收敛，无需继续推进`);
    }
    const g = this.loadGraph(run.graph_id);
    const persObj = JSON.parse(run.personalization_json) as Record<string, number>;
    const pers = g.nodeIds.map((id) => persObj[id]);
    let scores = g.nodeIds.map((id) => (this.getScores(runId, run.iteration) as any)[id] as number);

    let iteration = run.iteration;
    let lastL1: number | null = run.last_l1;
    let status: RunStatus = "running";
    let stopReason: string | null = null;

    this.db.exec("BEGIN");
    try {
      for (let step = 0; step < budget; step++) {
        if (iteration >= run.max_iterations) {
          status = "budget_exhausted";
          stopReason = `达到迭代预算 ${run.max_iterations}，L1 残差 ${lastL1} 未满足容差 ${run.tolerance}`;
          break;
        }
        const { next, l1 } = iterateOnce(g, scores, pers, run.damping);
        scores = next;
        iteration += 1;
        lastL1 = l1;
        const sum = next.reduce((a, b) => a + b, 0);
        const scoresObj: Record<string, number> = {};
        g.nodeIds.forEach((id, i) => (scoresObj[id] = next[i]));
        let contributionsJson: string | null = null;
        if (saveContributions) {
          const prev = g.nodeIds.map((id) => (this.getScores(runId, iteration - 1) as any)[id] as number);
          const contribs: Record<string, unknown> = {};
          for (const id of g.nodeIds) {
            contribs[id] = explainNode(g, prev, pers, run.damping, id);
          }
          contributionsJson = JSON.stringify(contribs);
        }
        this.db
          .prepare(
            "INSERT INTO iterations (run_id, iteration, l1, score_sum, scores_json, contributions_json) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(runId, iteration, l1, sum, JSON.stringify(scoresObj), contributionsJson);
        if (l1 <= run.tolerance) {
          status = "converged";
          stopReason = `L1 残差 ${l1} <= 容差 ${run.tolerance}`;
          break;
        }
      }
      if (status === "running" && iteration >= run.max_iterations) {
        status = "budget_exhausted";
        stopReason = `达到迭代预算 ${run.max_iterations}，L1 残差 ${lastL1} 未满足容差 ${run.tolerance}`;
      }
      this.db
        .prepare("UPDATE runs SET iteration = ?, last_l1 = ?, status = ?, stop_reason = ? WHERE id = ?")
        .run(iteration, lastL1, status, stopReason, runId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const scoreSum = scores.reduce((a, b) => a + b, 0);
    return { runId, fromIteration: run.iteration, toIteration: iteration, lastL1, scoreSum, status, stopReason };
  }

  ranking(runId: number, top?: number): {
    runId: number;
    iteration: number;
    status: RunStatus;
    lastL1: number | null;
    scoreSum: number;
    entries: Array<{ node: string; score: number; rank: number }>;
  } {
    const run = this.getRun(runId);
    const g = this.loadGraph(run.graph_id);
    const scoresObj = this.getScores(runId, run.iteration);
    const scores = g.nodeIds.map((id) => scoresObj[id]);
    let entries = rankNodes(g.nodeIds, scores);
    if (top !== undefined) entries = entries.slice(0, top);
    return {
      runId,
      iteration: run.iteration,
      status: run.status,
      lastL1: run.last_l1,
      scoreSum: scores.reduce((a, b) => a + b, 0),
      entries,
    };
  }

  explain(runId: number, iteration: number, nodeId: string): unknown {
    const run = this.getRun(runId);
    if (iteration < 1 || iteration > run.iteration) {
      throw new PprError("ITERATION_NOT_FOUND", `运行 ${runId} 当前轮次为 ${run.iteration}，无法解释第 ${iteration} 轮`);
    }
    const g = this.loadGraph(run.graph_id);
    const persObj = JSON.parse(run.personalization_json) as Record<string, number>;
    const pers = g.nodeIds.map((id) => persObj[id]);
    const prevObj = this.getScores(runId, iteration - 1);
    const prev = g.nodeIds.map((id) => prevObj[id]);
    return { runId, iteration, contribution: explainNode(g, prev, pers, run.damping, nodeId) };
  }

  residuals(runId: number): Array<{ iteration: number; l1: number | null; scoreSum: number }> {
    this.getRun(runId);
    const rows = this.db
      .prepare("SELECT iteration, l1, score_sum FROM iterations WHERE run_id = ? ORDER BY iteration")
      .all(runId) as Array<{ iteration: number; l1: number | null; score_sum: number }>;
    return rows.map((r) => ({ iteration: r.iteration, l1: r.l1, scoreSum: r.score_sum }));
  }

  compare(runIds: number[]): unknown {
    return runIds.map((id) => {
      const run = this.getRun(id);
      const r = this.ranking(id);
      return {
        runId: id,
        graphId: run.graph_id,
        damping: run.damping,
        tolerance: run.tolerance,
        maxIterations: run.max_iterations,
        algorithmVersion: run.algorithm_version,
        personalization: JSON.parse(run.personalization_json),
        iteration: r.iteration,
        status: r.status,
        lastL1: r.lastL1,
        scoreSum: r.scoreSum,
        ranking: r.entries,
      };
    });
  }

  exportRun(runId: number): unknown {
    const run = this.getRun(runId);
    const ranking = this.ranking(runId);
    return {
      format: "ppr-export-v1",
      run: {
        id: run.id,
        graphId: run.graph_id,
        damping: run.damping,
        tolerance: run.tolerance,
        maxIterations: run.max_iterations,
        algorithmVersion: run.algorithm_version,
        personalization: JSON.parse(run.personalization_json),
        status: run.status,
        stopReason: run.stop_reason,
        iteration: run.iteration,
        lastL1: run.last_l1,
      },
      ranking: ranking.entries,
      residuals: this.residuals(runId),
    };
  }
}

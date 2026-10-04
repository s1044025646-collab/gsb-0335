import { test } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service.ts";
import { prepareGraph, normalizePersonalization, advance, sum, ApiError } from "../src/pagerank.ts";

const svc = () => new Service(":memory:");
const approx = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function solveLinear(g: any, pv: number[], d: number): number[] {
  // 解 (I - d*M^T) x = (1-d) pv，高斯消元，作为独立对照
  const n = pv.length;
  const A: number[][] = Array.from({ length: n }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[i] = 1;
    row[n] = (1 - d) * pv[i];
    return row;
  });
  let dangIdx: number[] = [];
  for (let j = 0; j < n; j++) {
    if (g.dangling[j]) { dangIdx.push(j); continue; }
    for (const { to, weight } of g.outAdj[j]) A[to][j] -= d * weight / g.outWeightSum[j];
  }
  for (const j of dangIdx) for (let i = 0; i < n; i++) A[i][j] -= d * pv[i];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

test("两节点图首轮手算对照", () => {
  // A->B, B->A, d=0.8, 均匀个性化。初始各 0.5。
  // 第1轮: edge 部分各得 0.5; next = 0.8*0.5 + 0.2*0.5 = 0.5（不动点）
  const g = prepareGraph(["A", "B"], [
    { source: "A", target: "B", weight: 1 }, { source: "B", target: "A", weight: 1 }]);
  const pv = normalizePersonalization(g.nodeIds, null, g.index);
  const r = advance(g, pv, pv, 0.8, 1e-12, 1);
  approx(r.scores[0], 0.5); approx(r.scores[1], 0.5);
  approx(r.lastDiff, 0); assert.equal(r.stopReason, "converged");
});

test("三节点带悬挂首轮手算对照", () => {
  // A->B(1), B->A(1), C 悬挂。d=0.5，均匀 pv=1/3。初始各 1/3。
  // edge: A 得 1/3(来自B), B 得 1/3(来自A), C 得 0。悬挂质量 1/3 按 pv 各分 1/9。
  // next = 0.5*(edge+1/9) + 0.5*(1/3)
  // A: 0.5*(1/3+1/9)+1/6 = 0.5*4/9+1/6 = 2/9+1/6 = 7/18
  // B: 同 A = 7/18; C: 0.5*(0+1/9)+1/6 = 1/18+3/18 = 4/18
  const g = prepareGraph(["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 }, { source: "B", target: "A", weight: 1 }]);
  const pv = normalizePersonalization(g.nodeIds, null, g.index);
  const r = advance(g, pv, pv, 0.5, 0, 1);
  approx(r.scores[0], 7 / 18); approx(r.scores[1], 7 / 18); approx(r.scores[2], 4 / 18);
  approx(r.scoreSum, 1);
});

test("每轮分数非负且总和接近 1，终值与线性方程解一致", () => {
  const edges = [
    { source: "A", target: "B", weight: 2 }, { source: "A", target: "C", weight: 1 },
    { source: "B", target: "C", weight: 3 }, { source: "C", target: "C", weight: 1 },
    { source: "D", target: "A", weight: 1 },
  ];
  const g = prepareGraph(["A", "B", "C", "D", "E"], edges); // E 孤立(悬挂)
  const pv = normalizePersonalization(g.nodeIds, { A: 2, E: 1 }, g.index);
  let prev = pv;
  for (let k = 0; k < 60; k++) {
    const r = advance(g, prev, pv, 0.85, 0, 1);
    for (const s of r.scores) assert.ok(s >= 0);
    approx(r.scoreSum, 1, 1e-12);
    prev = r.scores;
  }
  const exact = solveLinear(g, pv, 0.85);
  prev.forEach((s, i) => approx(s, exact[i], 1e-8));
});

test("全悬挂图收敛到个性化向量", () => {
  const g = prepareGraph(["X", "Y", "Z"], []);
  const pv = normalizePersonalization(g.nodeIds, { X: 1, Y: 3 }, g.index);
  const r = advance(g, pv, pv, 0.85, 1e-12, 200);
  assert.equal(r.converged, true);
  approx(r.scores[0], 0.25, 1e-9); approx(r.scores[1], 0.75, 1e-9); approx(r.scores[2], 0, 1e-12);
});

test("零权边忽略、平行边合并、自环参与出权", () => {
  // A->B 两条平行边 1+2=3，A->A 自环 1，A->C 零权忽略 => 出权和 4
  const g = prepareGraph(["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 }, { source: "A", target: "B", weight: 2 },
    { source: "A", target: "A", weight: 1 }, { source: "A", target: "C", weight: 0 }]);
  assert.equal(g.outWeightSum[0], 4);
  assert.equal(g.outAdj[0].length, 2); // 平行边已合并
  assert.ok(g.dangling[2]); // C 仍悬挂
  const pv = normalizePersonalization(g.nodeIds, { A: 1 }, g.index);
  const r = advance(g, pv, pv, 1 - 1e-9, 0, 1); // d≈1 便于观察传播比例
  // A 自环留 1/4，B 得 3/4
  approx(r.scores[0] / (r.scores[0] + r.scores[1]), 0.25, 1e-6);
});

test("节点重排不改变最终分数", () => {
  const edges = [
    { source: "A", target: "B", weight: 1 }, { source: "B", target: "C", weight: 2 },
    { source: "C", target: "A", weight: 1 }, { source: "C", target: "B", weight: 1 }];
  const run = (nodes: string[]) => {
    const g = prepareGraph(nodes, edges);
    const pv = normalizePersonalization(g.nodeIds, null, g.index);
    const r = advance(g, pv, pv, 0.85, 1e-13, 500);
    const m = new Map<string, number>();
    g.nodeIds.forEach((id, i) => m.set(id, r.scores[i]));
    return m;
  };
  const m1 = run(["A", "B", "C"]);
  const m2 = run(["C", "A", "B"]);
  for (const id of ["A", "B", "C"]) approx(m1.get(id)!, m2.get(id)!, 1e-12);
});

test("预算耗尽标记未收敛", () => {
  const g = prepareGraph(["A", "B"], [
    { source: "A", target: "B", weight: 1 }, { source: "B", target: "A", weight: 1 }]);
  const pv = normalizePersonalization(g.nodeIds, { A: 1 }, g.index); // 非不动点
  const r = advance(g, pv, pv, 0.85, 1e-15, 3);
  assert.equal(r.converged, false);
  assert.equal(r.stopReason, "budget_exhausted");
  assert.equal(r.iterationsRun, 3);
});

test("重启续算：一次推进与分批推进结果一致", () => {
  const edges = [
    { source: "A", target: "B", weight: 1 }, { source: "B", target: "A", weight: 1 },
    { source: "B", target: "C", weight: 1 }];
  const setup = () => {
    const s = svc();
    const g = s.importGraph("g", ["A", "B", "C"], edges);
    const p = s.setPersonalization(g.graphId, "u", null);
    return { s, runId: s.createRun(g.graphId, p.personalizationId).runId };
  };
  const a = setup(); a.s.advanceRun(a.runId, 10);
  const b = setup();
  b.s.advanceRun(b.runId, 4); b.s.advanceRun(b.runId, 4); b.s.advanceRun(b.runId, 2);
  const ra = a.s.getRanking(a.runId, 10).ranking;
  const rb = b.s.getRanking(b.runId, 10).ranking;
  ra.forEach((row, i) => { assert.equal(row.nodeId, rb[i].nodeId); approx(row.score, rb[i].score, 1e-15); });
  a.s.close(); b.s.close();
});

test("失败回滚：推进事务失败不留半状态", () => {
  const s = svc();
  const g = s.importGraph("g", ["A", "B"], [
    { source: "A", target: "B", weight: 1 }, { source: "B", target: "A", weight: 1 }]);
  const p = s.setPersonalization(g.graphId, "u", null);
  const runId = s.createRun(g.graphId, p.personalizationId).runId;
  // 人为制造主键冲突：预占第 1 轮分数行
  (s as any).db.prepare("INSERT INTO scores (run_id, round, node_id, score) VALUES (?,?,?,?)").run(runId, 1, "A", 0.5);
  assert.throws(() => s.advanceRun(runId, 5));
  const run = s.getRun(runId);
  assert.equal(run.iterations, 0); // 轮次未被更新
  const rows = (s as any).db.prepare("SELECT COUNT(*) AS c FROM scores WHERE run_id=? AND round=1").get(runId);
  assert.equal(rows.c, 1); // 只剩人为插入的一行，事务内插入全部回滚
  s.close();
});

test("参数校验与错误码", () => {
  assert.throws(() => prepareGraph([], []), (e: any) => e.code === "EMPTY_NODE_SET");
  assert.throws(() => prepareGraph(["A"], [{ source: "A", target: "B", weight: 1 }]), (e: any) => e.code === "UNKNOWN_NODE_REF");
  assert.throws(() => prepareGraph(["A", "B"], [{ source: "A", target: "B", weight: -1 }]), (e: any) => e.code === "NEGATIVE_WEIGHT");
  const g = prepareGraph(["A", "B"], []);
  assert.throws(() => normalizePersonalization(g.nodeIds, { A: 0, B: 0 }, g.index), (e: any) => e.code === "ZERO_PERSONALIZATION");
  assert.throws(() => normalizePersonalization(g.nodeIds, { A: -1, B: 2 }, g.index), (e: any) => e.code === "NEGATIVE_PERSONALIZATION");
  assert.throws(() => normalizePersonalization(g.nodeIds, { Z: 1 }, g.index), (e: any) => e.code === "UNKNOWN_NODE_REF");
  const s = svc();
  const gi = s.importGraph("g", ["A", "B"], []);
  const pi = s.setPersonalization(gi.graphId, "u", null);
  assert.throws(() => s.createRun(gi.graphId, pi.personalizationId, 1), (e: any) => e.code === "INVALID_DAMPING");
  assert.throws(() => s.createRun(gi.graphId, pi.personalizationId, 0), (e: any) => e.code === "INVALID_DAMPING");
  assert.throws(() => s.createRun(gi.graphId, pi.personalizationId, 0.85, 0), (e: any) => e.code === "INVALID_TOLERANCE");
  const runId = s.createRun(gi.graphId, pi.personalizationId).runId;
  assert.throws(() => s.advanceRun(runId, 0), (e: any) => e.code === "INVALID_BUDGET");
  s.close();
});

test("同分按节点编号稳定破平，分数不被修改", () => {
  const s = svc();
  const g = s.importGraph("g", ["B", "A"], []); // 全悬挂，均匀 => 同分
  const p = s.setPersonalization(g.graphId, "u", null);
  const runId = s.createRun(g.graphId, p.personalizationId).runId;
  s.advanceRun(runId, 5);
  const r = s.getRanking(runId, 10).ranking;
  assert.equal(r[0].nodeId, "A"); // 编号序破平
  assert.equal(r[0].score, r[1].score); // 分数本身相同
  s.close();
});

test("贡献明细三部分相加等于新分数", () => {
  const s = svc();
  const g = s.importGraph("g", ["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 }, { source: "B", target: "A", weight: 1 }]);
  const p = s.setPersonalization(g.graphId, "u", null);
  const runId = s.createRun(g.graphId, p.personalizationId).runId;
  s.advanceRun(runId, 3, true);
  for (const id of ["A", "B", "C"]) {
    const c = s.getContributions(runId, id, 2);
    approx(c.edge + c.dangling + c.teleport, c.total, 1e-12);
  }
  s.close();
});

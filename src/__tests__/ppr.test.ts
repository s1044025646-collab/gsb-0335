import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildGraph,
  iterateOnce,
  normalizePersonalization,
  PprError,
} from "../core/pagerank";
import { Store } from "../store";

const D = 0.85;

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ppr-")), "test.db");
}

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PprError, `expected PprError, got ${e}`);
    assert.equal((e as PprError).code, code);
    return;
  }
  assert.fail(`expected error ${code}`);
}

test("拒绝空节点集、负权、非法引用、全零个性化、非法阻尼", () => {
  expectCode(() => buildGraph([], []), "EMPTY_NODE_SET");
  expectCode(() => buildGraph(["A"], [{ source: "A", target: "B", weight: 1 }]), "UNKNOWN_NODE");
  expectCode(() => buildGraph(["A"], [{ source: "A", target: "A", weight: -1 }]), "NEGATIVE_WEIGHT");
  const g = buildGraph(["A", "B"], []);
  expectCode(() => normalizePersonalization(g, { A: 0, B: 0 }), "ZERO_PERSONALIZATION");
  expectCode(() => normalizePersonalization(g, { A: -1, B: 2 }), "NEGATIVE_PERSONALIZATION");
  expectCode(() => normalizePersonalization(g, { C: 1 } as any), "UNKNOWN_NODE");
});

test("两节点图首轮结果与手算一致", () => {
  // A->B, B 悬挂, 均匀个性化, d=0.85
  const g = buildGraph(["A", "B"], [{ source: "A", target: "B", weight: 1 }]);
  const pers = normalizePersonalization(g, null);
  const { next, l1 } = iterateOnce(g, [...pers], pers, D);
  // A: 0.85*(0 + 0.5*0.5) + 0.15*0.5 = 0.2125+0.075 = 0.2875
  // B: 0.85*(0.5 + 0.5*0.5) + 0.075 = 0.6375+0.075 = 0.7125
  assert.ok(Math.abs(next[0] - 0.2875) < 1e-12);
  assert.ok(Math.abs(next[1] - 0.7125) < 1e-12);
  assert.ok(Math.abs(next[0] + next[1] - 1) < 1e-12);
  assert.ok(l1 > 0);
});

test("三节点环首轮结果与手算一致", () => {
  const g = buildGraph(["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 },
    { source: "B", target: "C", weight: 1 },
    { source: "C", target: "A", weight: 1 },
  ]);
  const pers = normalizePersonalization(g, null);
  const { next } = iterateOnce(g, [...pers], pers, D);
  // 对称: 每个节点 = 0.85*(1/3) + 0.15*(1/3) = 1/3
  for (const s of next) assert.ok(Math.abs(s - 1 / 3) < 1e-12);
});

test("平行边合并、自环计入出权、零权边导致悬挂", () => {
  const g = buildGraph(["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 },
    { source: "A", target: "B", weight: 2 },
    { source: "A", target: "A", weight: 1 },
    { source: "B", target: "C", weight: 0 },
  ]);
  assert.equal(g.edgeCount, 3);
  const ia = g.index.get("A")!;
  const ib = g.index.get("B")!;
  assert.equal(g.outWeight[ia], 4); // 1+2 合并 + 自环 1
  assert.equal(g.outWeight[ib], 0); // 零权边 => 悬挂
});

test("全悬挂图: 分数恒等于个性化分布", () => {
  const g = buildGraph(["A", "B", "C"], []);
  const pers = normalizePersonalization(g, { A: 2, B: 1, C: 1 });
  const { next } = iterateOnce(g, [...pers], pers, D);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(next[i] - pers[i]) < 1e-12);
});

test("节点重排不影响最终分数", () => {
  const edges = [
    { source: "A", target: "B", weight: 2 },
    { source: "B", target: "C", weight: 1 },
    { source: "C", target: "A", weight: 3 },
    { source: "A", target: "C", weight: 1 },
  ];
  const run = (nodes: string[]) => {
    const g = buildGraph(nodes, edges);
    const pers = normalizePersonalization(g, null);
    let s = [...pers];
    for (let i = 0; i < 200; i++) s = iterateOnce(g, s, pers, D).next;
    const out: Record<string, number> = {};
    g.nodeIds.forEach((id, i) => (out[id] = s[i]));
    return out;
  };
  const r1 = run(["A", "B", "C"]);
  const r2 = run(["C", "A", "B"]);
  for (const k of Object.keys(r1)) assert.ok(Math.abs(r1[k] - r2[k]) < 1e-12);
});

test("最终分数与独立线性方程解一致 (三节点带悬挂)", () => {
  // A->B, B->A(1),B->C(1), C 悬挂, d=0.85, 均匀个性化
  const g = buildGraph(["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 },
    { source: "B", target: "A", weight: 1 },
    { source: "B", target: "C", weight: 1 },
  ]);
  const pers = normalizePersonalization(g, null);
  let s = [...pers];
  for (let i = 0; i < 1000; i++) s = iterateOnce(g, s, pers, D).next;
  // 解线性方程: x = d*(M x + hang(x)*p) + (1-d)*p, 用高斯消元
  const n = 3;
  const M = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i < n; i++) {
    M[i][i] = 1;
    M[i][n] = (1 - D) * pers[i];
  }
  // x_i - d*sum_j M_ji x_j - d*hangSum*p_i = (1-d)p_i
  for (let j = 0; j < n; j++) {
    const total = g.outWeight[j];
    for (let i = 0; i < n; i++) {
      let coef = 0;
      if (total > 0) {
        const edge = g.outAdj[j].find(([t]) => t === i);
        if (edge) coef += edge[1] / total;
      } else {
        coef += pers[i];
      }
      M[i][j] -= D * coef;
    }
  }
  // gaussian elimination
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = 0; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const exact = M.map((row, i) => row[n] / row[i]);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(s[i] - exact[i]) < 1e-9, `node ${i}: ${s[i]} vs ${exact[i]}`);
});

test("每轮分数非负且总和接近 1", () => {
  const g = buildGraph(["A", "B", "C", "D"], [
    { source: "A", target: "B", weight: 1 },
    { source: "B", target: "C", weight: 2 },
    { source: "C", target: "A", weight: 1 },
  ]);
  const pers = normalizePersonalization(g, null);
  let s = [...pers];
  for (let i = 0; i < 50; i++) {
    const r = iterateOnce(g, s, pers, D);
    s = r.next;
    for (const v of s) assert.ok(v >= 0);
    assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
});

test("预算耗尽标记未收敛; 分批推进与一次推进结果一致; 重启续算一致", () => {
  const db = tmpDb();
  const store = new Store(db);
  const g = store.importGraph(["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 },
    { source: "B", target: "A", weight: 1 },
    { source: "B", target: "C", weight: 1 },
  ]);
  // 预算耗尽
  const r0 = store.createRun({ graphId: g.graphId, damping: D, tolerance: 1e-15, maxIterations: 3 });
  const a0 = store.advance(r0.runId, 10);
  assert.equal(a0.status, "budget_exhausted");
  assert.equal(a0.toIteration, 3);
  assert.ok(a0.stopReason!.includes("预算"));

  // 一次推进 20 轮 vs 分 4 次各 5 轮
  const r1 = store.createRun({ graphId: g.graphId, damping: D, tolerance: 1e-15, maxIterations: 20 });
  store.advance(r1.runId, 20);
  const r2 = store.createRun({ graphId: g.graphId, damping: D, tolerance: 1e-15, maxIterations: 20 });
  for (let i = 0; i < 4; i++) store.advance(r2.runId, 5);
  const rank1 = store.ranking(r1.runId);
  const rank2 = store.ranking(r2.runId);
  assert.equal(rank1.iteration, rank2.iteration);
  for (let i = 0; i < rank1.entries.length; i++) {
    assert.equal(rank1.entries[i].node, rank2.entries[i].node);
    assert.ok(Math.abs(rank1.entries[i].score - rank2.entries[i].score) < 1e-15);
  }

  // 重启续算: 推进 10 轮, 关闭重开, 再推进 10 轮 == 一次 20 轮
  const r3 = store.createRun({ graphId: g.graphId, damping: D, tolerance: 1e-15, maxIterations: 20 });
  store.advance(r3.runId, 10);
  store.close();
  const store2 = new Store(db);
  store2.advance(r3.runId, 10);
  const rank3 = store2.ranking(r3.runId);
  for (let i = 0; i < rank1.entries.length; i++) {
    assert.ok(Math.abs(rank1.entries[i].score - rank3.entries[i].score) < 1e-15);
  }
  store2.close();
});

test("失败回滚: 推进中途出错不留半成品状态", () => {
  const db = tmpDb();
  const store = new Store(db);
  const g = store.importGraph(["A", "B"], [{ source: "A", target: "B", weight: 1 }]);
  const r = store.createRun({ graphId: g.graphId, damping: D, tolerance: 1e-15, maxIterations: 5 });
  store.advance(r.runId, 3);
  const before = store.ranking(r.runId);
  // 非法预算 -> 抛错且状态不变
  expectCode(() => store.advance(r.runId, 0), "INVALID_BUDGET");
  expectCode(() => store.advance(r.runId, 99999), "INVALID_BUDGET");
  const after = store.ranking(r.runId);
  assert.equal(after.iteration, before.iteration);
  assert.deepEqual(after.entries, before.entries);
  store.close();
});

test("对称环相等分数; 改变个性化改变排名; 贡献解释三部分之和等于得分", () => {
  const db = tmpDb();
  const store = new Store(db);
  const g = store.importGraph(["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 },
    { source: "B", target: "C", weight: 1 },
    { source: "C", target: "A", weight: 1 },
  ]);
  const r1 = store.createRun({ graphId: g.graphId, damping: D, tolerance: 1e-13, maxIterations: 500 });
  store.advance(r1.runId, 500);
  const rank1 = store.ranking(r1.runId);
  assert.equal(rank1.status, "converged");
  for (const e of rank1.entries) assert.ok(Math.abs(e.score - 1 / 3) < 1e-6);
  // 平局按节点编号打破
  assert.deepEqual(rank1.entries.map((e) => e.node), ["A", "B", "C"]);

  const r2 = store.createRun({
    graphId: g.graphId,
    damping: D,
    tolerance: 1e-13,
    maxIterations: 500,
    personalization: { C: 10, A: 1, B: 1 },
  });
  store.advance(r2.runId, 500);
  const rank2 = store.ranking(r2.runId);
  assert.equal(rank2.entries[0].node, "C");

  // 贡献分解
  const exp = store.explain(r2.runId, 1, "C") as any;
  const c = exp.contribution;
  const sum = c.edgeTotal + c.danglingContrib + c.teleportContrib;
  assert.ok(Math.abs(sum - c.score) < 1e-12);
  assert.ok(c.teleportContrib > 0);
  store.close();
});

test("允许无边图与孤立点; 拒绝空节点集", () => {
  const db = tmpDb();
  const store = new Store(db);
  const g = store.importGraph(["X", "Y", "Z"], []);
  const r = store.createRun({ graphId: g.graphId, damping: D, tolerance: 1e-13, maxIterations: 10 });
  const a = store.advance(r.runId, 10);
  assert.equal(a.status, "converged");
  const rank = store.ranking(r.runId);
  for (const e of rank.entries) assert.ok(Math.abs(e.score - 1 / 3) < 1e-9);
  store.close();
});


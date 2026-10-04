import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";

function showRanking(store: Store, runId: number, label: string): void {
  const r = store.ranking(runId);
  console.log(`\n== ${label} (run ${runId}, 第 ${r.iteration} 轮, 状态=${r.status}) ==`);
  for (const e of r.entries) console.log(`  #${e.rank}  ${e.node}  ${e.score.toFixed(8)}`);
  console.log(`  分数和=${r.scoreSum.toFixed(12)}  最后L1=${r.lastL1}`);
}

export function runDemo(dbPath?: string): void {
  const db = dbPath ?? path.join(process.cwd(), "data", "demo.db");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  if (fs.existsSync(db)) fs.rmSync(db);
  const store = new Store(db);

  console.log("演示 1: 对称环 A->B->C->A，均匀个性化，三个节点分数应相等");
  const g1 = store.importGraph(["A", "B", "C"], [
    { source: "A", target: "B", weight: 1 },
    { source: "B", target: "C", weight: 1 },
    { source: "C", target: "A", weight: 1 },
  ]);
  const r1 = store.createRun({ graphId: g1.graphId, damping: 0.85, tolerance: 1e-12, maxIterations: 200 });
  store.advance(r1.runId, 200);
  showRanking(store, r1.runId, "对称环");

  console.log("\n演示 2: 带悬挂节点 D 的小图 (A->B, B->A, B->C, C->A, D 无出边)");
  const g2 = store.importGraph(["A", "B", "C", "D"], [
    { source: "A", target: "B", weight: 1 },
    { source: "B", target: "A", weight: 1 },
    { source: "B", target: "C", weight: 1 },
    { source: "C", target: "A", weight: 1 },
  ]);
  const r2 = store.createRun({ graphId: g2.graphId, damping: 0.85, tolerance: 1e-12, maxIterations: 500, saveContributions: true });
  store.advance(r2.runId, 500, true);
  showRanking(store, r2.runId, "带悬挂节点的小图");
  const exp = store.explain(r2.runId, 1, "A") as any;
  console.log(`\n第 1 轮节点 A 的来源贡献: 入边=${exp.contribution.edgeTotal.toFixed(8)}, 悬挂重分配=${exp.contribution.danglingContrib.toFixed(8)}, 随机跳转=${exp.contribution.teleportContrib.toFixed(8)}`);

  console.log("\n演示 3: 同一图，个性化分布改为偏向 D，观察排名变化");
  const r3 = store.createRun({
    graphId: g2.graphId,
    damping: 0.85,
    tolerance: 1e-12,
    maxIterations: 500,
    personalization: { D: 9, A: 1 },
  });
  store.advance(r3.runId, 500);
  showRanking(store, r3.runId, "偏向 D 的个性化");

  console.log("\n参数比较 (run 2 vs run 3):");
  const cmp = store.compare([r2.runId, r3.runId]) as any[];
  for (const c of cmp) {
    console.log(`  run ${c.runId}: 个性化=${JSON.stringify(c.personalization)} 第一名=${c.ranking[0].node} (${c.ranking[0].score.toFixed(6)})`);
  }
  store.close();
  console.log(`\n演示数据库: ${db}`);
}

if (require.main === module) {
  runDemo();
}

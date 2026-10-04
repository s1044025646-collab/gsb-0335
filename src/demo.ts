import { Service } from "./service.ts";
import * as path from "node:path";
import * as fs from "node:fs";

const dir = path.join(process.cwd(), "data");
fs.mkdirSync(dir, { recursive: true });
const svc = new Service(path.join(dir, "demo.db"));
const fmt = (x: number) => x.toFixed(6);
const show = (runId: number, label: string) => {
  const r = svc.getRanking(runId, 100);
  console.log(`\n== ${label}（运行 #${runId}，第 ${r.round} 轮，收敛=${r.converged}）==`);
  r.ranking.forEach((row, i) => console.log(`  ${i + 1}. ${row.nodeId.padEnd(8)} ${fmt(row.score)}`));
};

// 1) 对称环：四个节点成环，分数应相等
const g1 = svc.importGraph("ring4", ["A", "B", "C", "D"], [
  { source: "A", target: "B", weight: 1 }, { source: "B", target: "C", weight: 1 },
  { source: "C", target: "D", weight: 1 }, { source: "D", target: "A", weight: 1 },
]);
const p1 = svc.setPersonalization(g1.graphId, "uniform", null);
const r1 = svc.createRun(g1.graphId, p1.personalizationId);
svc.advanceRun(r1.runId, 200);
show(r1.runId, "对称四环（期望各 0.25）");

// 2) 带一个悬挂节点的小图：A->B, B->A, B->C，C 悬挂
const g2 = svc.importGraph("dangling", ["A", "B", "C"], [
  { source: "A", target: "B", weight: 1 },
  { source: "B", target: "A", weight: 1 }, { source: "B", target: "C", weight: 1 },
]);
const p2 = svc.setPersonalization(g2.graphId, "uniform", null);
const r2 = svc.createRun(g2.graphId, p2.personalizationId);
svc.advanceRun(r2.runId, 200, true);
show(r2.runId, "带悬挂节点 C 的小图");
const c = svc.getContributions(r2.runId, "C");
console.log(`  C 末轮贡献: 入边=${fmt(c.edge)} 悬挂重分配=${fmt(c.dangling)} 随机跳转=${fmt(c.teleport)}`);

// 3) 改变个性化分布后的排名变化（同一张图）
const p3 = svc.setPersonalization(g2.graphId, "bias-A", { A: 5 });
const r3 = svc.createRun(g2.graphId, p3.personalizationId);
svc.advanceRun(r3.runId, 200);
show(r3.runId, "同图但个性化偏向 A");

console.log("\n说明：高排名仅反映图结构访问频率，不代表内容正确性、社会影响或因果。");
svc.close();


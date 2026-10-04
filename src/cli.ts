import * as fs from "node:fs";
import * as path from "node:path";
import { Service } from "./service.ts";
import { ApiError } from "./pagerank.ts";

const DATA_DIR = process.env.PPR_DATA_DIR ?? path.join(process.cwd(), "data");
const service = new Service(path.join(DATA_DIR, "ppr.db"));

const fmt = (x: number) => x.toFixed(8); // 仅用于显示

function readJson(arg: string): any {
  if (fs.existsSync(arg)) return JSON.parse(fs.readFileSync(arg, "utf8"));
  return JSON.parse(arg);
}

function flag(args: string[], name: string, def?: string): string | undefined {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
}

function printRanking(r: { round?: number; converged: boolean; ranking: { nodeId: string; score: number }[] }) {
  if (r.round !== undefined) console.log(`轮次: ${r.round}  收敛: ${r.converged ? "是" : "否"}`);
  r.ranking.forEach((row, i) => console.log(`  ${String(i + 1).padStart(3)}. ${row.nodeId.padEnd(12)} ${fmt(row.score)}`));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "import": { // import <file.json> [--name x]
      const spec = readJson(args[0]);
      const r = service.importGraph(flag(args, "name") ?? spec.name ?? "graph", spec.nodes, spec.edges ?? []);
      console.log(`已导入图 #${r.graphId}：${r.nodeCount} 节点，${r.edgeCount} 边`);
      break;
    }
    case "personalize": { // personalize <graphId> '<json>'|--uniform [--name x]
      const graphId = Number(args[0]);
      const vec = args[1] === "--uniform" ? null : readJson(args[1]);
      const r = service.setPersonalization(graphId, flag(args, "name") ?? "p", vec);
      console.log(`已创建个性化向量 #${r.personalizationId}`);
      break;
    }
    case "run": { // run <graphId> <personalizationId> [--damping 0.85] [--tolerance 1e-10]
      const r = service.createRun(Number(args[0]), Number(args[1]),
        Number(flag(args, "damping", "0.85")), Number(flag(args, "tolerance", "1e-10")));
      console.log(`已创建运行 #${r.runId}（算法 ${r.algorithm}）`);
      break;
    }
    case "advance": { // advance <runId> <budget> [--explain]
      const r = service.advanceRun(Number(args[0]), Number(args[1]), args.includes("--explain"));
      console.log(`推进 ${r.iterationsRun} 轮（累计 ${r.totalIterations}）  最后 L1 差: ${r.lastDiff.toExponential(4)}  分数总和: ${fmt(r.scoreSum)}`);
      console.log(`停止原因: ${r.stopReason === "converged" ? "达到容差，已收敛" : "预算耗尽，未收敛"}`);
      break;
    }
    case "rank": { // rank <runId> [--limit 20]
      printRanking(service.getRanking(Number(args[0]), Number(flag(args, "limit", "20"))));
      break;
    }
    case "explain": { // explain <runId> <nodeId> [--round k]
      const c = service.getContributions(Number(args[0]), args[1],
        flag(args, "round") ? Number(flag(args, "round")) : undefined);
      console.log(`运行 #${c.runId} 第 ${c.round} 轮 节点 ${c.nodeId} 的来源贡献：`);
      console.log(`  入边传播:   ${fmt(c.edge)}`);
      console.log(`  悬挂重分配: ${fmt(c.dangling)}`);
      console.log(`  随机跳转:   ${fmt(c.teleport)}`);
      console.log(`  合计(新分): ${fmt(c.total)}`);
      for (const e of c.inEdges)
        console.log(`    <- ${e.from}  权重 ${e.weight}  占比 ${(e.share * 100).toFixed(2)}%  贡献 ${fmt(e.contribution)}`);
      break;
    }
    case "compare": { // compare <runId1> <runId2> [...]
      const results = service.compare(args.map(Number));
      for (const r of results) {
        console.log(`\n运行 #${r.runId}（图 ${r.graphId}, 阻尼 ${r.damping}, 容差 ${r.tolerance}）`);
        printRanking(r);
      }
      break;
    }
    case "export": { // export <runId> [out.json]
      const data = service.exportRun(Number(args[0]));
      const out = args[1];
      if (out) { fs.writeFileSync(out, JSON.stringify(data, null, 2)); console.log(`已导出到 ${out}`); }
      else console.log(JSON.stringify(data, null, 2));
      break;
    }
    default:
      console.log(`用法: npm run cli -- <命令>
  import <graph.json> [--name x]                 导入图 {nodes:[], edges:[{source,target,weight}]}
  personalize <graphId> '<json>'|--uniform       设置个性化向量
  run <graphId> <personalizationId> [--damping d] [--tolerance t]
  advance <runId> <budget> [--explain]           按轮预算推进（--explain 保存贡献明细）
  rank <runId> [--limit n]                       查询排名
  explain <runId> <nodeId> [--round k]           查看某轮传入贡献
  compare <runId...>                             比较多个运行
  export <runId> [out.json]                      导出`);
  }
}

main().catch((e) => {
  if (e instanceof ApiError) { console.error(`错误 [${e.code}]: ${e.message}`); process.exit(2); }
  throw e;
});


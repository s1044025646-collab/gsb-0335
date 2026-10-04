import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";
import { PprError } from "./core/pagerank";

function fmt(x: number | null, digits = 10): string {
  if (x === null || x === undefined) return "-";
  return x.toExponential(4).replace("e", "e");
}

function fmtScore(x: number): string {
  return x.toFixed(8);
}

function usage(): never {
  console.log(`个性化 PageRank CLI

用法: node dist/cli.js <命令> [参数]   (数据默认存于 ./data/ppr.db，可用 --db= 覆盖)

命令:
  import-graph --file=graph.json                     导入图 {nodes:[], edges:[{source,target,weight}]}
  set-personalization --graph=ID --file=pers.json    校验并归一个性化向量 {weights:{节点:权重}}
  run --graph=ID [--damping=0.85] [--tol=1e-10] [--max-iter=100] [--pers=pers.json]
  advance --run=ID --budget=N [--save-contribs]      按预算推进 N 轮
  rank --run=ID [--top=K]                            查看排名
  residuals --run=ID                                 查看每轮 L1 残差
  explain --run=ID --iter=N --node=ID                查看第 N 轮某节点的来源贡献
  compare --runs=ID,ID,...                           比较多个运行的参数与排名
  export --run=ID [--out=file.json]                  导出运行结果
  demo                                               运行内置演示
`);
  process.exit(1);
}

function argMap(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) m.set(a.slice(2, eq), a.slice(eq + 1));
      else m.set(a.slice(2), "true");
    }
  }
  return m;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function runCli(argv: string[], dbPath?: string): void {
  const args = argMap(argv);
  const db = dbPath ?? args.get("db") ?? path.join(process.cwd(), "data", "ppr.db");
  const store = new Store(db);
  const cmd = argv.find((a) => !a.startsWith("--"));
  try {
    switch (cmd) {
      case "import-graph": {
        const g = readJson(args.get("file")!);
        const r = store.importGraph(g.nodes, g.edges ?? []);
        console.log(`图已导入: graphId=${r.graphId} 节点=${r.nodeCount} 边=${r.edgeCount}（平行边已合并）`);
        break;
      }
      case "set-personalization": {
        const p = readJson(args.get("file")!);
        const norm = store.checkPersonalization(Number(args.get("graph")), p.weights ?? null);
        console.log("归一化后的个性化分布:");
        for (const [k, v] of Object.entries(norm)) console.log(`  ${k}: ${fmtScore(v as number)}`);
        break;
      }
      case "run": {
        const pers = args.get("pers") ? readJson(args.get("pers")!).weights : null;
        const r = store.createRun({
          graphId: Number(args.get("graph")),
          damping: args.get("damping") ? Number(args.get("damping")) : undefined,
          tolerance: args.get("tol") ? Number(args.get("tol")) : undefined,
          maxIterations: args.get("max-iter") ? Number(args.get("max-iter")) : undefined,
          personalization: pers,
        });
        console.log(`运行已创建: runId=${r.runId}`);
        break;
      }
      case "advance": {
        const r = store.advance(Number(args.get("run")), Number(args.get("budget") ?? "1"), args.has("save-contribs"));
        console.log(
          `推进: 轮次 ${r.fromIteration} -> ${r.toIteration}  最后L1=${fmt(r.lastL1)}  分数和=${r.scoreSum.toFixed(12)}  状态=${r.status}`,
        );
        if (r.stopReason) console.log(`停止原因: ${r.stopReason}`);
        break;
      }
      case "rank": {
        const r = store.ranking(Number(args.get("run")), args.get("top") ? Number(args.get("top")) : undefined);
        console.log(`运行 ${r.runId} 第 ${r.iteration} 轮排名 (状态=${r.status}, L1=${fmt(r.lastL1)}, 分数和=${r.scoreSum.toFixed(12)}):`);
        for (const e of r.entries) console.log(`  #${e.rank}  ${e.node}  ${fmtScore(e.score)}`);
        break;
      }
      case "residuals": {
        const rows = store.residuals(Number(args.get("run")));
        console.log("轮次  L1残差        分数和");
        for (const r of rows) console.log(`  ${r.iteration}\t${fmt(r.l1)}\t${r.scoreSum.toFixed(12)}`);
        break;
      }
      case "explain": {
        const r = store.explain(Number(args.get("run")), Number(args.get("iter")), args.get("node")!) as any;
        const c = r.contribution;
        console.log(`运行 ${r.runId} 第 ${r.iteration} 轮, 节点 ${c.node} 得分 ${fmtScore(c.score)} 的来源:`);
        console.log(`  入边贡献(已乘阻尼): ${fmtScore(c.edgeTotal)}`);
        for (const e of c.edgeContrib) {
          console.log(`    <- ${e.from} (边权 ${e.weight}/${e.fromOutWeight}): 原始 ${fmtScore(e.raw)}, 阻尼后 ${fmtScore(e.damped)}`);
        }
        console.log(`  悬挂重分配: ${fmtScore(c.danglingContrib)}`);
        console.log(`  随机跳转:   ${fmtScore(c.teleportContrib)}`);
        break;
      }
      case "compare": {
        const ids = (args.get("runs") ?? "").split(",").filter(Boolean).map(Number);
        const rows = store.compare(ids) as any[];
        for (const r of rows) {
          console.log(`运行 ${r.runId}: 图=${r.graphId} 阻尼=${r.damping} 容差=${r.tolerance} 预算=${r.maxIterations} 轮次=${r.iteration} 状态=${r.status}`);
          console.log(`  个性化: ${JSON.stringify(r.personalization)}`);
          for (const e of r.ranking.slice(0, 10)) console.log(`    #${e.rank}  ${e.node}  ${fmtScore(e.score)}`);
        }
        break;
      }
      case "export": {
        const data = store.exportRun(Number(args.get("run")));
        const out = args.get("out");
        if (out) {
          fs.writeFileSync(out, JSON.stringify(data, null, 2), "utf8");
          console.log(`已导出到 ${out}`);
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof PprError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      process.exit(2);
    }
    throw err;
  } finally {
    store.close();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

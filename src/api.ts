import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { Store } from "./store";
import { PprError } from "./core/pagerank";

const DEFAULT_PORT = 8787;

function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => {
      const s2 = net.createServer();
      s2.once("error", () => resolve(0));
      s2.listen(0, () => {
        const p = (s2.address() as net.AddressInfo).port;
        s2.close(() => resolve(p));
      });
    });
    srv.listen(preferred, () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new PprError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

export async function startServer(opts: { port?: number; dbPath?: string } = {}): Promise<{
  port: number;
  close: () => void;
}> {
  const dbPath = opts.dbPath ?? path.join(process.cwd(), "data", "ppr.db");
  const store = new Store(dbPath);
  const port = opts.port ?? (await findFreePort(DEFAULT_PORT));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      const body = (req.method === "POST" ? await readBody(req) : {}) as any;

      if (req.method === "POST" && url.pathname === "/graphs") {
        return send(res, 201, store.importGraph(body.nodes, body.edges ?? []));
      }
      if (req.method === "POST" && parts[0] === "graphs" && parts[2] === "personalization") {
        return send(res, 200, { normalized: store.checkPersonalization(Number(parts[1]), body.weights ?? null) });
      }
      if (req.method === "POST" && url.pathname === "/runs") {
        return send(res, 201, store.createRun(body));
      }
      if (req.method === "POST" && parts[0] === "runs" && parts[2] === "advance") {
        return send(res, 200, store.advance(Number(parts[1]), body.budget ?? 1, body.saveContributions === true));
      }
      if (req.method === "GET" && parts[0] === "runs" && parts[2] === "ranking") {
        const top = url.searchParams.get("top");
        return send(res, 200, store.ranking(Number(parts[1]), top ? Number(top) : undefined));
      }
      if (req.method === "GET" && parts[0] === "runs" && parts[2] === "residuals") {
        return send(res, 200, { runId: Number(parts[1]), residuals: store.residuals(Number(parts[1])) });
      }
      if (req.method === "GET" && parts[0] === "runs" && parts[2] === "iterations" && parts[4] === "contributions") {
        const node = url.searchParams.get("node");
        if (!node) throw new PprError("MISSING_PARAM", "缺少查询参数 node");
        return send(res, 200, store.explain(Number(parts[1]), Number(parts[3]), node));
      }
      if (req.method === "POST" && url.pathname === "/compare") {
        if (!Array.isArray(body.runIds)) throw new PprError("MISSING_PARAM", "需要 runIds 数组");
        return send(res, 200, { comparison: store.compare(body.runIds) });
      }
      if (req.method === "GET" && parts[0] === "runs" && parts[2] === "export") {
        return send(res, 200, store.exportRun(Number(parts[1])));
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: `未知路由: ${req.method} ${url.pathname}` } });
    } catch (err) {
      if (err instanceof PprError) {
        send(res, 400, { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  const actualPort = (server.address() as net.AddressInfo).port;
  console.log(`PPR API 服务已启动: http://localhost:${actualPort} (数据目录: ${path.dirname(dbPath)})`);
  return { port: actualPort, close: () => server.close() };
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const dbArg = process.argv.find((a) => a.startsWith("--db="));
  startServer({
    port: portArg ? Number(portArg.split("=")[1]) : undefined,
    dbPath: dbArg ? dbArg.split("=")[1] : undefined,
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

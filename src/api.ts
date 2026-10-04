import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { Service } from "./service.ts";
import { ApiError } from "./pagerank.ts";

const DATA_DIR = process.env.PPR_DATA_DIR ?? path.join(process.cwd(), "data");
const service = new Service(path.join(DATA_DIR, "ppr.db"));

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new ApiError("INVALID_JSON", "请求体不是合法 JSON"); }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

type Handler = (body: any, query: URLSearchParams) => unknown;
const routes: Record<string, Handler> = {
  "POST /graphs": (b) => service.importGraph(b.name, b.nodes, b.edges),
  "POST /personalizations": (b) => service.setPersonalization(num(b.graphId, "graphId"), b.name, b.vector ?? null),
  "POST /runs": (b) => service.createRun(num(b.graphId, "graphId"), num(b.personalizationId, "personalizationId"), b.damping ?? 0.85, b.tolerance ?? 1e-10),
  "POST /advance": (b) => service.advanceRun(num(b.runId, "runId"), b.budget, !!b.saveContributions),
  "GET /ranking": (_b, q) => service.getRanking(num(q.get("runId"), "runId"), q.get("limit") ? Number(q.get("limit")) : 50),
  "GET /contributions": (_b, q) => service.getContributions(num(q.get("runId"), "runId"), str(q.get("nodeId"), "nodeId"), q.get("round") ? Number(q.get("round")) : undefined),
  "POST /compare": (b) => service.compare(b.runIds, b.limit ?? 20),
  "GET /export": (_b, q) => service.exportRun(num(q.get("runId"), "runId")),
  "GET /health": () => ({ ok: true }),
};

function num(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError("INVALID_PARAM", `参数 ${name} 必须是数字`);
  return n;
}
function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new ApiError("INVALID_PARAM", `参数 ${name} 必须是非空字符串`);
  return v;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new ApiError("NOT_FOUND", "路由不存在", 404);
      const body = req.method === "POST" ? await readBody(req) : {};
      send(res, 200, { ok: true, data: handler(body, url.searchParams) });
    } catch (e) {
      if (e instanceof ApiError) send(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
      else { console.error(e); send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(e) } }); }
    }
  });
}

export function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(findFreePort(preferred + 1)));
    srv.listen(preferred, () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)); });
  });
}

if (process.argv[1] && process.argv[1].endsWith("api.ts")) {
  const preferred = Number(process.env.PORT ?? 8080);
  const port = await findFreePort(preferred);
  createServer().listen(port, () => console.log(`PPR API listening on http://127.0.0.1:${port} (data: ${DATA_DIR})`));
}

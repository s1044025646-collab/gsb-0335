import { createServer, findFreePort } from "../src/api.ts";
const port = await findFreePort(8080);
const server = createServer();
await new Promise<void>((r) => server.listen(port, () => r()));
const base = `http://127.0.0.1:${port}`;
const post = async (p: string, body: any) => {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
const get = async (p: string) => (await fetch(base + p)).json();

const g = await post("/graphs", { name: "t", nodes: ["A", "B", "C"], edges: [
  { source: "A", target: "B", weight: 1 }, { source: "B", target: "A", weight: 1 }] });
const p = await post("/personalizations", { graphId: g.data.graphId });
const r = await post("/runs", { graphId: g.data.graphId, personalizationId: p.data.personalizationId });
const a = await post("/advance", { runId: r.data.runId, budget: 100, saveContributions: true });
console.log("advance:", a.data.converged, a.data.totalIterations, "sum=", a.data.scoreSum);
console.log("ranking:", (await get(`/ranking?runId=${r.data.runId}`)).data.ranking);
const c = (await get(`/contributions?runId=${r.data.runId}&nodeId=C`)).data;
console.log("C contributions:", c.edge, c.dangling, c.teleport, c.total);
const bad = await post("/runs", { graphId: 1, personalizationId: 1, damping: 1.5 });
console.log("bad damping:", bad.status, bad.error.code);
const cmp = await post("/compare", { runIds: [r.data.runId] });
console.log("compare ok:", cmp.ok, "runs:", cmp.data.length);
server.close();


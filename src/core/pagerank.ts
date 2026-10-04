export const LIMITS = {
  MAX_NODES: 100000,
  MAX_EDGES: 1000000,
  MAX_ITERATIONS: 10000,
  MIN_TOLERANCE: 1e-15,
  MAX_TOLERANCE: 1.0,
} as const;

export const ALGORITHM_VERSION = "ppr-power-iter-v1";

export type EdgeInput = { source: string; target: string; weight: number };

export class PprError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "PprError";
  }
}

export type NormalizedGraph = {
  nodeIds: string[];
  index: Map<string, number>;
  outAdj: Array<Array<[number, number]>>;
  inAdj: Array<Array<[number, number]>>;
  outWeight: number[];
  edgeCount: number;
};

export function buildGraph(nodes: string[], edges: EdgeInput[]): NormalizedGraph {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new PprError("EMPTY_NODE_SET", "节点集不能为空");
  }
  if (nodes.length > LIMITS.MAX_NODES) {
    throw new PprError("TOO_MANY_NODES", `节点数超过上限 ${LIMITS.MAX_NODES}`);
  }
  const seen = new Set<string>();
  for (const n of nodes) {
    if (typeof n !== "string" || n.length === 0) {
      throw new PprError("INVALID_NODE_ID", "节点编号必须是非空字符串");
    }
    if (seen.has(n)) throw new PprError("DUPLICATE_NODE", `节点编号重复: ${n}`);
    seen.add(n);
  }
  if (!Array.isArray(edges)) throw new PprError("INVALID_EDGES", "边必须是数组");
  if (edges.length > LIMITS.MAX_EDGES) {
    throw new PprError("TOO_MANY_EDGES", `边数超过上限 ${LIMITS.MAX_EDGES}`);
  }
  const merged = new Map<string, number>();
  for (const e of edges) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") {
      throw new PprError("INVALID_EDGE", "边必须包含 source 与 target");
    }
    if (!seen.has(e.source) || !seen.has(e.target)) {
      throw new PprError("UNKNOWN_NODE", `边引用了不存在的节点: ${e.source} -> ${e.target}`);
    }
    if (typeof e.weight !== "number" || !Number.isFinite(e.weight)) {
      throw new PprError("INVALID_WEIGHT", "边权必须是有限数字");
    }
    if (e.weight < 0) throw new PprError("NEGATIVE_WEIGHT", `边权不能为负: ${e.source} -> ${e.target}`);
    const key = e.source + "\u0001" + e.target;
    merged.set(key, (merged.get(key) ?? 0) + e.weight);
  }
  const nodeIds = [...nodes].sort();
  const index = new Map<string, number>(nodeIds.map((id, i) => [id, i]));
  const n = nodeIds.length;
  const outAdj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  const inAdj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  const outWeight = new Array<number>(n).fill(0);
  for (const [key, w] of merged) {
    const sep = key.indexOf("\u0001");
    const s = index.get(key.slice(0, sep))!;
    const t = index.get(key.slice(sep + 1))!;
    outAdj[s].push([t, w]);
    inAdj[t].push([s, w]);
    outWeight[s] += w;
  }
  return { nodeIds, index, outAdj, inAdj, outWeight, edgeCount: merged.size };
}

export function validateDamping(damping: number): number {
  if (typeof damping !== "number" || !Number.isFinite(damping) || damping <= 0 || damping >= 1) {
    throw new PprError("INVALID_DAMPING", "阻尼系数必须严格位于 (0, 1)");
  }
  return damping;
}

export function validateTolerance(tol: number): number {
  if (typeof tol !== "number" || !Number.isFinite(tol) || tol < LIMITS.MIN_TOLERANCE || tol > LIMITS.MAX_TOLERANCE) {
    throw new PprError("INVALID_TOLERANCE", `容差必须在 [${LIMITS.MIN_TOLERANCE}, ${LIMITS.MAX_TOLERANCE}]`);
  }
  return tol;
}

export function validateBudget(budget: number): number {
  if (!Number.isInteger(budget) || budget < 1 || budget > LIMITS.MAX_ITERATIONS) {
    throw new PprError("INVALID_BUDGET", `迭代预算必须是 [1, ${LIMITS.MAX_ITERATIONS}] 的整数`);
  }
  return budget;
}

export function normalizePersonalization(
  graph: NormalizedGraph,
  weights: Record<string, number> | null | undefined,
): number[] {
  const n = graph.nodeIds.length;
  if (weights == null) {
    return new Array<number>(n).fill(1 / n);
  }
  if (typeof weights !== "object" || Array.isArray(weights)) {
    throw new PprError("INVALID_PERSONALIZATION", "个性化权重必须是 {节点编号: 权重} 对象");
  }
  const vec = new Array<number>(n).fill(0);
  let sum = 0;
  for (const [id, w] of Object.entries(weights)) {
    const i = graph.index.get(id);
    if (i === undefined) throw new PprError("UNKNOWN_NODE", `个性化权重引用了不存在的节点: ${id}`);
    if (typeof w !== "number" || !Number.isFinite(w)) throw new PprError("INVALID_PERSONALIZATION", "个性化权重必须是有限数字");
    if (w < 0) throw new PprError("NEGATIVE_PERSONALIZATION", `个性化权重不能为负: ${id}`);
    vec[i] = w;
    sum += w;
  }
  if (sum <= 0) throw new PprError("ZERO_PERSONALIZATION", "个性化权重总和必须大于零");
  for (let i = 0; i < n; i++) vec[i] /= sum;
  return vec;
}

export function iterateOnce(
  graph: NormalizedGraph,
  scores: number[],
  personalization: number[],
  damping: number,
): { next: number[]; l1: number } {
  const n = graph.nodeIds.length;
  const next = new Array<number>(n).fill(0);
  let danglingMass = 0;
  for (let s = 0; s < n; s++) {
    const total = graph.outWeight[s];
    if (total === 0) {
      danglingMass += scores[s];
    } else {
      for (const [t, w] of graph.outAdj[s]) {
        next[t] += (scores[s] * w) / total;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    next[i] = damping * (next[i] + danglingMass * personalization[i]) + (1 - damping) * personalization[i];
  }
  let l1 = 0;
  for (let i = 0; i < n; i++) l1 += Math.abs(next[i] - scores[i]);
  return { next, l1 };
}

export type Contribution = {
  node: string;
  score: number;
  edgeContrib: Array<{ from: string; weight: number; fromOutWeight: number; raw: number; damped: number }>;
  edgeTotal: number;
  danglingContrib: number;
  teleportContrib: number;
};

export function explainNode(
  graph: NormalizedGraph,
  prevScores: number[],
  personalization: number[],
  damping: number,
  nodeId: string,
): Contribution {
  const i = graph.index.get(nodeId);
  if (i === undefined) throw new PprError("UNKNOWN_NODE", `未知节点: ${nodeId}`);
  let danglingMass = 0;
  for (let s = 0; s < graph.nodeIds.length; s++) {
    if (graph.outWeight[s] === 0) danglingMass += prevScores[s];
  }
  const edgeContrib = graph.inAdj[i].map(([s, w]) => {
    const raw = (prevScores[s] * w) / graph.outWeight[s];
    return {
      from: graph.nodeIds[s],
      weight: w,
      fromOutWeight: graph.outWeight[s],
      raw,
      damped: damping * raw,
    };
  });
  const edgeTotal = edgeContrib.reduce((a, c) => a + c.damped, 0);
  const danglingContrib = damping * danglingMass * personalization[i];
  const teleportContrib = (1 - damping) * personalization[i];
  return {
    node: nodeId,
    score: edgeTotal + danglingContrib + teleportContrib,
    edgeContrib,
    edgeTotal,
    danglingContrib,
    teleportContrib,
  };
}

export function rankNodes(
  nodeIds: string[],
  scores: number[],
): Array<{ node: string; score: number; rank: number }> {
  const order = nodeIds.map((id, i) => ({ id, i }));
  order.sort((a, b) => {
    const d = scores[b.i] - scores[a.i];
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return order.map((o, k) => ({ node: o.id, score: scores[o.i], rank: k + 1 }));
}



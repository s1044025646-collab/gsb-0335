export const ALGORITHM_VERSION = "ppr-power-v1";

export const LIMITS = {
  maxNodes: 100000,
  maxEdges: 1000000,
  maxIterationsPerAdvance: 10000,
  minTolerance: 1e-15,
  maxTolerance: 1.0,
} as const;

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface EdgeInput { source: string; target: string; weight: number; }

export interface PreparedGraph {
  nodeIds: string[];
  index: Map<string, number>;
  outAdj: { to: number; weight: number }[][];
  inAdj: { from: number; weight: number }[][];
  outWeightSum: number[];
  dangling: boolean[];
}

export function prepareGraph(nodeIds: string[], edges: EdgeInput[]): PreparedGraph {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0)
    throw new ApiError("EMPTY_NODE_SET", "节点集不能为空");
  if (nodeIds.length > LIMITS.maxNodes)
    throw new ApiError("TOO_MANY_NODES", `节点数超过上限 ${LIMITS.maxNodes}`);
  const seen = new Set<string>();
  for (const id of nodeIds) {
    if (typeof id !== "string" || id.length === 0)
      throw new ApiError("INVALID_NODE_ID", "节点编号必须是非空字符串");
    if (seen.has(id)) throw new ApiError("DUPLICATE_NODE", `节点编号重复: ${id}`);
    seen.add(id);
  }
  if (!Array.isArray(edges)) throw new ApiError("INVALID_EDGES", "边必须是数组");
  if (edges.length > LIMITS.maxEdges)
    throw new ApiError("TOO_MANY_EDGES", `边数超过上限 ${LIMITS.maxEdges}`);

  const index = new Map<string, number>();
  nodeIds.forEach((id, i) => index.set(id, i));
  const n = nodeIds.length;
  const merged = new Map<string, number>();
  for (const e of edges) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string")
      throw new ApiError("INVALID_EDGE", "边必须包含 source 与 target");
    if (!index.has(e.source) || !index.has(e.target))
      throw new ApiError("UNKNOWN_NODE_REF", `边引用了未知节点: ${e.source} -> ${e.target}`);
    if (typeof e.weight !== "number" || !Number.isFinite(e.weight))
      throw new ApiError("INVALID_WEIGHT", "边权必须是有限数字");
    if (e.weight < 0) throw new ApiError("NEGATIVE_WEIGHT", `边权不能为负: ${e.source} -> ${e.target}`);
    if (e.weight === 0) continue; // 零权边忽略，不影响出权总和
    const si = index.get(e.source)!, ti = index.get(e.target)!;
    const key = si + "->" + ti;
    merged.set(key, (merged.get(key) ?? 0) + e.weight); // 平行边合并
  }
  const outAdj: { to: number; weight: number }[][] = Array.from({ length: n }, () => []);
  const inAdj: { from: number; weight: number }[][] = Array.from({ length: n }, () => []);
  const outWeightSum = new Array<number>(n).fill(0);
  for (const [key, w] of merged) {
    const [si, ti] = key.split("->").map(Number);
    outAdj[si].push({ to: ti, weight: w });
    inAdj[ti].push({ from: si, weight: w });
    outWeightSum[si] += w;
  }
  const dangling = outWeightSum.map((s) => s === 0);
  return { nodeIds, index, outAdj, inAdj, outWeightSum, dangling };
}

export function normalizePersonalization(
  nodeIds: string[],
  input: Record<string, number> | null | undefined,
  index: Map<string, number>
): number[] {
  const n = nodeIds.length;
  if (input == null) return new Array<number>(n).fill(1 / n); // 默认均匀
  if (typeof input !== "object" || Array.isArray(input))
    throw new ApiError("INVALID_PERSONALIZATION", "个性化向量必须是 {节点编号: 权重} 对象");
  const v = new Array<number>(n).fill(0);
  let total = 0;
  for (const [id, w] of Object.entries(input)) {
    const i = index.get(id);
    if (i === undefined) throw new ApiError("UNKNOWN_NODE_REF", `个性化向量引用未知节点: ${id}`);
    if (typeof w !== "number" || !Number.isFinite(w))
      throw new ApiError("INVALID_PERSONALIZATION", "个性化权重必须是有限数字");
    if (w < 0) throw new ApiError("NEGATIVE_PERSONALIZATION", `个性化权重不能为负: ${id}`);
    v[i] += w;
    total += w;
  }
  if (total <= 0) throw new ApiError("ZERO_PERSONALIZATION", "个性化权重不能全为零");
  return v.map((x) => x / total); // 明确归一
}

export function validateDamping(d: unknown): number {
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0 || d >= 1)
    throw new ApiError("INVALID_DAMPING", "阻尼系数必须严格在 0 和 1 之间");
  return d;
}

export function validateTolerance(t: unknown): number {
  if (typeof t !== "number" || !Number.isFinite(t) || t < LIMITS.minTolerance || t > LIMITS.maxTolerance)
    throw new ApiError("INVALID_TOLERANCE", `容差必须在 [${LIMITS.minTolerance}, ${LIMITS.maxTolerance}] 内`);
  return t;
}

export function validateBudget(b: unknown): number {
  if (typeof b !== "number" || !Number.isInteger(b) || b < 1 || b > LIMITS.maxIterationsPerAdvance)
    throw new ApiError("INVALID_BUDGET", `迭代预算必须是 1..${LIMITS.maxIterationsPerAdvance} 的整数`);
  return b;
}

export interface Contribution {
  nodeId: string;
  edge: number;      // 入边传播贡献
  dangling: number;  // 悬挂重分配贡献
  teleport: number;  // 随机跳转贡献
  total: number;     // 新分数
  inEdges: { from: string; weight: number; share: number; contribution: number }[];
}

/** 单轮幂迭代。prev 为上一整轮分数，本轮内不被修改。返回新分数与贡献明细。 */
export function iterateOnce(
  g: PreparedGraph,
  prev: number[],
  personalization: number[],
  damping: number
): { next: number[]; contributions: Contribution[] } {
  const n = g.nodeIds.length;
  const edgePart = new Array<number>(n).fill(0);
  let danglingMass = 0;
  for (let i = 0; i < n; i++) {
    const s = prev[i];
    if (s === 0) continue;
    if (g.dangling[i]) { danglingMass += s; continue; }
    const sum = g.outWeightSum[i];
    for (const { to, weight } of g.outAdj[i]) edgePart[to] += s * (weight / sum);
  }
  const next = new Array<number>(n).fill(0);
  const contributions: Contribution[] = new Array(n);
  for (let j = 0; j < n; j++) {
    const dang = danglingMass * personalization[j];
    const tele = (1 - damping) * personalization[j];
    next[j] = damping * (edgePart[j] + dang) + tele;
    const inEdges = g.inAdj[j].map(({ from, weight }) => {
      const share = weight / g.outWeightSum[from];
      return { from: g.nodeIds[from], weight, share, contribution: damping * prev[from] * share };
    });
    contributions[j] = {
      nodeId: g.nodeIds[j],
      edge: damping * edgePart[j],
      dangling: damping * dang,
      teleport: tele,
      total: next[j],
      inEdges,
    };
  }
  return { next, contributions };
}

export function l1Diff(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

export function sum(v: number[]): number {
  let s = 0;
  for (const x of v) s += x;
  return s;
}

export type StopReason = "converged" | "budget_exhausted";

export interface AdvanceResult {
  iterationsRun: number;
  totalIterations: number;
  lastDiff: number;
  scoreSum: number;
  converged: boolean;
  stopReason: StopReason;
  scores: number[];
}

/** 推进最多 budget 轮；达到容差提前停止。 */
export function advance(
  g: PreparedGraph,
  startScores: number[],
  personalization: number[],
  damping: number,
  tolerance: number,
  budget: number,
  onRound?: (round: number, scores: number[], contributions: Contribution[]) => void,
  startRound = 0
): AdvanceResult {
  let prev = startScores;
  let lastDiff = NaN;
  let ran = 0;
  let converged = false;
  for (let k = 1; k <= budget; k++) {
    const { next, contributions } = iterateOnce(g, prev, personalization, damping);
    lastDiff = l1Diff(next, prev);
    ran = k;
    prev = next;
    onRound?.(startRound + k, next, contributions);
    if (lastDiff <= tolerance) { converged = true; break; }
  }
  return {
    iterationsRun: ran,
    totalIterations: startRound + ran,
    lastDiff,
    scoreSum: sum(prev),
    converged,
    stopReason: converged ? "converged" : "budget_exhausted",
    scores: prev,
  };
}

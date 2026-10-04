# 个性化 PageRank 权重传播与收敛解释后端

纯本地、离线运行的个性化 PageRank（Personalized PageRank）分析服务。
输入带稳定编号的节点、非负边权和个性化概率向量，计算随机浏览者长期访问各节点的稳态分数。
只做 API 与 CLI，无前端；不抓取网页、不做最短路径 / 最大流 / 吸收终点分析。

- 运行时：Node.js（建议 >= 22.5，开发使用 Node 25，使用内置 `node:sqlite`，无需原生编译）
- 语言：TypeScript（编译为 CommonJS）
- 存储：SQLite（WAL 模式），数据默认在项目内 `data/` 目录
- 无 Docker / WSL / 付费服务 / 外部在线 API 依赖，运行时零第三方依赖

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript 等）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认端口 8787，被占用时自动选空闲端口）
npm run demo       # 运行内置演示（对称环 / 悬挂节点 / 个性化对比）
```

自定义端口与数据库位置：

```powershell
node dist/api.js --port=9000 --db=data\my.db
```

## 模型与算法

- **有向加权图**：边 `(source, target, weight)`，`weight >= 0`。平行边先合并权重；自环正常计入源节点出边权总和；允许无边图与孤立点。
- **传播规则**：每轮先把源节点分数按 `边权 / 源节点总出权` 分发；总出权为零的节点（悬挂节点，包括只有零权出边的节点）把分数按**个性化向量**重新分配（悬挂质量不丢弃、不按入边归一）。
- **随机跳转**：`新分数 = d × 传播结果 + (1 - d) × 个性化向量`，阻尼系数 `d` 严格位于 `(0, 1)`。
- **初始分数**：第 0 轮等于所选个性化分布（默认均匀；用户给定时校验并归一，绝不按入度等结构量偷偷替换）。
- **同步迭代**：每轮完全基于上一整轮分数计算，不边更新边影响同轮其他节点。
- **停止条件**：相邻两轮分数向量的 **L1 差** `<= tolerance` 判定收敛；达到迭代预算仍未满足容差时状态为 `budget_exhausted`（未收敛），不会因为分数有限就宣布完成。
- **输出**：实际迭代次数、最后 L1 差、分数总和、停止原因。展示平局按节点编号字典序打破，分数本身不被修改。

### 公开参数范围

| 参数 | 范围 | 默认 |
|---|---|---|
| 节点数 | 1 .. 100000 | - |
| 边数 | 0 .. 1000000 | - |
| damping | (0, 1) 开区间 | 0.85 |
| tolerance | [1e-15, 1.0] | 1e-10 |
| maxIterations / 单次推进预算 | [1, 10000] 整数 | 100 |

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/graphs` | 导入图 `{nodes:[], edges:[{source,target,weight}]}` |
| POST | `/graphs/:id/personalization` | 校验并归一个性化向量 `{weights:{节点:权重}}` |
| POST | `/runs` | 创建分析 `{graphId, damping?, tolerance?, maxIterations?, personalization?}` |
| POST | `/runs/:id/advance` | 按预算推进 `{budget, saveContributions?}`（原子提交） |
| GET | `/runs/:id/ranking?top=K` | 查询排名 |
| GET | `/runs/:id/residuals` | 每轮 L1 残差与分数和 |
| GET | `/runs/:id/iterations/:n/contributions?node=X` | 第 n 轮节点 X 的来源贡献（入边 / 悬挂重分配 / 随机跳转） |
| POST | `/compare` | 比较多个运行 `{runIds:[...]}` |
| GET | `/runs/:id/export` | 导出运行完整结果（JSON） |
| GET | `/health` | 健康检查 |

错误统一返回 `{"error":{"code","message"}}`，错误码包括：
`EMPTY_NODE_SET`、`DUPLICATE_NODE`、`INVALID_NODE_ID`、`UNKNOWN_NODE`、`NEGATIVE_WEIGHT`、`INVALID_WEIGHT`、`INVALID_DAMPING`、`INVALID_TOLERANCE`、`INVALID_BUDGET`、`ZERO_PERSONALIZATION`、`NEGATIVE_PERSONALIZATION`、`INVALID_PERSONALIZATION`、`GRAPH_NOT_FOUND`、`RUN_NOT_FOUND`、`ITERATION_NOT_FOUND`、`ALREADY_CONVERGED`、`TOO_MANY_NODES`、`TOO_MANY_EDGES`、`INVALID_JSON`。

## CLI

```powershell
node dist/cli.js import-graph --file=examples/ring.json
node dist/cli.js set-personalization --graph=1 --file=examples/pers.json
node dist/cli.js run --graph=1 --damping=0.85 --tol=1e-10 --max-iter=100 --pers=examples/pers.json
node dist/cli.js advance --run=1 --budget=50 --save-contribs
node dist/cli.js rank --run=1 --top=10
node dist/cli.js residuals --run=1
node dist/cli.js explain --run=1 --iter=1 --node=B
node dist/cli.js compare --runs=1,2
node dist/cli.js export --run=1 --out=export.json
```

CLI 默认使用 `./data/ppr.db`，可用 `--db=路径` 覆盖。

## 持久化与续算

SQLite 冻结图、个性化分布、阻尼、容差、预算、算法版本（`ppr-power-iter-v1`）以及每次推进的每轮分数与 L1 残差：

- 重启后从已保存的整轮状态继续，一次推进与分批推进结果完全一致；
- 改变图或参数会创建独立运行，旧排名不会混入新图；
- 每次 `advance` 调用在一个事务中原子提交，失败回滚，不会只更新轮次却留下旧分数；
- 贡献解释明细可通过 `saveContributions` 选择保存以节省空间，核心分数始终完整保存。

## 测试

`npm test` 覆盖：两节点 / 三节点首轮手算对照、三节点带悬挂图的独立线性方程（高斯消元）最终分数对照、全悬挂图、零权边、平行边合并、自环、节点重排不变性、预算耗尽标记、分批与一次推进一致性、重启续算、失败回滚、对称环相等分数、个性化改变排名、贡献三部分分解、每轮非负且总和约等于 1。

## 本地规模限制

- 单进程内存计算，幂迭代每轮复杂度 O(节点数 + 边数)；默认上限 10 万节点 / 100 万边，本地小中规模图（数千至数万节点）体验良好。
- 每轮分数完整落盘，长迭代历史会占用磁盘（每轮约 `节点数 × ~20 字节` 的 JSON）；大图长迭代建议减少预算或不保存贡献明细。
- 小数格式化（如 CLI 的 8 位小数）仅用于显示，存储与比较使用完整双精度。

## 解释边界

分数只表示该数学模型下随机浏览者的长期访问概率。**高排名不代表内容正确、不代表社会影响力、不构成任何因果关系结论。**

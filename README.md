# 个性化 PageRank 权重传播与收敛解释后端

离线、本地运行的有向加权图个性化 PageRank 分析服务。仅提供 HTTP API 与 CLI，不抓取网页、不依赖 Docker/WSL/任何在线服务。输入带稳定编号的节点、非负边权和个性化概率向量，计算随机浏览者长期访问各节点的分数。

> 免责声明：高排名仅表示图结构上的长期访问频率，不代表内容正确性、社会影响或因果关系。

## 环境要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite`，无需原生编译、无需安装 SQLite）
- 依赖仅 `typescript` 与 `@types/node`（开发依赖）

## 快速开始

```powershell
npm install        # 安装开发依赖
npm run build      # TypeScript 类型检查（运行时用 Node 原生类型剥离，无需编译产物）
npm test           # 运行全部测试
npm run demo       # 内置演示：对称环 / 悬挂节点 / 个性化对比
npm run start      # 启动 HTTP API（默认端口 8080，被占用时自动选择下一个空闲端口）
npm run cli -- <命令>   # 使用 CLI
```

数据默认存放在项目内 `data/` 目录（可用环境变量 `PPR_DATA_DIR` 覆盖），端口用 `PORT` 覆盖。

## 模型与算法

- **加权方向**：边 `A -> B` 权重 `w` 表示 A 把分数按 `w / A的出边权总和` 的比例传给 B。自环正常计入出边权总和；平行边先合并权重；零权边被忽略（不影响出权总和）。
- **悬挂节点**：总出权为零的节点（含孤立点）把全部分数按个性化向量重新分配，悬挂质量不丢弃、不按入边归一。
- **更新公式**：`next = d * (入边传播 + 悬挂重分配) + (1 - d) * personalization`，阻尼系数 `d` 严格在 0 和 1 之间。
- **同步迭代**：每轮基于上一整轮分数计算，轮内不就地更新。
- **初始分数**：等于所选个性化分布。个性化向量默认均匀；用户给定时校验（未知节点、负值、全零均拒绝）并显式归一，不会按入度等规则偷偷替换。
- **停止条件**：相邻两轮分数向量的 L1 差 `<= tolerance` 即收敛；否则推进到预算耗尽并标记 `budget_exhausted`（未收敛）。输出实际迭代次数、最后差值、分数总和与停止原因。
- **展示**：同分按节点编号字典序稳定破平，分数本身不被修改；贡献明细中的小数格式化仅用于显示。

## 公开参数范围

| 参数 | 范围 |
| --- | --- |
| 节点数 | 1 .. 100,000（不允许空节点集） |
| 边数 | 0 .. 1,000,000（允许无边图） |
| 单次推进预算 | 1 .. 10,000 轮 |
| 容差 | [1e-15, 1.0] |
| 阻尼系数 | (0, 1) 开区间 |

## HTTP API

统一返回 `{ ok: true, data: ... }`；错误返回 `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/graphs` | 导入图 `{name, nodes:[], edges:[{source,target,weight}]}` |
| POST | `/personalizations` | 设置个性化向量 `{graphId, name, vector?}`（缺省为均匀） |
| POST | `/runs` | 创建运行 `{graphId, personalizationId, damping?, tolerance?}` |
| POST | `/advance` | 按轮预算推进 `{runId, budget, saveContributions?}` |
| GET | `/ranking?runId=&limit=` | 查询排名 |
| GET | `/contributions?runId=&nodeId=&round=` | 某轮传入贡献（入边/悬挂/随机跳转三部分） |
| POST | `/compare` | 比较多个运行 `{runIds:[...]}` |
| GET | `/export?runId=` | 导出完整运行（图、参数、各轮分数） |

主要错误码：`EMPTY_NODE_SET`、`DUPLICATE_NODE`、`UNKNOWN_NODE_REF`、`NEGATIVE_WEIGHT`、`ZERO_PERSONALIZATION`、`NEGATIVE_PERSONALIZATION`、`INVALID_DAMPING`、`INVALID_TOLERANCE`、`INVALID_BUDGET`、`ALREADY_CONVERGED`、`RUN_NOT_FOUND`、`GRAPH_NOT_FOUND`、`PERSONALIZATION_NOT_FOUND`、`CONTRIBUTIONS_NOT_FOUND`。

## CLI 示例

```powershell
npm run cli -- import graph.json --name demo
npm run cli -- personalize 1 '{"A": 2}'     # 或 --uniform
npm run cli -- run 1 1 --damping 0.85 --tolerance 1e-10
npm run cli -- advance 1 100 --explain      # 显示迭代轮数、残差、停止原因
npm run cli -- rank 1                       # 排名
npm run cli -- explain 1 C                  # 节点 C 末轮的来源贡献
npm run cli -- compare 1 2                  # 比较两次运行
npm run cli -- export 1 out.json
```

## 持久化与一致性

- SQLite（WAL）冻结图、个性化分布、阻尼、容差、算法版本（`ppr-power-v1`）以及每次推进的每轮完整分数。
- 每次推进在一个事务中原子提交分数、轮次与运行状态；失败整体回滚，不会出现轮次更新但分数滞留旧值。
- 重启后续算从已保存的整轮状态继续；一次推进 N 轮与分批推进结果完全一致（有测试覆盖）。
- 改变图或参数需创建新运行，各运行相互独立，旧排名不会混入新图。
- 贡献明细为可选保存（`saveContributions`），核心分数始终完整保存。

## 本地规模限制

为单机解释性服务设计：默认上限 10 万节点 / 100 万边，内存中保存稠密分数向量与邻接表。更大规模请分片或改用专用图计算系统。

## 测试

`npm test` 覆盖：两节点/三节点首轮手算对照、独立线性方程解对照、全悬挂图、零权边、平行边合并、自环、节点重排不变性、预算耗尽未收敛标记、重启续算等价性、推进失败事务回滚、参数校验错误码、同分稳定破平、贡献三部分守恒。

# bkn-workbuddy

把 OpenBKN 业务上下文接入 [WorkBuddy](https://www.workbuddy.cn/)：WorkBuddy 用户可以只读查询自己有权访问的 OpenBKN 业务知识网络，每一轮问答都在 OpenBKN 平台留下可审计的业务溯源（在 OpenBKN Studio 中查看）。

English: [README.md](README.md)。

## 组成

| 路径 | 说明 |
| --- | --- |
| `packages/core` | 纯逻辑：工具契约与指纹、知识网络目录与选择、任务绑定、轮次状态机、生命周期结果、溯源投影、场景包与评测包 |
| `packages/bridge` | WorkBuddy 启动的本地 stdio MCP 服务：任务与一个网络绑定，透传审阅过的 OpenBKN 只读工具，按轮开记录和收尾 |
| `gateway` | 凭证网关（Go，无第三方依赖）：凭证只存在系统凭据库（macOS 钥匙串 / Windows DPAPI），是唯一与平台通信的组件 |
| `scenes`、`schemas`、`eval` | 声明式场景包、JSON Schema、样例网络的评测包 |
| `probes/e2e` | 针对你提供的 OpenBKN 平台运行的实时端到端检查 |

设计与决策：[TECHNICAL_PLAN.md](TECHNICAL_PLAN.md)；当前进度：[docs/STATUS.md](docs/STATUS.md)；连接器市场分发方案：[docs/plans/2026-10-20-marketplace-connector.md](docs/plans/2026-10-20-marketplace-connector.md)。

## 构建与测试

需要 Node.js 20+、Go 1.25+（macOS 上构建网关需要 cgo）。

```bash
npm ci
npm run build
npm test                       # core、bridge 单元测试
(cd gateway && go vet ./... && go test ./...)
node scripts/check-public.mjs  # 公开内容检查，CI 中同样运行
```

实时端到端检查（需要 `openbkn` CLI 已登录同一平台；令牌只经网关进程环境传递）：

```bash
node probes/e2e/bridge-live.mjs --origin https://<你的 OpenBKN> [--ca <私有 CA.pem>]
```

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题见 [SECURITY.md](SECURITY.md)。

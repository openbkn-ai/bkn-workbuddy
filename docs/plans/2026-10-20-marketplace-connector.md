# 方案：无 Hook、可从 WorkBuddy 连接器市场安装的 OpenBKN 连接器

> 日期：2026-10-20。状态：**方案，待确认**，尚未改代码。
> 背景：用户决定统一改为无 Hook，与 bkn-dsh 一致，并以“在 WorkBuddy 连接器市场直接安装”为目标形态。
> 本文取代 TECHNICAL_PLAN §0.12 的“两档记录”：Hook 档不再保留。§0.9 的凭证决定不变：凭证只放在签名网关和系统凭据库里。

依据分类（每条结论都注明属于哪一类）：

- **官方**：WorkBuddy 开放平台与 WorkBuddy Enterprise 的公开文档；
- **本机代码**：只读检查 WorkBuddy 5.8.3 客户端的行为（细节在内部记录中）；
- **本机市场**：本机 `~/.workbuddy/plugins/marketplaces/workbuddy-connector-plugins-official` 中的 432 个连接器；
- **平台代码**：openbkn-ai 下 `bkn-foundry`、`bkn-sdk` 的 main 分支（2026-10-20）；
- **推断**：由以上来源推出，没有实测；
- **未知**：以上来源都没有覆盖。

## 1. 结论

- 连接器市场的包格式只有 `connector-meta.json`、`mcp.json` 或 `cli.json`、图标和 `skills/`，**不能带 Hook**。因此走市场就只能是无 Hook 形态（官方、本机市场）。
- 形态定为：**stdio MCP，通过 `npx` 运行我们发布的 npm 包**（桥接器加签名网关）。表单只收平台地址这类不敏感的配置。**在对话里用设备码登录**，令牌只进网关的系统凭据库，并支持刷新。
- 每轮记录完全由模型负责：`openbkn_begin_turn` 开记录，`openbkn_end_turn` 收尾，与 bkn-dsh 一致。业务溯源统一在 OpenBKN Studio 查看。
- 需要外部配合三件事：OpenBKN 一方注册开放平台开发者；平台预置 WorkBuddy 专用的 OAuth 客户端；确认企业环境能访问 npm 源。
- 发布前必须实测六件事，见第 6 节。其中最关键的两件：Windows 沙箱下能否写数据目录；模型收尾率。

## 2. 已核实的事实

### 2.1 连接器包与本地程序

| 事实 | 依据 |
| --- | --- |
| 两种包型：MCP + Skill（推荐）、CLI + Skill；每个连接器只能配置一个 MCP 服务 | 官方 [连接器开发文档] |
| stdio 用于本地进程，`command` 可为 `npx` / `uvx` / `node`；可声明 `runtime: {type: node}`，由 WorkBuddy 准备托管 Node，npm 全局安装和缓存放在 WorkBuddy 目录；可用 `npmRegistry` 指定镜像（数组形式可回退） | 官方 |
| 要求“不依赖用户系统预装的 Node.js、Python 或全局包”；包和配置里不得写入真实凭证 | 官方 |
| 432 个连接器中，stdio 21 个（`npx` 19 个，含从 gitee 下载的 tgz），streamable-http 333 个，sse 10 个；`cli.json` 57 个，`token-schema.json` 101 个 | 本机市场 |
| `ai-hive`：MCP 用 `npx -y <包>`，登录用同一个包的 `auth` 子命令，与本方案结构相同；`kdocs` 初始化时运行连接器目录里自带的脚本 | 本机市场 |
| 连接器目录里没有任何 `hooks/` | 本机市场（432/432） |

### 2.2 凭证与登录

| 事实 | 依据 |
| --- | --- |
| 令牌表单（`auth_mode: token`）的值“只存在本机 `~/.workbuddy`”，经 `${VAR}` 注入 MCP 的 `env` 或 `headers` | 官方 |
| 表单凭证由 WorkBuddy 在本机加密保存。按我们的评估，它的保护强度低于系统凭据库（钥匙串 / DPAPI），不适合存放 OpenBKN 令牌 | 本机检查（未读取任何值，细节在内部记录中） |
| 同一用户下运行的 Agent 工具能否接触到表单凭证，没有官方说明；我们按“可能接触到”设计 | 推断（已向 WorkBuddy 团队询问） |
| `cli.json` 的 `auth` 由 WorkBuddy 主进程用 shell 启动，**没有任何输入**；普通模式下 10 秒内要输出登录链接，WorkBuddy 拿到链接后会结束登录进程。启用 `authDeviceFlow`（5.0.0 起，RFC 8628，按 `uriPattern` / `codePattern` 识别）或 `authWaitForExit` 时，登录进程最多保留 300 秒 | 官方；本机代码 |
| 登录命令的环境变量只来自 WorkBuddy 自身环境、托管运行时和 `cli.json` 里写死的 `env`，**不包含用户在表单里填的值** | 本机代码 |
| 远程 MCP 的 OAuth 2.1 要求服务端支持动态客户端注册（RFC 7591）和 PKCE | 官方 |
| bkn-safe 只预置固定的几个客户端：`openbkn-sdk`（设备码 + 刷新令牌，公共客户端，scope `openid offline`）、`openbkn-studio`、`openbkn-cli`（授权码 + PKCE）、`ci-runner`；这些是第一方客户端，不显示授权确认页；不提供通用的客户端注册 | 平台代码（`bkn-safe/charts/bkn-safe/values.yaml`、`client-seed-job.yaml`、`server/internal/httpapi/auth.go`） |
| 设备码接口：`POST {origin}/oauth2/device/auth`，轮询 `POST {origin}/oauth2/token`，刷新也用 `/oauth2/token` | 平台代码（`bkn-sdk/src/auth/oauth.ts`） |

### 2.3 上架与分发

| 事实 | 依据 |
| --- | --- |
| 开放平台 2026-09-02 上线；开发者需先通过认证和资质审核，才能接入技能、专家和连接器 | 公开报道 |
| 审核时长：官方文档写“提交后通常 10–15 分钟同步生效”，报道写“约 7 个工作日” | 官方；报道（两者不一致） |
| 文档没有说明第三方连接器能否只对特定企业可见 | 官方（未提及） |
| 企业管理员自建连接器只能填远程 MCP 地址，系统自动生成 Gateway 路由，示例都是公网地址；没有上传连接器包的入口 | 官方 [Connector 管理] |

### 2.4 记录与溯源（已在 TECHNICAL_PLAN §0.12、（内部记录） 第 5 节核实）

- 业务调用必须带有效的交互标识；以 completed 收尾时必须带非空回答。
- 交互租约默认 5 分钟，过期后标为 `abandoned`，不生成企业版历史业务投影。
- Studio 的业务溯源页只在企业版提供，可用 `?conversation_id=&interaction_id=` 直接打开某一轮。

## 3. 目标形态

### 3.1 连接器包

```
openbkn/                         # source: openbkn（以全局唯一为准）
├── connector-meta.json          # type: mcp；auth_mode: token；minWorkbuddyVersion: 5.0.0
├── mcp.json                     # stdio：npx -y @openbkn/workbuddy-connector@<固定版本>
├── ai.workbuddy/token-schema.json   # 只有不敏感字段：平台地址（必填）、业务域（可选，默认 bd_public）
├── icon.svg
└── skills/openbkn/SKILL.md      # 何时选网络、何时开记录和收尾、只读边界、失败处理
```

`mcp.json` 草案：

```json
{
  "mcpServers": {
    "openbkn": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@openbkn/workbuddy-connector@0.1.0", "mcp"],
      "runtime": { "type": "node", "version": "22" },
      "env": { "OPENBKN_URL": "${OPENBKN_URL}", "OPENBKN_BUSINESS_DOMAIN": "${OPENBKN_BUSINESS_DOMAIN}" },
      "timeout": 60000
    }
  }
}
```

- 版本号固定，不用 `@latest`：用户机器上运行的代码要能对应到审核过的版本。
- 不用 `cli.json`：它的登录命令拿不到表单里的平台地址（2.2），而 MCP 服务每个连接器只能有一个。登录改在对话里完成（3.3）。

### 3.2 npm 包

- `@openbkn/workbuddy-connector`：桥接器（零运行时依赖），入口 `mcp`。
- 网关按平台拆成可选依赖：`@openbkn/workbuddy-gateway-darwin-arm64` / `-darwin-x64` / `-win32-x64` / `-win32-arm64`（可选 `-linux-x64`），做法同 esbuild。
- 签名：macOS 用 Developer ID 签名并公证；Windows 用 Authenticode。360 删除未签名 exe 的问题依然存在（R0b-W）。npm 安装的文件不带下载隔离标记，所以 macOS 上不会触发首次打开的拦截，但这一点要实测。
- 数据目录：`~/.bkn-workbuddy`（任务状态、网关配置、Windows 的 DPAPI 凭证文件）。macOS 凭证存钥匙串（现有实现）。

### 3.3 配置与登录

1. 用户在市场点“连接”，表单填平台地址（例如 `https://bkn.example.com`），没有任何秘密字段。
2. MCP 进程启动后，网关从环境变量读取平台地址，并与 `~/.bkn-workbuddy/gateway.json` 中已登录的平台比对；地址变化就视为未登录。
3. 新增工具 `openbkn_login`：网关向 `{origin}/oauth2/device/auth` 发起设备码登录，工具返回**验证链接和验证码**，模型照原样展示给用户。网关在后台轮询 `/oauth2/token`，拿到令牌后写进系统凭据库。令牌不经过模型、WorkBuddy 和磁盘明文。
4. 网关用刷新令牌自动续期，解决现在“OAuth 令牌约 1 小时过期、网关不续期”的问题。刷新失败返回 `AUTHENTICATION_REQUIRED`，提示用户重新调用 `openbkn_login`。
5. 新增 `openbkn_logout`，清除凭据库里的令牌。
6. 私有 CA：Go 在 macOS 和 Windows 上使用系统的证书信任库，企业把 CA 装进系统即可（推断，需实测）。表单不提供“跳过证书校验”。
7. OAuth 客户端：请平台方预置 WorkBuddy 专用的第一方客户端（暂定 `bkn-workbuddy`，设备码 + 刷新）。平台按“可信应用身份”记录溯源的归属，复用 `openbkn-sdk` 会让这些记录看起来是 SDK 产生的。平台方给出之前，开发和测试暂用 `openbkn-sdk`。

### 3.4 每轮记录（只有模型档）

- 工具：`openbkn_status`、`openbkn_login`、`openbkn_logout`、`openbkn_list_networks`、`openbkn_select_network`、`openbkn_starters`、`openbkn_begin_turn`、`openbkn_end_turn`，加上透传的平台只读工具（D1 白名单）。
- 开记录：本轮没开记录时，业务查询返回 `TURN_NOT_STARTED`。服务说明和技能都要求“需要查询时先调用 `openbkn_begin_turn`”，减少一次被拒。
- 收尾：业务查询结果末尾提示调用 `openbkn_end_turn`。漏掉的轮次，同一任务下一次查询前补记为 failed；之后一直没有查询，则 5 分钟租约到期后被平台标为 `abandoned`。
- 选网络的确认门槛要调整。现在的判断依赖 Hook 记下的用户原话，改为：网络列表必须在更早的一轮给出；或者本轮已经调用过 `openbkn_begin_turn`，且其 `question` 包含网络名称。
- 溯源：企业版查询结果附带 Studio 链接，`openbkn_status` 返回最近两轮的记录状态（现有实现）。

### 3.5 监督边界（与现在相同，全部在桥接器内）

任务与网络一次性绑定；剥掉模型可填的 `kn_id`、`bkn_context`；只读白名单；契约指纹门槛；失败时禁止沿用旧数字。这些对应 bkn-dsh 里 `tools.guard` 承担的部分，WorkBuddy 上由我们自己的 MCP 服务完成，与宿主是否提供 Hook 无关。

## 4. 改动清单

| 类别 | 内容 |
| --- | --- |
| 删除 | `packages/bridge/src/hook.ts`、`hook-settings.ts`；安装器里写 Hook、Hook 运行检查、`hook-stderr` 相关逻辑；core 里从对话记录（transcript）解析回答的部分（如果没有别处使用）；轮次的 `source` 字段与 Hook 档分支；对应测试 |
| 保留并调整 | 会话状态机（只留模型档）；`TURN_NOT_STARTED`；选网络确认门槛（见 3.4）；溯源链接；契约门槛；`answer_rule` |
| 新增：网关 | 设备码登录与轮询；刷新令牌；按平台地址区分登录；平台地址与业务域从环境变量读取；`login.start` / `login.poll` / `logout` 三个操作 |
| 新增：桥接器 | `openbkn_login`、`openbkn_logout`；读取环境变量里的配置；登录状态写进 `openbkn_status` |
| 新增：打包 | npm 主包与四个平台子包；签名流水线（macOS 公证、Windows Authenticode）；连接器包四个文件和技能 |
| 安装器 | 不再是用户必经的步骤。保留 `doctor`（诊断）和 `uninstall --purge`（清理数据目录和凭证），可以作为 npm 包的子命令 |
| 文档 | TECHNICAL_PLAN 新增 §0.13，取代 §0.12 的两档；STATUS；验收交接按市场形态重写；（内部记录） 中已由文档回答的问题标注答案 |

## 5. 需要外部配合

| 事项 | 找谁 | 为什么 |
| --- | --- | --- |
| 注册开放平台开发者账号，完成资质审核 | OpenBKN 产品方 | 上架的前提 |
| 预置 WorkBuddy 专用的第一方 OAuth 客户端（设备码 + 刷新） | 平台（bkn-safe） | 溯源记录归属正确；不复用 SDK 的身份 |
| 能否只对授权企业可见、能否私有发布 | WorkBuddy | 文档未说明；影响是公开上架还是定向发布 |
| 内网或离线企业怎样获取 npm 包（`npmRegistry` 指向企业私有源，还是离线包） | 客户与 WorkBuddy | 完全离线时 `npx` 装不上 |
| macOS Developer ID、Windows 代码签名证书 | OpenBKN 产品方 | 网关二进制必须签名 |

## 6. 实测计划（开发前后都要做）

| 编号 | 内容 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T1 | 市场形态的安装与连接 | 照 R0c-W 的做法，在本地自建市场装入连接器包（macOS、Windows 各一次）；表单填平台地址 | 托管 Node 启动 `npx` 包；MCP 连接成功；工具列表正确 |
| T2 | Windows 沙箱写入 | MCP 进程在 `~/.bkn-workbuddy` 下创建、改写和重命名任务状态文件 | 都成功；否则改用沙箱可写的位置，例如 `~/.workbuddy/plugins/data/<id>`（R0c-W 证实沙箱内可读），并重新验证 |
| T3 | 对话内设备码登录 | 调用 `openbkn_login`，用户在浏览器批准 | 令牌进入凭据库；完全重启后仍然有效；刷新令牌能续期；模型输出和日志里没有令牌 |
| T4 | 私有 CA | EE 测试平台 和 CE 测试平台 的 CA 装进系统信任库，网关不配 `caFile` | TLS 校验通过；卸载 CA 后返回 `CERTIFICATE_ERROR` |
| T5 | 模型收尾率 | 按 A、E 段用例完整走一遍，统计 begin/end 的调用率、补记 failed 和 abandoned 的比例 | 先只记录数字；目标值由用户定（建议 95%） |
| T6 | 签名与杀毒 | 360 环境下通过 npm 安装签名后的网关 | 不被删除、不被拦截 |

## 7. 风险

1. **收尾率（最大风险）。** macOS 验收中，模型每一轮都没有按说明调用 `openbkn_evidence`，那是同一类“回答前先调用某个工具”的要求。如果收尾率低，企业版证据链会有大量轮次没有问答。MCP 拿不到最终回答，桥接器无法替模型补上。能做的只有两件：加强技能和工具结果里的提示；接受这个限制并写进发布说明（bkn-dsh 也是这样）。
2. **取消识别不到。** 用户中途停止，这一轮最后记为 failed 或 abandoned，不会是 cancelled。
3. **重复输出。** `end_turn` 要先提交一遍完整回答，长回答的输出量和耗时约翻倍。
4. **依赖 npm 源。** 首次连接时下载；内网或离线环境需要私有源。
5. **上架不确定。** 资质审核、审核时长、能否定向可见都不明确。
6. **平台版本差异。** 设备码接口、客户端预置以 main 分支为准；部署在客户处的 0.2.0 是否一致，要在 T3 中确认。

## 8. 建议顺序

1. **准备（不改代码）：** 发起第 5 节的外部事项。先做 T1、T2 的最小探针：一个只回显的 stdio npm 包，用本地市场装入，在 macOS 和 Windows 上验证安装和沙箱读写。
2. **开发（探针通过后）：**
   - 网关：设备码登录、刷新、从环境变量读配置；
   - 桥接器：去掉 Hook 档，加上登录工具，调整确认门槛；
   - 打包：npm 主包与平台子包、连接器包、技能。
3. **验收：** T3–T6，以及按市场形态重写的 A、E 段用例。
4. **上架：** 签名、提交审核、发布说明（写清收尾率和取消的限制）。

## 9. 与现有决定的关系

| 决定 | 变化 |
| --- | --- |
| §0.9 凭证只放签名网关 + 系统凭据库 | 不变；登录方式从“终端里粘贴令牌”改为设备码 |
| §0.12 两档记录 | Hook 档取消，只留模型档 |
| D3（只能做到“每次检索”级时不发布业务发行版） | 不变；模型档是按轮记录，不属于 C 路线 |
| 开发包 `-4` 与现有的宿主验收交接 | 作废；验收改按本方案第 6 节 |
| WorkBuddy 提问清单 | B9、C10、C11、D16 已由文档基本回答；C12（浏览器登录）有了替代方案（设备码）；A 组（每轮事件、Hook）不再影响上线 |

## 来源

- [连接器开发文档（WorkBuddy 开放平台）][连接器开发文档]
- [Connector 管理（WorkBuddy Enterprise，腾讯云）][Connector 管理]
- [连接器（WorkBuddy Enterprise，腾讯云）](https://cloud.tencent.com/document/product/1831/134525)
- [手把手教你，接入 WorkBuddy 开放平台（腾讯新闻）](https://news.qq.com/rain/a/20260902A0DOKE00)
- [腾讯 WorkBuddy 开放平台上线（OpenAI Hub）](https://www.openai-hub.com/news/1859/)
- 本机：WorkBuddy 5.8.3 客户端（只读检查，细节在内部记录中）
- 平台：`bkn-foundry/bkn-safe`（客户端预置）、`bkn-sdk/src/auth/oauth.ts`（设备码流程）

[连接器开发文档]: https://open.workbuddy.cn/docs/connector
[Connector 管理]: https://cloud.tencent.com/document/product/1831/134453

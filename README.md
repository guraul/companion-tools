# companion-tools

companion（agent-mobile 手机端）用的 **opencode v2 只读工具插件**。

- `assignment_history` —— 经 BFF 新增内部端点读取 companion 责任（assignment）历史（施工卡：agent-mobile#60 DoD3）
- `project_sessions` —— 经 BFF 内部端点列举 **chatcode 侧**项目会话（只读；伴侣聊天会话不展示）
- `today_brief` —— 经 BFF 内部聚合端点拿「今天」的全貌（未处理事项 / 执行摘要 / 日历 / 会议 / 补跑报告），压成 ≤8 行短文本
- `session_status` —— 进程内读会话/进程状态（`ctx.session.context` + `ctx.storage`）（施工卡：agent-mobile#61）；显式 `sessionId` 只允许 chatcode 侧

> **当前状态：切片 3.2 已合 main（`today_brief`，Ref #153）**。
> `assignment_history` / `project_sessions` / `today_brief` 需要一份可选配置（见下），
> 未配置时返回中文提示而非报错。

## 配置（可选）

`assignment_history` / `project_sessions` / `today_brief` 的 BFF 地址与 token 来自 `~/.config/opencode/companion-tools.json`（**文件可缺省**）：

```json
{
  "bffBase": "http://127.0.0.1:19234",
  "token": "<内部 token>",
  "excludedDirectories": ["/root/project", "/root/project/homebase"]
}
```

| 键 | 必填 | 说明 |
|----|------|------|
| `bffBase` | 是 | BFF 地址（只来自配置，代码里不写死生产地址） |
| `token` | 是 | 内部只读 token（`x-internal-token`），由 homebase 侧投放 |
| `excludedDirectories` | 否 | **视为「非项目会话」的目录表**，默认 `["/root/project", "/root/project/homebase"]`（`DEFAULT_EXCLUDED_DIRECTORIES`）。精确匹配、尾斜杠等价；配了它**整体替换**默认值（想让 `/root/project` 重新算项目会话就写别的表，写 `[]` 表示不排除任何目录） |

- 缺文件 / 非法 JSON / 缺任一键 → 工具返回「未配置 BFF 地址或 token」中文提示，**不抛错**。
- `excludedDirectories` **非法（非数组 / 含非字符串）时只忽略该字段**（走默认值），不会让整份配置失败。
- 默认值是**生产机布局**（App 聊天会话落 `/root/project`，伴侣大本营是 `/root/project/homebase`）；
  本机 / 别的部署若聊天会话落在别处，按实际目录改写这一项即可——不需要改代码。
- 地址一律来自配置，代码里**不写死任何生产地址**（默认值是注释里的示例）。
- 测试可用 `COMPANION_TOOLS_CONFIG` 覆盖配置路径。
- token 由 homebase 侧投放（`INTERNAL_READ_TOKEN`，见 homebase OPERATIONS），本仓不持有。

## 工具

| 工具 | 说明 | 只读方式 |
|------|------|----------|
| `assignment_history` | 责任（assignment）历史执行记录；responsibility 模糊 / assignmentId 精确 | HTTP 调 homebase `GET /api/internal/assignment-history`（x-internal-token） |
| `project_sessions` | chatcode 侧项目会话列表（id · 标题 · 目录 · 更新时间，最近更新在前）；`projectPath` 可选过滤 | HTTP 调 homebase `GET /api/internal/project-sessions`（x-internal-token） |
| `today_brief` | 今天的全貌：未处理事项（open Attention）、执行摘要（assignment-runtime 计数）、日历（今天剩余日程）、会议（今天剩下的 one-shot 责任）、补跑报告（未过期 retry-report）；压成 ≤8 行短文本 | HTTP 调 homebase `GET /api/internal/today-brief`（x-internal-token） |
| `session_status` | 会话标题、目录、消息数、最近几条 user/assistant 文本摘要 | 进程内 `ctx.session.context` + `ctx.session.get` |

四个工具都声明 `options: { codemode: false }`：本机 companion 白名单没有 `execute` 的 allow，
不声明则宿主会要求走 code-mode 包装，工具将**彻底不可达**（memx 已踩过此坑）。

### 范围约束：只读 chatcode 侧

伴侣聊天（chat）会话的判定与 agent-mobile `agent-mobile-app/src/services/conversation-kind.ts`
的 `resolveConversationKind` 一致（常量值**抄写**在本仓 `src/core/project-sessions.ts`，**不跨仓 import**）：

- `directory` 为空 / `"/"` / **在排除目录表里**（默认 `/root/project` 与伴侣大本营 `/root/project/homebase`）→ **chat 侧**（不展示、不读取）
- 其余目录 → **chatcode 侧**（项目会话，可展示）；`/root/project/<repo>` 这类**子目录**仍是项目侧（精确匹配，不做前缀判断）

> **为什么必须排除 `/root/project`（issue #11）**：App 建**聊天**会话时传 `directory: "/"`，服务端把
> 它落成自己的 cwd `/root/project`；工程会话在它的**子目录**里。只排除伴侣大本营的话，
> `agent` 缺失的旧聊天会话会漏进「项目进展」（生产实测 20 条里 5 条是聊天）。排除表可用
> 配置项 `excludedDirectories` 改写（见上），代码里不再写死。

约束在**插件侧**兜底执行（服务端 `project-sessions` 端点本身不做 chat/project 区分）：

- `project_sessions`：响应里即使混入 chat 侧会话也会被剔除；目录比较会先归一尾斜杠（`/repo/` ≡ `/repo`）；
  排除表取自配置（缺省 `DEFAULT_EXCLUDED_DIRECTORIES`）；`agent === "companion"` 的排除作为**第二道**判据保留。
- `session_status`：**缺省（当前会话）放行**；显式 `sessionId` 时用 `ctx.session.get` 取目录——
  chat 侧 → 拒绝并说明原因；**目录取不到 → 保守拒绝**（无法判断范围就不放行）。
  这里用**默认**排除表（不读配置）：读取会话状态不该因为缺配置而不可用。

**分页顺序（issue #9）**：BFF 先按 `limit` 截断、插件后过滤，所以 `project_sessions` 请求时**多取**——
`fetchLimit = min(20, max(limit * 3, limit))`（BFF 上限 20），拿到响应后先过滤 chat 侧，再截断到用户
`limit`。`truncated` = 服务端截断 **或** 过滤后条数超过 `limit`，两种情况末尾都会提示「更早的会话已截断」。
这样最近活动全是聊天时，也不会一页只剩 1–2 条。

**生产生效前提（切片 4）**：① homebase 部署含 `GET /api/internal/project-sessions` 的版本并投放
`INTERNAL_READ_TOKEN`；② 本插件安装/更新到宿主；③ companion agent 的 tools 白名单加入
`project_sessions`（否则工具虽注册但不可调用）；④ 重启 opencode 宿主（插件在启动时一次性加载）。

**时间字段契约（issue #3）**：与 BFF 交换的时间字段（`occurredAt` / `activatedAt` / `updatedAt`）一律是 **epoch 毫秒 number**（来源 opencode `session.time.updated` / homebase `product_events.occurred_at`，13 位），**不是 ISO 字符串**；测试 fixture 必须用真实契约类型，**禁止用 ISO 字符串自造契约**（否则漏测）。

## 安装

```bash
bash install.sh            # 仓 → 依赖 → 插件入口 → 依赖自愈
systemctl restart opencode-4096    # 宿主启动时一次性加载插件（生产宿主机）
tail -n 20 ~/.opencode/companion-tools.log   # 每条 = 一次宿主启动装载
```

可选：`bash install.sh /path/to/checkout` 指定检出路径（默认 `~/workspace/companion-tools`）。

安装脚本是**非破坏式**的：只往 `~/.config/opencode/package.json` 合并缺的依赖（既有键、别的插件的依赖一律不动），
只写自己的入口 `~/.config/opencode/plugins/companion-tools.ts`，且可重复执行（幂等）。

环境变量：`COMPANION_TOOLS_LOG` 覆盖装载日志路径（测试用）；`COMPANION_TOOLS_SKIP_SYNC=1` 跳过仓同步与 `pnpm install`。

## 回滚

```bash
rm ~/.config/opencode/plugins/companion-tools.ts
systemctl restart opencode-4096
```

插件无状态、不写任何业务数据，删除入口 + 重启即彻底移除。

## 开发

```bash
pnpm install
pnpm exec tsc --noEmit   # 类型检查
pnpm test                # vitest（纯函数单测 + 工具接线集成 + 插件壳结构 / 入口红线 / install.sh 非破坏式与幂等）
```

红线（与 memx 的宿主入口红线同源）：

1. `src/hosts/opencode/index.ts` **只 export default**，任何命名导出都会让宿主 crash（`plugin config hook failed`）；
   `~/.config/opencode/plugins/companion-tools.ts` 只 re-export default。
2. 四个工具都是**只读**的：不写库、不触发 BFF 副作用、不写文件；工具内错误一律吞掉转中文文本。
3. `setup` 内所有副作用 try-catch，错误绝不抛回宿主。
4. 工具必须声明 `options: { codemode: false }`，否则本机白名单下不可达。

## 切片计划

| 切片 | 内容 | 状态 |
|------|------|------|
| 1 | 仓骨架 + 安装/回滚 + 门禁（**不含任何工具**） | 已合 main |
| 2 | 注册 `assignment_history` / `session_status`（含 BFF 内部端点对接 + 纯函数下沉） | 已合 main |
| 3 | `project_sessions`（BFF `project-sessions` 端点对接）+ `session_status` 只读 chatcode 侧范围约束 | 已合 main |
| 3.1 | 范围判据修正：排除 `/root/project`（聊天会话落点）+ 排除目录配置化 `excludedDirectories`（issue #11） | 已合 main |
| 3.2 | `today_brief`（BFF `today-brief` 聚合端点对接；五段压成 ≤8 行，全空明说「今天没有待处理的事」） | 本次 PR（Ref #153） |
| 4 | 生产安装（端点投放 + token + 工具白名单 + 重启窗口） | 待做 |

首建 scaffold 直推 `main`；**之后的任何改动一律走 PR**（勿直推）。

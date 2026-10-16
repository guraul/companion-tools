# companion-tools

companion（agent-mobile 手机端）用的 **opencode v2 只读工具插件**。

- `assignment_history` —— 经 BFF 新增内部端点读取 companion 责任（assignment）历史（施工卡：agent-mobile#60 DoD3）
- `session_status` —— 进程内读会话/进程状态（`ctx.session.context` + `ctx.storage`）（施工卡：agent-mobile#61）

> **当前状态：切片 2**。插件可安装、可被宿主加载，并已注册两个只读工具。
> `assignment_history` 需要一份可选配置（见下），未配置时返回中文提示而非报错。

## 配置（可选）

`assignment_history` 的 BFF 地址与 token 来自 `~/.config/opencode/companion-tools.json`（**文件可缺省**）：

```json
{ "bffBase": "http://127.0.0.1:19234", "token": "<内部 token>" }
```

- 缺文件 / 非法 JSON / 缺任一键 → 工具返回「未配置 BFF 地址或 token」中文提示，**不抛错**。
- 地址一律来自配置，代码里**不写死任何生产地址**（默认值是注释里的示例）。
- 测试可用 `COMPANION_TOOLS_CONFIG` 覆盖配置路径。
- token 由 homebase 侧投放（`INTERNAL_READ_TOKEN`，见 homebase OPERATIONS），本仓不持有。

## 工具

| 工具 | 说明 | 只读方式 |
|------|------|----------|
| `assignment_history` | 责任（assignment）历史执行记录；responsibility 模糊 / assignmentId 精确 | HTTP 调 homebase `GET /api/internal/assignment-history`（x-internal-token） |
| `session_status` | 会话标题、目录、消息数、最近几条 user/assistant 文本摘要 | 进程内 `ctx.session.context` + `ctx.session.get` |

两个工具都声明 `options: { codemode: false }`：本机 companion 白名单没有 `execute` 的 allow，
不声明则宿主会要求走 code-mode 包装，工具将**彻底不可达**（memx 已踩过此坑）。

**时间字段契约（issue #3）**：与 BFF 交换的时间字段（`occurredAt` / `activatedAt`）一律是 **epoch 毫秒 number**（来源 homebase `product_events.occurred_at`，13 位），**不是 ISO 字符串**；测试 fixture 必须用真实契约类型，**禁止用 ISO 字符串自造契约**（否则漏测）。

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
2. 两个工具都是**只读**的：不写库、不触发 BFF 副作用、不写文件；工具内错误一律吞掉转中文文本。
3. `setup` 内所有副作用 try-catch，错误绝不抛回宿主。
4. 工具必须声明 `options: { codemode: false }`，否则本机白名单下不可达。

## 切片计划

| 切片 | 内容 | 状态 |
|------|------|------|
| 1 | 仓骨架 + 安装/回滚 + 门禁（**不含任何工具**） | 已合 main |
| 2 | 注册 `assignment_history` / `session_status`（含 BFF 内部端点对接 + 纯函数下沉） | 本次 |
| 3 | 生产安装（token 投放 + 重启窗口 + 生产白名单） | 待做 |

首建 scaffold 直推 `main`；**之后的任何改动一律走 PR**（勿直推）。

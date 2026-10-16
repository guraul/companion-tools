# companion-tools

companion（agent-mobile 手机端）用的 **opencode v2 只读工具插件**。

- `assignment_history` —— 经 BFF 新增内部端点读取 companion 责任（assignment）历史（施工卡：agent-mobile#60 DoD3）
- `session_status` —— 进程内读会话/进程状态（`ctx.session.context` + `ctx.storage`）（施工卡：agent-mobile#61）

> **当前状态：切片 1（骨架）**。插件可安装、可被宿主加载，但**还没有注册任何工具** ——
> 两个工具在切片 2 实现，注册点已在 `src/hosts/opencode/index.ts` 里以注释形式留好。

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
pnpm test                # vitest（插件壳结构 / 入口红线 / install.sh 非破坏式与幂等）
```

红线（与 memx 的宿主入口红线同源）：

1. `src/hosts/opencode/index.ts` **只 export default**，任何命名导出都会让宿主 crash（`plugin config hook failed`）；
   `~/.config/opencode/plugins/companion-tools.ts` 只 re-export default。
2. 两个工具都是**只读**的：不写库、不触发 BFF 副作用。
3. `setup` 内所有副作用 try-catch，错误绝不抛回宿主。

## 切片计划

| 切片 | 内容 | 状态 |
|------|------|------|
| 1 | 仓骨架 + 安装/回滚 + 门禁（**不含任何工具**） | 本次 |
| 2 | 注册 `assignment_history` / `session_status`（含 BFF 内部端点对接） | 待做 |

首建 scaffold 直推 `main`；**之后的任何改动一律走 PR**（勿直推）。

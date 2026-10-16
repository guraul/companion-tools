// companion-tools · opencode v2 插件壳
//
// 切片 1（本文件当前内容）：**只做骨架，不注册任何工具**。
// 切片 2 才实现的两个只读工具（施工卡：agent-mobile#60 DoD3 / agent-mobile#61）：
//   - assignment_history  → 经 BFF 新增内部端点读取（跨越进程，走 HTTP）
//   - session_status      → 进程内 ctx.session.context + ctx.storage
//
// 红线（与 memx/AGENTS.md 的宿主入口红线同源）：
//   本文件**只 export default 插件**。多导出任何命名符号（函数/常量/类型值）都会被宿主
//   当插件对象去调用而 crash（宿主报 `plugin config hook failed`）。
//   ~/.config/opencode/plugins/companion-tools.ts 同理只 re-export default。
// 纪律：setup 内所有副作用 try-catch，错误绝不抛回宿主。
import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 装载痕迹落盘位置（可用 COMPANION_TOOLS_LOG 覆盖，测试用 tmp 路径，避免污染真实 HOME）。
const LOG_FILE = process.env.COMPANION_TOOLS_LOG ?? join(homedir(), ".opencode", "companion-tools.log");
// 宿主 storage 键前缀：切片 2 的诊断也共用此前缀。
const STORAGE_PREFIX = "companion-tools:";

export default Plugin.define({
  id: "companion-tools",
  async setup(ctx) {
    // ---- 切片 1 唯一副作用：最小可见痕迹（一行日志 + storage 装载计数）----
    // 为什么要有：插件是被宿主在启动时一次性加载的目录扫描件，本地安装演练
    // （install.sh）之后需要一条能证明"确实被加载"的痕迹，而不是去猜宿主的清单。
    try {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] loaded id=companion-tools pid=${process.pid} dir=${ctx.location.directory ?? "-"}\n`,
      );
    } catch {
      // trace must never escape
    }

    try {
      const key = `${STORAGE_PREFIX}loads`;
      const prev = (await ctx.storage.get(key)) as number | undefined;
      await ctx.storage.set(key, (typeof prev === "number" ? prev : 0) + 1);
      await ctx.storage.set(`${STORAGE_PREFIX}load`, {
        at: new Date().toISOString(),
        directory: ctx.location.directory ?? "",
      });
    } catch {
      // trace must never escape
    }

    // ---- 切片 2 的注册点（本切片刻意不实现）----
    // 只读工具，签名如下（最终形态，届时用真实现替换本注释）：
    //
    //   await ctx.tool.transform((editor) => {
    //     editor.add({
    //       name: "assignment_history",
    //       description: "读取 companion 责任（assignment）的历史记录（只读，经 BFF 内部端点）",
    //       input: { type: "object", properties: { /* 过滤条件 */ }, required: [] },
    //       async execute(args, toolCtx) { /* BFF 只读查询 → 文本结果 */ },
    //     });
    //     editor.add({
    //       name: "session_status",
    //       description: "读取当前会话/进程状态（只读，进程内 ctx.session.context + ctx.storage）",
    //       input: { type: "object", properties: {}, required: [] },
    //       async execute(_args, toolCtx) { /* 进程内读取 → 文本结果 */ },
    //     });
    //   });
    //
    // 纪律：两个工具都**只读**——不写库、不触发 BFF 副作用；工具内错误一并吞掉并返回文本结果。

    return () => {
      // 切片 2：清理（定时器/缓存）放这里；切片 1 无状态，故为空实现。
      // 宿主约定：cleanup 为 () => Promise<void> | void，且绝不允许抛错。
    };
  },
});

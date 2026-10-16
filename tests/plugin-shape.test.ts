// 切片 2 门禁：插件壳的**结构**、两条入口红线，以及「两个工具都被注册且声明 codemode:false」。
// 为什么用动态 import：装载痕迹的落盘路径在模块加载时就确定了，
// 测试必须先把 COMPANION_TOOLS_LOG 指到 tmp 路径再加载模块，否则会污染真实 HOME。
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeHost } from "./helpers/fake-host.ts";

type LoosePlugin = {
  readonly id: string;
  readonly setup: (ctx: unknown) => Promise<unknown> | unknown;
};

let mod: Record<string, unknown>;
let plugin: LoosePlugin;
let logFile: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-tools-shape-"));
  logFile = join(dir, "companion-tools.log");
  process.env.COMPANION_TOOLS_LOG = logFile;
  // 配置指到不存在的路径：本用例不测工具行为，避免读到开发机真实配置。
  process.env.COMPANION_TOOLS_CONFIG = join(dir, "companion-tools.json");
  mod = (await import("../src/hosts/opencode/index.ts")) as Record<string, unknown>;
  plugin = mod.default as LoosePlugin;
});

describe("插件壳结构", () => {
  it("宿主入口红线：模块只 export default，没有任何命名导出", () => {
    expect(Object.keys(mod)).toEqual(["default"]);
  });

  it("Plugin.define 结构成立：id 为 companion-tools，setup 是函数", () => {
    expect(plugin.id).toBe("companion-tools");
    expect(typeof plugin.setup).toBe("function");
  });

  it("setup 写一行装载日志 + storage 计数，并返回 cleanup", async () => {
    const host = createFakeHost();

    const cleanup = await plugin.setup(host.ctx);

    const log = readFileSync(logFile, "utf-8");
    expect(log.split("\n").filter((l) => l.length > 0).length).toBe(1);
    expect(log).toMatch(/\] loaded id=companion-tools pid=\d+ dir=\/tmp\/companion-tools-test\n$/);

    expect(host.store.get("companion-tools:loads")).toBe(1);
    expect(host.store.get("companion-tools:load")).toMatchObject({ directory: "/tmp/companion-tools-test" });

    expect(typeof cleanup).toBe("function");
    expect(() => (cleanup as () => void)()).not.toThrow();
  });

  it("切片 2 注册两个只读工具：assignment_history 与 session_status", async () => {
    const host = createFakeHost();

    await plugin.setup(host.ctx);

    expect(host.state.transformCalls).toBe(1);
    expect([...host.tools.keys()].sort()).toEqual(["assignment_history", "session_status"]);
    for (const tool of host.tools.values()) {
      expect(typeof tool.execute).toBe("function");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("反证锚点：两个工具都必须声明 options.codemode === false", async () => {
    const host = createFakeHost();

    await plugin.setup(host.ctx);

    expect(host.tools.get("assignment_history")?.options).toEqual({ codemode: false });
    expect(host.tools.get("session_status")?.options).toEqual({ codemode: false });
  });
});

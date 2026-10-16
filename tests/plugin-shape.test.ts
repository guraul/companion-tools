// 切片 1 门禁：插件壳的**结构**与两条入口红线。
// 为什么用动态 import：装载痕迹的落盘路径在模块加载时就确定了，
// 测试必须先把 COMPANION_TOOLS_LOG 指到 tmp 路径再加载模块，否则会污染真实 HOME。
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  mod = (await import("../src/hosts/opencode/index.ts")) as Record<string, unknown>;
  plugin = mod.default as LoosePlugin;
});

/** 只实现 setup 真正用到的面：location + storage（其余留空，够用即可）。 */
function fakeCtx(store: Map<string, unknown>): { ctx: unknown; transforms: number } {
  const state = { transforms: 0 };
  const ctx = {
    location: { directory: "/tmp/companion-tools-test" },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      remove: async (key: string) => {
        store.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    session: { context: async () => [] },
    tool: {
      transform: async () => {
        state.transforms++;
        return { dispose: async () => {} };
      },
    },
  };
  return {
    ctx,
    get transforms() {
      return state.transforms;
    },
  };
}

describe("插件壳结构（切片 1）", () => {
  it("宿主入口红线：模块只 export default，没有任何命名导出", () => {
    expect(Object.keys(mod)).toEqual(["default"]);
  });

  it("Plugin.define 结构成立：id 为 companion-tools，setup 是函数", () => {
    expect(plugin.id).toBe("companion-tools");
    expect(typeof plugin.setup).toBe("function");
  });

  it("setup 只做最小可见痕迹：写一行日志 + storage 计数，并返回 cleanup", async () => {
    const store = new Map<string, unknown>();
    const fake = fakeCtx(store);

    const cleanup = await plugin.setup(fake.ctx);

    const log = readFileSync(logFile, "utf-8");
    expect(log.split("\n").filter((l) => l.length > 0).length).toBe(1);
    expect(log).toMatch(/\] loaded id=companion-tools pid=\d+ dir=\/tmp\/companion-tools-test\n$/);

    expect(store.get("companion-tools:loads")).toBe(1);
    expect(store.get("companion-tools:load")).toMatchObject({ directory: "/tmp/companion-tools-test" });

    expect(typeof cleanup).toBe("function");
    expect(() => (cleanup as () => void)()).not.toThrow();
  });

  it("切片 1 不注册任何工具：setup 期间不触碰 ctx.tool.transform", async () => {
    const store = new Map<string, unknown>();
    const fake = fakeCtx(store);

    await plugin.setup(fake.ctx);

    expect(fake.transforms).toBe(0);
  });
});

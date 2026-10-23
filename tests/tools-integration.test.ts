// 集成型用例：走 setup → 拿到注册的工具 → 直接调 execute（fetch 用 mock）。
// 覆盖「工具真的接线到纯函数」这一段，顺带做 codemode:false 的存在性断言。
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeHost, fakeToolContext, type FakeHost } from "./helpers/fake-host.ts";
import type { RegisteredTool } from "./helpers/fake-host.ts";

type LoosePlugin = {
  readonly id: string;
  readonly setup: (ctx: unknown) => Promise<unknown> | unknown;
};

let plugin: LoosePlugin;
let configPath: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "companion-tools-integ-"));
  configPath = join(dir, "companion-tools.json");
  process.env.COMPANION_TOOLS_LOG = join(dir, "companion-tools.log");
  process.env.COMPANION_TOOLS_CONFIG = configPath;
  const mod = (await import("../src/hosts/opencode/index.ts")) as Record<string, unknown>;
  plugin = mod.default as LoosePlugin;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(configPath, { force: true });
  vi.unstubAllGlobals();
});

async function setup(): Promise<{ host: FakeHost; tool: (name: string) => RegisteredTool }> {
  const host = createFakeHost();
  await plugin.setup(host.ctx);
  return {
    host,
    tool: (name: string) => {
      const tool = host.tools.get(name);
      if (tool === undefined) throw new Error(`tool not registered: ${name}`);
      return tool;
    },
  };
}

describe("assignment_history · execute 完整路径（mock fetch）", () => {
  it("无配置 → 未配置中文提示，且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("assignment_history").execute({ responsibility: "房租" }, fakeToolContext());

    expect(String(result.content)).toContain("未配置 BFF 地址或 token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("两参都不给 → 参数提示，且不发请求（即使已配置）", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("assignment_history").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("至少给出 responsibility");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("limit 越界 → 参数提示，且不发请求", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("assignment_history").execute({ responsibility: "房租", limit: 99 }, fakeToolContext());

    expect(String(result.content)).toContain("limit 必须是");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("命中 → 请求 URL/鉴权头正确，响应转中文文本", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234/", token: "tok" }));
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          matched: [{ id: "asg_1", responsibility: "交房租", state: "active" }],
          // 契约：homebase product_events.occurred_at = 13 位 epoch 毫秒 number
          history: [{ occurredAt: 1790845200000, label: "执行", status: "succeeded", id: "h1" }],
          ambiguous: false,
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("assignment_history").execute(
      { responsibility: "房租", limit: 3 },
      fakeToolContext(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; signal: AbortSignal }];
    expect(url).toBe("http://127.0.0.1:19234/api/internal/assignment-history?responsibility=%E6%88%BF%E7%A7%9F&limit=3");
    expect(init.headers["x-internal-token"]).toBe("tok");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(result.content)).toContain("匹配到 1 条责任");
    expect(String(result.content)).toContain("交房租");
    // epoch 毫秒按固定 UTC+8 渲染（issue #3）
    expect(String(result.content)).toContain("2026-10-01 17:00");
  });

  it("401 → 中文 token 提示，绝不抛", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "wrong" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })));
    const { tool } = await setup();

    const result = await tool("assignment_history").execute({ assignmentId: "asg_1" }, fakeToolContext());

    expect(String(result.content)).toContain("token 未配置或值不正确");
  });

  it("网络错 → 中文提示，绝不抛", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { tool } = await setup();

    const result = await tool("assignment_history").execute({ responsibility: "房租" }, fakeToolContext());

    expect(String(result.content)).toContain("无法连接 BFF");
  });
});

describe("session_status · execute 完整路径（进程内）", () => {
  it("返回标题与消息数；不依赖 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { host, tool } = await setup();
    host.setMessages([
      { id: "m1", type: "user", text: "你好" },
      { id: "m2", type: "assistant", content: [{ type: "text", text: "你好呀" }] },
    ]);
    host.setSessionInfo({ id: "ses_current", title: "陪聊会话", location: { directory: "/tmp/x" } });

    const result = await tool("session_status").execute({}, fakeToolContext("ses_current"));

    expect(String(result.content)).toContain("标题：陪聊会话");
    expect(String(result.content)).toContain("消息数：2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sessionId 覆盖生效", async () => {
    const { tool } = await setup();
    const result = await tool("session_status").execute({ sessionId: "ses_other" }, fakeToolContext("ses_current"));
    expect(String(result.content)).toContain("ID：ses_other");
  });

  it("context 取不到 → 中文提示，绝不抛", async () => {
    const { host, tool } = await setup();
    host.ctx.session = {
      context: async () => {
        throw new Error("no session");
      },
      get: async () => ({}),
    };

    const result = await tool("session_status").execute({}, fakeToolContext("ses_x"));

    expect(String(result.content)).toContain("读取会话状态失败");
    expect(String(result.content)).toContain("ses_x");
  });

  it("session.get 不可用也不影响（标题/目录退化占位）", async () => {
    const { host, tool } = await setup();
    host.setSessionGetThrows(true);
    host.setMessages([{ id: "m1", type: "user", text: "hi" }]);

    const result = await tool("session_status").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("（无标题）");
    expect(String(result.content)).toContain("消息数：1");
  });
});

describe("project_sessions · execute 完整路径（mock fetch）", () => {
  it("无配置 → 未配置中文提示，且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("未配置 BFF 地址或 token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("参数非法（相对路径 / limit 越界）→ 提示，且不发请求", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const relative = await tool("project_sessions").execute({ projectPath: "repo/a" }, fakeToolContext());
    expect(String(relative.content)).toContain("绝对路径");

    const badLimit = await tool("project_sessions").execute({ limit: 99 }, fakeToolContext());
    expect(String(badLimit.content)).toContain("limit 必须是");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功 → URL/鉴权头正确；只显示 chatcode 侧、按更新时间倒序、截断提示", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234/", token: "tok" }));
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          sessions: [
            { id: "ses_old", title: "旧会话", directory: "/repo/a", updatedAt: 1790845200000 },
            { id: "ses_chat", title: "伴侣陪聊", directory: "/root/project/homebase", updatedAt: 1790845300000 },
            { id: "ses_new", title: "新会话", directory: "/repo/a/", updatedAt: 1790845600000 },
            { id: "ses_root", title: "裸进", directory: "/", updatedAt: 1790845700000 },
          ],
          truncated: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("project_sessions").execute(
      { projectPath: "/repo/a/", limit: 3 },
      fakeToolContext(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; signal: AbortSignal },
    ];
    expect(url).toBe(
      "http://127.0.0.1:19234/api/internal/project-sessions?limit=3&directory=%2Frepo%2Fa",
    );
    expect(init.headers["x-internal-token"]).toBe("tok");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const text = String(result.content);
    expect(text).toContain("ses_new · 新会话 · /repo/a/ · 2026-10-01 17:06");
    expect(text.indexOf("ses_new")).toBeLessThan(text.indexOf("ses_old"));
    expect(text).not.toContain("ses_chat");
    expect(text).not.toContain("伴侣陪聊");
    expect(text).not.toContain("ses_root");
    expect(text).toContain("更早的会话已截断");
  });

  it("空结果 → 明确文案", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ sessions: [], truncated: false }), { status: 200 })),
    );
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("没有找到可展示的项目会话");
  });

  it("401 → 中文 token 提示，绝不抛", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "wrong" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })));
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("token 未配置或值不正确");
  });

  it("网络错 → 中文提示，绝不抛", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("无法连接 BFF");
  });
});

describe("session_status · 范围约束（只读 chatcode 侧）", () => {
  it("缺省（当前会话）放行：即使当前会话是 chat 侧", async () => {
    const { host, tool } = await setup();
    host.setSessionInfo({ id: "ses_current", title: "陪聊", location: { directory: "/" } });
    host.setMessages([{ id: "m1", type: "user", text: "你好" }]);

    const result = await tool("session_status").execute({}, fakeToolContext("ses_current"));

    expect(String(result.content)).toContain("会话状态");
    expect(String(result.content)).toContain("消息数：1");
  });

  it("显式 chat 侧 sessionId → 拒绝（伴侣大本营）", async () => {
    const { host, tool } = await setup();
    host.setSessionInfo({
      id: "ses_chat",
      title: "伴侣",
      location: { directory: "/root/project/homebase" },
    });

    const result = await tool("session_status").execute({ sessionId: "ses_chat" }, fakeToolContext("ses_current"));

    expect(String(result.content)).toContain("拒绝读取会话 ses_chat");
    expect(String(result.content)).toContain("chat");
  });

  it("显式项目侧 sessionId → 放行", async () => {
    const { host, tool } = await setup();
    host.setSessionInfo({
      id: "ses_proj",
      title: "项目会话",
      location: { directory: "/root/project/agent-mobile" },
    });
    host.setMessages([{ id: "m1", type: "user", text: "hi" }]);

    const result = await tool("session_status").execute({ sessionId: "ses_proj" }, fakeToolContext("ses_current"));

    expect(String(result.content)).toContain("会话状态");
    expect(String(result.content)).toContain("ID：ses_proj");
    expect(String(result.content)).toContain("目录：/root/project/agent-mobile");
  });

  it("目录不可得 → 保守拒绝", async () => {
    const { host, tool } = await setup();
    host.setSessionInfo({ id: "ses_no_dir", title: "无目录" });

    const result = await tool("session_status").execute({ sessionId: "ses_no_dir" }, fakeToolContext("ses_current"));

    expect(String(result.content)).toContain("保守拒绝");
  });

  it("session.get 抛错 → 保守拒绝", async () => {
    const { host, tool } = await setup();
    host.setSessionGetThrows(true);

    const result = await tool("session_status").execute({ sessionId: "ses_x" }, fakeToolContext("ses_current"));

    expect(String(result.content)).toContain("保守拒绝");
  });
});

describe("codemode:false 存在性（否则本机白名单下工具彻底不可达）", () => {
  it("三个工具都声明了 options.codemode === false", async () => {
    const { host } = await setup();
    expect(host.tools.get("assignment_history")?.options).toEqual({ codemode: false });
    expect(host.tools.get("project_sessions")?.options).toEqual({ codemode: false });
    expect(host.tools.get("session_status")?.options).toEqual({ codemode: false });
  });
});


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
      "http://127.0.0.1:19234/api/internal/project-sessions?limit=9&directory=%2Frepo%2Fa",
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

  it("agent=companion 的会话被剔除（生产聊天会话目录是 /root/project，目录判据拦不住）", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: "ses_chat_prod",
                title: "伴侣陪聊",
                directory: "/root/project",
                updatedAt: 1790845600000,
                agent: "companion",
              },
              {
                id: "ses_proj",
                title: "修登录",
                directory: "/root/project/agent-mobile",
                updatedAt: 1790845200000,
                agent: "build",
              },
            ],
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({}, fakeToolContext());

    const text = String(result.content);
    expect(text).toContain("ses_proj · 修登录 · /root/project/agent-mobile · 2026-10-01 17:00");
    expect(text).toContain("共 1 条");
    expect(text).not.toContain("ses_chat_prod");
    expect(text).not.toContain("伴侣陪聊");
  });

  // issue #11：App 聊天会话目录 = /root/project（agent 可能缺失），默认排除表必须拦住。
  it("默认排除表：agent 缺失的 /root/project 会话被剔除，子目录会话保留", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessions: [
              { id: "ses_chat_old", title: "简单确认回复", directory: "/root/project", updatedAt: 1790845600000 },
              { id: "ses_chat_old2", title: "要求仅回复ok", directory: "/root/project/", updatedAt: 1790845500000 },
              {
                id: "ses_proj",
                title: "修登录",
                directory: "/root/project/agent-mobile",
                updatedAt: 1790845200000,
                agent: "build",
              },
            ],
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({}, fakeToolContext());

    const text = String(result.content);
    expect(text).toContain("ses_proj · 修登录 · /root/project/agent-mobile · 2026-10-01 17:00");
    expect(text).toContain("共 1 条");
    expect(text).not.toContain("ses_chat_old");
    expect(text).not.toContain("简单确认回复");
  });

  // issue #11：配置 excludedDirectories 生效，且**整体替换**默认值。
  it("配置 excludedDirectories：/tmp/x 被剔除、/root/project 反而保留", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        bffBase: "http://127.0.0.1:19234",
        token: "tok",
        excludedDirectories: ["/tmp/x"],
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessions: [
              { id: "ses_tmp", title: "临时目录聊天", directory: "/tmp/x", updatedAt: 1790845600000 },
              { id: "ses_root_proj", title: "根目录会话", directory: "/root/project", updatedAt: 1790845200000 },
            ],
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({}, fakeToolContext());

    const text = String(result.content);
    expect(text).toContain("ses_root_proj · 根目录会话 · /root/project · 2026-10-01 17:00");
    expect(text).toContain("共 1 条");
    expect(text).not.toContain("ses_tmp");
  });

  it("先多取后截断：limit=3 请求 limit=9，过滤后 5 条仍只展示 3 条并提示截断", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          sessions: [5, 4, 3, 2, 1].map((n) => ({
            id: `ses_${n}`,
            title: `会话${n}`,
            directory: "/root/project/agent-mobile",
            updatedAt: 1790845200000 + n * 1000,
            agent: "build",
          })),
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({ limit: 3 }, fakeToolContext());

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://127.0.0.1:19234/api/internal/project-sessions?limit=9");

    const text = String(result.content);
    expect(text).toContain("共 3 条");
    expect(text).toContain("ses_5");
    expect(text).toContain("ses_3");
    expect(text).not.toContain("ses_2");
    expect(text).toContain("更早的会话已截断");
  });

  it("过滤后 2 条、limit=3、服务端未截断 → 展示 2 条且不提示截断", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessions: [
              { id: "ses_chat", directory: "/root/project", agent: "companion", updatedAt: 1790845400000 },
              { id: "ses_a", title: "A", directory: "/repo/a", updatedAt: 1790845300000 },
              { id: "ses_b", title: "B", directory: "/repo/a", updatedAt: 1790845200000 },
            ],
            truncated: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { tool } = await setup();

    const result = await tool("project_sessions").execute({ limit: 3 }, fakeToolContext());

    const text = String(result.content);
    expect(text).toContain("共 2 条");
    expect(text).toContain("ses_a");
    expect(text).toContain("ses_b");
    expect(text).not.toContain("已截断");
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

describe("today_brief · execute 完整路径（mock fetch）", () => {
  it("无配置 → 未配置中文提示，且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("today_brief").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("未配置 BFF 地址或 token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功 → URL/鉴权头正确，响应压成中文短文", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234/", token: "tok" }));
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          openAttention: {
            count: 1,
            top: [{ id: "att_1", title: "交房租", summary: "本月 5 号到期", createdAt: 1790841600000 }],
          },
          executions: { count: 3, matched: 2, failed: 1 },
          calendar: { count: 1, first: [{ time: "09:00", summary: "周会" }] },
          meetings: { count: 1, items: [{ at: 1790820000000, responsibility: "和设计评审" }] },
          retryReports: [{ text: "2 条失败已重试", createdAt: 1790841600000 }],
          generatedAt: 1790845200000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { tool } = await setup();

    const result = await tool("today_brief").execute({}, fakeToolContext());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; signal: AbortSignal },
    ];
    expect(url).toBe("http://127.0.0.1:19234/api/internal/today-brief");
    expect(init.headers["x-internal-token"]).toBe("tok");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const text = String(result.content);
    expect(text).toContain("未处理 1 件");
    expect(text).toContain("执行 3 次（命中 2 / 失败 1）");
    expect(text).toContain("交房租");
    expect(text).toContain("09:00 周会");
    expect(text).toContain("今天的会议：10:00 和设计评审");
    expect(text).toContain("2 条失败已重试");
    expect(text.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("端点 401 → 中文 token 提示，绝不抛", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "wrong" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })));
    const { tool } = await setup();

    const result = await tool("today_brief").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("401");
    expect(String(result.content)).toContain("token 未配置或值不正确");
  });

  it("全空响应 → 明说今天没有待处理的事", async () => {
    writeFileSync(configPath, JSON.stringify({ bffBase: "http://127.0.0.1:19234", token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            openAttention: { count: 0, top: [] },
            executions: { count: 0, matched: 0, failed: 0 },
            calendar: { count: 0, first: [] },
            retryReports: [],
            generatedAt: 1790845200000,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { tool } = await setup();

    const result = await tool("today_brief").execute({}, fakeToolContext());

    expect(String(result.content)).toBe("今天没有待处理的事。");
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

    const result = await tool("today_brief").execute({}, fakeToolContext());

    expect(String(result.content)).toContain("无法连接 BFF");
  });
});

describe("codemode:false 存在性（否则本机白名单下工具彻底不可达）", () => {
  it("四个工具都声明了 options.codemode === false", async () => {
    const { host } = await setup();
    expect(host.tools.get("assignment_history")?.options).toEqual({ codemode: false });
    expect(host.tools.get("project_sessions")?.options).toEqual({ codemode: false });
    expect(host.tools.get("today_brief")?.options).toEqual({ codemode: false });
    expect(host.tools.get("session_status")?.options).toEqual({ codemode: false });
  });
});


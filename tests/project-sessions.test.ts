import { describe, it, expect } from "vitest";
import { DEFAULT_EXCLUDED_DIRECTORIES } from "../src/core/config.ts";
import {
  COMPANION_HOME_DIRECTORY,
  buildProjectSessionsUrl,
  finalizeSessions,
  formatProjectSessions,
  isProjectDirectory,
  normalizeDirectory,
  parseProjectSessions,
  resolveFetchLimit,
  validateLimit,
  validateProjectSessionsInput,
} from "../src/core/project-sessions.ts";

const HOUR = 1790845200000; // 2026-10-01T09:00:00Z → UTC+8 渲染为 2026-10-01 17:00

function response(sessions: unknown[], truncated = false): unknown {
  return { sessions, truncated };
}

describe("normalizeDirectory", () => {
  it("去空白与尾部斜杠；根目录保持不变", () => {
    expect(normalizeDirectory(" /repo/a/ ")).toBe("/repo/a");
    expect(normalizeDirectory("/repo/a///")).toBe("/repo/a");
    expect(normalizeDirectory("/")).toBe("/");
  });

  it("非字符串 / 空值 → 空串", () => {
    expect(normalizeDirectory(undefined)).toBe("");
    expect(normalizeDirectory(null)).toBe("");
    expect(normalizeDirectory(42)).toBe("");
    expect(normalizeDirectory("   ")).toBe("");
  });
});

describe("isProjectDirectory（chatcode 侧判据）", () => {
  it("普通项目路径（含尾斜杠）→ 项目侧", () => {
    expect(isProjectDirectory("/root/project/agent-mobile")).toBe(true);
    expect(isProjectDirectory("/root/project/agent-mobile/")).toBe(true);
    expect(isProjectDirectory(" /root/project/agent-mobile ")).toBe(true);
  });

  it("空 / 根 / 伴侣大本营（含尾斜杠）→ chat 侧", () => {
    expect(isProjectDirectory("")).toBe(false);
    expect(isProjectDirectory(undefined)).toBe(false);
    expect(isProjectDirectory("/")).toBe(false);
    expect(isProjectDirectory(COMPANION_HOME_DIRECTORY)).toBe(false);
    expect(isProjectDirectory(`${COMPANION_HOME_DIRECTORY}/`)).toBe(false);
    expect(isProjectDirectory(` ${COMPANION_HOME_DIRECTORY}/ `)).toBe(false);
  });

  // issue #11：生产聊天会话的 directory 是 /root/project（App 传 "/" → 服务端落成 cwd）。
  it("/root/project 本身（含尾斜杠/空白）→ chat 侧；子目录仍是项目侧", () => {
    expect(isProjectDirectory("/root/project")).toBe(false);
    expect(isProjectDirectory("/root/project/")).toBe(false);
    expect(isProjectDirectory(" /root/project/ ")).toBe(false);
    expect(isProjectDirectory("/root/project/agent-mobile")).toBe(true);
    expect(isProjectDirectory("/root/project/agent-mobile/")).toBe(true);
  });

  it("默认排除表包含 /root/project 与伴侣大本营", () => {
    expect(DEFAULT_EXCLUDED_DIRECTORIES).toContain("/root/project");
    expect(DEFAULT_EXCLUDED_DIRECTORIES).toContain(COMPANION_HOME_DIRECTORY);
  });

  it("自定义 excluded → 整体替换默认值（精确匹配、尾斜杠等价）", () => {
    const excluded = ["/tmp/x"];
    expect(isProjectDirectory("/tmp/x", excluded)).toBe(false);
    expect(isProjectDirectory("/tmp/x/", excluded)).toBe(false);
    expect(isProjectDirectory("/tmp/x/y", excluded)).toBe(true);
    // 覆盖默认：默认里的 /root/project 在自定义表下重新被视为项目侧
    expect(isProjectDirectory("/root/project", excluded)).toBe(true);
    expect(isProjectDirectory("/root/project", [])).toBe(true);
  });
});

describe("validateLimit", () => {
  it("缺省 10；1 与 20 合法", () => {
    expect(validateLimit(undefined)).toEqual({ ok: true, limit: 10 });
    expect(validateLimit(null)).toEqual({ ok: true, limit: 10 });
    expect(validateLimit("")).toEqual({ ok: true, limit: 10 });
    expect(validateLimit(1)).toEqual({ ok: true, limit: 1 });
    expect(validateLimit(20)).toEqual({ ok: true, limit: 20 });
    expect(validateLimit("7")).toEqual({ ok: true, limit: 7 });
  });

  it("越界 / 非整数 / 非数字 → 中文提示", () => {
    for (const bad of [0, 21, -1, 1.5, "abc", "2.0"]) {
      const r = validateLimit(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("limit 必须是");
    }
  });
});

describe("validateProjectSessionsInput", () => {
  it("无参数 → limit 10、无 directory", () => {
    expect(validateProjectSessionsInput({})).toEqual({ ok: true, query: { limit: 10 } });
  });

  it("projectPath 归一为绝对目录（去尾斜杠）", () => {
    expect(validateProjectSessionsInput({ projectPath: "/repo/a/", limit: 3 })).toEqual({
      ok: true,
      query: { limit: 3, directory: "/repo/a" },
    });
  });

  it("相对路径 → 拒绝（与服务端 400 口径一致）", () => {
    const r = validateProjectSessionsInput({ projectPath: "repo/a" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("绝对路径");
  });
});

describe("resolveFetchLimit（先多取，过滤后再截断）", () => {
  it("按 3 倍放大", () => {
    expect(resolveFetchLimit(1)).toBe(3);
    expect(resolveFetchLimit(3)).toBe(9);
    expect(resolveFetchLimit(6)).toBe(18);
  });

  it("封顶 BFF 上限 20", () => {
    expect(resolveFetchLimit(7)).toBe(20);
    expect(resolveFetchLimit(10)).toBe(20);
    expect(resolveFetchLimit(20)).toBe(20);
  });
});

describe("finalizeSessions（截断到用户 limit + truncated 语义）", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, directory: "/repo/a" }));

  it("过滤后 5 条、limit=3 → 截断为 3 条并提示", () => {
    const finalized = finalizeSessions(many, 3, false);
    expect(finalized.sessions.map((s) => s.id)).toEqual(["s0", "s1", "s2"]);
    expect(finalized.truncated).toBe(true);
  });

  it("过滤后 2 条、limit=3、服务端未截断 → 不提示", () => {
    expect(finalizeSessions(many.slice(0, 2), 3, false)).toEqual({
      sessions: many.slice(0, 2),
      truncated: false,
    });
  });

  it("服务端已截断（即便本地不够 limit）→ 提示", () => {
    expect(finalizeSessions(many.slice(0, 2), 3, true).truncated).toBe(true);
  });

  it("刚好等于 limit → 不提示", () => {
    expect(finalizeSessions(many.slice(0, 3), 3, false).truncated).toBe(false);
  });
});

describe("parseProjectSessions（过滤 + 排序）", () => {
  it("剔除 chat 侧（空 / 根 / 伴侣大本营含尾斜杠）、无 id 项，按更新时间倒序", () => {
    const parsed = parseProjectSessions(
      response(
        [
          { id: "chat_empty", directory: "" },
          { id: "chat_root", directory: "/" },
          { id: "chat_home", directory: COMPANION_HOME_DIRECTORY },
          { id: "chat_home_slash", directory: `${COMPANION_HOME_DIRECTORY}/` },
          { id: "old", title: "旧", directory: "/repo/a", updatedAt: HOUR },
          { id: "new", title: "新", directory: "/repo/a/", updatedAt: HOUR + 2_000 },
          { id: "mid", directory: "/repo/b", updatedAt: HOUR + 1_000 },
          { id: "notime", directory: "/repo/c" },
          { id: "", directory: "/repo/d" },
        ],
        true,
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.sessions.map((s) => s.id)).toEqual(["new", "mid", "old", "notime"]);
    expect(parsed!.sessions[0]).toEqual({
      id: "new",
      title: "新",
      directory: "/repo/a/",
      updatedAt: HOUR + 2_000,
    });
    expect(parsed!.sessions[3]).toEqual({ id: "notime", directory: "/repo/c" });
    expect(parsed!.truncated).toBe(true);
  });

  it("空数组 → 空结果、未截断", () => {
    expect(parseProjectSessions(response([]))).toEqual({ sessions: [], truncated: false });
  });

  // issue #7：目录判据拦不住生产聊天会话（directory = /root/project），需按 agent 排除。
  it("agent=companion → 剔除（即便目录不是伴侣大本营）", () => {
    const parsed = parseProjectSessions(
      response([
        { id: "chat_prod", directory: "/root/project", agent: "companion", updatedAt: HOUR + 3_000 },
        { id: "chat_home", directory: COMPANION_HOME_DIRECTORY, agent: "companion", updatedAt: HOUR + 2_000 },
        { id: "proj", directory: "/root/project/agent-mobile", agent: "build", updatedAt: HOUR },
      ]),
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.sessions.map((s) => s.id)).toEqual(["proj"]);
  });

  // issue #11：老聊天会话 agent 缺失，只能靠目录判据拦住 /root/project。
  it("agent 缺失 + /root/project（含尾斜杠）→ 剔除；子目录保留", () => {
    const parsed = parseProjectSessions(
      response([
        { id: "chat_old", title: "简单确认回复", directory: "/root/project", updatedAt: HOUR + 4_000 },
        { id: "chat_old_slash", title: "要求仅回复ok", directory: "/root/project/", updatedAt: HOUR + 3_500 },
        { id: "proj", title: "修登录", directory: "/root/project/agent-mobile", updatedAt: HOUR },
      ]),
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.sessions.map((s) => s.id)).toEqual(["proj"]);
  });

  // issue #11：配置 excludedDirectories 生效且**整体替换**默认值。
  it("自定义 excluded：/tmp/x 剔除、/root/project 反而保留", () => {
    const parsed = parseProjectSessions(
      response([
        { id: "chat_tmp", directory: "/tmp/x", updatedAt: HOUR + 2_000 },
        { id: "proj_root", directory: "/root/project", updatedAt: HOUR + 1_000 },
        { id: "proj_sub", directory: "/tmp/x/y", updatedAt: HOUR },
      ]),
      ["/tmp/x"],
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.sessions.map((s) => s.id)).toEqual(["proj_root", "proj_sub"]);
  });

  it("空排除表 → 只保留「非空、非根」判据", () => {
    const parsed = parseProjectSessions(
      response([
        { id: "chat_root", directory: "/" },
        { id: "proj_root", directory: "/root/project", updatedAt: HOUR },
        { id: "chat_empty", directory: "" },
      ]),
      [],
    );

    expect(parsed!.sessions.map((s) => s.id)).toEqual(["proj_root"]);
  });

  it("agent=build / general / plan 或缺失 → 保留；agent 值随解析结果透出", () => {
    const parsed = parseProjectSessions(
      response([
        { id: "b", directory: "/repo/a", agent: "build", updatedAt: HOUR + 3_000 },
        { id: "g", directory: "/repo/a", agent: "general", updatedAt: HOUR + 2_000 },
        { id: "p", directory: "/repo/a", agent: "plan", updatedAt: HOUR + 1_000 },
        { id: "none", directory: "/repo/a" },
        { id: "empty", directory: "/repo/a", agent: "" },
        { id: "num", directory: "/repo/a", agent: 42 },
      ]),
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.sessions.map((s) => s.id)).toEqual(["b", "g", "p", "none", "empty", "num"]);
    expect(parsed!.sessions[0]).toEqual({ id: "b", directory: "/repo/a", updatedAt: HOUR + 3_000, agent: "build" });
    // 缺失 / 空串 / 非字符串 → 字段省略，不伪造
    expect(parsed!.sessions[3]).toEqual({ id: "none", directory: "/repo/a" });
    expect(parsed!.sessions[4]).toEqual({ id: "empty", directory: "/repo/a" });
    expect(parsed!.sessions[5]).toEqual({ id: "num", directory: "/repo/a" });
  });

  it("形状不合法 → null（调用方给明确文案，不抛）", () => {
    expect(parseProjectSessions(null)).toBeNull();
    expect(parseProjectSessions({})).toBeNull();
    expect(parseProjectSessions({ sessions: "nope" })).toBeNull();
    expect(parseProjectSessions("<html>")).toBeNull();
  });
});

describe("formatProjectSessions", () => {
  it("紧凑文本：id · 标题 · 目录 · 更新时间，且只含 chatcode 侧", () => {
    const text = formatProjectSessions(
      response([
        { id: "ses_new", title: "修登录", directory: "/repo/a", updatedAt: HOUR + 2_000 },
        { id: "ses_old", directory: "/repo/b", updatedAt: HOUR },
        { id: "ses_chat", title: "陪聊", directory: "/" },
      ]),
    );

    expect(text).toContain("共 2 条");
    expect(text).toContain("ses_new · 修登录 · /repo/a · 2026-10-01 17:00");
    expect(text).toContain("ses_old · （无标题） · /repo/b · 2026-10-01 17:00");
    expect(text).not.toContain("ses_chat");
    expect(text).not.toContain("陪聊");
  });

  it("truncated → 末尾提示截断", () => {
    const text = formatProjectSessions(
      response([{ id: "ses_1", directory: "/repo/a", updatedAt: HOUR }], true),
    );
    expect(text).toContain("更早的会话已截断");
  });

  // issue #9：先过滤再按用户 limit 截断。
  it("过滤后 5 条、limit=3 → 只展示 3 条并提示截断", () => {
    const text = formatProjectSessions(
      response([
        { id: "ses_1", directory: "/repo/a", updatedAt: HOUR + 4_000 },
        { id: "chat", directory: "/", updatedAt: HOUR + 3_500 },
        { id: "ses_2", directory: "/repo/a", updatedAt: HOUR + 3_000 },
        { id: "ses_3", directory: "/repo/a", updatedAt: HOUR + 2_000 },
        { id: "ses_4", directory: "/repo/a", updatedAt: HOUR + 1_000 },
        { id: "ses_5", directory: "/repo/a", updatedAt: HOUR },
      ]),
      3,
    );

    expect(text).toContain("共 3 条");
    expect(text).toContain("ses_1");
    expect(text).toContain("ses_3");
    expect(text).not.toContain("ses_4");
    expect(text).not.toContain("ses_5");
    expect(text).toContain("更早的会话已截断");
  });

  it("过滤后 2 条、limit=3、服务端未截断 → 2 条且不提示截断", () => {
    const text = formatProjectSessions(
      response([
        { id: "ses_1", directory: "/repo/a", updatedAt: HOUR + 1_000 },
        { id: "ses_2", directory: "/repo/a", updatedAt: HOUR },
      ]),
      3,
    );

    expect(text).toContain("共 2 条");
    expect(text).toContain("ses_1");
    expect(text).toContain("ses_2");
    expect(text).not.toContain("已截断");
  });

  it("空结果 → 明确文案（说明只读 chatcode 侧）", () => {
    const text = formatProjectSessions(response([]));
    expect(text).toContain("没有找到可展示的项目会话");
    expect(text).toContain("chatcode");
  });

  it("形状不合法 → 明确失败文案（绝不抛）", () => {
    expect(formatProjectSessions(null)).toContain("响应格式不符合预期");
  });

  // issue #11：excluded 由调用方（宿主按配置）透传。
  it("排除表透传：默认剔除 /root/project，自定义后保留", () => {
    const payload = response([
      { id: "ses_chat", title: "旧聊天", directory: "/root/project", updatedAt: HOUR + 1_000 },
      { id: "ses_proj", title: "修登录", directory: "/root/project/agent-mobile", updatedAt: HOUR },
    ]);

    const withDefault = formatProjectSessions(payload);
    expect(withDefault).toContain("共 1 条");
    expect(withDefault).not.toContain("ses_chat");

    const withCustom = formatProjectSessions(payload, 10, ["/tmp/x"]);
    expect(withCustom).toContain("共 2 条");
    expect(withCustom).toContain("ses_chat");
  });

  it("缺 updatedAt → 明确写「未提供更新时间」", () => {
    const text = formatProjectSessions(response([{ id: "ses_x", directory: "/repo/a" }]));
    expect(text).toContain("未提供更新时间");
  });

  it("格式化不变：不展示 agent（有 agent 也还是 id · 标题 · 目录 · 时间）", () => {
    const text = formatProjectSessions(
      response([{ id: "ses_b", title: "修登录", directory: "/repo/a", updatedAt: HOUR, agent: "build" }]),
    );

    expect(text).toContain("ses_b · 修登录 · /repo/a · 2026-10-01 17:00");
    expect(text).not.toContain("build");
  });
});

describe("buildProjectSessionsUrl", () => {
  const config = { bffBase: "http://127.0.0.1:19234/", token: "tok" };

  it("base 去尾斜杠；limit 按 resolveFetchLimit 多取（3 → 9）", () => {
    expect(buildProjectSessionsUrl(config, { limit: 3 })).toBe(
      "http://127.0.0.1:19234/api/internal/project-sessions?limit=9",
    );
  });

  it("limit=10 → 请求封顶 20", () => {
    expect(buildProjectSessionsUrl(config, { limit: 10 })).toBe(
      "http://127.0.0.1:19234/api/internal/project-sessions?limit=20",
    );
  });

  it("directory 走 URLSearchParams 编码（中文/空格/斜杠）", () => {
    expect(buildProjectSessionsUrl(config, { limit: 10, directory: "/repo/项目 a" })).toBe(
      "http://127.0.0.1:19234/api/internal/project-sessions?limit=20&directory=%2Frepo%2F%E9%A1%B9%E7%9B%AE+a",
    );
  });
});

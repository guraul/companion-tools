import { describe, it, expect } from "vitest";
import {
  COMPANION_HOME_DIRECTORY,
  buildProjectSessionsUrl,
  formatProjectSessions,
  isProjectDirectory,
  normalizeDirectory,
  parseProjectSessions,
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

  it("空结果 → 明确文案（说明只读 chatcode 侧）", () => {
    const text = formatProjectSessions(response([]));
    expect(text).toContain("没有找到可展示的项目会话");
    expect(text).toContain("chatcode");
  });

  it("形状不合法 → 明确失败文案（绝不抛）", () => {
    expect(formatProjectSessions(null)).toContain("响应格式不符合预期");
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

  it("base 去尾斜杠 + limit 编码", () => {
    expect(buildProjectSessionsUrl(config, { limit: 3 })).toBe(
      "http://127.0.0.1:19234/api/internal/project-sessions?limit=3",
    );
  });

  it("directory 走 URLSearchParams 编码（中文/空格/斜杠）", () => {
    expect(buildProjectSessionsUrl(config, { limit: 10, directory: "/repo/项目 a" })).toBe(
      "http://127.0.0.1:19234/api/internal/project-sessions?limit=10&directory=%2Frepo%2F%E9%A1%B9%E7%9B%AE+a",
    );
  });
});

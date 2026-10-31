import { describe, it, expect } from "vitest";
import {
  buildOpenThreadsUrl,
  describeOpenThreadHttpFailure,
  formatClosedThread,
  formatOpenedThread,
  formatOpenThreads,
} from "../src/core/open-threads.ts";

const NOW = Date.parse("2026-10-31T21:00:00+08:00");

describe("open-threads 纯函数", () => {
  it("URL 拼接去掉尾部斜杠", () => {
    expect(buildOpenThreadsUrl({ bffBase: "http://x:19234/", token: "t" })).toBe(
      "http://x:19234/api/internal/open-threads",
    );
  });

  it("空列表如实说没有", () => {
    expect(formatOpenThreads({ threads: [] })).toContain("没有未收口");
    expect(formatOpenThreads({})).toContain("没有未收口");
  });

  it("列表按天显示，超长理由截断", () => {
    const text = formatOpenThreads(
      {
        threads: [
          { id: "ot_1", sessionId: "s1", reason: "市场提醒设计还没定", createdAt: NOW - 2 * 86_400_000 },
          { id: "ot_2", sessionId: "s2", reason: "x".repeat(80), createdAt: NOW },
        ],
      },
      NOW,
    );
    expect(text).toContain("2 天前：市场提醒设计还没定（ot_1）");
    expect(text).toContain("今天：");
    expect(text).toContain("…");
  });

  it("超过 5 条只列前 5 并说明还有几条", () => {
    const threads = Array.from({ length: 7 }, (_, i) => ({
      id: `ot_${i}`,
      sessionId: `s${i}`,
      reason: `r${i}`,
      createdAt: NOW,
    }));
    const text = formatOpenThreads({ threads }, NOW);
    expect(text).toContain("另有 2 条未列出");
  });

  it("开/收口的回执文案", () => {
    expect(formatOpenedThread({ thread: { id: "ot_1", reason: "x" } })).toContain("记下了");
    expect(formatOpenedThread({})).toContain("没回执");
    expect(formatClosedThread({ thread: { id: "ot_1" } })).toContain("已收口");
  });

  it("404 单独解释，其它状态码带状态", () => {
    expect(describeOpenThreadHttpFailure(404, "")).toContain("没找到");
    expect(describeOpenThreadHttpFailure(500, "boom")).toContain("500");
  });
});

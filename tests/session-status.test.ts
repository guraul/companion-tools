import { describe, it, expect } from "vitest";
import {
  buildSessionStatus,
  extractTranscript,
  formatSessionStatus,
  toMessages,
  truncateText,
} from "../src/core/session-status.ts";

const messages = [
  { id: "m1", type: "session.agent.selected" },
  { id: "m2", type: "user", text: "帮我看看这个月的账单" },
  { id: "m3", type: "assistant", content: [{ type: "reasoning", text: "先想想" }, { type: "text", text: "好的，我看一下。" }] },
  { id: "m4", type: "system", text: "系统提示不该出现" },
  { id: "m5", type: "assistant", content: [{ type: "tool", input: { secret: 1 } }] },
  { id: "m6", type: "user", text: "谢谢" },
  { id: "m7", type: "assistant", content: [{ type: "text", text: "不客气" }] },
];

describe("toMessages", () => {
  it("数组原样返回；信封兜底；其它 → 空数组", () => {
    expect(toMessages(messages)).toHaveLength(messages.length);
    expect(toMessages({ messages })).toHaveLength(messages.length);
    expect(toMessages(null)).toEqual([]);
    expect(toMessages("nope")).toEqual([]);
  });
});

describe("truncateText", () => {
  it("压平空白 + 超长截断加省略号", () => {
    expect(truncateText("  a\n\nb  ")).toBe("a b");
    const long = "字".repeat(250);
    const out = truncateText(long, 200);
    expect(out.length).toBe(201);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("extractTranscript", () => {
  it("只取 user/assistant 文本；忽略事件/系统/工具消息", () => {
    const { entries } = extractTranscript(messages, 10);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(entries[1]?.text).toBe("好的，我看一下。");
    expect(entries.some((e) => e.text.includes("系统提示"))).toBe(false);
    expect(entries.some((e) => e.text.includes("secret"))).toBe(false);
  });

  it("条数上限：取最近 N 条并标记截断", () => {
    const { entries, truncated } = extractTranscript(messages, 2);
    expect(truncated).toBe(true);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries[1]?.text).toBe("不客气");
  });

  it("空会话 → 空摘要", () => {
    const { entries, truncated } = extractTranscript([], 5);
    expect(entries).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("单条文本截断到 200 字", () => {
    const { entries } = extractTranscript([{ type: "user", text: "x".repeat(500) }], 5);
    expect(entries[0]?.text.length).toBe(201);
  });
});

describe("formatSessionStatus / buildSessionStatus", () => {
  it("包含标题/目录/消息数/摘要", () => {
    const text = buildSessionStatus(messages, { sessionID: "ses_1", title: "账单会话", directory: "/tmp/work" });
    expect(text).toContain("会话状态（只读）");
    expect(text).toContain("ID：ses_1");
    expect(text).toContain("标题：账单会话");
    expect(text).toContain("目录：/tmp/work");
    expect(text).toContain("消息数：7");
    expect(text).toContain("[用户] 帮我看看这个月的账单");
    expect(text).toContain("[助手] 好的，我看一下。");
  });

  it("缺标题/目录 → 显示占位而非 undefined", () => {
    const text = formatSessionStatus({ sessionID: "ses_2", messageCount: 0, transcript: [], truncated: false });
    expect(text).toContain("标题：（无标题）");
    expect(text).toContain("目录：（未知）");
    expect(text).not.toContain("undefined");
  });

  it("空会话 → 明说没有文本消息", () => {
    const text = buildSessionStatus([], { sessionID: "ses_3" });
    expect(text).toContain("最近没有 user / assistant 文本消息");
    expect(text).toContain("消息数：0");
  });

  it("形状怪异 → 不抛，退化为空会话", () => {
    expect(() => buildSessionStatus(null, { sessionID: "ses_4" })).not.toThrow();
    expect(buildSessionStatus(null, { sessionID: "ses_4" })).toContain("消息数：0");
  });
});

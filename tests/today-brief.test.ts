// today_brief 纯函数门禁：有数据 / 全空 / 端点 401 / ≤8 行与文本压平。
import { describe, it, expect } from "vitest";
import {
  MAX_LINES,
  NOTHING_TODAY,
  buildTodayBriefUrl,
  describeTodayBriefHttpFailure,
  describeTodayBriefNetworkFailure,
  describeTodayBriefParseFailure,
  formatTodayBrief,
} from "../src/core/today-brief.ts";

// 契约：createdAt / generatedAt 都是 epoch 毫秒 number（homebase product_events / Date.now()）
const GENERATED_AT = 1790845200000; // 2026-10-01 17:00 (UTC+8)

function fullBrief() {
  return {
    openAttention: {
      count: 2,
      top: [
        { id: "att_1", title: "交房租", summary: "本月 5 号到期，还没转", createdAt: 1790758800000 },
        { id: "att_2", title: "体检预约", summary: "周四上午", createdAt: 1790845200000 },
      ],
    },
    executions: { count: 12, matched: 10, failed: 2 },
    calendar: {
      count: 2,
      first: [
        { time: "09:00", summary: "周会" },
        { time: "14:00", summary: "体检" },
      ],
    },
    retryReports: [{ text: "昨天 3 条失败已重试，2 条成功", createdAt: 1790841600000 }],
    generatedAt: GENERATED_AT,
  };
}

describe("buildTodayBriefUrl", () => {
  it("拼内部端点，base 去尾部斜杠", () => {
    expect(buildTodayBriefUrl({ bffBase: "http://127.0.0.1:19234/", token: "tok" })).toBe(
      "http://127.0.0.1:19234/api/internal/today-brief",
    );
  });
});

describe("formatTodayBrief · 有数据", () => {
  it("四个部分都出现：未处理 / 执行摘要 / 日程 / 补跑报告", () => {
    const text = formatTodayBrief(fullBrief());

    expect(text).toContain("未处理 2 件");
    expect(text).toContain("执行 12 次（命中 10 / 失败 2）");
    expect(text).toContain("日程 2 项");
    expect(text).toContain("补跑报告 1 条");
    expect(text).toContain("交房租");
    expect(text).toContain("本月 5 号到期");
    expect(text).toContain("09:00 周会");
    expect(text).toContain("昨天 3 条失败已重试，2 条成功");
  });

  it("时间按 epoch 毫秒渲染：同日只给 HH:mm，跨日给 MM-DD HH:mm", () => {
    const text = formatTodayBrief(fullBrief());

    expect(text).toContain("体检预约（17:00）");
    expect(text).toContain("交房租（09-30 17:00）");
  });

  it("行数不超过上限", () => {
    const text = formatTodayBrief(fullBrief());
    expect(text.split("\n").length).toBeLessThanOrEqual(MAX_LINES);
  });

  it("上游脏数据（换行 / 超长）被压平，行数不破上限", () => {
    const brief = fullBrief();
    brief.openAttention.top[0] = {
      id: "att_1",
      title: "交房租\n还有第二行",
      summary: "很长的摘要".repeat(50),
      createdAt: 1790841600000,
    } as (typeof brief.openAttention.top)[number];
    brief.retryReports = [
      { text: "第一行\n第二行\n第三行", createdAt: GENERATED_AT },
      { text: "第二条", createdAt: GENERATED_AT },
      { text: "第三条", createdAt: GENERATED_AT },
    ];

    const text = formatTodayBrief(brief);
    const lines = text.split("\n");

    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(text).not.toContain("\n第二行");
    expect(text).toContain("（另有 1 条未列出）");
  });

  it("展开条数有上限：count 大于 top 时提示还有多少条", () => {
    const brief = fullBrief();
    brief.openAttention.count = 5;
    const text = formatTodayBrief(brief);

    expect(text).toContain("未处理 5 件");
    expect(text).toContain("（另有 3 条未列出）");
  });
});

describe("formatTodayBrief · 全空", () => {
  it("四个部分都是 0 / 空 → 明说今天没有待处理的事", () => {
    const text = formatTodayBrief({
      openAttention: { count: 0, top: [] },
      executions: { count: 0, matched: 0, failed: 0 },
      calendar: { count: 0, first: [] },
      retryReports: [],
      generatedAt: GENERATED_AT,
    });

    expect(text).toBe(NOTHING_TODAY);
    expect(text).toBe("今天没有待处理的事。");
  });

  it("空对象 / 任意怪形状 → 同样落到「今天没有待处理的事。」，绝不抛", () => {
    expect(formatTodayBrief({})).toBe(NOTHING_TODAY);
    expect(formatTodayBrief(null)).toBe(NOTHING_TODAY);
    expect(formatTodayBrief("oops")).toBe(NOTHING_TODAY);
  });

  it("只有执行、没有未处理/日程/补跑 → 不算空，给出执行摘要", () => {
    const text = formatTodayBrief({
      openAttention: { count: 0, top: [] },
      executions: { count: 4, matched: 4, failed: 0 },
      calendar: { count: 0, first: [] },
      retryReports: [],
      generatedAt: GENERATED_AT,
    });

    expect(text).not.toBe(NOTHING_TODAY);
    expect(text).toContain("执行 4 次（命中 4 / 失败 0）");
    expect(text.split("\n").length).toBe(1);
  });
});

describe("today_brief · 失败文案", () => {
  it("401 说清是 token 问题", () => {
    const message = describeTodayBriefHttpFailure(401, '{"error":"unauthorized"}');
    expect(message).toContain("401");
    expect(message).toContain("token");
  });

  it("其它状态码带上服务端 error 摘要", () => {
    expect(describeTodayBriefHttpFailure(500, '{"error":"boom"}')).toContain("boom");
  });

  it("网络 / 解析失败都有中文说明", () => {
    expect(describeTodayBriefNetworkFailure(new TypeError("fetch failed"))).toContain("无法连接 BFF");
    expect(describeTodayBriefParseFailure()).toContain("不是合法 JSON");
  });
});

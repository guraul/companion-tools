import { describe, it, expect } from "vitest";
import {
  buildQueryUrl,
  describeHttpFailure,
  describeNetworkFailure,
  describeParseFailure,
  formatAssignmentHistory,
  requestSignal,
  validateQuery,
} from "../src/core/assignment-history.ts";

const singleMatch = {
  matched: [
    {
      id: "asg_1",
      responsibility: "交房租",
      domain: "finance",
      state: "active",
      activatedAt: "2026-10-01T08:30:00.000Z",
      schedule: "0 9 1 * *",
      timezone: "Asia/Shanghai",
    },
  ],
  history: [
    { occurredAt: "2026-10-01T09:01:00.000Z", label: "执行", status: "succeeded", id: "h1" },
    { occurredAt: "2026-09-01T09:02:00.000Z", label: "执行", status: "failed", attempt: 2, retried: true, reason: "余额不足", id: "h2" },
  ],
  ambiguous: false,
  truncated: false,
};

describe("validateQuery", () => {
  it("两参都不给 → 中文提示（与服务端 400 口径一致）", () => {
    const result = validateQuery({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("至少给出 responsibility");
  });

  it("只给空白字符串 → 视同未给", () => {
    const result = validateQuery({ responsibility: "   ", assignmentId: "" });
    expect(result.ok).toBe(false);
  });

  it("limit 越界（0 / 21 / 非整数）→ 中文提示", () => {
    expect(validateQuery({ responsibility: "房租", limit: 0 }).ok).toBe(false);
    expect(validateQuery({ responsibility: "房租", limit: 21 }).ok).toBe(false);
    expect(validateQuery({ responsibility: "房租", limit: 1.5 }).ok).toBe(false);
  });

  it("limit 字符串数字可接受（\"3\" → 3），缺省 10", () => {
    const withString = validateQuery({ responsibility: "房租", limit: "3" });
    expect(withString.ok && withString.query.limit).toBe(3);
    const omitted = validateQuery({ responsibility: "房租" });
    expect(omitted.ok && omitted.query.limit).toBe(10);
  });

  it("单参通过并 trim；不塞空字段", () => {
    const byId = validateQuery({ assignmentId: "  asg_1  " });
    expect(byId).toEqual({ ok: true, query: { limit: 10, assignmentId: "asg_1" } });
    const byName = validateQuery({ responsibility: "房租" });
    expect(byName).toEqual({ ok: true, query: { limit: 10, responsibility: "房租" } });
  });
});

describe("buildQueryUrl", () => {
  it("拼端点 + 参数编码；base 尾部斜杠去掉；不写死地址", () => {
    const url = buildQueryUrl(
      { bffBase: "http://127.0.0.1:19234/", token: "t" },
      { limit: 5, responsibility: "交 房 租" },
    );
    expect(url).toBe("http://127.0.0.1:19234/api/internal/assignment-history?responsibility=%E4%BA%A4+%E6%88%BF+%E7%A7%9F&limit=5");
  });

  it("给了 assignmentId 就带上（精确参数）", () => {
    const url = buildQueryUrl({ bffBase: "https://bff.example", token: "t" }, { limit: 10, assignmentId: "asg_1" });
    expect(url).toBe("https://bff.example/api/internal/assignment-history?assignmentId=asg_1&limit=10");
  });
});

describe("formatAssignmentHistory", () => {
  it("单命中 → 标题 + 各自最近执行结果 + 明细", () => {
    const text = formatAssignmentHistory(singleMatch);
    expect(text).toContain("匹配到 1 条责任");
    expect(text).toContain("交房租");
    expect(text).toContain("id: asg_1");
    expect(text).toContain("succeeded");
    expect(text).toContain("failed");
    expect(text).toContain("第 2 次");
    expect(text).toContain("含重试");
    expect(text).toContain("余额不足");
    // 不吐原始 JSON
    expect(text).not.toContain("{");
  });

  it("多命中 ambiguous → 列出全部并提示收窄，不编造历史", () => {
    const text = formatAssignmentHistory({
      matched: [
        { id: "a1", responsibility: "交房租" },
        { id: "a2", responsibility: "交物业费" },
      ],
      history: [],
      ambiguous: true,
      truncated: false,
    });
    expect(text).toContain("匹配到 2 条责任");
    expect(text).toContain("不唯一");
    expect(text).toContain("交物业费");
    expect(text).toContain("缩小范围");
  });

  it("无命中 → 空数组给「没找到」而非错误", () => {
    const text = formatAssignmentHistory({ matched: [], history: [], ambiguous: false, truncated: false });
    expect(text).toContain("没有找到匹配的责任");
  });

  it("单命中但无历史 → 暂无执行记录", () => {
    const text = formatAssignmentHistory({ matched: [{ id: "a1", responsibility: "交房租" }], history: [], ambiguous: false, truncated: false });
    expect(text).toContain("暂无执行记录");
  });

  it("truncated → 明示只显示最近 N 条", () => {
    const text = formatAssignmentHistory({ ...singleMatch, truncated: true });
    expect(text).toContain("已截断");
  });

  it("形状怪异（null / 字符串）→ 退化为「没找到」，绝不抛", () => {
    expect(() => formatAssignmentHistory(null)).not.toThrow();
    expect(formatAssignmentHistory(null)).toContain("没有找到匹配的责任");
    expect(formatAssignmentHistory("boom")).toContain("没有找到匹配的责任");
  });
});

describe("错误 → 中文文本", () => {
  it("401 → 点明 token 问题", () => {
    expect(describeHttpFailure(401, '{"error":"unauthorized"}')).toContain("token 未配置或值不正确");
  });

  it("400 → 带上服务端 error 文本", () => {
    const text = describeHttpFailure(400, '{"error":"limit must be an integer between 1 and 20"}');
    expect(text).toContain("400");
    expect(text).toContain("limit must be an integer");
  });

  it("其它状态码 → 通用说明 + 截断 body", () => {
    expect(describeHttpFailure(500, "internal boom")).toContain("500");
  });

  it("超时 / 网络错 / 解析错 → 各自的说明", () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    expect(describeNetworkFailure(timeout)).toContain("超时");
    expect(describeNetworkFailure(new TypeError("fetch failed"))).toContain("无法连接 BFF");
    expect(describeParseFailure()).toContain("不是合法 JSON");
  });
});

describe("requestSignal", () => {
  it("无宿主 signal → 返回 AbortSignal（超时）", () => {
    expect(requestSignal()).toBeInstanceOf(AbortSignal);
  });

  it("有宿主 signal → 合并后仍是 AbortSignal", () => {
    const controller = new AbortController();
    const signal = requestSignal(controller.signal);
    expect(signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

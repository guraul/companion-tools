import { describe, it, expect } from "vitest";
import {
  buildKbSearchUrl,
  buildRawIdeaUrl,
  describeIdeaHttpFailure,
  formatKbHits,
  formatSavedIdea,
} from "../src/core/ideas.ts";

const CONFIG = { bffBase: "http://127.0.0.1:19234/", token: "t" };

describe("ideas 纯函数", () => {
  it("URL 拼接（去尾斜杠，查询参数编码）", () => {
    expect(buildRawIdeaUrl(CONFIG)).toBe("http://127.0.0.1:19234/api/internal/raw-ideas");
    expect(buildKbSearchUrl(CONFIG, "手机 组件")).toContain("q=%E6%89%8B%E6%9C%BA+%E7%BB%84%E4%BB%B6");
  });

  it("保存回执：成功说清「暂时不用做事」，无回执如实说", () => {
    expect(formatSavedIdea({ ref: "raw-ideas/x.md", title: "手机小组件" })).toContain("暂时不需要你做什么");
    expect(formatSavedIdea({})).toContain("没回执");
  });

  it("检索结果：空 / 未配置 / 多条截断", () => {
    expect(formatKbHits({ configured: false, hits: [] })).toContain("没配置");
    expect(formatKbHits({ configured: true, hits: [] })).toContain("没找到");
    const hits = Array.from({ length: 5 }, (_, i) => ({ title: `想法${i}`, snippet: "内容" }));
    const text = formatKbHits({ configured: true, hits });
    expect(text).toContain("找到 5 条");
    expect(text).toContain("另有 2 条未列出");
  });

  it("错误文案：503 单独解释", () => {
    expect(describeIdeaHttpFailure("知识库", 503)).toContain("没配置");
    expect(describeIdeaHttpFailure("知识库", 500)).toContain("500");
  });
});

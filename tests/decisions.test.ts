import { describe, it, expect } from "vitest";
import {
  buildDecisionUrl,
  describeDecisionHttpFailure,
  describeDecisionNetworkFailure,
  formatSavedDecision,
} from "../src/core/decisions.ts";

const CONFIG = { bffBase: "http://127.0.0.1:19234/", token: "t" };

describe("decisions 纯函数", () => {
  it("URL 拼接（去尾斜杠）", () => {
    expect(buildDecisionUrl(CONFIG)).toBe("http://127.0.0.1:19234/api/internal/decisions");
    expect(buildDecisionUrl({ bffBase: "http://127.0.0.1:19234", token: "t" })).toBe(
      "http://127.0.0.1:19234/api/internal/decisions",
    );
  });

  it("保存回执：含标题与「知识库的决策」，标题超 40 字截断", () => {
    expect(formatSavedDecision({ ref: "decisions/x.md", title: "改用 pnpm" })).toBe(
      "记下了：改用 pnpm（在知识库的决策里）",
    );
    const long = "a".repeat(60);
    const text = formatSavedDecision({ ref: "decisions/y.md", title: long });
    expect(text).toContain("a".repeat(40));
    expect(text).not.toContain("a".repeat(41));
  });

  it("无回执兜底：如实说可能没存进去", () => {
    expect(formatSavedDecision(undefined)).toContain("没回执");
    expect(formatSavedDecision({})).toContain("可能没存进去");
  });

  it("错误文案：503 与 500 区分，网络故障带原始错误", () => {
    expect(describeDecisionHttpFailure(503)).toContain("没配置");
    expect(describeDecisionHttpFailure(500)).toBe("决策接口返回 500。");
    expect(describeDecisionNetworkFailure(new Error("ECONNREFUSED"))).toBe(
      "连不上决策接口：ECONNREFUSED",
    );
  });

  it("401 单独文案：鉴权失败（配置问题）", () => {
    expect(describeDecisionHttpFailure(401)).toContain("鉴权失败");
  });

  it("503 仍说没配置（防回归）", () => {
    expect(describeDecisionHttpFailure(503)).toContain("没配置");
  });
});

import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/core/config.ts";

describe("parseConfig", () => {
  it("正常配置 → ok + 去空白后的 bffBase/token", () => {
    const result = parseConfig('{"bffBase":"http://127.0.0.1:19234/","token":"  abc  "}');
    expect(result).toEqual({ ok: true, config: { bffBase: "http://127.0.0.1:19234/", token: "abc" } });
  });

  it("文件缺失（undefined）→ 未配置中文提示，不抛", () => {
    const result = parseConfig(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("未配置 BFF 地址或 token");
  });

  it("空文件 → 未配置提示", () => {
    const result = parseConfig("   \n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("未配置 BFF 地址或 token");
  });

  it("非法 JSON → 中文提示（点明不是合法 JSON）", () => {
    const result = parseConfig("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("不是合法 JSON");
  });

  it("缺 token → 未配置提示", () => {
    const result = parseConfig('{"bffBase":"http://127.0.0.1:19234"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("未配置 BFF 地址或 token");
  });

  it("缺 bffBase → 未配置提示", () => {
    const result = parseConfig('{"token":"abc"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("未配置 BFF 地址或 token");
  });

  it("键类型不对（非字符串）→ 未配置提示", () => {
    const result = parseConfig('{"bffBase":123,"token":true}');
    expect(result.ok).toBe(false);
  });

  it("顶层是数组 → 未配置提示（不崩）", () => {
    const result = parseConfig("[1,2,3]");
    expect(result.ok).toBe(false);
  });
});

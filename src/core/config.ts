// companion-tools · 配置解析（纯函数，可单测）
//
// 配置文件 ~/.config/opencode/companion-tools.json（**可选**）：
//   { "bffBase": "http://127.0.0.1:19234", "token": "<内部 token>" }
//
// 缺文件 / 非法 JSON / 缺任一键 → 返回中文提示（工具层原样转述给模型，**绝不抛**）。
// 纪律：默认 BFF 地址**只出现在提示文本里作示例**，请求 URL 一律来自配置，
// 生产地址绝不写死进代码。

/** 配置文件路径（仅用于提示文本与宿主读取；可用 COMPANION_TOOLS_CONFIG 覆盖，测试用） */
export const CONFIG_FILE = "~/.config/opencode/companion-tools.json";

/** 示例配置（只在「未配置」提示里出现，不作为请求默认值） */
const EXAMPLE = '{"bffBase":"http://127.0.0.1:19234","token":"<内部 token>"}';

export interface CompanionConfig {
  readonly bffBase: string;
  readonly token: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: CompanionConfig }
  | { readonly ok: false; readonly message: string };

/** 「未配置」统一文案：缺文件与缺键共用（对模型而言是同一件事：还差配置） */
export function notConfiguredMessage(): string {
  return `未配置 BFF 地址或 token：请在 ${CONFIG_FILE} 写入 ${EXAMPLE} 后重试。`;
}

/**
 * 解析配置文本。
 * @param raw 文件内容；`undefined` 表示文件不存在。
 */
export function parseConfig(raw: string | undefined): ConfigResult {
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, message: notConfiguredMessage() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `${CONFIG_FILE} 不是合法 JSON，请修正为 ${EXAMPLE}。`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: notConfiguredMessage() };
  }

  const record = parsed as Record<string, unknown>;
  const bffBase = typeof record.bffBase === "string" ? record.bffBase.trim() : "";
  const token = typeof record.token === "string" ? record.token.trim() : "";
  if (bffBase === "" || token === "") {
    return { ok: false, message: notConfiguredMessage() };
  }

  return { ok: true, config: { bffBase, token } };
}

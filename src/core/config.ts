// companion-tools · 配置解析（纯函数，可单测）
//
// 配置文件 ~/.config/opencode/companion-tools.json（**可选**）：
//   { "bffBase": "http://127.0.0.1:19234", "token": "<内部 token>",
//     "excludedDirectories": ["/root/project", "/root/project/homebase"] }
//
// 缺文件 / 非法 JSON / 缺任一键 → 返回中文提示（工具层原样转述给模型，**绝不抛**）。
// excludedDirectories 是**可选**字段：非法值只忽略该字段（走默认），不影响其它字段。
// 纪律：默认 BFF 地址**只出现在提示文本里作示例**，请求 URL 一律来自配置，
// 生产地址绝不写死进代码。

/** 配置文件路径（仅用于提示文本与宿主读取；可用 COMPANION_TOOLS_CONFIG 覆盖，测试用） */
export const CONFIG_FILE = "~/.config/opencode/companion-tools.json";

/** 示例配置（只在「未配置」提示里出现，不作为请求默认值） */
const EXAMPLE = '{"bffBase":"http://127.0.0.1:19234","token":"<内部 token>"}';

/**
 * 默认「非项目（chat 侧）目录」：`project_sessions` / `session_status` 的范围判据用。
 * `/root/project` 是 App 聊天会话的落点（App 传 directory:"/" → 服务端落成 cwd）；
 * `/root/project/homebase` 是伴侣大本营。配置里写了 `excludedDirectories` 就**整体替换**本默认值。
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = ["/root/project", "/root/project/homebase"];

export interface CompanionConfig {
  readonly bffBase: string;
  readonly token: string;
  /**
   * 视为「非项目会话」的目录（精确匹配；尾斜杠等价）。
   * 缺省 / 非法（非数组、含非字符串）→ 字段省略，由 DEFAULT_EXCLUDED_DIRECTORIES 兜底。
   */
  readonly excludedDirectories?: readonly string[];
}

export type ConfigResult =
  | { readonly ok: true; readonly config: CompanionConfig }
  | { readonly ok: false; readonly message: string };

/** 「未配置」统一文案：缺文件与缺键共用（对模型而言是同一件事：还差配置） */
export function notConfiguredMessage(): string {
  return `未配置 BFF 地址或 token：请在 ${CONFIG_FILE} 写入 ${EXAMPLE} 后重试。`;
}

/**
 * 解析 `excludedDirectories`：必须是字符串数组（元素去空白、drop 空串）。
 * 非法（非数组 / 含非字符串）→ `undefined`（字段省略，走默认；**不**让整个配置解析失败）。
 */
export function parseExcludedDirectories(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry): entry is string => typeof entry === "string")) return undefined;
  return value.map((entry) => entry.trim()).filter((entry) => entry !== "");
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

  const excludedDirectories = parseExcludedDirectories(record.excludedDirectories);
  return {
    ok: true,
    config: { bffBase, token, ...(excludedDirectories !== undefined ? { excludedDirectories } : {}) },
  };
}

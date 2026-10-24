// companion-tools · project_sessions 的纯函数（可单测）
//
// 职责边界（宿主侧 execute 只做接线）：
//   参数校验 → validateProjectSessionsInput；URL 拼装 → buildProjectSessionsUrl；
//   响应 → 过滤/排序 → parseProjectSessions；中文文本 → formatProjectSessions；
//   错误 → 中文文本 → describeProjectSessionsHttpFailure / …NetworkFailure / …ParseFailure。
//
// 契约（homebase `GET /api/internal/project-sessions`，见 homebase PR #50 / issue #49；
//   `agent` 字段见 homebase issue #51）：
//   query: limit（1-20，缺省 10）/ directory（绝对路径，可选）
//   header: x-internal-token
//   resp:   { sessions: [{ id, title?, directory, updatedAt?, messageCount?, agent? }], truncated }
//   updatedAt 是 **epoch 毫秒 number**（opencode session.time.updated），不是 ISO 字符串。
//
// 范围约束（**插件侧**执行，不依赖服务端）：只展示 **chatcode 侧**会话。
//   ① 目录判据抄自 agent-mobile `agent-mobile-app/src/services/conversation-kind.ts` 的
//   resolveConversationKind：directory 为空 / "/" / 伴侣大本营 → chat（伴侣聊天）侧；
//   其余 → chatcode（项目）侧。常量值在此**抄写**，**不跨仓 import**（两仓独立发布）。
//   ② agent 判据：`agent === "companion"` → chat 侧。**必要补充**——生产聊天会话的
//   directory 是 `/root/project`（不是伴侣大本营），①拦不住。只排除 companion，
//   `agent` 缺失（上游没给）时保持放行，避免误伤老会话/其它 agent（build / general / plan）。
//   范围过滤只在插件侧；BFF 只做投影，不按 agent 过滤。
//
// 纪律：本模块只读，绝不构造写请求。

import type { CompanionConfig } from "./config.ts";

export const DEFAULT_LIMIT = 10;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 20;

/** 伴侣聊天大本营（agent-mobile conversation-kind.ts 的 MARKET_TALK_DIRECTORY；勿跨仓 import） */
export const COMPANION_HOME_DIRECTORY = "/root/project/homebase";

/** 伴侣聊天会话使用的 agent id（opencode `Agent.ID` 取值之一）；范围判据的权威依据 */
const COMPANION_AGENT_ID = "companion";

export interface ProjectSession {
  readonly id: string;
  readonly title?: string;
  readonly directory: string;
  readonly updatedAt?: number;
  /** opencode 会话的 agent id（build / general / plan / companion…）；上游没给则缺失 */
  readonly agent?: string;
}

export interface ProjectSessionsInput {
  readonly projectPath?: unknown;
  readonly limit?: unknown;
}

export interface ProjectSessionsQuery {
  readonly limit: number;
  readonly directory?: string;
}

export type ProjectSessionsValidation =
  | { readonly ok: true; readonly query: ProjectSessionsQuery }
  | { readonly ok: false; readonly message: string };

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 目录归一：去空白、去尾部斜杠（根目录 "/" 保持不变）。
 * 目的：`/repo/` 与 `/repo` 判为同一目录（上游/配置可能带尾斜杠）。
 */
export function normalizeDirectory(value: unknown): string {
  const trimmed = asTrimmedString(value);
  if (trimmed === "" || trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/, "");
}

/** chatcode 侧（项目）目录：非空、非根、非伴侣大本营 */
export function isProjectDirectory(value: unknown): boolean {
  const directory = normalizeDirectory(value);
  if (directory === "" || directory === "/") return false;
  return directory !== normalizeDirectory(COMPANION_HOME_DIRECTORY);
}

/** limit 校验（与服务端 400 口径一致）：缺省 10，1..20 的整数 */
export function validateLimit(raw: unknown): { readonly ok: true; readonly limit: number } | { readonly ok: false; readonly message: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, limit: DEFAULT_LIMIT };
  // 字符串必须整体是数字（"2.0" / "1.5" 与服务端同样拒绝，不做浮点宽容）
  const parsed = typeof raw === "number" ? raw : /^\d+$/.test(asTrimmedString(raw)) ? Number(asTrimmedString(raw)) : NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_LIMIT || parsed > MAX_LIMIT) {
    return { ok: false, message: `limit 必须是 ${MIN_LIMIT}-${MAX_LIMIT} 之间的整数。` };
  }
  return { ok: true, limit: parsed };
}

/** 工具入参校验：projectPath 可选，但给了就必须是绝对路径（与服务端一致） */
export function validateProjectSessionsInput(input: ProjectSessionsInput): ProjectSessionsValidation {
  const limitResult = validateLimit(input.limit);
  if (!limitResult.ok) return { ok: false, message: limitResult.message };

  const projectPath = normalizeDirectory(input.projectPath);
  if (projectPath !== "" && !projectPath.startsWith("/")) {
    return { ok: false, message: "projectPath 必须是绝对路径（以 / 开头）。" };
  }

  return {
    ok: true,
    query: {
      limit: limitResult.limit,
      ...(projectPath !== "" ? { directory: projectPath } : {}),
    },
  };
}

/** 拼 URL：base 去尾部斜杠，参数走 URLSearchParams 编码 */
export function buildProjectSessionsUrl(config: CompanionConfig, query: ProjectSessionsQuery): string {
  const base = config.bffBase.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("limit", String(query.limit));
  if (query.directory !== undefined) params.set("directory", query.directory);
  return `${base}/api/internal/project-sessions?${params.toString()}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toProjectSession(value: unknown): ProjectSession | null {
  const record = asRecord(value);
  const id = typeof record.id === "string" && record.id !== "" ? record.id : undefined;
  if (id === undefined) return null;
  const directory = typeof record.directory === "string" ? record.directory : "";
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : undefined;
  const title = typeof record.title === "string" && record.title !== "" ? record.title : undefined;
  const agent = typeof record.agent === "string" && record.agent !== "" ? record.agent : undefined;
  return {
    id,
    ...(title !== undefined ? { title } : {}),
    directory,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(agent !== undefined ? { agent } : {}),
  };
}

/** 更新时间倒序；缺 updatedAt 排最后（稳定排序保留服务端顺序） */
function byUpdatedDesc(a: ProjectSession, b: ProjectSession): number {
  const at = a.updatedAt ?? Number.NEGATIVE_INFINITY;
  const bt = b.updatedAt ?? Number.NEGATIVE_INFINITY;
  if (at === bt) return 0;
  return at < bt ? 1 : -1;
}

/**
 * 响应归一：抽 sessions、**剔除 chat 侧**、按更新时间倒序。
 * chat 侧判据 = 目录判据不成立 **或** agent 为 companion（后者补上 `/root/project` 的漏洞）。
 * 形状不合法（无 sessions 数组）→ null（调用方给明确文案，不抛）。
 */
export function parseProjectSessions(response: unknown): { readonly sessions: ProjectSession[]; readonly truncated: boolean } | null {
  const record = asRecord(response);
  if (!Array.isArray(record.sessions)) return null;

  const sessions = record.sessions
    .map(toProjectSession)
    .filter((s): s is ProjectSession => s !== null && isProjectDirectory(s.directory) && s.agent !== COMPANION_AGENT_ID)
    .sort(byUpdatedDesc);

  return { sessions, truncated: record.truncated === true };
}

/** 时间戳收成「YYYY-MM-DD HH:MM」（epoch 毫秒，固定 UTC+8——Asia/Shanghai 无夏令时） */
function formatUpdatedAt(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  }
  if (typeof value === "string") {
    const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
    if (iso) return `${iso[1]} ${iso[2]}`;
  }
  // 措辞陈述事实：避免模型把「时间未知」当作「无法确认时段」的证据。
  return "未提供更新时间";
}

/** 单行：会话id · 标题 · 目录 · 更新时间 */
function formatSession(session: ProjectSession): string {
  const title = session.title !== undefined && session.title !== "" ? session.title : "（无标题）";
  return `${session.id} · ${title} · ${session.directory} · ${formatUpdatedAt(session.updatedAt)}`;
}

/** 响应 → 给模型读的简洁中文文本。**绝不抛**：形状再怪也退化成明确文案。 */
export function formatProjectSessions(response: unknown): string {
  const parsed = parseProjectSessions(response);
  if (parsed === null) return "读取项目会话失败：服务端响应格式不符合预期。";

  if (parsed.sessions.length === 0) {
    return "没有找到可展示的项目会话。（本工具只读 chatcode 侧会话；伴侣聊天会话不在此列。）";
  }

  const head = `项目会话（最近更新在前，共 ${parsed.sessions.length} 条）：`;
  const lines = parsed.sessions.map(formatSession);
  const tail = parsed.truncated
    ? ["", `（仅显示最近 ${parsed.sessions.length} 条，更早的会话已截断）`]
    : [];
  return [head, ...lines, ...tail].join("\n");
}

/** 服务端 JSON 里抽 error 文本（截断），非 JSON 就取前 120 字 */
function errorSnippet(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const error = asRecord(parsed).error;
    if (typeof error === "string" && error !== "") return `：${error}`;
  } catch {
    // 非 JSON：落到下面按纯文本截断
  }
  const flat = trimmed.replace(/\s+/g, " ");
  return `：${flat.length > 120 ? `${flat.slice(0, 120)}…` : flat}`;
}

/** HTTP 失败 → 中文说明（401 单独说清是 token 问题） */
export function describeProjectSessionsHttpFailure(status: number, body: string): string {
  if (status === 401) {
    return "读取项目会话失败：服务端拒绝（401）——token 未配置或值不正确，请检查 ~/.config/opencode/companion-tools.json 的 token。";
  }
  if (status === 400) {
    return `读取项目会话失败：请求参数被服务端拒绝（400）${errorSnippet(body)}`;
  }
  return `读取项目会话失败：服务端返回 ${status}${errorSnippet(body)}`;
}

/** 网络/超时/取消 → 中文说明 */
export function describeProjectSessionsNetworkFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return "读取项目会话失败：请求超时（5 秒）。";
  if (name === "AbortError") return "读取项目会话失败：请求已取消。";
  const message = error instanceof Error ? error.message : String(error);
  return `读取项目会话失败：无法连接 BFF（${message}）。请确认配置里的 bffBase 可达。`;
}

/** 响应不是合法 JSON → 中文说明 */
export function describeProjectSessionsParseFailure(): string {
  return "读取项目会话失败：服务端响应不是合法 JSON。";
}

/** 显式 sessionId 命中 chat 侧 → 拒绝文案 */
export function sessionChatScopeMessage(sessionID: string): string {
  return `拒绝读取会话 ${sessionID}：它属于伴侣聊天（chat）侧（目录为空、根目录或伴侣大本营）。本工具只读 chatcode 侧项目会话；如需查看当前会话，请省略 sessionId。`;
}

/** 显式 sessionId 取不到目录 → 保守拒绝（无法判断范围就不放行） */
export function sessionScopeUnknownMessage(sessionID: string): string {
  return `拒绝读取会话 ${sessionID}：无法取得它的目录，出于范围约束保守拒绝。如需查看当前会话，请省略 sessionId。`;
}

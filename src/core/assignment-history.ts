// companion-tools · assignment_history 的纯函数（可单测）
//
// 职责边界（宿主侧 execute 只做接线）：
//   参数校验 → validateQuery；URL 拼装 → buildQueryUrl；
//   响应 → 中文文本 → formatAssignmentHistory；错误 → 中文文本 → describeHttpFailure / describeNetworkFailure。
//
// 契约（homebase `GET /api/internal/assignment-history`，见 homebase PR #38）：
//   query: responsibility（模糊）/ assignmentId（精确，至少给一个）/ limit（1-20）
//   header: x-internal-token
//   resp:   { matched:[{id,responsibility,domain,state,activatedAt,schedule,timezone}],
//             history:[{occurredAt,label,status,attempt,retried,reason,id}],
//             ambiguous, truncated }
//   服务端：env 未配/缺头/错值 → 401；两参都不给 → 400；limit 非法 → 400；
//          多命中 → ambiguous:true 且 history:[]；无命中 → matched:[]。
// 纪律：本模块**只读**，绝不构造写请求。

import type { CompanionConfig } from "./config.ts";

export const DEFAULT_LIMIT = 10;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 20;

/** 宿主 fetch 的超时（毫秒）：跨进程调用，必须有上限，避免工具卡死会话 */
export const REQUEST_TIMEOUT_MS = 5000;

export interface QueryInput {
  readonly responsibility?: unknown;
  readonly assignmentId?: unknown;
  readonly limit?: unknown;
}

export interface AssignmentQuery {
  readonly limit: number;
  readonly responsibility?: string;
  readonly assignmentId?: string;
}

export type QueryResult =
  | { readonly ok: true; readonly query: AssignmentQuery }
  | { readonly ok: false; readonly message: string };

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 参数校验：两参至少给一个；limit 缺省 10、非法立即失败（与服务端 400 口径一致） */
export function validateQuery(input: QueryInput): QueryResult {
  const responsibility = asTrimmedString(input.responsibility);
  const assignmentId = asTrimmedString(input.assignmentId);
  if (responsibility === "" && assignmentId === "") {
    return {
      ok: false,
      message: "请至少给出 responsibility（责任描述，模糊匹配）或 assignmentId（精确 id）之一。",
    };
  }

  let limit = DEFAULT_LIMIT;
  const rawLimit = input.limit;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
    const parsed = typeof rawLimit === "number" ? rawLimit : Number(asTrimmedString(rawLimit));
    if (!Number.isInteger(parsed) || parsed < MIN_LIMIT || parsed > MAX_LIMIT) {
      return { ok: false, message: `limit 必须是 ${MIN_LIMIT}-${MAX_LIMIT} 之间的整数。` };
    }
    limit = parsed;
  }

  return {
    ok: true,
    query: {
      limit,
      ...(responsibility !== "" ? { responsibility } : {}),
      ...(assignmentId !== "" ? { assignmentId } : {}),
    },
  };
}

/** 拼 URL：base 去掉尾部斜杠，参数走 URLSearchParams 编码 */
export function buildQueryUrl(config: CompanionConfig, query: AssignmentQuery): string {
  const base = config.bffBase.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (query.responsibility !== undefined) params.set("responsibility", query.responsibility);
  if (query.assignmentId !== undefined) params.set("assignmentId", query.assignmentId);
  params.set("limit", String(query.limit));
  return `${base}/api/internal/assignment-history?${params.toString()}`;
}

/** 超时 + 宿主 signal 合并；宿主没传（或运行时无 AbortSignal.any）则只用超时 */
export function requestSignal(hostSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (hostSignal === undefined) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([timeout, hostSignal]);
  return timeout;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 时间戳收成「YYYY-MM-DD HH:MM」。
 *
 * 契约：BFF 投影的 `occurredAt` / `activatedAt` 都是 **epoch 毫秒 number**
 * （来源 homebase `product_events.occurred_at`，13 位）——**不是** ISO 字符串。
 * 此前的实现只认字符串，导致 history 时间全丢、matched 的「激活」整行被静默丢弃。
 * string 分支仅为向后兼容旧响应/旧 fixture 保留。
 *
 * 时区依据：history 项里**没有** timezone 字段——BFF 只在 matched 上投影 `Asia/Shanghai`；
 * 而 Asia/Shanghai **无夏令时**，故一律按固定 UTC+8 渲染（不读宿主机器时区，避免引入不确定性）。
 */
function shortTime(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  }
  if (typeof value === "string") {
    const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
    if (iso) return `${iso[1]} ${iso[2]}`;
    if (value !== "") return value;
  }
  // 措辞刻意陈述事实：旧文案「时间未知」曾被现场模型当作「无法确认时段」的证据而得出错误结论。
  return "该记录未含执行时刻";
}

function formatMatched(item: unknown): string {
  const record = asRecord(item);
  const responsibility = pickString(record, "responsibility") ?? "（无名称）";
  const id = pickString(record, "id") ?? "?";
  const parts: string[] = [];
  const state = pickString(record, "state");
  if (state !== undefined) parts.push(`状态 ${state}`);
  const domain = pickString(record, "domain");
  if (domain !== undefined) parts.push(`域 ${domain}`);
  const timezone = pickString(record, "timezone");
  const schedule = pickString(record, "schedule");
  if (schedule !== undefined) parts.push(`计划 ${schedule}${timezone !== undefined ? `（${timezone}）` : ""}`);
  const activatedAt = record.activatedAt;
  if (activatedAt !== undefined && activatedAt !== null) parts.push(`激活 ${shortTime(activatedAt)}`);
  const suffix = parts.length > 0 ? `（${parts.join(" / ")}）` : "";
  return `- ${responsibility}（id: ${id}）${suffix}`;
}

function formatHistoryItem(item: unknown, index: number): string {
  const record = asRecord(item);
  const label = pickString(record, "label") ?? "执行";
  const status = pickString(record, "status") ?? "未知状态";
  const bits: string[] = [];
  const attempt = record.attempt;
  if (typeof attempt === "number") bits.push(`第 ${attempt} 次`);
  if (record.retried === true) bits.push("含重试");
  const reason = pickString(record, "reason");
  if (reason !== undefined) bits.push(`原因：${reason}`);
  const detail = bits.length > 0 ? `，${bits.join("，")}` : "";
  return `  ${index + 1}) ${shortTime(record.occurredAt)} ${label} —— ${status}${detail}`;
}

/**
 * 响应 → 给模型读的简洁中文文本。**绝不抛**：形状再怪也退化成「无记录」。
 * @param response 服务端 JSON（已 parse，或任意形状）
 */
export function formatAssignmentHistory(response: unknown): string {
  const record = asRecord(response);
  const matchedRaw = Array.isArray(record.matched) ? record.matched : [];
  const historyRaw = Array.isArray(record.history) ? record.history : [];
  const ambiguous = record.ambiguous === true;
  const truncated = record.truncated === true;

  if (matchedRaw.length === 0) {
    return "没有找到匹配的责任。可以换一个 responsibility 关键词，或改用 assignmentId 精确定位。";
  }

  if (ambiguous || matchedRaw.length > 1) {
    const lines = matchedRaw.map(formatMatched);
    return [
      `匹配到 ${matchedRaw.length} 条责任（不唯一，无法确定要讲哪一条）：`,
      ...lines,
      "请用更精确的 responsibility 或 assignmentId 缩小范围后重试。",
    ].join("\n");
  }

  const head = `匹配到 1 条责任：\n${formatMatched(matchedRaw[0])}`;
  if (historyRaw.length === 0) {
    return `${head}\n暂无执行记录。`;
  }

  const lines = historyRaw.map(formatHistoryItem);
  const tail = truncated ? `\n（仅显示最近 ${historyRaw.length} 条，更早的记录已截断）` : "";
  return `${head}\n最近执行记录（${historyRaw.length} 条）：\n${lines.join("\n")}${tail}`;
}

/** 服务端 JSON 里抽 error 文本（截断），非 JSON 就取前 120 字 */
function errorSnippet(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const error = pickString(asRecord(parsed), "error");
    if (error !== undefined) return `：${error}`;
  } catch {
    // 非 JSON：落到下面按纯文本截断
  }
  const flat = trimmed.replace(/\s+/g, " ");
  return `：${flat.length > 120 ? `${flat.slice(0, 120)}…` : flat}`;
}

/** HTTP 失败 → 中文说明（401 单独说清是 token 问题，不泄露服务端细节） */
export function describeHttpFailure(status: number, body: string): string {
  if (status === 401) {
    return "读取责任历史失败：服务端拒绝（401）——token 未配置或值不正确，请检查 ~/.config/opencode/companion-tools.json 的 token。";
  }
  if (status === 400) {
    return `读取责任历史失败：请求参数被服务端拒绝（400）${errorSnippet(body)}`;
  }
  return `读取责任历史失败：服务端返回 ${status}${errorSnippet(body)}`;
}

/** 网络/超时/取消 → 中文说明 */
export function describeNetworkFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return "读取责任历史失败：请求超时（5 秒）。";
  if (name === "AbortError") return "读取责任历史失败：请求已取消。";
  const message = error instanceof Error ? error.message : String(error);
  return `读取责任历史失败：无法连接 BFF（${message}）。请确认配置里的 bffBase 可达。`;
}

/** 响应不是合法 JSON → 中文说明 */
export function describeParseFailure(): string {
  return "读取责任历史失败：服务端响应不是合法 JSON。";
}

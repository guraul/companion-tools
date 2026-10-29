// companion-tools · today_brief 的纯函数（可单测）
//
// 职责边界（宿主侧 execute 只做接线）：
//   URL 拼装 → buildTodayBriefUrl；响应 → 中文短文 → formatTodayBrief；
//   错误 → 中文文本 → describeTodayBriefHttpFailure / …NetworkFailure / …ParseFailure。
//
// 契约（homebase `GET /api/internal/today-brief`，Ref #153）：
//   header: x-internal-token（fail-closed）
//   resp:   { openAttention:{count,top:[{id,title,summary,createdAt}]},
//             executions:{count,matched,failed},
//             calendar:{count,first:[{time,summary}]},
//             retryReports:[{text,createdAt}],
//             generatedAt }
//   服务端：env 未配 / 缺头 / 错值 → 401；无数据 → 200 + 0 / 空数组（不是 404）。
//   时间字段 createdAt / generatedAt 是 **epoch 毫秒 number**（不是 ISO 字符串）。
//
// 输出是给模型读的**短文本**：≤ MAX_LINES 行，一节一行；任何字段里的换行/长文本都被压平，
// 保证行数上限不受上游脏数据影响。全空 →「今天没有待处理的事。」
// 纪律：本模块只读，绝不构造写请求。

import type { CompanionConfig } from "./config.ts";

/** 给模型读的文本行数上限（需求硬约束） */
export const MAX_LINES = 8;

/** 单条事项文本的字符上限（防止一行被一条长摘要撑爆） */
const MAX_ITEM_CHARS = 40;
/** 「未处理」最多展开几条（count 仍是真实总数） */
const MAX_ATTENTION_ITEMS = 3;
/** 「日程」最多展开几条 */
const MAX_CALENDAR_ITEMS = 3;
/** 「补跑报告」最多展开几条 */
const MAX_RETRY_ITEMS = 2;

/** 全空时的固定回答 */
export const NOTHING_TODAY = "今天没有待处理的事。";

/** 拼 URL：base 去掉尾部斜杠；本端点无查询参数 */
export function buildTodayBriefUrl(config: CompanionConfig): string {
  const base = config.bffBase.replace(/\/+$/, "");
  return `${base}/api/internal/today-brief`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function pickCount(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 压平：折叠所有空白（含换行）并截断——保证「一行 = 一条」，行数上限不被上游文本破坏 */
function flat(value: string): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length > MAX_ITEM_CHARS ? `${one.slice(0, MAX_ITEM_CHARS)}…` : one;
}

/** epoch 毫秒 → 「MM-DD HH:mm」（固定 UTC+8；Asia/Shanghai 无夏令时）；同日省略日期 */
function shortTime(value: unknown, reference: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  const shifted = new Date(value + 8 * 3600_000);
  const iso = shifted.toISOString();
  const stamp = `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  if (typeof reference === "number" && Number.isFinite(reference) && reference > 0) {
    const sameDay = new Date(reference + 8 * 3600_000).toISOString().slice(0, 10) === iso.slice(0, 10);
    if (sameDay) return iso.slice(11, 16);
  }
  return stamp;
}

/** 「A；B；C」+ 剩余未展开提示 */
function joinItems(items: string[], total: number): string {
  const body = items.join("；");
  const rest = total - items.length;
  return rest > 0 ? `${body}（另有 ${rest} 条未列出）` : body;
}

/**
 * 响应 → 给模型读的简短中文文本（≤8 行）。**绝不抛**：形状再怪也退化成明确文案。
 * 空数据（未处理 0 / 执行 0 / 日程 0 / 补跑 0）→「今天没有待处理的事。」
 */
export function formatTodayBrief(response: unknown): string {
  const record = asRecord(response);
  const generatedAt = record.generatedAt;

  const attention = asRecord(record.openAttention);
  const attentionTop = asArray(attention.top);
  const attentionCount = pickCount(attention, "count", attentionTop.length);

  const executions = asRecord(record.executions);
  const executionCount = pickCount(executions, "count", 0);
  const executionMatched = pickCount(executions, "matched", 0);
  const executionFailed = pickCount(executions, "failed", 0);

  const calendar = asRecord(record.calendar);
  const calendarFirst = asArray(calendar.first);
  const calendarCount = pickCount(calendar, "count", calendarFirst.length);

  const retryReports = asArray(record.retryReports);

  const nothingToDo =
    attentionCount === 0 && executionCount === 0 && calendarCount === 0 && retryReports.length === 0;
  if (nothingToDo) return NOTHING_TODAY;

  const lines: string[] = [
    `今天概览：未处理 ${attentionCount} 件 · 执行 ${executionCount} 次（命中 ${executionMatched} / 失败 ${executionFailed}）· 日程 ${calendarCount} 项 · 补跑报告 ${retryReports.length} 条`,
  ];

  if (attentionTop.length > 0) {
    const items = attentionTop.slice(0, MAX_ATTENTION_ITEMS).map((entry) => {
      const item = asRecord(entry);
      const title = flat(pickString(item, "title") ?? "（无标题）");
      const summary = pickString(item, "summary");
      const time = shortTime(item.createdAt, generatedAt);
      const tail = summary !== undefined ? ` — ${flat(summary)}` : "";
      return `${title}${time !== "" ? `（${time}）` : ""}${tail}`;
    });
    lines.push(`未处理：${joinItems(items, Math.max(attentionCount, attentionTop.length))}`);
  }

  if (calendarFirst.length > 0) {
    const items = calendarFirst.slice(0, MAX_CALENDAR_ITEMS).map((entry) => {
      const item = asRecord(entry);
      const time = pickString(item, "time");
      const summary = flat(pickString(item, "summary") ?? "（无标题）");
      return time !== undefined ? `${time} ${summary}` : summary;
    });
    lines.push(`日程：${joinItems(items, Math.max(calendarCount, calendarFirst.length))}`);
  }

  if (retryReports.length > 0) {
    const items = retryReports.slice(0, MAX_RETRY_ITEMS).map((entry) => flat(pickString(asRecord(entry), "text") ?? ""));
    const shown = items.filter((item) => item !== "");
    if (shown.length > 0) {
      lines.push(`补跑报告：${joinItems(shown, retryReports.length)}`);
    } else {
      lines.push(`补跑报告：${retryReports.length} 条（内容为空）`);
    }
  }

  return lines.slice(0, MAX_LINES).join("\n");
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
  const oneLine = trimmed.replace(/\s+/g, " ");
  return `：${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`;
}

/** HTTP 失败 → 中文说明（401 单独说清是 token 问题，不泄露服务端细节） */
export function describeTodayBriefHttpFailure(status: number, body: string): string {
  if (status === 401) {
    return "读取今日概览失败：服务端拒绝（401）——token 未配置或值不正确，请检查 ~/.config/opencode/companion-tools.json 的 token。";
  }
  return `读取今日概览失败：服务端返回 ${status}${errorSnippet(body)}`;
}

/** 网络/超时/取消 → 中文说明 */
export function describeTodayBriefNetworkFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return "读取今日概览失败：请求超时（5 秒）。";
  if (name === "AbortError") return "读取今日概览失败：请求已取消。";
  const message = error instanceof Error ? error.message : String(error);
  return `读取今日概览失败：无法连接 BFF（${message}）。请确认配置里的 bffBase 可达。`;
}

/** 响应不是合法 JSON → 中文说明 */
export function describeTodayBriefParseFailure(): string {
  return "读取今日概览失败：服务端响应不是合法 JSON。";
}

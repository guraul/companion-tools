// companion-tools · Open Thread 的纯函数（可单测）
//
// 契约（homebase `/api/internal/open-threads`，PRODUCT_MODEL §24）：
//   header: x-internal-token（fail-closed）
//   GET  → { threads: [{ id, sessionId, reason, createdAt }] }
//   POST { action:"open",  sessionId, reason } → { thread }
//   POST { action:"close", id, reason? }       → { thread }（404 = 不存在）
//
// 语义纪律（照模型，别自行发明）：
//   · 续接标记只是「这个会话值得回头」的记号——工具**不建会话、不存对话**；
//   · 一个会话最多一条未收口标记（服务端幂等，重复开只更新理由）。

import type { CompanionConfig } from "./config.ts";

export function buildOpenThreadsUrl(config: CompanionConfig): string {
  const base = config.bffBase.replace(/\/+$/, "");
  return `${base}/api/internal/open-threads`;
}

export interface OpenThreadItem {
  id: string;
  sessionId: string;
  reason: string;
  createdAt: number;
}

function clampText(value: unknown, max = 60): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "（未写理由）";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function daysAgo(createdAt: number, now: number): string {
  const days = Math.floor((now - createdAt) / 86_400_000);
  if (days <= 0) return "今天";
  return `${days} 天前`;
}

/** 列表 → 给模型读的短文本（≤6 行）。空列表如实说"没有"。 */
export function formatOpenThreads(
  payload: unknown,
  now: number = Date.now(),
): string {
  const threads = (payload as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(threads) || threads.length === 0) {
    return "没有未收口的续接标记。";
  }

  const lines = threads.slice(0, 5).map((raw) => {
    const item = raw as Partial<OpenThreadItem>;
    const when = typeof item.createdAt === "number" ? daysAgo(item.createdAt, now) : "时间未知";
    return `- ${when}：${clampText(item.reason)}（${String(item.id ?? "?")}）`;
  });

  const extra = threads.length > 5 ? `\n（另有 ${threads.length - 5} 条未列出）` : "";
  return `未收口的续接标记：\n${lines.join("\n")}${extra}`;
}

export function formatOpenedThread(payload: unknown): string {
  const thread = (payload as { thread?: Partial<OpenThreadItem> } | null)?.thread;
  if (!thread?.id) return "已标记，但服务端没回执 id（可能未保存，稍后可复查）。";
  return `记下了：这个话题留着回头继续（${clampText(thread.reason)}）。`;
}

export function formatClosedThread(payload: unknown): string {
  const thread = (payload as { thread?: { id?: string } } | null)?.thread;
  if (!thread?.id) return "已收口。";
  return "这条续接标记已收口。";
}

export function describeOpenThreadHttpFailure(status: number, body: string): string {
  if (status === 404) return "没找到这条续接标记（可能已经收口）。";
  const snippet = body.replace(/\s+/g, " ").slice(0, 120);
  return snippet ? `续接标记接口返回 ${status}：${snippet}` : `续接标记接口返回 ${status}`;
}

export function describeOpenThreadNetworkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `连不上续接标记接口：${message}`;
}

export function describeOpenThreadParseFailure(): string {
  return "续接标记接口返回的内容无法解析。";
}

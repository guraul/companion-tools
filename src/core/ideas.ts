// companion-tools · Raw Idea 的纯函数（可单测）
//
// 契约（homebase 内部端点，PRODUCT_MODEL §27）：
//   POST /api/internal/raw-ideas  { title, content, source } → { ref, title }
//   GET  /api/internal/kb-search?q=&limit=                      → { configured, hits: [{ title, snippet, ref, scope }] }
//   header: x-internal-token（fail-closed）
//
// 语义纪律：RAW IDEA 只入知识库（vault）——**不建 Attention、不建 Open Thread、不建 Assignment、不写 Memory**。
// 存想法不等于要做事；工具文案也不能暗示"我会去做"。

import type { CompanionConfig } from "./config.ts";

function base(config: CompanionConfig): string {
  return config.bffBase.replace(/\/+$/, "");
}

export function buildRawIdeaUrl(config: CompanionConfig): string {
  return `${base(config)}/api/internal/raw-ideas`;
}

export function buildKbSearchUrl(config: CompanionConfig, query: string, limit = 5): string {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return `${base(config)}/api/internal/kb-search?${params.toString()}`;
}

export interface KbHit {
  title?: string;
  snippet?: string;
  ref?: string;
  scope?: string;
}

function clamp(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatSavedIdea(payload: unknown): string {
  const saved = payload as { ref?: unknown; title?: unknown } | null;
  if (!saved || typeof saved.ref !== "string") {
    return "想法已提交，但服务端没回执（可能没存进去，稍后可再试）。";
  }
  return `存下了：${clamp(saved.title, 40)}（知识库里，暂时不需要你做什么）。`;
}

export function formatKbHits(payload: unknown): string {
  const body = payload as { configured?: unknown; hits?: unknown } | null;
  if (!body || body.configured === false) return "知识库没配置，暂时查不了。";
  const hits = Array.isArray(body.hits) ? (body.hits as KbHit[]) : [];
  if (hits.length === 0) return "知识库里没找到相关的想法。";

  const lines = hits.slice(0, 3).map((hit, index) => {
    const title = clamp(hit.title, 40) || "（无标题）";
    const snippet = clamp(hit.snippet, 80);
    return `${index + 1}. ${title}${snippet ? ` — ${snippet}` : ""}`;
  });
  const extra = hits.length > 3 ? `\n（另有 ${hits.length - 3} 条未列出）` : "";
  return `知识库里找到 ${hits.length} 条：\n${lines.join("\n")}${extra}`;
}

export function describeIdeaHttpFailure(scope: string, status: number): string {
  if (status === 503) return "知识库没配置，暂时存不了。";
  return `${scope}接口返回 ${status}。`;
}

export function describeIdeaNetworkFailure(scope: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `连不上${scope}接口：${message}`;
}

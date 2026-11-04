// companion-tools · Decision 的纯函数（可单测）
//
// 契约（homebase 内部端点，PM §29 / homebase #135）：
//   POST /api/internal/decisions  { title, decision, decidedBy, context?, rationale?, domain? } → { ref, title }
//   header: x-internal-token（fail-closed）
//
// 语义纪律：决策只入知识库（wiki/decisions/<slug>.md）——**不建 Attention、不建 Assignment、不建 Open Thread**。
// 决策不等于任务；工具文案也不能暗示"我会去做"。

import type { CompanionConfig } from "./config.ts";

function base(config: CompanionConfig): string {
  return config.bffBase.replace(/\/+$/, "");
}

export function buildDecisionUrl(config: CompanionConfig): string {
  return `${base(config)}/api/internal/decisions`;
}

export function formatSavedDecision(payload: unknown): string {
  const saved = payload as { ref?: unknown; title?: unknown } | null;
  if (!saved || typeof saved.ref !== "string") return "决策已提交，但服务端没回执（可能没存进去）。";
  const title = typeof saved.title === "string" ? saved.title.slice(0, 40) : "";
  return `记下了：${title}（在知识库的决策里）`;
}

export function describeDecisionHttpFailure(status: number): string {
  if (status === 503) return "知识库没配置，暂时记不了决策。";
  return `决策接口返回 ${status}。`;
}

export function describeDecisionNetworkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `连不上决策接口：${message}`;
}

// companion-tools · session_status 的纯函数（可单测）
//
// 数据来源：宿主进程内 `ctx.session.context({ sessionID })` 返回的消息数组
// （v2 SDK 直接返回 `SessionMessageInfo[]`；为兼容旧信封形状，数组/`{messages:[]}` 都认）。
//
// 只读边界：只抽 user / assistant 的**文本**摘要，不透出原始 parts、推理、工具调用、
// 系统提示；每条截断到 ~200 字。错误一律由宿主吞掉转文本，本模块**绝不抛**。

export const DEFAULT_TRANSCRIPT_LIMIT = 5;
export const MAX_TEXT_CHARS = 200;

export interface SessionMessageLike {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
}

export interface TranscriptEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface SessionStatusData {
  readonly sessionID: string;
  readonly title?: string;
  readonly directory?: string;
  readonly messageCount: number;
  readonly transcript: readonly TranscriptEntry[];
  /** 是否因条数上限省略了更早的消息 */
  readonly truncated: boolean;
}

/** 宿主返回形状归一：数组为准、`{messages:[]}` 信封兜底、其余 → 空数组（绝不抛） */
export function toMessages(raw: unknown): SessionMessageLike[] {
  if (Array.isArray(raw)) return raw as SessionMessageLike[];
  if (raw !== null && typeof raw === "object") {
    const inner = (raw as { messages?: unknown }).messages;
    if (Array.isArray(inner)) return inner as SessionMessageLike[];
  }
  return [];
}

/** 助手正文：只取 content 里 type === "text" 的片段 */
function assistantText(message: SessionMessageLike): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (part === null || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function userText(message: SessionMessageLike): string {
  return typeof message.text === "string" ? message.text : "";
}

/** 单条文本收成一行并截断到 maxChars（超出加省略号） */
export function truncateText(text: string, maxChars: number = MAX_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** 最近的 user/assistant 文本摘要（时间序保留，取最后 limit 条） */
export function extractTranscript(
  messages: readonly SessionMessageLike[],
  limit: number = DEFAULT_TRANSCRIPT_LIMIT,
): { readonly entries: TranscriptEntry[]; readonly truncated: boolean } {
  const picked: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      const text = truncateText(userText(message));
      if (text !== "") picked.push({ role: "user", text });
    } else if (message.type === "assistant") {
      const text = truncateText(assistantText(message));
      if (text !== "") picked.push({ role: "assistant", text });
    }
  }
  const truncated = picked.length > limit;
  return { entries: truncated ? picked.slice(picked.length - limit) : picked, truncated };
}

/** 组装最终文本（不含 fallback 措辞，纯排版，便于单测） */
export function formatSessionStatus(data: SessionStatusData): string {
  const header = [
    "会话状态（只读）：",
    `- ID：${data.sessionID}`,
    `- 标题：${data.title !== undefined && data.title !== "" ? data.title : "（无标题）"}`,
    `- 目录：${data.directory !== undefined && data.directory !== "" ? data.directory : "（未知）"}`,
    `- 消息数：${data.messageCount}`,
  ];

  if (data.transcript.length === 0) {
    return [...header, "", "最近没有 user / assistant 文本消息。"].join("\n");
  }

  const body = data.transcript.map(
    (entry) => `[${entry.role === "user" ? "用户" : "助手"}] ${entry.text}`,
  );
  const note = data.truncated ? ["", "（更早的消息已省略）"] : [];
  return [...header, "", `最近 ${data.transcript.length} 条对话摘要：`, ...body, ...note].join("\n");
}

export interface SessionStatusMeta {
  readonly sessionID: string;
  readonly title?: string;
  readonly directory?: string;
}

/** 归一 + 抽摘要 + 排版；形状怪也退化成「空会话」，**绝不抛** */
export function buildSessionStatus(raw: unknown, meta: SessionStatusMeta): string {
  const messages = toMessages(raw);
  const { entries, truncated } = extractTranscript(messages);
  return formatSessionStatus({
    sessionID: meta.sessionID,
    messageCount: messages.length,
    transcript: entries,
    truncated,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.directory !== undefined ? { directory: meta.directory } : {}),
  });
}

/** 取不到会话时的中文说明 */
export function sessionUnavailableMessage(sessionID: string, detail: string): string {
  return `读取会话状态失败（sessionID: ${sessionID}）：${detail}`;
}

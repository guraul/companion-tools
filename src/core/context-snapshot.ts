// companion-tools · 「她此刻的处境」快照（自动注入）
//
// 目的（用户 2026-11-09 拍板）：让她**不用先问**就知道今天有什么等你、你最近在忙什么。
// 现状是每个工具都要她主动调，所以「她知不知道」取决于她有没有想起来问。
//
// 边界：
//   - 只读：只 GET homebase 内部端点，不写任何数据；
//   - 短：注入进 system 的东西每轮都在，必须控制体积（≤ SNAPSHOT_MAX_LINES 行）；
//   - 失败即静默：任一来源失败就少一段，全空则不注入（绝不塞「加载失败」进上下文）；
//   - 只对 companion 生效（宿主侧闸门），不污染 build / plan / general 等 agent。
//
// 数据来源：
//   ① today-brief：今天要你注意的事、执行摘要、会议、补跑报告（已由 today-brief.ts 格式化成短文）；
//   ② project-sessions：最近活跃的**工程**会话（agent ≠ companion），即「你在忙什么」。
//
// 纪律：本模块纯函数为主，fetch 只在 `fetchContextSnapshot` 里，且全部 try-catch。

import type { CompanionConfig } from "./config.ts";
import { DEFAULT_EXCLUDED_DIRECTORIES } from "./config.ts";

/** 注入块的行数上限（含标题行）。 */
export const SNAPSHOT_MAX_LINES = 12;
/** 「最近在忙」最多列几个项目。 */
export const MAX_BUSY_PROJECTS = 3;
/** 单个项目名/标题的字符上限。 */
const MAX_PROJECT_CHARS = 18;
/** 注入块标题：让模型知道这是自动来的、可以无视、也可以去查细节。 */
export const SNAPSHOT_HEADER =
  "【自动注入 · 你此刻的处境（可能滞后几分钟；要细节就调 today_brief / project_sessions）】";

/** 一个工程会话的最小投影。 */
export interface BusySession {
  readonly title?: string | undefined;
  readonly directory: string;
  readonly agent?: string | undefined;
}

/** 目录末段当项目名：`/root/project/homebase` → `homebase`。 */
export function projectNameOf(directory: string): string {
  const trimmed = directory.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  const last = parts[parts.length - 1] ?? "";
  return last.length > 0 ? last : trimmed;
}

/** 目录是否属于「非项目」（与 project_sessions 工具同一判据）。 */
export function isExcludedDirectory(
  directory: string,
  excluded: readonly string[] = DEFAULT_EXCLUDED_DIRECTORIES,
): boolean {
  const norm = directory.replace(/\/+$/, "");
  if (norm === "" || norm === "/") return true;
  return excluded.some((e) => e.replace(/\/+$/, "") === norm);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

/**
 * 「最近在忙」的工程会话 → 一行项目名（去重、按出现顺序）。
 * 过滤：companion 会话不算「在忙的项目」；非项目目录（/root/project 等）跳过；标题为空用目录末段。
 */
export function formatBusyProjects(
  sessions: readonly BusySession[],
  max: number = MAX_BUSY_PROJECTS,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sessions) {
    if (s.agent === "companion") continue;
    if (isExcludedDirectory(s.directory)) continue;
    const name = clip(s.title && s.title.trim().length > 0 ? s.title : projectNameOf(s.directory), MAX_PROJECT_CHARS);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

export interface SnapshotParts {
  /** today-brief 已格式化文本（空串 / undefined 表示没有）。 */
  readonly todayBrief?: string | undefined;
  /** 最近工程会话。 */
  readonly sessions?: readonly BusySession[] | undefined;
}

/**
 * 拼注入块。全空 → `null`（调用方据此什么都不注入）。
 * 输出行数受 `SNAPSHOT_MAX_LINES` 约束，超出截断并加省略号。
 */
export function buildContextSnapshot(parts: SnapshotParts): string | null {
  const lines: string[] = [];

  const brief = (parts.todayBrief ?? "").trim();
  if (brief.length > 0) {
    for (const line of brief.split("\n")) {
      const t = line.trim();
      if (t.length > 0) lines.push(t);
    }
  }

  const busy = formatBusyProjects(parts.sessions ?? []);
  if (busy.length > 0) lines.push(`最近在忙：${busy.join("、")}`);

  if (lines.length === 0) return null;

  // 预算要同时扣掉表头与可能的省略行，否则截断路径会超出 SNAPSHOT_MAX_LINES
  const budget = SNAPSHOT_MAX_LINES - 2;
  const shown = lines.slice(0, budget);
  if (lines.length > budget) shown.push("…（其余略）");
  return [SNAPSHOT_HEADER, ...shown].join("\n");
}

/**
 * 把快照追加进宿主给的 system 片段数组。**幂等**：已含本块表头就不再追加
 * （若宿主跨 step 复用同一数组，重复 push 会让上下文线性膨胀）。
 * 返回是否真的追加了（供接线测试断言）。
 */
export function appendSnapshotToSystem(
  system: Array<{ type: "text"; text: string }> | undefined,
  snapshot: string,
): boolean {
  if (!Array.isArray(system) || snapshot.length === 0) return false;
  const already = system.some(
    (part) => typeof part?.text === "string" && (part.text === snapshot || part.text.startsWith(SNAPSHOT_HEADER)),
  );
  if (already) return false;
  system.push({ type: "text", text: snapshot });
  return true;
}

/** 注入块的总字符上限（防御上游脏数据把 system 撑爆）。 */
export const SNAPSHOT_MAX_CHARS = 1200;

function capChars(text: string): string {
  const chars = Array.from(text);
  return chars.length > SNAPSHOT_MAX_CHARS ? `${chars.slice(0, SNAPSHOT_MAX_CHARS).join("")}…` : text;
}

/** 拉一次快照所需的两个端点的 URL（与既有工具同一拼法：base 去尾斜杠）。 */
export function buildSnapshotUrls(config: CompanionConfig): { brief: string; sessions: string } {
  const base = config.bffBase.replace(/\/+$/, "");
  return {
    brief: `${base}/api/internal/today-brief`,
    sessions: `${base}/api/internal/project-sessions?limit=5`,
  };
}

interface FetchLike {
  (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
}

export interface FetchSnapshotOptions {
  readonly config: CompanionConfig;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
  /** today-brief 的格式化函数（注入以便单测；默认由调用方传入真实实现）。 */
  readonly formatBrief: (parsed: unknown) => string;
}

/**
 * 拉取并拼装快照。任一来源失败 → 该段留空；两段都空 → `null`。
 * **永不抛**：调用方在 hook 里同步使用缓存值，刷新失败只意味着沿用旧快照。
 */
export async function fetchContextSnapshot(options: FetchSnapshotOptions): Promise<string | null> {
  const { config, fetchImpl, formatBrief } = options;
  const timeoutMs = options.timeoutMs ?? 4000;
  const urls = buildSnapshotUrls(config);
  const headers = { "x-internal-token": config.token };

  const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const briefText = await withTimeout(async (signal) => {
    const res = await fetchImpl(urls.brief, { headers, signal });
    if (!res.ok) return "";
    return formatBrief(await res.json());
  });

  const sessions = await withTimeout(async (signal) => {
    const res = await fetchImpl(urls.sessions, { headers, signal });
    if (!res.ok) return [] as BusySession[];
    const body = (await res.json()) as { sessions?: unknown };
    const raw = Array.isArray(body?.sessions) ? body.sessions : [];
    return raw
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
      .map((s) => ({
        title: typeof s.title === "string" ? s.title : undefined,
        directory: typeof s.directory === "string" ? s.directory : "",
        agent: typeof s.agent === "string" ? s.agent : undefined,
      }))
      .filter((s) => s.directory.length > 0);
  });

  const snapshot = buildContextSnapshot({ todayBrief: briefText ?? "", sessions: sessions ?? [] });
  return snapshot === null ? null : capChars(snapshot);
}

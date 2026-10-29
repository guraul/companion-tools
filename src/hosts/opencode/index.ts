// companion-tools · opencode v2 插件壳
//
// 注册四个**只读**工具：
//   - assignment_history  → 经 HTTP 调 homebase 内部只读端点（跨进程，token 鉴权）
//   - project_sessions    → 经 HTTP 调 homebase 内部只读端点；插件侧再过滤为 chatcode 侧
//   - today_brief         → 经 HTTP 调 homebase 内部只读聚合端点（今日全貌，压成 ≤8 行短文本）
//   - session_status      → 进程内 ctx.session.context + ctx.session.get
//                           显式 sessionId 只允许 chatcode 侧；目录不可得 → 保守拒绝。
//
// 红线（与 memx/AGENTS.md 的宿主入口红线同源）：
//   本文件**只 export default 插件**。多导出任何命名符号（函数/常量/类型值）都会被宿主
//   当插件对象去调用而 crash（宿主报 `plugin config hook failed`）。
//   ~/.config/opencode/plugins/companion-tools.ts 同理只 re-export default。
// 纪律：setup 内所有副作用 try-catch，错误绝不抛回宿主；两个工具只读，不写任何数据。
import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfig } from "../../core/config.ts";
import type { CompanionConfig } from "../../core/config.ts";
import {
  buildQueryUrl,
  describeHttpFailure,
  describeNetworkFailure,
  describeParseFailure,
  formatAssignmentHistory,
  requestSignal,
  validateQuery,
} from "../../core/assignment-history.ts";
import {
  buildTodayBriefUrl,
  describeTodayBriefHttpFailure,
  describeTodayBriefNetworkFailure,
  describeTodayBriefParseFailure,
  formatTodayBrief,
} from "../../core/today-brief.ts";
import { buildSessionStatus, sessionUnavailableMessage } from "../../core/session-status.ts";
import {
  buildProjectSessionsUrl,
  describeProjectSessionsHttpFailure,
  describeProjectSessionsNetworkFailure,
  describeProjectSessionsParseFailure,
  formatProjectSessions,
  isProjectDirectory,
  sessionChatScopeMessage,
  sessionScopeUnknownMessage,
  validateProjectSessionsInput,
} from "../../core/project-sessions.ts";

// 装载痕迹落盘位置（可用 COMPANION_TOOLS_LOG 覆盖，测试用 tmp 路径，避免污染真实 HOME）。
const LOG_FILE = process.env.COMPANION_TOOLS_LOG ?? join(homedir(), ".opencode", "companion-tools.log");
// 宿主 storage 键前缀：诊断共用此前缀。
const STORAGE_PREFIX = "companion-tools:";
// 配置路径：~/.config/opencode/companion-tools.json（可选文件；COMPANION_TOOLS_CONFIG 覆盖，测试用）。
const CONFIG_PATH = process.env.COMPANION_TOOLS_CONFIG ?? join(homedir(), ".config", "opencode", "companion-tools.json");

/** 读配置文本：文件不存在 / 读不动 → undefined（parseConfig 会给出「未配置」提示，不抛） */
function readConfigText(): string | undefined {
  try {
    return readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default Plugin.define({
  id: "companion-tools",
  async setup(ctx) {
    // ---- 最小可见痕迹：一行日志 + storage 装载计数（证明插件确实被宿主加载）----
    try {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] loaded id=companion-tools pid=${process.pid} dir=${ctx.location.directory ?? "-"}\n`,
      );
    } catch {
      // trace must never escape
    }

    try {
      const key = `${STORAGE_PREFIX}loads`;
      const prev = (await ctx.storage.get(key)) as number | undefined;
      await ctx.storage.set(key, (typeof prev === "number" ? prev : 0) + 1);
      await ctx.storage.set(`${STORAGE_PREFIX}load`, {
        at: new Date().toISOString(),
        directory: ctx.location.directory ?? "",
      });
    } catch {
      // trace must never escape
    }

    // ---- 切片 2：注册两个只读工具 ----
    // `options: { codemode: false }` 是硬要求：本机 companion 白名单没有 `execute` 的 allow，
    // 不声明则宿主要求走 code-mode 包装（execute 工具）→ 工具彻底不可达（memx 已踩过此坑）。
    try {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "assignment_history",
          description:
            "读取 companion 责任（assignment）的历史执行记录（只读）。可用 responsibility 模糊匹配或用 assignmentId 精确定位，两者至少给一个。经 BFF 内部只读端点查询，结果含匹配到的责任、最近执行结果、是否多命中/被截断。",
          input: {
            type: "object",
            properties: {
              responsibility: {
                type: "string",
                description: "责任描述（模糊匹配，如「交房租」）；与 assignmentId 至少给一个",
              },
              assignmentId: {
                type: "string",
                description: "责任 id（精确匹配，优先于 responsibility）",
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 20,
                description: "最多返回多少条历史记录，缺省 10",
              },
            },
            required: [],
          },
          options: { codemode: false },
          async execute(args, toolCtx) {
            const input = (args ?? {}) as { responsibility?: unknown; assignmentId?: unknown; limit?: unknown };
            try {
              const validation = validateQuery(input);
              if (!validation.ok) return { content: validation.message };

              const configResult = parseConfig(readConfigText());
              if (!configResult.ok) return { content: configResult.message };
              const config: CompanionConfig = configResult.config;

              const url = buildQueryUrl(config, validation.query);
              const response = await fetch(url, {
                method: "GET",
                headers: { "x-internal-token": config.token },
                signal: requestSignal(toolCtx.signal),
              });

              const body = await response.text();
              if (!response.ok) return { content: describeHttpFailure(response.status, body) };

              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                return { content: describeParseFailure() };
              }
              return { content: formatAssignmentHistory(parsed) };
            } catch (error) {
              // 网络 / 超时 / 取消 —— 一律吞掉转文本（绝不抛回宿主）
              return { content: describeNetworkFailure(error) };
            }
          },
        });

        editor.add({
          name: "project_sessions",
          description:
            "列出 chatcode 侧（绑定真实项目目录）的会话，按最近更新倒序（只读）。可给出 projectPath 只看某个项目；伴侣聊天会话（agent 为 companion，或目录为空、根目录、排除目录表里的目录——如 /root/project、伴侣大本营）一律不展示。经 BFF 内部只读端点查询。",
          input: {
            type: "object",
            properties: {
              projectPath: {
                type: "string",
                description: "项目绝对路径（如 /root/project/agent-mobile）；缺省列出所有项目会话",
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 20,
                description: "最多返回多少个会话，缺省 10",
              },
            },
            required: [],
          },
          options: { codemode: false },
          async execute(args, toolCtx) {
            const input = (args ?? {}) as { projectPath?: unknown; limit?: unknown };
            const validation = validateProjectSessionsInput(input);
            if (!validation.ok) return { content: validation.message };

            try {
              const configResult = parseConfig(readConfigText());
              if (!configResult.ok) return { content: configResult.message };

              const url = buildProjectSessionsUrl(configResult.config, validation.query);
              const response = await fetch(url, {
                method: "GET",
                headers: { "x-internal-token": configResult.config.token },
                signal: requestSignal(toolCtx.signal),
              });

              const body = await response.text();
              if (!response.ok) return { content: describeProjectSessionsHttpFailure(response.status, body) };

              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                return { content: describeProjectSessionsParseFailure() };
              }
              // 范围约束 + 分页顺序（issue #9）：URL 里按 resolveFetchLimit 多取，
              // formatProjectSessions 内部再过滤 chat 侧并截断到用户请求的 limit。
              // 排除目录表取自配置（缺省走 DEFAULT_EXCLUDED_DIRECTORIES，issue #11）。
              return {
                content: formatProjectSessions(
                  parsed,
                  validation.query.limit,
                  configResult.config.excludedDirectories,
                ),
              };
            } catch (error) {
              return { content: describeProjectSessionsNetworkFailure(error) };
            }
          },
        });

        editor.add({
          name: "today_brief",
          description: "拿到今天的全貌：未处理事项、执行摘要、日历、会议、补跑报告",
          input: {
            type: "object",
            properties: {},
            required: [],
          },
          options: { codemode: false },
          async execute(_args, toolCtx) {
            try {
              const configResult = parseConfig(readConfigText());
              if (!configResult.ok) return { content: configResult.message };

              const url = buildTodayBriefUrl(configResult.config);
              const response = await fetch(url, {
                method: "GET",
                headers: { "x-internal-token": configResult.config.token },
                signal: requestSignal(toolCtx.signal),
              });

              const body = await response.text();
              if (!response.ok) return { content: describeTodayBriefHttpFailure(response.status, body) };

              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                return { content: describeTodayBriefParseFailure() };
              }
              return { content: formatTodayBrief(parsed) };
            } catch (error) {
              return { content: describeTodayBriefNetworkFailure(error) };
            }
          },
        });

        editor.add({
          name: "session_status",
          description:
            "读取当前（或指定）会话的状态：标题、目录、消息数，以及最近几条 user/assistant 文本摘要（只读，进程内读取；不含系统提示、工具调用与推理内容）。",
          input: {
            type: "object",
            properties: {
              sessionId: { type: "string", description: "要查询的会话 id；缺省为当前会话" },
            },
            required: [],
          },
          options: { codemode: false },
          async execute(args, toolCtx) {
            const input = (args ?? {}) as { sessionId?: unknown };
            const requested =
              typeof input.sessionId === "string" ? input.sessionId.trim() : "";
            const explicitSessionId = requested !== "";
            const sessionID = explicitSessionId ? requested : toolCtx.sessionID;

            // 范围约束（只读 chatcode 侧）：缺省（当前会话）放行；显式 sessionId 必须能取到
            // 目录且属于项目侧。目录取不到 → 保守拒绝（无法判断范围就不放行）。
            if (explicitSessionId) {
              let directory: string | undefined;
              try {
                const info = await ctx.session.get({ sessionID });
                const dir = info.location?.directory;
                if (typeof dir === "string" && dir.trim() !== "") directory = dir;
              } catch {
                return { content: sessionScopeUnknownMessage(sessionID) };
              }
              if (directory === undefined) return { content: sessionScopeUnknownMessage(sessionID) };
              if (!isProjectDirectory(directory)) return { content: sessionChatScopeMessage(sessionID) };
            }

            try {
              const raw = await ctx.session.context({ sessionID });

              // 标题 / 目录：best-effort（宿主不一定支持 session.get；取不到就退化为「未知」）
              let title: string | undefined;
              let directory: string | undefined;
              try {
                const info = await ctx.session.get({ sessionID });
                if (typeof info.title === "string" && info.title !== "") title = info.title;
                const dir = info.location?.directory;
                if (typeof dir === "string" && dir !== "") directory = dir;
              } catch {
                // ignore：退化为「（无标题）/（未知）」
              }
              if (directory === undefined && typeof ctx.location.directory === "string") {
                directory = ctx.location.directory;
              }

              const meta = {
                sessionID,
                ...(title !== undefined ? { title } : {}),
                ...(directory !== undefined ? { directory } : {}),
              };
              return { content: buildSessionStatus(raw, meta) };
            } catch (error) {
              return { content: sessionUnavailableMessage(sessionID, messageOf(error)) };
            }
          },
        });
      });
    } catch {
      // 注册失败绝不抛回宿主；工具缺失由真机验证暴露，不静默兜底。
    }

    return () => {
      // 无状态、无定时器 → 空实现。宿主约定：cleanup 绝不允许抛错。
    };
  },
});

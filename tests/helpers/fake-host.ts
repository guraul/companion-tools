// 测试用宿主替身：只实现本插件真正用到的面（location / storage / session / tool.transform）。
// 抽出来供 plugin-shape 与 tools-integration 共用；文件名不含 .test，vitest 不会当用例跑。

export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  readonly options?: unknown;
  readonly execute: (args: unknown, ctx: unknown) => Promise<{ content?: unknown }>;
}

export interface FakeHost {
  readonly ctx: Record<string, unknown>;
  readonly store: Map<string, unknown>;
  readonly tools: Map<string, RegisteredTool>;
  readonly state: { transformCalls: number; addCalls: number };
  setMessages(raw: unknown): void;
  setSessionInfo(info: unknown): void;
  setSessionGetThrows(value: boolean): void;
}

export function createFakeHost(store: Map<string, unknown> = new Map()): FakeHost {
  const tools = new Map<string, RegisteredTool>();
  const state = { transformCalls: 0, addCalls: 0 };
  let messages: unknown = [];
  let sessionInfo: unknown = {
    id: "ses_test",
    title: "测试会话",
    location: { directory: "/tmp/session-dir" },
  };
  let sessionGetThrows = false;

  const ctx: Record<string, unknown> = {
    location: { directory: "/tmp/companion-tools-test" },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      remove: async (key: string) => {
        store.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    session: {
      context: async () => messages,
      get: async () => {
        if (sessionGetThrows) throw new Error("session.get unavailable");
        return sessionInfo;
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        state.transformCalls++;
        callback({
          list: () => [],
          get: () => undefined,
          namespace: () => {},
          add: (tool: RegisteredTool) => {
            state.addCalls++;
            tools.set(tool.name, tool);
          },
          update: () => {},
          remove: () => {},
        });
        return { dispose: async () => {} };
      },
    },
  };

  return {
    ctx,
    store,
    tools,
    state,
    setMessages(raw) {
      messages = raw;
    },
    setSessionInfo(info) {
      sessionInfo = info;
    },
    setSessionGetThrows(value) {
      sessionGetThrows = value;
    },
  };
}

/** execute 的最小 tool 上下文（本插件只用到 sessionID 与 signal） */
export function fakeToolContext(sessionID = "ses_current"): {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  signal: AbortSignal;
  progress: () => Promise<void>;
} {
  return {
    sessionID,
    agent: "companion",
    messageID: "msg_test",
    id: "call_test",
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

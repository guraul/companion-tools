import { describe, it, expect, vi } from "vitest";
import {
  buildContextSnapshot,
  formatBusyProjects,
  projectNameOf,
  isExcludedDirectory,
  SNAPSHOT_HEADER,
  MAX_BUSY_PROJECTS,
  fetchContextSnapshot,
  appendSnapshotToSystem,
  SNAPSHOT_MAX_LINES,
} from "../src/core/context-snapshot.ts";
import type { CompanionConfig } from "../src/core/config.ts";

const config: CompanionConfig = { bffBase: "http://127.0.0.1:19234", token: "t" };

describe("buildContextSnapshot", () => {
  it("两段都空 → null（不注入噪音）", () => {
    expect(buildContextSnapshot({})).toBeNull();
    expect(buildContextSnapshot({ todayBrief: "   ", sessions: [] })).toBeNull();
  });

  it("只有今日简报 → 标题 + 简报行", () => {
    const out = buildContextSnapshot({ todayBrief: "未处理 2 条\n今日会议 1 个" });
    expect(out).toBe(`${SNAPSHOT_HEADER}\n未处理 2 条\n今日会议 1 个`);
  });

  it("只有最近在忙 → 一行项目名", () => {
    const out = buildContextSnapshot({
      sessions: [
        { directory: "/root/project/agent-mobile", title: "修部署" },
        { directory: "/root/project/memx" },
      ],
    });
    expect(out).toContain("最近在忙：修部署、memx");
  });

  it("行数超上限 → 截断并加「其余略」", () => {
    const brief = Array.from({ length: 20 }, (_, i) => `第 ${i} 行`).join("\n");
    const out = buildContextSnapshot({ todayBrief: brief })!;
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(13); // 12 行上限 + 「…（其余略）」
    expect(out).toContain("其余略");
  });
});

describe("formatBusyProjects", () => {
  it("companion 会话与非项目目录都不算「在忙的项目」", () => {
    expect(
      formatBusyProjects([
        { directory: "/root/project/chat", agent: "companion" },
        { directory: "/root/project" },
        { directory: "/" },
        { directory: "/root/project/memx" },
      ]),
    ).toEqual(["memx"]);
  });

  it("同名项目去重，最多 3 个", () => {
    expect(
      formatBusyProjects([
        { directory: "/a/one" },
        { directory: "/b/one" },
        { directory: "/a/two" },
        { directory: "/a/three" },
        { directory: "/a/four" },
      ]),
    ).toHaveLength(MAX_BUSY_PROJECTS);
  });

  it("标题优先于目录名，超长截断", () => {
    const [name] = formatBusyProjects([{ directory: "/a/x", title: "一个非常非常非常非常非常长的项目标题啊啊" }]);
    expect(name!.endsWith("…")).toBe(true);
  });
});

describe("projectNameOf / isExcludedDirectory", () => {
  it("取目录末段，尾斜杠等价", () => {
    expect(projectNameOf("/root/project/homebase/")).toBe("homebase");
  });
  it("根与空目录视为非项目", () => {
    expect(isExcludedDirectory("/")).toBe(true);
    expect(isExcludedDirectory("")).toBe(true);
    expect(isExcludedDirectory("/root/project")).toBe(true);
    expect(isExcludedDirectory("/root/project/homebase")).toBe(true);
    expect(isExcludedDirectory("/root/project/homebase/sub")).toBe(false);
  });
});

describe("fetchContextSnapshot", () => {
  const okJson = (body: unknown) => ({ ok: true, json: async () => body });

  it("两个端点都成功 → 拼出快照", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("today-brief")
        ? okJson({ openAttention: { count: 1 } })
        : okJson({ sessions: [{ directory: "/root/project/memx", agent: "build" }] }),
    );
    const out = await fetchContextSnapshot({ config, fetchImpl, formatBrief: () => "未处理 1 条" });
    expect(out).toContain("未处理 1 条");
    expect(out).toContain("最近在忙：memx");
  });

  it("简报失败但会话成功 → 只注入「最近在忙」", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("today-brief") ? { ok: false, json: async () => ({}) } : okJson({ sessions: [{ directory: "/root/project/memx" }] }),
    );
    const out = await fetchContextSnapshot({ config, fetchImpl, formatBrief: () => "不该出现" });
    expect(out).not.toContain("不该出现");
    expect(out).toContain("最近在忙：memx");
  });

  it("全失败 → null（不注入错误文案）", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await fetchContextSnapshot({ config, fetchImpl, formatBrief: () => "x" })).toBeNull();
  });
});

describe("appendSnapshotToSystem（hook 接线语义）", () => {
  it("追加一次成功，重复调用不重复追加（幂等）", () => {
    const system: Array<{ type: "text"; text: string }> = [{ type: "text", text: "宿主原有提示" }];
    expect(appendSnapshotToSystem(system, "快照A")).toBe(true);
    expect(appendSnapshotToSystem(system, "快照A")).toBe(false);
    expect(system).toHaveLength(2);
    expect(system[1]!.text).toBe("快照A");
  });

  it("快照为空 / system 不是数组 → 不追加也不抛", () => {
    expect(appendSnapshotToSystem([], "")).toBe(false);
    expect(appendSnapshotToSystem(undefined, "x")).toBe(false);
  });

  it("已含表头的块视为已注入（即使文本不同）", () => {
    const system: Array<{ type: "text"; text: string }> = [{ type: "text", text: `${SNAPSHOT_HEADER}\n旧内容` }];
    expect(appendSnapshotToSystem(system, `${SNAPSHOT_HEADER}\n新内容`)).toBe(false);
    expect(system).toHaveLength(1);
  });
});

describe("行数上限（含表头与省略行）", () => {
  it("截断路径也不超过 SNAPSHOT_MAX_LINES", () => {
    const brief = Array.from({ length: 30 }, (_, i) => `行${i}`).join("\n");
    const out = buildContextSnapshot({ todayBrief: brief })!;
    expect(out.split("\n").length).toBeLessThanOrEqual(SNAPSHOT_MAX_LINES);
    expect(out).toContain("其余略");
  });
});

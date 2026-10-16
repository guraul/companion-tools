// 切片 1 门禁：install.sh 的两条非破坏式承诺。
//   ① 入口文件只 re-export default（宿主入口红线）
//   ② 依赖合并幂等，且绝不覆盖 ~/.config/opencode/package.json 的既有键
// 全部跑在 tmp HOME 上（COMPANION_TOOLS_SKIP_SYNC=1 跳过网络步骤），不碰真实 ~/.config。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WANTED = { "@opencode/plugin": "^2.0.26", "@opencode/client": "^2.0.26" };

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "companion-tools-install-"));
}

function installerOutput(home: string): string {
  return execFileSync("bash", [join(ROOT, "install.sh"), ROOT], {
    env: { ...process.env, HOME: home, COMPANION_TOOLS_SKIP_SYNC: "1" },
    encoding: "utf-8",
  });
}

const entryPath = (home: string): string => join(home, ".config", "opencode", "plugins", "companion-tools.ts");
const pkgPath = (home: string): string => join(home, ".config", "opencode", "package.json");
const read = (file: string): string => readFileSync(file, "utf-8");

describe("install.sh · 入口文件", () => {
  it("写出入口，且全文只有一条 export —— 只 re-export default", () => {
    const home = freshHome();
    installerOutput(home);

    expect(existsSync(entryPath(home))).toBe(true);
    const entry = read(entryPath(home));

    expect(entry).toBe(`export { default } from "${ROOT}/src/hosts/opencode/index";\n`);
    // 红线：任何命名导出都会被宿主当插件调用而 crash
    expect(entry).toMatch(/^export \{ default \} from "[^"]+";\n$/);
    expect(entry.match(/\bexport\b/g)).toHaveLength(1);
    expect(entry).not.toMatch(/export\s+(const|let|var|function|class|type|interface)\b/);
  });

  it("不覆盖别的插件入口（memx.ts 原样留着）", () => {
    const home = freshHome();
    const pluginsDir = join(home, ".config", "opencode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const other = join(pluginsDir, "memx.ts");
    writeFileSync(other, 'export { default } from "/somewhere/memx/src/hosts/opencode/index";\n');

    installerOutput(home);

    expect(read(other)).toBe('export { default } from "/somewhere/memx/src/hosts/opencode/index";\n');
  });
});

describe("install.sh · 依赖合并（幂等 + 非破坏式）", () => {
  it("全新配置目录：补齐两个依赖", () => {
    const home = freshHome();
    installerOutput(home);

    const pkg = JSON.parse(read(pkgPath(home)));
    expect(pkg.dependencies).toMatchObject(WANTED);
  });

  it("已有 package.json：既有键与别的依赖全部保留，只补缺的", () => {
    const home = freshHome();
    const configDir = join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      pkgPath(home),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          name: "my-opencode-config",
          dependencies: { "@opencode/plugin": "^2.0.26", lodash: "^4.17.21" },
          scripts: { doctor: "echo hi" },
        },
        null,
        2,
      ) + "\n",
    );

    installerOutput(home);

    const pkg = JSON.parse(read(pkgPath(home)));
    expect(pkg.$schema).toBe("https://opencode.ai/config.json");
    expect(pkg.name).toBe("my-opencode-config");
    expect(pkg.scripts).toEqual({ doctor: "echo hi" });
    expect(pkg.dependencies.lodash).toBe("^4.17.21");
    expect(pkg.dependencies["@opencode/plugin"]).toBe("^2.0.26");
    expect(pkg.dependencies["@opencode/client"]).toBe("^2.0.26");
  });

  it("跑两次结果逐字节一致（幂等）", () => {
    const home = freshHome();

    const first = installerOutput(home);
    const pkgAfterFirst = read(pkgPath(home));
    const entryAfterFirst = read(entryPath(home));

    const second = installerOutput(home);
    expect(read(pkgPath(home))).toBe(pkgAfterFirst);
    expect(read(entryPath(home))).toBe(entryAfterFirst);

    // 第二次不该再"补"任何东西
    expect(second).toMatch(/dependencies already present, nothing to change/);
    expect(first).toMatch(/added: .*@opencode\/plugin/);
  });
});

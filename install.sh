#!/usr/bin/env bash
set -euo pipefail

# companion-tools installer —— 镜像 memx 的安装套路（见 memx/install.sh）：
#   仓 → 依赖 → 插件入口 → （重启宿主）
# 比 memx 少两步：本仓没有协议文件、也不需要动 opencode.json 的 instructions。
#
# 非破坏式承诺（红线）：
#   - 只往 ~/.config/opencode/package.json **合并**依赖：缺什么补什么，
#     绝不覆盖 / 重排 / 删除其它已存在的键（别的插件的依赖原样保留）
#   - 只写自己的入口 ~/.config/opencode/plugins/companion-tools.ts，绝不动别的插件入口
#   - 幂等：重复执行结果一致（没有变化就不重写文件）
#
# 用法: bash install.sh [repo-path]
#   默认 repo-path: ~/workspace/companion-tools（与开发检出同一路径，只维护一份）
#   环境变量 COMPANION_TOOLS_SKIP_SYNC=1 → 跳过「仓同步 + pnpm install」两步，
#   供测试（用 tmp HOME、无网络）或已就绪的检出使用。

REPO_PATH="${1:-$HOME/workspace/companion-tools}"
OCP_CONFIG_DIR="$HOME/.config/opencode"
# 远端一律走 SSH：生产服务器用 https 拉取会报 `GnuTLS recv error (-110)`（2026-10-29）。
REPO_URL="git@github.com:guraul/companion-tools.git"

echo "=== companion-tools installer ==="
echo "Repo path: $REPO_PATH"
echo "Config dir: $OCP_CONFIG_DIR"
echo ""

# Step 1: 仓（clone 或 ff-only pull）
if [ "${COMPANION_TOOLS_SKIP_SYNC:-0}" = "1" ]; then
  echo "[1/4] Skipping repo sync (COMPANION_TOOLS_SKIP_SYNC=1)"
elif [ -d "$REPO_PATH/.git" ]; then
  echo "[1/4] Repo exists, pulling latest..."
  # 老检出可能还是 https 远端：就地改写成 SSH（幂等，已是 SSH 则跳过）。
  current_url="$(git -C "$REPO_PATH" remote get-url origin 2>/dev/null || true)"
  if [ "$current_url" != "$REPO_URL" ]; then
    echo "  -> rewriting origin: ${current_url:-<missing>} -> $REPO_URL"
    if ! git -C "$REPO_PATH" remote set-url origin "$REPO_URL"; then
      echo "  !! failed to rewrite origin of $REPO_PATH to $REPO_URL" >&2
      echo "     Fix by hand: git -C $REPO_PATH remote set-url origin $REPO_URL" >&2
      exit 1
    fi
  fi
  if ! git -C "$REPO_PATH" pull --ff-only; then
    echo "  !! git pull --ff-only failed in $REPO_PATH (remote: $REPO_URL)" >&2
    echo "     Check SSH access: ssh -T git@github.com" >&2
    exit 1
  fi
else
  echo "[1/4] Cloning repo..."
  # 父目录必须先建出来：默认值在 ~/workspace/ 下，干净机器上这个母目录不一定存在。
  mkdir -p "$(dirname "$REPO_PATH")"
  if ! git clone "$REPO_URL" "$REPO_PATH"; then
    echo "  !! git clone failed: $REPO_URL -> $REPO_PATH" >&2
    echo "     Check SSH access: ssh -T git@github.com" >&2
    exit 1
  fi
fi
echo ""

# Step 2: 依赖（包管理器统一 pnpm；仓库只维护 pnpm-lock.yaml）
if [ "${COMPANION_TOOLS_SKIP_SYNC:-0}" = "1" ]; then
  echo "[2/4] Skipping dependency install (COMPANION_TOOLS_SKIP_SYNC=1)"
else
  echo "[2/4] Installing dependencies (pnpm)..."
  cd "$REPO_PATH"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
  else
    echo "  !! pnpm not found. Install it (corepack enable pnpm) and re-run; npm/yarn/bun are not used in this repo."
    exit 1
  fi
fi
echo ""

# Step 3: 插件入口
# 入口**只 re-export default**（命名导出会被宿主当插件调用而 crash）。
# 入口里的路径要能被宿主的模块解析器直接 load，故指向 src/hosts/opencode/index（不带扩展名，同 memx）。
echo "[3/4] Creating plugin entry..."
mkdir -p "$OCP_CONFIG_DIR/plugins"
cat > "$OCP_CONFIG_DIR/plugins/companion-tools.ts" <<EOF
export { default } from "$REPO_PATH/src/hosts/opencode/index";
EOF
echo "  -> $OCP_CONFIG_DIR/plugins/companion-tools.ts"
echo ""

# Step 4: 依赖自愈（往 ~/.config/opencode/package.json 合并，不覆盖既有键）
# 宿主从配置目录解析插件依赖；本插件只需要 @opencode/plugin（plugin 定义的入口）
# 与 @opencode/client（domain 类型来源），版本与 memx 保持一致。
echo "[4/4] Ensuring dependencies declared..."
if ! command -v node >/dev/null 2>&1; then
  echo "  !! node not found on PATH; cannot merge dependencies by hand. Add to $OCP_CONFIG_DIR/package.json:"
  echo '     "@opencode/plugin": "^2.0.26", "@opencode/client": "^2.0.26"'
  exit 1
fi

node - "$OCP_CONFIG_DIR/package.json" <<'NODE'
const fs = require("fs");
const path = require("path");
const file = process.argv[2];

// 与 memx/install.sh 相同的版本 pin（memx/package.json 是单一事实源；升级时两边一起动）
const WANTED = {
  "@opencode/plugin": "^2.0.26",
  "@opencode/client": "^2.0.26",
};

let pkg;
if (fs.existsSync(file)) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error("  !! " + file + " unreadable - fix by hand, nothing written (" + err.message + ")");
    process.exit(1);
  }
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    console.error("  !! " + file + " is not valid JSON - fix by hand, nothing written (" + err.message + ")");
    process.exit(1);
  }
} else {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  pkg = {};
  console.log("  -> created " + file);
}
if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
  console.error("  !! " + file + " is not a JSON object - fix by hand, nothing written");
  process.exit(1);
}
if (!Object.prototype.hasOwnProperty.call(pkg, "dependencies")) {
  pkg.dependencies = {};
} else if (pkg.dependencies === null || typeof pkg.dependencies !== "object" || Array.isArray(pkg.dependencies)) {
  console.error('  !! "dependencies" exists but is not an object - fix by hand, nothing written');
  process.exit(1);
}

// 只补缺失的键：已有的版本、别的插件的依赖、以及任何其它顶层键一律原样保留。
const added = [];
for (const [name, spec] of Object.entries(WANTED)) {
  if (!Object.prototype.hasOwnProperty.call(pkg.dependencies, name)) {
    pkg.dependencies[name] = spec;
    added.push(name + '@' + spec);
  }
}

if (added.length === 0) {
  console.log("  -> dependencies already present, nothing to change");
} else {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log("  -> added: " + added.join(", "));
}
NODE
echo "  -> $OCP_CONFIG_DIR/package.json"
echo ""

echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart OpenCode (plugins load once at startup):"
echo "     systemctl restart opencode-4096   # 生产宿主机；本机开发请重启你自己的 serve/CLI"
echo "  2. Verify loaded: tail -n 20 ~/.opencode/companion-tools.log"
echo "     (one line per host start; absence means the host did not load the plugin)"
echo "  3. Rollback: rm $OCP_CONFIG_DIR/plugins/companion-tools.ts && restart the host"

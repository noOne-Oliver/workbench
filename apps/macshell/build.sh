#!/usr/bin/env bash
# 构建工作台 macOS 外壳：swiftc 编译 → 组装 dist/Workbench.app（含内核）→ ad-hoc 签名。
# 产物自带 node + 内核（src/ + web/），脱离仓库也能运行；数据写在用户选择的工作区，不在 app 里。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/Workbench.swift"
DIST="$ROOT/dist"
APP="$DIST/Workbench.app"
MACOS_DIR="$APP/Contents/MacOS"
KERNEL="$APP/Contents/Resources/kernel"
PLIST="$APP/Contents/Info.plist"

echo "==> 1/6 检查工具链"
command -v swiftc >/dev/null 2>&1 || {
  echo "错误：找不到 swiftc。请安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
}
SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
if [ -z "$SDK" ]; then
  echo "错误：xcrun --show-sdk-path 拿不到 macOS SDK（需要 Command Line Tools 或 Xcode）" >&2
  exit 1
fi
[ -f "$SRC" ] || { echo "错误：找不到源文件 $SRC" >&2; exit 1; }
echo "    swiftc: $(swiftc --version 2>/dev/null | head -1)"
echo "    SDK:    $SDK"

# 打包用的 node：WB_NODE 优先，否则从 PATH 里取；cp -L 跟着符号链接复制真实文件。
NODE_SRC="${WB_NODE:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_SRC" ] || [ ! -x "$NODE_SRC" ]; then
  echo "错误：找不到可执行的 node（>=22.5）。装一个 Node.js，或 WB_NODE=/path/to/node bash apps/macshell/build.sh" >&2
  exit 1
fi
echo "    node:   $NODE_SRC ($("$NODE_SRC" --version 2>/dev/null || echo '?'))"

echo "==> 2/6 清理并准备 $APP"
rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$KERNEL"

echo "==> 3/6 编译 Workbench.swift（-O，arm64-apple-macos13.0）"
# 模块缓存放进工作区，避免在 /var/folders 的 clang ModuleCache 上被沙箱拒绝。
MODULE_CACHE="$DIST/.modulecache"
mkdir -p "$MODULE_CACHE"
swiftc -O -swift-version 5 -parse-as-library \
  -target arm64-apple-macos13.0 \
  -sdk "$SDK" \
  -module-cache-path "$MODULE_CACHE" \
  -framework AppKit \
  -framework WebKit \
  -o "$MACOS_DIR/Workbench" \
  "$SRC"

echo "==> 4/6 把内核打包进 Contents/Resources/kernel"
# 布局：kernel/{node, package.json, src/, web/}
# 不带 data/ worktrees/ .git/ tests/ scripts/ .oc/ .bench/ .demo/ —— 那些是仓库的开发产物。
cp -L "$NODE_SRC" "$KERNEL/node"          # -L：homebrew 的 node 是符号链接，复制真实文件
chmod +x "$KERNEL/node"

# homebrew 的 node 是动态链接的：二进制还依赖 @rpath/libnode.NN.dylib（不在 /usr/lib 里）。
# 一起拷进 kernel/——node 的 LC_RPATH 含 @loader_path，正好从同目录命中，app 才不会 "Library not loaded"。
NODE_REAL="$NODE_SRC"
if command -v readlink >/dev/null 2>&1; then
  NODE_REAL="$(readlink -f "$NODE_SRC" 2>/dev/null || printf '%s' "$NODE_SRC")"
fi
NODE_LIB="$(cd "$(dirname "$NODE_REAL")/../lib" 2>/dev/null && pwd || true)"
DYLIB_COUNT=0
if [ -n "$NODE_LIB" ] && [ -d "$NODE_LIB" ]; then
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    base="$(basename "$dep")"
    if [ -f "$NODE_LIB/$base" ]; then
      cp -L "$NODE_LIB/$base" "$KERNEL/$base"
      DYLIB_COUNT=$((DYLIB_COUNT + 1))
    else
      echo "    警告：找不到 @rpath 依赖 $dep（在 $NODE_LIB 里）" >&2
    fi
  done < <(otool -L "$NODE_REAL" 2>/dev/null | awk '/@rpath\//{print $1}')
fi
echo "    @rpath 依赖: $DYLIB_COUNT 个（从 $NODE_LIB 复制）"
mkdir -p "$KERNEL/src" "$KERNEL/web"
cp -R "$ROOT/src/." "$KERNEL/src/"
cp -R "$ROOT/web/." "$KERNEL/web/"
cp "$ROOT/package.json" "$KERNEL/package.json"
# 逐个删（不用 find -delete：那是不可逆的批量删除，安全网会拦）
find "$KERNEL" -name '.DS_Store' -print -exec rm -f {} + 2>/dev/null || true

# 断言产物：该在的在，不该带的没带（打包错了要在这里就炸，而不是等用户双击）。
for f in node package.json src/server/index.mjs src/cli.mjs src/core/workspace.mjs web/index.html; do
  [ -e "$KERNEL/$f" ] || { echo "错误：产物缺少 kernel/$f" >&2; exit 1; }
done
for bad in data worktrees .git tests scripts .oc .bench .demo node_modules; do
  if [ -e "$KERNEL/$bad" ]; then
    echo "错误：产物不应包含 kernel/$bad（打包只该带运行所需文件）" >&2
    exit 1
  fi
done
echo "    产物内核: $KERNEL"
echo "    大小:     $(du -sh "$KERNEL" | cut -f1)（node $(du -sh "$KERNEL/node" | cut -f1) + src/ + web/）"

echo "==> 5/6 写 Info.plist（内核随包，不再写仓库路径）"
cat > "$PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleExecutable</key>
  <string>Workbench</string>
  <key>CFBundleIdentifier</key>
  <string>local.workbench.shell</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Workbench</string>
  <key>CFBundleDisplayName</key>
  <string>工作台</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.0</string>
  <key>CFBundleVersion</key>
  <string>2</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null
echo "    Info.plist OK"

echo "==> 6/6 ad-hoc 签名"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --verbose=1 "$APP" 2>&1 | sed 's/^/    /'
echo "    签名 OK（ad-hoc，仅本机可运行）"

echo
echo "产物: $APP"
echo "运行: open -a \"$APP\"        # 首次启动会让你选工作区"
echo "自检: WB_WORKSPACE=\"$HOME/Workbench\" WB_SHELL_SMOKE=1 \"$MACOS_DIR/Workbench\""

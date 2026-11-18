#!/usr/bin/env bash
# 构建工作台 macOS 外壳：swiftc 编译 → 组装 dist/Workbench.app → ad-hoc 签名。
# 零第三方依赖：只要 Command Line Tools 里的 swiftc + 系统框架（AppKit / WebKit）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/Workbench.swift"
DIST="$ROOT/dist"
APP="$DIST/Workbench.app"
MACOS_DIR="$APP/Contents/MacOS"
PLIST="$APP/Contents/Info.plist"

echo "==> 1/5 检查工具链"
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

echo "==> 2/5 清理并准备 $APP"
rm -rf "$APP"
mkdir -p "$MACOS_DIR"

echo "==> 3/5 编译 Workbench.swift（-O，arm64-apple-macos13.0）"
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

echo "==> 4/5 写 Info.plist（WBRepoRoot=${ROOT}）"
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
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>WBRepoRoot</key>
  <string></string>
</dict>
</plist>
PLIST
plutil -replace WBRepoRoot -string "$ROOT" "$PLIST"
plutil -lint "$PLIST" >/dev/null
echo "    Info.plist OK"

echo "==> 5/5 ad-hoc 签名"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --verbose=1 "$APP" 2>&1 | sed 's/^/    /'
echo "    签名 OK（ad-hoc，仅本机可运行）"

echo
echo "产物: $APP"
echo "自检: WB_SHELL_SMOKE=1 \"$MACOS_DIR/Workbench\""

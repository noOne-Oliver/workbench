#!/usr/bin/env bash
# 把已构建的 dist/Workbench.app 打成可下载的 DMG + ZIP。
# 不做签名/公证（没有开发者证书，那一步无法自动化），所以下载后第一次打开需要用户手动放行，见 README。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$ROOT/dist/Workbench.app"
VERSION="$(node -p "require('$ROOT/package.json').version")"

[ -d "$APP" ] || { echo "错误：没有 $APP，先跑 bash apps/macshell/build.sh" >&2; exit 1; }

echo "==> 1/2 DMG（拖进应用程序就能装）"
DMG="$ROOT/dist/Workbench-$VERSION.dmg"
rm -f "$DMG"
# 受限环境（沙箱/CI）里 hdiutil 会失败：那不是致命错误，ZIP 一样能装，别让它拦住发布
if hdiutil create -quiet -volname "工作台 $VERSION" -srcfolder "$APP" -ov -format UDZO "$DMG" 2>/dev/null; then
  echo "    $DMG  $(du -h "$DMG" | cut -f1)"
else
  echo "    跳过 DMG（hdiutil 在这个环境不可用），只出 ZIP"
fi

echo "==> 2/2 ZIP（命令行/脚本用）"
ZIP="$ROOT/dist/Workbench-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "    $ZIP  $(du -h "$ZIP" | cut -f1)"

echo
echo "sha256:"
(cd "$ROOT/dist" && shasum -a 256 Workbench-"$VERSION"*.dmg Workbench-"$VERSION".zip 2>/dev/null | sed 's/^/    /')
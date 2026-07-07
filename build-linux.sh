#!/usr/bin/env bash
set -euo pipefail

#
# SPlayer-Next Linux 全量构建脚本
# 构建顺序：
#   1. pnpm build:linux  → 生成 AppImage + tar.gz（与 electron-builder 配置一致）
#   2. 从 linux-unpacked 构建 Arch Linux pacman 包
#
# 使用方式：
#   chmod +x build-linux.sh
#   ./build-linux.sh
#
# 产物输出：
#   dist/splayer-next-${version}-x86_64.AppImage   — 便携式 AppImage
#   dist/splayer-next-${version}-x64.tar.gz        — 通用压缩包
#   dist/pkgbuild/splayer-next-*.pkg.tar.zst      — Arch Linux 包
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo " SPlayer-Next Linux Build"
echo "=========================================="

# ------------------------------------------------------------------
# 步骤 1：构建 electron-builder 产物（AppImage + tar.gz）
# ------------------------------------------------------------------
echo ""
echo ">> [1/2] 构建 electron-builder 产物..."

if ! command -v pnpm &>/dev/null; then
  echo "ERROR: pnpm 未安装，请先安装 Node.js >=22 和 pnpm"
  exit 1
fi

pnpm build:linux || {
  echo ""
  echo "⚠ pnpm build:linux 失败（deb 因缺少 libcrypt.so.1 可能报错，不影响 AppImage/tar.gz）"
  echo "  继续构建 pacman 包..."
}

# ------------------------------------------------------------------
# 步骤 2：从 linux-unpacked 构建 pacman 包
# ------------------------------------------------------------------
echo ""
echo ">> [2/2] 构建 pacman 包..."

PKGBUILD_DIR="dist/pkgbuild"
UNPACKED_DIR="dist/linux-unpacked"

if [ ! -d "$UNPACKED_DIR" ]; then
  echo "ERROR: 未找到 $UNPACKED_DIR，请先确保构建成功"
  exit 1
fi

mkdir -p "$PKGBUILD_DIR"

# 复制 PKGBUILD 和 install 文件（脚本内置，不依赖 dist 目录下的版本）
cat > "$PKGBUILD_DIR/PKGBUILD" <<'PKGBUILD_EOF'
# Maintainer: SPlayer-Dev
pkgname=splayer-next
pkgver=1.0.0
pkgrel=1
pkgdesc="A modern cross-platform music player built with Electron, Vue 3, and TypeScript"
arch=('x86_64')
url="https://splayer.imsyy.top"
license=('AGPL3')
depends=(
  'gtk3'
  'libnotify'
  'nss'
  'libxss'
  'libxtst'
  'xdg-utils'
  'at-spi2-core'
  'libsecret'
  'libappindicator'
)
optdepends=(
  'pipewire: audio playback'
  'pulseaudio: audio playback'
)
source=("splayer-next.tar.gz")
md5sums=('SKIP')
install=splayer-next.install

package() {
  install -d "${pkgdir}/opt/SPlayer-Next"
  cp -r "${srcdir}/splayer-next/"* "${pkgdir}/opt/SPlayer-Next/"

  chmod 4755 "${pkgdir}/opt/SPlayer-Next/chrome-sandbox"

  install -Dm755 /dev/stdin "${pkgdir}/usr/bin/SPlayer-Next" <<'WRAPPER'
#!/bin/sh
exec /opt/SPlayer-Next/SPlayer-Next "$@"
WRAPPER

  install -Dm644 /dev/stdin "${pkgdir}/usr/share/applications/top.imsyy.splayer_next.desktop" <<DESKTOP
[Desktop Entry]
Name=SPlayer-Next
Comment=A modern cross-platform music player
Exec=/opt/SPlayer-Next/SPlayer-Next %U
Terminal=false
Type=Application
Icon=SPlayer-Next
StartupWMClass=SPlayer-Next
Categories=Audio;Music;AudioVideo;
MimeType=x-scheme-handler/orpheus;
DESKTOP

  install -Dm644 "${srcdir}/splayer-next/resources/app.asar.unpacked/public/icons/favicon-512x512.png" \
    "${pkgdir}/usr/share/icons/hicolor/512x512/apps/SPlayer-Next.png"

  for size in 16 32 96 192 256; do
    icon_src="${srcdir}/splayer-next/resources/app.asar.unpacked/public/icons/favicon-${size}x${size}.png"
    if [ -f "$icon_src" ]; then
      install -Dm644 "$icon_src" \
        "${pkgdir}/usr/share/icons/hicolor/${size}x${size}/apps/SPlayer-Next.png"
    fi
  done

  install -Dm644 "${srcdir}/splayer-next/resources/app.asar.unpacked/public/icons/logo-icon.png" \
    "${pkgdir}/usr/share/icons/hicolor/1024x1024/apps/SPlayer-Next.png"

  install -Dm644 "${srcdir}/splayer-next/resources/apparmor-profile" \
    "${pkgdir}/etc/apparmor.d/top.imsyy.splayer_next"
}
PKGBUILD_EOF

cat > "$PKGBUILD_DIR/splayer-next.install" <<'INSTALL_EOF'
post_install() {
  update-desktop-database -q 2>/dev/null || true
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
  update-mime-database /usr/share/mime 2>/dev/null || true
}
post_upgrade() {
  post_install
}
pre_remove() {
  :
}
post_remove() {
  post_install
}
INSTALL_EOF

# 清理旧的构建产物
cd "$PKGBUILD_DIR"
rm -rf src pkg splayer-next splayer-next.tar.gz *.pkg.tar.zst

# 复制 linux-unpacked 并打包为 source tarball
cp -a ../../"$UNPACKED_DIR" splayer-next
tar czf splayer-next.tar.gz splayer-next/
rm -rf splayer-next

# 运行 makepkg
makepkg -f --clean 2>&1

cd "$SCRIPT_DIR"

# ------------------------------------------------------------------
# 摘要
# ------------------------------------------------------------------
echo ""
echo "=========================================="
echo " 构建完成！"
echo "=========================================="
echo ""

APPIMAGE=$(ls dist/splayer-next-*-x86_64.AppImage 2>/dev/null || true)
TGZ=$(ls dist/splayer-next-*-x64.tar.gz 2>/dev/null || true)
PACMAN=$(ls dist/pkgbuild/splayer-next-*.pkg.tar.zst 2>/dev/null || true)

if [ -n "$APPIMAGE" ]; then
  echo "  AppImage:   $(ls -lh "$APPIMAGE" | awk '{print $5}')  $APPIMAGE"
fi
if [ -n "$TGZ" ]; then
  echo "  tar.gz:     $(ls -lh "$TGZ" | awk '{print $5}')  $TGZ"
fi
if [ -n "$PACMAN" ]; then
  echo "  pacman:     $(ls -lh "$PACMAN" | awk '{print $5}')  $PACMAN"
fi
echo ""
echo " 安装 pacman 包："
echo "    sudo pacman -U $PACMAN"
echo " 运行 AppImage："
echo "    chmod +x $APPIMAGE && ./$APPIMAGE"
echo ""

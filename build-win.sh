#!/bin/bash
# Windows exe 本地构建脚本（直接安装 wine）
# 使用方法: bash scripts/build-win.sh
set -e

cd "$(dirname "$0")/.."

echo "=== 1. 安装 wine + mingw-w64 ==="
sudo pacman -S --noconfirm wine mingw-w64-gcc

echo "=== 2. 添加 Rust Windows 目标 ==="
rustup target add x86_64-pc-windows-gnu

echo "=== 3. 交叉编译原生模块 ==="
cd native/audio-engine &&   napi build --platform --release --target x86_64-pc-windows-gnu && cd "$OLDPWD"
cd native/media-ctrl &&     napi build --platform --release --target x86_64-pc-windows-gnu && cd "$OLDPWD"
cd native/taskbar-lyric &&  napi build --platform --release --target x86_64-pc-windows-gnu && cd "$OLDPWD"
cd native/taskbar-thumbnail && napi build --platform --release --target x86_64-pc-windows-gnu && cd "$OLDPWD"

echo "=== 4. 构建 Windows exe ==="
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
pnpm build && tsx scripts/gen-license.ts && electron-builder --config electron-builder.config.ts --win

echo "=== 5. 清理 ==="
# Rust 交叉编译产物
cargo clean --manifest-path native/audio-engine/Cargo.toml
cargo clean --manifest-path native/media-ctrl/Cargo.toml
cargo clean --manifest-path native/taskbar-lyric/Cargo.toml
cargo clean --manifest-path native/taskbar-thumbnail/Cargo.toml
# Windows .node 文件
find native -name "*.win32-x64-*.node" -delete
# 构建中间目录
rm -rf build out node_modules/.cache .pnpm-store
# wine 虚拟 C: 盘（~1.2GB）
rm -rf ~/.wine

echo "=== 完成 ==="
echo "产物:"
ls -lh dist/*.{exe,msi} 2>/dev/null || echo "dist/ 目录中未找到 exe"

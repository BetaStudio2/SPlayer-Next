#!/usr/bin/env bash
# ============================================================
# SPlayer-Next 多架构 Docker 构建（docker buildx）
#
# 目标架构：
#   - linux/amd64   (x86_64)
#   - linux/arm64   (ARM v8 / aarch64)
#   - linux/arm/v7  (ARM v7)
#
# 特性：
#   - 使用 Dockerfile.cn（国内源加速）
#   - 自动创建/复用 buildx builder（含 QEMU 跨架构模拟）
#   - 逐架构构建并 --load 到本地（带架构后缀 tag）
#   - 构建后导出 .tar 镜像包到 dist/images/（可用 NO_EXPORT=1 跳过）
#   - 构建完成后自动清理：buildx builder 实例 + 构建缓存 + 悬空镜像 + 旧版同架构镜像
#
# 用法：
#   chmod +x build-multiarch.sh
#   ./build-multiarch.sh                # 构建全部架构 + 导出镜像包
#   ./build-multiarch.sh amd64          # 仅构建 amd64
#   ./build-multiarch.sh arm64 armv7    # 仅构建 arm64 + armv7
#   NO_EXPORT=1 ./build-multiarch.sh    # 跳过镜像包导出
#   NO_CLEANUP=1 ./build-multiarch.sh   # 跳过自动清理
#   KEEP_BUILDER=1 ./build-multiarch.sh # 保留 buildx builder 实例（默认构建后移除）
#   EXPORT_DIR=./out VERSION_TAG=v1.0 ./build-multiarch.sh  # 自定义导出路径与版本标签
# ============================================================
set -euo pipefail

# ---------- 配置 ----------
IMAGE_NAME="splayer-next"
DOCKERFILE="Dockerfile.cn"
BUILDER_NAME="splayer-multiarch"

# 镜像包导出目录（NO_EXPORT=1 跳过导出）
EXPORT_DIR="${EXPORT_DIR:-dist/images}"
VERSION_TAG="${VERSION_TAG:-$(date +%Y%m%d-%H%M)}"

# 架构映射：buildx platform → 本地 tag 后缀
declare -A PLATFORM_MAP=(
  ["amd64"]="linux/amd64"
  ["arm64"]="linux/arm64"
  ["armv7"]="linux/arm/v7"
)

# 默认构建全部架构
TARGET_ARCHS=("$@")
if [[ ${#TARGET_ARCHS[@]} -eq 0 ]]; then
  TARGET_ARCHS=("amd64" "arm64" "armv7")
fi

# 颜色输出
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

log()  { echo -e "${GREEN}[build]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }
step() { echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n${BLUE}▶ $*${NC}\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ---------- 前置检查 ----------
step "前置检查"

if ! command -v docker &>/dev/null; then
  err "未找到 docker，请先安装 Docker"
  exit 1
fi

if ! docker buildx version &>/dev/null; then
  err "未找到 docker buildx，请安装 buildx 插件（Docker 20.10+ 内置）"
  exit 1
fi

log "Docker: $(docker --version)"
log "buildx: $(docker buildx version 2>&1 | head -1)"

# 检查 Docker 守护进程是否运行（buildx 任何驱动都依赖 daemon）
if ! docker info &>/dev/null; then
  err "Docker 守护进程未运行（无法连接 /var/run/docker.sock）"
  echo ""
  echo "  请先启动 Docker："
  echo "    sudo systemctl start docker      # 启动"
  echo "    sudo systemctl enable docker     # 开机自启（可选）"
  echo ""
  echo "  若使用 rootless docker 或其他 socket，请确认 DOCKER_HOST 环境变量"
  exit 1
fi
log "Docker daemon: 运行中"

# 校验目标架构
for arch in "${TARGET_ARCHS[@]}"; do
  if [[ -z "${PLATFORM_MAP[$arch]:-}" ]]; then
    err "未知架构: $arch（可选: amd64 arm64 armv7）"
    exit 1
  fi
done
log "目标架构: ${TARGET_ARCHS[*]}"

# 校验 Dockerfile 存在
if [[ ! -f "$DOCKERFILE" ]]; then
  err "未找到 $DOCKERFILE（请在项目根目录运行本脚本）"
  exit 1
fi

# ---------- 创建/复用 buildx builder ----------
step "准备 buildx builder: $BUILDER_NAME"

# buildkit 镜像（国内镜像源，避免 docker.io 超时）
BUILDKIT_IMAGE="${BUILDKIT_IMAGE:-docker.m.daocloud.io/moby/buildkit:latest}"

# 检查 builder 是否已存在；若存在但 image 配置不匹配则删除重建
if docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
  current_image=$(docker buildx inspect "$BUILDER_NAME" 2>/dev/null | grep -oP 'image=\S+' | head -1 | cut -d= -f2 || true)
  if [[ "$current_image" != "$BUILDKIT_IMAGE" ]]; then
    warn "已有 builder 使用旧镜像 ($current_image)，删除重建..."
    docker buildx rm "$BUILDER_NAME" 2>/dev/null || true
  else
    log "复用已有 builder"
  fi
fi

# 若上面删除了或本就不存在，则创建
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
  log "创建新 builder（buildkit 镜像: $BUILDKIT_IMAGE）"
  docker buildx create \
    --name "$BUILDER_NAME" \
    --driver docker-container \
    --driver-opt image="$BUILDKIT_IMAGE" \
    --bootstrap
fi

# 设为当前 builder
docker buildx use "$BUILDER_NAME"
log "当前 builder: $(docker buildx inspect --bootstrap 2>&1 | grep 'Name:' | head -1 | xargs)"

# 确认 QEMU 已注册（跨架构模拟）
BINFMT_IMAGE="${BINFMT_IMAGE:-docker.m.daocloud.io/tonistiigi/binfmt:latest}"
if ! docker buildx inspect "$BUILDER_NAME" | grep -q "qemu"; then
  warn "builder 未检测到 QEMU，正在注册 binfmt..."
  docker run --privileged --rm "$BINFMT_IMAGE" --install all
fi
log "QEMU 跨架构模拟就绪"

# ---------- 逐架构构建 ----------
FAILED_ARCHS=()

for arch in "${TARGET_ARCHS[@]}"; do
  platform="${PLATFORM_MAP[$arch]}"
  tag="${IMAGE_NAME}:${arch}"
  latest_tag="${IMAGE_NAME}:${arch}-latest"

  step "构建 ${arch} (${platform})"

  log "目标镜像: $tag"

  # 清理同架构旧镜像（避免残留）
  if docker image inspect "$tag" &>/dev/null; then
    log "移除旧镜像 $tag"
    docker rmi -f "$tag" 2>/dev/null || true
  fi

  log "开始构建..."

  # 关闭 set -e，构建失败只记录不终止脚本
  set +e
  docker buildx build \
    --platform "$platform" \
    --file "$DOCKERFILE" \
    --tag "$tag" \
    --tag "$latest_tag" \
    --load \
    --progress=plain \
    .
  build_exit_code=$?
  set -e

  if [[ $build_exit_code -eq 0 ]]; then
    log "✓ ${arch} 构建成功: $tag"
    # 显示镜像信息
    img_info=$(docker image inspect "$tag" --format '  镜像: {{.RepoTags}}  大小: {{.Size}}' 2>/dev/null || true)
    echo -e "  ${img_info}"
  else
    err "✗ ${arch} 构建失败"
    FAILED_ARCHS+=("$arch")
  fi
done

# ---------- 构建结果汇总 ----------
step "构建结果汇总"

if [[ ${#FAILED_ARCHS[@]} -eq 0 ]]; then
  log "✓ 全部架构构建成功"
else
  err "✗ 以下架构构建失败: ${FAILED_ARCHS[*]}"
fi

echo ""
log "本地镜像列表:"
docker images "${IMAGE_NAME}" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}  ({{.CreatedSince}})" || true
echo ""

# ---------- 导出镜像包 ----------
EXPORTED_FILES=()

if [[ "${NO_EXPORT:-0}" == "1" ]]; then
  warn "NO_EXPORT=1，跳过镜像包导出"
else
  step "导出镜像包"

  mkdir -p "$EXPORT_DIR"
  log "导出目录: $(cd "$EXPORT_DIR" && pwd)"
  log "版本标签: $VERSION_TAG"

  # 收集所有构建成功的架构（排除失败的）
  SUCCESS_ARCHS=()
  for arch in "${TARGET_ARCHS[@]}"; do
    if [[ ! " ${FAILED_ARCHS[*]} " =~ " ${arch} " ]]; then
      SUCCESS_ARCHS+=("$arch")
    fi
  done

  if [[ ${#SUCCESS_ARCHS[@]} -eq 0 ]]; then
    warn "无成功构建的架构，跳过导出"
  else
    # 1. 逐架构单独导出（便于按需分发单架构）
    for arch in "${SUCCESS_ARCHS[@]}"; do
      tag="${IMAGE_NAME}:${arch}"
      tar_file="${EXPORT_DIR}/${IMAGE_NAME}-${arch}-${VERSION_TAG}.tar"

      log "导出 ${arch} → ${tar_file##*/}"
      if docker save -o "$tar_file" "$tag" 2>/dev/null; then
        # gzip 压缩
        log "压缩 ${tar_file##*/}.tar.gz"
        if gzip -f "$tar_file"; then
          EXPORTED_FILES+=("${tar_file}.gz")
          size=$(du -h "${tar_file}.gz" | cut -f1)
          log "  ✓ ${tar_file##*/}.gz ($size)"
        else
          warn "  gzip 压缩失败，保留未压缩 .tar"
          EXPORTED_FILES+=("$tar_file")
        fi
      else
        err "  ✗ ${arch} 导出失败"
      fi
    done

    # 2. 合并导出所有架构为一个包（便于一次性分发）
    if [[ ${#EXPORTED_FILES[@]} -gt 1 ]]; then
      all_tar="${EXPORT_DIR}/${IMAGE_NAME}-all-${VERSION_TAG}.tar"
      log "合并导出全部架构 → ${all_tar##*/}"
      all_tags=()
      for arch in "${SUCCESS_ARCHS[@]}"; do
        all_tags+=("${IMAGE_NAME}:${arch}")
      done
      if docker save -o "$all_tar" "${all_tags[@]}" 2>/dev/null; then
        log "压缩 ${all_tar##*/}.tar.gz"
        if gzip -f "$all_tar"; then
          EXPORTED_FILES+=("${all_tar}.gz")
          size=$(du -h "${all_tar}.gz" | cut -f1)
          log "  ✓ ${all_tar##*/}.gz ($size)"
        else
          warn "  gzip 压缩失败，保留未压缩 .tar"
          EXPORTED_FILES+=("$all_tar")
        fi
      else
        err "  ✗ 合并导出失败"
      fi
    fi

    # 3. 生成校验文件
    if [[ ${#EXPORTED_FILES[@]} -gt 0 ]]; then
      checksum_file="${EXPORT_DIR}/${IMAGE_NAME}-${VERSION_TAG}.sha256"
      log "生成校验文件: ${checksum_file##*/}"
      : > "$checksum_file"
      for f in "${EXPORTED_FILES[@]}"; do
        sha256sum "$f" >> "$checksum_file"
      done
      log "✓ 校验文件已生成"
    fi

    echo ""
    log "导出文件列表:"
    for f in "${EXPORTED_FILES[@]}"; do
      size=$(du -h "$f" | cut -f1)
      echo "    ${f##*/}  ($size)"
    done
  fi
fi

# ---------- 自动清理 ----------
if [[ "${NO_CLEANUP:-0}" == "1" ]]; then
  warn "NO_CLEANUP=1，跳过自动清理"
  exit ${#FAILED_ARCHS[@]}
fi

step "自动清理"

# 1. 清理 buildx 构建缓存
log "清理 buildx 构建缓存..."
docker buildx prune -f --filter "until=1h" 2>/dev/null || warn "buildx prune 跳过"

# 2. 清理悬空镜像（<none> 标签）
log "清理悬空镜像..."
dangling_count=$(docker images -f "dangling=true" -q | wc -l)
if [[ "$dangling_count" -gt 0 ]]; then
  log "发现 $dangling_count 个悬空镜像，正在清理..."
  docker image prune -f 2>/dev/null || warn "image prune 跳过"
else
  log "无悬空镜像"
fi

# 3. 清理未使用的构建缓存层
log "清理未使用的构建缓存..."
docker builder prune -f --filter "until=1h" 2>/dev/null || warn "builder prune 跳过"

# 4. 移除 buildx builder 实例（docker-container 驱动会留下常驻容器）
if [[ "${KEEP_BUILDER:-0}" == "1" ]]; then
  warn "KEEP_BUILDER=1，保留 builder 实例: $BUILDER_NAME"
else
  log "移除 buildx builder 实例: $BUILDER_NAME"
  # 切回默认 builder，避免移除当前 in-use builder 报错
  docker buildx use default 2>/dev/null || true
  if docker buildx rm "$BUILDER_NAME" 2>/dev/null; then
    log "✓ builder 已移除"
  else
    warn "builder 移除失败（可能已被移除）"
  fi
fi

log "清理完成"

# ---------- 退出码 ----------
if [[ ${#FAILED_ARCHS[@]} -eq 0 ]]; then
  echo ""
  log "🎉 全部完成！"
  echo ""
  log "本地镜像："
  for arch in "${TARGET_ARCHS[@]}"; do
    echo "    ${IMAGE_NAME}:${arch}"
  done
  if [[ ${#EXPORTED_FILES[@]} -gt 0 ]]; then
    echo ""
    log "镜像包（$(cd "$EXPORT_DIR" && pwd)）："
    for f in "${EXPORTED_FILES[@]}"; do
      echo "    ${f##*/}"
    done
    echo ""
    log "导入示例："
    echo "    docker load -i ${EXPORTED_FILES[0]##*/}"
    echo "    # 或校验后导入："
    echo "    sha256sum -c ${IMAGE_NAME}-${VERSION_TAG}.sha256"
  fi
  echo ""
  log "运行示例："
  echo "    docker run --rm -p 8080:8080 -v \$(pwd)/data:/app/data ${IMAGE_NAME}:amd64"
  exit 0
else
  err "构建完成但有 ${#FAILED_ARCHS[@]} 个架构失败: ${FAILED_ARCHS[*]}"
  exit 1
fi

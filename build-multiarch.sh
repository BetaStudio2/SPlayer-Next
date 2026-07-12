#!/usr/bin/env bash
# ============================================================
# SPlayer-Next 多架构 Docker 构建（docker buildx）
#
# 镜像：splayer-next（全量单镜像：TS API + Go Subsonic + C# Scanner + C++ Scraper）
#
# 目标架构：
#   - linux/amd64   (x86_64)
#   - linux/arm64   (ARM v8 / aarch64)
#
# 特性：
#   - 默认使用 Dockerfile（国际版），USE_CN_MIRROR=1 切换为 Dockerfile.cn（国内源加速）
#   - 自动创建/复用 buildx builder（含 QEMU 跨架构模拟）
#   - 逐架构构建并 --load 到本地（带架构后缀 tag）
#   - 构建后导出 .tar.gz 镜像包到 dist/images/（可用 NO_EXPORT=1 跳过）
#   - 构建完成后自动清理：buildx builder 实例 + 构建缓存 + 悬空镜像
#
# 用法：
#   ./build-multiarch.sh --build              # 构建全部架构 + 导出镜像包
#   ./build-multiarch.sh --build amd64        # 仅构建 amd64
#   ./build-multiarch.sh --build arm64        # 仅构建 arm64
#   USE_CN_MIRROR=1 ./build-multiarch.sh --build   # 使用 Dockerfile.cn（国内加速）
#   sudo bash ./build-multiarch.sh --cn --build amd64  # sudo 下显式切国内镜像
#   NO_EXPORT=1 ./build-multiarch.sh --build        # 跳过镜像包导出
#   NO_CLEANUP=1 ./build-multiarch.sh --build       # 跳过自动清理
#   KEEP_BUILDER=1 ./build-multiarch.sh --build     # 保留 buildx builder 实例
#   EXPORT_DIR=./out VERSION_TAG=v1.0 ./build-multiarch.sh --build  # 自定义导出路径
#   ./build-multiarch.sh --help               # 显示此帮助
# ============================================================
set -euo pipefail

# ---------- 颜色输出 ----------
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }
fatal() { echo -e "${RED}[FATAL]${NC} $*" >&2; }
step() { echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n${BLUE}▶ $*${NC}\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ---------- 自动清理（通过 trap EXIT 保证无论成败都执行） ----------
cleanup() {
  local exit_code=$?
  echo ""

  if [[ "${NO_CLEANUP:-0}" == "1" ]]; then
    warn "NO_CLEANUP=1，跳过自动清理"
    return
  fi

  step "自动清理"

  log "清理 buildx 构建缓存..."
  docker buildx prune -f --filter "until=1h" 2>/dev/null || true

  log "清理悬空镜像..."
  local dangling_count
  dangling_count=$(docker images -f "dangling=true" -q 2>/dev/null | wc -l) || true
  if [[ "$dangling_count" -gt 0 ]]; then
    log "发现 $dangling_count 个悬空镜像，正在清理..."
    docker image prune -f 2>/dev/null || true
  fi

  log "清理未使用的构建缓存..."
  docker builder prune -f --filter "until=1h" 2>/dev/null || true

  if [[ "${KEEP_BUILDER:-0}" == "1" ]]; then
    warn "KEEP_BUILDER=1，保留 builder 实例: $BUILDER_NAME"
  else
    log "移除 buildx builder 实例: $BUILDER_NAME"
    docker buildx use default 2>/dev/null || true
    if docker buildx rm "$BUILDER_NAME" 2>/dev/null; then
      log "✓ builder 已移除"
    fi
  fi

  log "清理完成"
  echo ""
  exit "$exit_code"
}

detect_build_jobs() {
  if [[ -n "${BUILD_JOBS:-}" ]]; then
    echo "$BUILD_JOBS"
    return
  fi
  if command -v nproc &>/dev/null; then
    nproc
    return
  fi
  if command -v getconf &>/dev/null; then
    getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1
    return
  fi
  echo 1
}

# ---------- 帮助信息 ----------
print_help() {
  cat <<EOF
用法: $0 --build [架构...]
      $0 --help

SPlayer-Next 多架构 Docker 构建（docker buildx）
构建内容：全量单镜像（TS API + Go Subsonic + C# Scanner + C++ Scraper）

目标架构：amd64 (x86_64) / arm64 (ARM v8)

示例：
  $0 --build                         构建全部架构 + 导出镜像包
  $0 --build amd64                   仅构建 amd64
  $0 --build arm64                   仅构建 arm64
  $0 --cn --build amd64              显式使用 Dockerfile.cn（适合 sudo 场景）
  $0 --intl --build amd64            显式使用 Dockerfile

国内源加速（DaoCloud + 清华 TUNA + npmmirror）：
  USE_CN_MIRROR=1 $0 --build         国内源构建全部架构
  USE_CN_MIRROR=1 $0 --build amd64   国内源仅构建 amd64
  $0 --cn --build amd64              显式使用国内源（适合 sudo 场景）

Fedora 42 版本特性：
  - glibc 生态，与主流发行版完美兼容
  - dnf 并行下载 + fastestmirror 加速
  - Node.js 22 由 Fedora 42 官方仓库提供
  - 支持 amd64/arm64 双架构

其他环境变量：
  USE_CN_MIRROR=1          使用国内源加速（通过 Dockerfile 的 CN_MIRROR 参数）
  --cn                     显式使用国内源，优先级高于环境变量
  --intl                   显式使用国际源，优先级高于环境变量
  NO_EXPORT=1              跳过镜像包导出
  NO_CLEANUP=1             跳过构建后自动清理
  KEEP_BUILDER=1           保留 buildx builder 实例
  EXPORT_DIR=./out         自定义镜像包导出目录（默认 dist/images）
  VERSION_TAG=v1.0         自定义版本标签（默认 日期-时间）
  BUILD_JOBS=\$(nproc)      自定义 Dockerfile 内并行编译任务数
  BUILDKIT_IMAGE=...       自定义 buildkit 镜像
  BINFMT_IMAGE=...         自定义 binfmt 镜像
EOF
  exit 0
}

# ---------- 解析参数 ----------
if [[ $# -eq 0 ]]; then
  print_help
fi

BUILD_MODE=false
PARSED_ARGS=()
CN_MIRROR_MODE=""

for arg in "$@"; do
  case "$arg" in
    --build) BUILD_MODE=true ;;
    --cn) CN_MIRROR_MODE="1" ;;
    --intl) CN_MIRROR_MODE="0" ;;
    --help|-h) print_help ;;
    *) PARSED_ARGS+=("$arg") ;;
  esac
done

if [[ "$BUILD_MODE" != "true" ]]; then
  print_help
fi

# ---------- 注册清理（确保无论成败都执行） ----------
trap cleanup EXIT

# ---------- 配置 ----------
IMAGE_NAME="splayer-next"

# 国内源模式：优先命令行开关，其次 USE_CN_MIRROR 环境变量
if [[ "$CN_MIRROR_MODE" == "1" || ( -z "$CN_MIRROR_MODE" && "${USE_CN_MIRROR:-0}" == "1" ) ]]; then
  CN_MIRROR_ARG="1"
  # 国内镜像名 (Fedora 版本)
  FEDORA_IMAGE="docker.m.daocloud.io/library/fedora:42"
else
  CN_MIRROR_ARG="0"
  # 国际镜像名 (Fedora 版本)
  FEDORA_IMAGE="fedora:42"
fi
DOCKERFILE="Dockerfile"

BUILDER_NAME="splayer-multiarch"

# 镜像包导出目录（NO_EXPORT=1 跳过导出）
EXPORT_DIR="${EXPORT_DIR:-dist/images}"
VERSION_TAG="${VERSION_TAG:-$(date +%Y%m%d-%H%M)}"
BUILD_JOBS="$(detect_build_jobs)"

# 架构映射：buildx platform → 本地 tag 后缀
declare -A PLATFORM_MAP=(
  ["amd64"]="linux/amd64"
  ["arm64"]="linux/arm64"
)

# 目标架构：从 --build 后面的参数解析
TARGET_ARCHS=("${PARSED_ARGS[@]}")
if [[ ${#TARGET_ARCHS[@]} -eq 0 ]]; then
  TARGET_ARCHS=("amd64" "arm64")
fi

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
log "Dockerfile: $DOCKERFILE"
log "并行构建任务数: $BUILD_JOBS"

if ! docker info &>/dev/null; then
  err "Docker 守护进程未运行（无法连接 /var/run/docker.sock）"
  echo ""
  echo "  请先启动 Docker："
  echo "    sudo systemctl start docker      # 启动"
  echo "    sudo systemctl enable docker     # 开机自启（可选）"
  exit 1
fi
log "Docker daemon: 运行中"

# 校验目标架构
for arch in "${TARGET_ARCHS[@]}"; do
  if [[ -z "${PLATFORM_MAP[$arch]:-}" ]]; then
    err "未知架构: $arch（可选: amd64 arm64）"
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

if docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
  current_image=$(docker buildx inspect "$BUILDER_NAME" 2>/dev/null | grep -oP 'image=\S+' | head -1 | cut -d= -f2 || true)
  if [[ "$current_image" != "$BUILDKIT_IMAGE" ]]; then
    warn "已有 builder 使用旧镜像 ($current_image)，删除重建..."
    docker buildx rm "$BUILDER_NAME" 2>/dev/null || true
  else
    log "复用已有 builder"
  fi
fi

if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
  log "创建新 builder（buildkit 镜像: $BUILDKIT_IMAGE）"
  docker buildx create \
    --name "$BUILDER_NAME" \
    --driver docker-container \
    --driver-opt image="$BUILDKIT_IMAGE" \
    --bootstrap
fi

docker buildx use "$BUILDER_NAME"
log "当前 builder: $(docker buildx inspect --bootstrap 2>&1 | grep 'Name:' | head -1 | xargs)"

# 注册 QEMU（跨架构模拟）
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

  # 清理同架构旧镜像
  if docker image inspect "$tag" &>/dev/null; then
    log "移除旧镜像 $tag"
    docker rmi -f "$tag" 2>/dev/null || true
  fi

  log "开始构建（全量单镜像）..."

  set +e
  # auto 进度模式：Docker 原生单行显示，构建正常时只显示精简进度
  # 同时通过 tee 在后台保留完整构建日志，构建失败时从中提取错误信息
  _build_out=$(mktemp)
  docker buildx build \
    --platform "$platform" \
    --file "$DOCKERFILE" \
    --tag "$tag" \
    --tag "$latest_tag" \
    --build-arg "BUILD_JOBS=$BUILD_JOBS" \
    --build-arg "CN_MIRROR=$CN_MIRROR_ARG" \
    --build-arg "FEDORA_IMAGE=$FEDORA_IMAGE" \
    --load \
    --progress=auto \
    . 2>&1 | tee "$_build_out"
  build_exit_code=${PIPESTATUS[0]}
  if [[ $build_exit_code -ne 0 ]]; then
    echo ""
    log "构建失败，正在提取错误信息..."
    # 从日志中过滤错误行，优先用 ERROR/CANCELED/failed，兜底取最后几行
    _errors=$(grep -E 'ERROR|CANCELED|exit code [^0]|failed to|CMake Error' "$_build_out" 2>/dev/null | tail -5)
    if [[ -z "$_errors" ]]; then
      _errors=$(tail -10 "$_build_out" 2>/dev/null)
    fi
    if [[ -n "$_errors" ]]; then
      echo ""
      echo "$_errors"
    fi
  fi
  rm -f "$_build_out"
  set -e

  if [[ $build_exit_code -eq 0 ]]; then
    log "✓ ${arch} 构建成功: $tag"
    img_info=$(docker image inspect "$tag" --format '  镜像: {{.RepoTags}}  大小: {{.Size}}' 2>/dev/null || true)
    echo -e "  ${img_info}"
  else
    fatal "✗ ${arch} 构建失败"
    FAILED_ARCHS+=("$arch")
  fi
done

# ---------- 构建结果 ----------
if [[ ${#FAILED_ARCHS[@]} -eq 0 ]]; then
  log "✓ 全部架构构建成功"
else
  fatal "✗ 以下架构构建失败: ${FAILED_ARCHS[*]}"
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

  SUCCESS_ARCHS=()
  for arch in "${TARGET_ARCHS[@]}"; do
    if [[ ! " ${FAILED_ARCHS[*]} " =~ " ${arch} " ]]; then
      SUCCESS_ARCHS+=("$arch")
    fi
  done

  if [[ ${#SUCCESS_ARCHS[@]} -eq 0 ]]; then
    warn "无成功构建的架构，跳过导出"
  else
    # 1. 逐架构单独导出
    for arch in "${SUCCESS_ARCHS[@]}"; do
      tag="${IMAGE_NAME}:${arch}"
      tar_file="${EXPORT_DIR}/${IMAGE_NAME}-${arch}-${VERSION_TAG}.tar"

      log "导出 ${arch} → ${tar_file##*/}"
      if docker save -o "$tar_file" "$tag" 2>/dev/null; then
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

    # 2. 合并导出所有架构
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

      echo ""
      log "导出文件列表:"
      for f in "${EXPORTED_FILES[@]}"; do
        size=$(du -h "$f" | cut -f1)
        echo "    ${f##*/}  ($size)"
      done
    fi
  fi
fi

# ---------- 退出 ----------
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
  echo "    docker run --rm -p 8080:8080 -p 8081:8081 -v \$(pwd)/data:/app/data ${IMAGE_NAME}:amd64"
  echo "    # 或使用 docker compose："
  echo "    docker compose up -d"
  echo ""
  log "容器内工具："
  echo "    docker compose exec splayer /usr/local/bin/splayer-entrypoint scan --dirs /app/music"
  echo "    docker compose exec splayer /usr/local/bin/splayer-entrypoint once"
fi

# 清理在 trap EXIT 中自动执行；此处仅设置退出码
exit ${#FAILED_ARCHS[@]}

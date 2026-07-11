# SPlayer-Next 统一 Dockerfile (Fedora 42 版本)
# 单镜像打包：
#   - TS API + 前端静态资源
#   - Go Subsonic
#   - C# Scanner
#   - C++ Scraper
#   - Rust Downloader
#
# 国内加速：由 build-multiarch.sh 传入 CN_MIRROR=1 及各 *_IMAGE ARG
#
# 用法：
#   docker build -t splayer-next .                                          # 国际源
#   docker build --build-arg CN_MIRROR=1 --build-arg FEDORA_IMAGE=... -t splayer-next .  # 国内源
#
# 从 Ubuntu 24.04 迁移到 Fedora 42 的包名映射：
#   build-essential       → gcc-c++ make
#   libcurl4-openssl-dev  → libcurl-devel
#   libssl-dev            → openssl-devel
#   libtag1-dev           → taglib-devel
#   nlohmann-json3-dev    → nlohmann-json-devel
#   libtag1v5             → taglib
#   libstdc++6            → libstdc++
#   zlib1g                → zlib-ng

ARG BUILD_JOBS=1
ARG CN_MIRROR=0

# ===== 基础镜像（由构建脚本或用户传入，默认国际源） =====
ARG GO_IMAGE=golang:1.23-bookworm
ARG FEDORA_IMAGE=fedora:42
ARG RUST_IMAGE=rust:1-bookworm
ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:9.0-bookworm-slim

# Go 代理
ARG GO_PROXY=https://proxy.golang.org,direct
ARG GO_SUMDB=sum.golang.org

# ===== 通用：Fedora 基础配置 =====
FROM ${FEDORA_IMAGE} AS fedora-base
ARG CN_MIRROR
ARG BUILD_JOBS

# 配置 dnf（国内源 / 加速）
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      sed -i 's|^metalink=|#metalink=|g' /etc/yum.repos.d/fedora.repo && \
      sed -i 's|^#baseurl=http://download.example/pub/fedora/linux|baseurl=https://mirrors.aliyun.com/fedora|g' /etc/yum.repos.d/fedora.repo; \
      sed -i 's|^metalink=|#metalink=|g' /etc/yum.repos.d/fedora-updates.repo && \
      sed -i 's|^#baseurl=http://download.example/pub/fedora/linux|baseurl=https://mirrors.aliyun.com/fedora|g' /etc/yum.repos.d/fedora-updates.repo; \
    fi && \
    echo 'max_parallel_downloads=10' >> /etc/dnf/dnf.conf && \
    echo 'fastestmirror=True' >> /etc/dnf/dnf.conf && \
    dnf install -y --setopt=install_weak_deps=False \
      ca-certificates curl wget tzdata git && \
    dnf clean all

# ===== API: Web Builder =====
FROM fedora-base AS web-builder
ARG BUILD_JOBS
ARG CN_MIRROR

# 安装 Node.js 22（Fedora 42 原生支持）
RUN dnf install -y --setopt=install_weak_deps=False nodejs npm && \
    dnf clean all

# 配置 npm 国内源
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      npm config set registry https://registry.npmmirror.com; \
    fi

WORKDIR /app
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm_config_jobs="${BUILD_JOBS}" npm install --no-audit --no-fund
RUN ln -s web/node_modules node_modules
COPY web/ ./web/
COPY src/ ./src/
COPY shared/ ./shared/
COPY public/ ./public/
COPY package.json USER_AGREEMENT.md ./
COPY tsconfig.json tsconfig.web.json tsconfig.node.json ./
RUN cd web && npm run build && npm cache clean --force

# ===== API: Server Builder =====
FROM fedora-base AS server-builder
ARG BUILD_JOBS
ARG CN_MIRROR

# 安装 Node.js 22 + native addon 编译工具
RUN dnf install -y --setopt=install_weak_deps=False \
      nodejs npm \
      gcc-c++ make python3 \
      pkgconf-pkg-config && \
    dnf clean all

# 配置 npm 国内源 & better-sqlite3 二进制镜像
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      npm config set registry https://registry.npmmirror.com && \
      echo "better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3" >> /root/.npmrc; \
    fi

WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm_config_jobs="${BUILD_JOBS}" npm install --no-audit --no-fund
COPY server/ ./
COPY shared/ ../shared/
RUN npm run build && npm prune --production && npm cache clean --force

# ===== Go Monitor Builder =====
FROM ${GO_IMAGE} AS monitor-builder
ARG BUILD_JOBS
ARG CN_MIRROR
ARG GO_PROXY
ARG GO_SUMDB

# 配置国内源
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi

WORKDIR /src
COPY server/monitor/go.mod ./
ENV GOPROXY=${GO_PROXY}
ENV GOSUMDB=${GO_SUMDB}
ENV CGO_ENABLED=0
RUN go mod download
COPY server/monitor/ ./
RUN GOMAXPROCS="${BUILD_JOBS}" go build -p "${BUILD_JOBS}" -ldflags="-s -w" -o /out/splayer-monitor . && \
    go clean -modcache

# ===== Go Subsonic Builder =====
FROM ${GO_IMAGE} AS subsonic-builder
ARG BUILD_JOBS
ARG CN_MIRROR
ARG GO_PROXY
ARG GO_SUMDB

# 配置国内源
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi

WORKDIR /src
COPY server/subsonic/go.mod server/subsonic/go.sum ./
ENV GOPROXY=${GO_PROXY}
ENV GOSUMDB=${GO_SUMDB}
ENV CGO_ENABLED=0
RUN go mod download
COPY server/subsonic/ ./
RUN GOMAXPROCS="${BUILD_JOBS}" go build -p "${BUILD_JOBS}" -ldflags="-s -w" -o /out/subsonic-go . && \
    go clean -modcache

# ===== C# Scanner Builder =====
FROM ${DOTNET_SDK_IMAGE} AS scanner-builder
ARG BUILD_JOBS
ARG TARGETARCH

WORKDIR /src
COPY server/scanner/scanner.csproj ./scanner/
RUN case "$TARGETARCH" in \
      amd64) rid=linux-x64 ;; \
      arm64) rid=linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    cd scanner && \
    dotnet restore -r "$rid" /m:${BUILD_JOBS}
COPY server/scanner/*.cs ./scanner/
RUN case "$TARGETARCH" in \
      amd64) rid=linux-x64 ;; \
      arm64) rid=linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    cd scanner && \
    dotnet publish -c Release -r "$rid" -o /out --no-restore --self-contained true \
      /p:PublishSingleFile=false /p:PublishTrimmed=false /p:InvariantGlobalization=true /m:${BUILD_JOBS} && \
    dotnet clean -c Release && rm -rf ~/.nuget

# ===== C++ Scraper Builder =====
FROM fedora-base AS scraper-builder
ARG BUILD_JOBS
ARG CN_MIRROR

# 安装 C++ 编译链 + 依赖
RUN dnf install -y --setopt=install_weak_deps=False \
      gcc-c++ make cmake ninja-build \
      libcurl-devel openssl-devel sqlite-devel \
      taglib-devel nlohmann-json-devel && \
    dnf clean all

WORKDIR /src
RUN mkdir -p /out
COPY server/scraper/CMakeLists.txt ./scraper/
COPY server/scraper/cmake/ ./scraper/cmake/
COPY server/scraper/include/ ./scraper/include/
COPY server/scraper/src/ ./scraper/src/
RUN cd scraper && \
    cmake -GNinja -DCMAKE_BUILD_TYPE=Release -B build && \
    cmake --build build -j"${BUILD_JOBS}" && \
    cp build/splayer-scraper /out/splayer-scraper && \
    rm -rf build

# ===== Rust Downloader Builder =====
FROM ${RUST_IMAGE} AS downloader-builder
ARG BUILD_JOBS
ARG CN_MIRROR

# 配置 Debian 国内源
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 配置 GitHub 镜像（国内加速：阿里云镜像）
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      git config --global url."https://gh-proxy.com/https://github.com/".insteadOf "https://github.com/"; \
    fi

# 配置 Cargo 国内源（阿里云，CDN 加速最稳定）
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      mkdir -p /usr/local/cargo && \
      echo '[source.crates-io]' >> /usr/local/cargo/config.toml && \
      echo 'replace-with = "aliyun"' >> /usr/local/cargo/config.toml && \
      echo '' >> /usr/local/cargo/config.toml && \
      echo '[source.aliyun]' >> /usr/local/cargo/config.toml && \
      echo 'registry = "sparse+https://mirrors.aliyun.com/crates.io-index/"' >> /usr/local/cargo/config.toml && \
      echo '' >> /usr/local/cargo/config.toml && \
      echo '[net]' >> /usr/local/cargo/config.toml && \
      echo 'git-fetch-with-cli = true' >> /usr/local/cargo/config.toml; \
    fi

WORKDIR /src
RUN mkdir -p /out
# 整个 workspace 需要让 Cargo 解析依赖图，因此复制全部 native 子目录与根 Cargo.toml
COPY Cargo.toml ./
COPY native/audio-engine/Cargo.toml ./native/audio-engine/Cargo.toml
COPY native/media-ctrl/Cargo.toml ./native/media-ctrl/Cargo.toml
COPY native/taskbar-lyric/Cargo.toml ./native/taskbar-lyric/Cargo.toml
COPY native/taskbar-thumbnail/Cargo.toml ./native/taskbar-thumbnail/Cargo.toml
COPY native/download-engine/Cargo.toml ./native/download-engine/Cargo.toml
# stub 源文件：cdylib crate 用 lib.rs，bin crate 用 main.rs
# 仅满足 Cargo 解析与 fetch，实际编译目标只有 splayer-downloader
RUN mkdir -p native/audio-engine/src native/media-ctrl/src native/taskbar-lyric/src \
             native/taskbar-thumbnail/src native/download-engine/src && \
    for d in audio-engine media-ctrl taskbar-lyric taskbar-thumbnail; do \
      echo "pub fn _unused() {}" > "native/$d/src/lib.rs"; \
    done && \
    echo "fn main() {}" > native/download-engine/src/main.rs
RUN cargo fetch --manifest-path Cargo.toml
# 用真实源码覆盖 stub
COPY native/download-engine/src/ ./native/download-engine/src/
# 仅构建 download-engine 二进制（其余 native 模块为桌面端 Electron 用，不在服务端编译）
RUN CARGO_BUILD_JOBS="${BUILD_JOBS}" cargo build --release --manifest-path Cargo.toml \
      --package splayer-downloader && \
    cp target/release/splayer-downloader /out/splayer-downloader && \
    cargo clean --manifest-path Cargo.toml && rm -rf /usr/local/cargo/registry

# ===== Subsonic Transcoder Builder（服务端专用，独立于桌面端 workspace） =====
FROM ${RUST_IMAGE} AS transcoder-builder
ARG BUILD_JOBS
ARG CN_MIRROR

# 配置 Debian 国内源
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 配置 GitHub 镜像（国内加速：阿里云镜像）
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      git config --global url."https://gh-proxy.com/https://github.com/".insteadOf "https://github.com/"; \
    fi

# 配置 Cargo 国内源（阿里云，CDN 加速最稳定）
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      mkdir -p /usr/local/cargo && \
      echo '[source.crates-io]' >> /usr/local/cargo/config.toml && \
      echo 'replace-with = "aliyun"' >> /usr/local/cargo/config.toml && \
      echo '' >> /usr/local/cargo/config.toml && \
      echo '[source.aliyun]' >> /usr/local/cargo/config.toml && \
      echo 'registry = "sparse+https://mirrors.aliyun.com/crates.io-index/"' >> /usr/local/cargo/config.toml && \
      echo '' >> /usr/local/cargo/config.toml && \
      echo '[net]' >> /usr/local/cargo/config.toml && \
      echo 'git-fetch-with-cli = true' >> /usr/local/cargo/config.toml; \
    fi

WORKDIR /src
RUN mkdir -p /out
# 转码器是 subsonic 服务端的组成部分，源码位于 server/subsonic/subsonic-transcoder

# 第 1 层：仅复制 Cargo.toml + stub → fetch 依赖（层缓存，源码不变时不重编）
COPY server/subsonic/subsonic-transcoder/Cargo.toml ./Cargo.toml
RUN mkdir -p src && echo "fn main() {}" > src/main.rs
RUN cargo fetch

# 第 2 层：用真实源码覆盖 stub → 编译（仅改 src/ 时才重编）
COPY server/subsonic/subsonic-transcoder/src/ ./src/
RUN CARGO_BUILD_JOBS="${BUILD_JOBS}" cargo build --release --frozen && \
    cp target/release/subsonic-transcoder /out/subsonic-transcoder && \
    cargo clean && rm -rf /usr/local/cargo/registry

# ===== All-In-One Runtime =====
FROM fedora-base AS runtime
ARG CN_MIRROR

# 安装 Node.js 22 + C++ libs + taglib
RUN dnf install -y --setopt=install_weak_deps=False \
      nodejs npm \
      tini \
      openssl sqlite-libs \
      libstdc++ zlib-ng \
      taglib && \
    dnf clean all

WORKDIR /app
RUN mkdir -p /app/bin /app/scanner /app/music /app/data /app/scrape

COPY --from=web-builder /app/package.json /app/package.json
COPY --from=server-builder /app/server/package.json ./server/
COPY --from=server-builder /app/server/node_modules ./server/node_modules
COPY --from=server-builder /app/server/dist ./server
COPY --from=web-builder /app/dist/web ./public
COPY --from=subsonic-builder /out/subsonic-go /app/bin/subsonic-go
COPY --from=scanner-builder /out/ /app/bin/
COPY --from=scraper-builder /out/splayer-scraper /app/bin/splayer-scraper
COPY --from=downloader-builder /out/splayer-downloader /app/bin/splayer-downloader
COPY --from=transcoder-builder /out/subsonic-transcoder /app/bin/subsonic-transcoder
COPY --from=monitor-builder /out/splayer-monitor /app/bin/splayer-monitor

RUN cat > /usr/local/bin/splayer-entrypoint <<'EOF' && chmod +x /usr/local/bin/splayer-entrypoint
#!/bin/bash
set -eu

cmd="${1:-run}"
if [ "$#" -gt 0 ]; then
  shift
fi

# 在 server 目录下运行，以便 package.json 中的 "type": "module" 生效
cd /app/server

# Node.js 内存控制参数（纯 V8 自动归还，不依赖手动 GC）：
#   --max-old-space-size=128       老生代上限（基线~27MB，扫描峰值~80MB），
#                                  V8 触顶时自动做增量压缩 + munmap 空闲页还给 OS
#   --max-semi-space-size=4        新生代从默认 16MB 压到 4MB，减少 V8 预分配
#   --optimize-for-size            启用 V8 大小优化模式，减少预分配、更积极归还内存
NODE_ARGS=""

# 仅 api / run 模式施加内存限制（子进程 scan/scraper 等不适用）
case "$cmd" in
  run|api)
    NODE_ARGS="--max-old-space-size=${NODE_MAX_OLD_SPACE:-128} --max-semi-space-size=4 --optimize-for-size"
    ;;
esac

case "$cmd" in
  run)
    node $NODE_ARGS index.js "$@"
    status="$?"
    exit "$status"
    ;;
  api)
    exec node $NODE_ARGS index.js "$@"
    ;;
  subsonic)
    exec /app/bin/subsonic-go "$@"
    ;;
  scan|parse)
    exec /app/bin/splayer-scanner "$cmd" "$@"
    ;;
  scraper)
    exec /app/bin/splayer-scraper "$@"
    ;;
  once|daemon|query)
    exec /app/bin/splayer-scraper "$cmd" "$@"
    ;;
  download)
    exec /app/bin/splayer-downloader "$@"
    ;;
  *)
    exec "$cmd" "$@"
    ;;
esac
EOF

ENV NODE_ENV=production
ENV PORT=8080
ENV SPA_DIR=/app/public
ENV SPLAYER_MUSIC_DIR=/app/music
ENV SPLAYER_DATA_DIR=/app/data
ENV SPLAYER_SCRAPE_DIR=/app/scrape
ENV SUBSONIC_BACKEND_URL=http://127.0.0.1:8081
ENV SUBSONIC_PORT=8081
ENV SPLAYER_MONITOR_ENABLED=true
ENV SPLAYER_MONITOR_BIN=/app/bin/splayer-monitor
ENV TZ=Asia/Shanghai

EXPOSE 8080 8081
VOLUME ["/app/music", "/app/data", "/app/scrape"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/splayer-entrypoint"]
CMD ["run"]

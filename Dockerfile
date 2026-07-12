# SPlayer-Next 统一 Dockerfile（Fedora all-in-one）
# 单镜像打包：
#   - TS API + 前端静态资源
#   - Go Subsonic / Monitor
#   - C# Scanner
#   - C++ Scraper
#   - C Audio Engine（FFmpeg 解码 → OGG/Opus 转码）
#   - Rust Downloader / Transcoder
#
# 所有语言编译器均由 Fedora 42 原生提供（golang / rust cargo / dotnet-sdk-9.0 等）
#
# 国内加速：由 build-multiarch.sh 传入 CN_MIRROR=1 及 Fedora 镜像 ARG
#
# 用法：
#   docker build -t splayer-next .                                          # 国际源
#   docker build --build-arg CN_MIRROR=1 --build-arg FEDORA_IMAGE=... -t splayer-next .  # 国内源

ARG BUILD_JOBS=1
ARG CN_MIRROR=0

# ===== 基础镜像 =====
ARG FEDORA_IMAGE=fedora:42

# Go 代理
ARG GOPROXY=https://proxy.golang.org,direct
ARG GOSUMDB=sum.golang.org

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
    echo 'timeout=120' >> /etc/dnf/dnf.conf && \
    echo 'retries=5' >> /etc/dnf/dnf.conf && \
    _RPMFUSION_BASE="https://mirrors.rpmfusion.org" && \
    if [ "${CN_MIRROR}" = "1" ]; then _RPMFUSION_BASE="https://mirrors.tuna.tsinghua.edu.cn/rpmfusion"; fi && \
    dnf install -y --setopt=install_weak_deps=False \
      ca-certificates curl wget tzdata git \
      "${_RPMFUSION_BASE}/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm" && \
    if [ "${CN_MIRROR}" = "1" ]; then \
      sed -i 's|^metalink=|#metalink=|g' /etc/yum.repos.d/rpmfusion*.repo && \
      sed -i 's|^#baseurl=|baseurl=|g' /etc/yum.repos.d/rpmfusion*.repo && \
      sed -i 's|https\?://download1.rpmfusion.org/|https://mirrors.tuna.tsinghua.edu.cn/rpmfusion/|g' /etc/yum.repos.d/rpmfusion*.repo; \
    fi && \
    dnf clean all

# ===== Web Builder =====
FROM fedora-base AS web-builder
ARG BUILD_JOBS
ARG CN_MIRROR

RUN dnf install -y --setopt=install_weak_deps=False nodejs npm && dnf clean all
RUN if [ "${CN_MIRROR}" = "1" ]; then npm config set registry https://registry.npmmirror.com; fi

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

# ===== Server Builder =====
FROM fedora-base AS server-builder
ARG BUILD_JOBS
ARG CN_MIRROR

RUN dnf install -y --setopt=install_weak_deps=False \
      nodejs npm gcc-c++ make python3 pkgconf-pkg-config && dnf clean all

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
FROM fedora-base AS monitor-builder
ARG BUILD_JOBS
ARG CN_MIRROR
ARG GOPROXY
ARG GOSUMDB

RUN dnf install -y --setopt=install_weak_deps=False golang && dnf clean all

ENV GOPROXY=${GOPROXY}
ENV GOSUMDB=${GOSUMDB}
ENV CGO_ENABLED=0

WORKDIR /src
COPY server/monitor/go.mod ./
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      GOPROXY=https://goproxy.cn,direct GOSUMDB=sum.golang.cn go mod download; \
    else \
      go mod download; \
    fi
COPY server/monitor/ ./
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      GOPROXY=https://goproxy.cn,direct GOMAXPROCS="${BUILD_JOBS}" go build -p "${BUILD_JOBS}" -ldflags="-s -w" -o /out/splayer-monitor .; \
    else \
      GOMAXPROCS="${BUILD_JOBS}" go build -p "${BUILD_JOBS}" -ldflags="-s -w" -o /out/splayer-monitor .; \
    fi && \
    go clean -modcache

# ===== Go Subsonic Builder =====
FROM fedora-base AS subsonic-builder
ARG BUILD_JOBS
ARG CN_MIRROR
ARG GOPROXY
ARG GOSUMDB

RUN dnf install -y --setopt=install_weak_deps=False golang && dnf clean all

ENV GOPROXY=${GOPROXY}
ENV GOSUMDB=${GOSUMDB}
ENV CGO_ENABLED=0

WORKDIR /src
COPY server/subsonic/go.mod server/subsonic/go.sum ./
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      GOPROXY=https://goproxy.cn,direct GOSUMDB=sum.golang.cn go mod download; \
    else \
      go mod download; \
    fi
COPY server/subsonic/ ./
RUN if [ "${CN_MIRROR}" = "1" ]; then \
      GOPROXY=https://goproxy.cn,direct GOMAXPROCS="${BUILD_JOBS}" go build -p "${BUILD_JOBS}" -ldflags="-s -w" -o /out/subsonic-go .; \
    else \
      GOMAXPROCS="${BUILD_JOBS}" go build -p "${BUILD_JOBS}" -ldflags="-s -w" -o /out/subsonic-go .; \
    fi && \
    go clean -modcache

# ===== C# Scanner Builder =====
FROM fedora-base AS scanner-builder
ARG BUILD_JOBS
ARG CN_MIRROR
ARG TARGETARCH

RUN dnf install -y --setopt=install_weak_deps=False dotnet-sdk-9.0 && dnf clean all

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

# ===== C Audio Engine Builder（FFmpeg 解码 → OGG/Opus 转码） =====
FROM fedora-base AS audio-engine-builder
ARG BUILD_JOBS
ARG CN_MIRROR

# ffmpeg-devel + C/C++ 编译 + cmake + cargo（tempo-rs Rust 库）
# clang：signalsmith-stretch 的 build script 通过 bindgen 生成 FFI，需要 libclang
RUN dnf install -y --setopt=install_weak_deps=False \
      ffmpeg-devel gcc gcc-c++ cmake cargo clang && \
    dnf clean all

ENV CARGO_HOME=/usr/local/cargo
# bindgen 在 build script 阶段动态加载 libclang，显式指定路径以避免探测失败
ENV LIBCLANG_PATH=/usr/lib64

# 配置 Cargo 国内源（tempo-rs 构建需要）
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
COPY server/audio-engine/CMakeLists.txt ./
COPY server/audio-engine/include/ ./include/
COPY server/audio-engine/src/ ./src/
COPY server/audio-engine/tempo-rs/ ./tempo-rs/
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build -j"${BUILD_JOBS}" && \
    cp build/splayer-audio-engine /out/splayer-audio-engine && \
    rm -rf build tempo-target

# ===== Rust Downloader Builder（独立 CLI，不依赖 workspace） =====
FROM fedora-base AS downloader-builder
ARG BUILD_JOBS
ARG CN_MIRROR

RUN dnf install -y --setopt=install_weak_deps=False rust cargo && dnf clean all

ENV CARGO_HOME=/usr/local/cargo

# 配置 Cargo 国内源
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
    fi && \
    if [ "${CN_MIRROR}" = "1" ]; then \
      git config --global url."https://gh-proxy.com/https://github.com/".insteadOf "https://github.com/"; \
    fi

WORKDIR /src
RUN mkdir -p /out
COPY native/download-engine/ ./
RUN cargo fetch && \
    CARGO_BUILD_JOBS="${BUILD_JOBS}" cargo build --release && \
    cp target/release/splayer-downloader /out/splayer-downloader && \
    cargo clean && rm -rf /usr/local/cargo/registry

# ===== Rust Transcoder Builder =====
FROM fedora-base AS transcoder-builder
ARG BUILD_JOBS
ARG CN_MIRROR

RUN dnf install -y --setopt=install_weak_deps=False rust cargo && dnf clean all

ENV CARGO_HOME=/usr/local/cargo

# 配置 Cargo 国内源
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
# 第 1 层：仅复制 Cargo.toml + stub → fetch 依赖
COPY server/subsonic/subsonic-transcoder/Cargo.toml ./Cargo.toml
RUN mkdir -p src && echo "fn main() {}" > src/main.rs
RUN cargo fetch
# 第 2 层：用真实源码覆盖 stub → 编译
COPY server/subsonic/subsonic-transcoder/src/ ./src/
RUN CARGO_BUILD_JOBS="${BUILD_JOBS}" cargo build --release --frozen && \
    cp target/release/subsonic-transcoder /out/subsonic-transcoder && \
    cargo clean && rm -rf /usr/local/cargo/registry

# ===== All-In-One Runtime =====
FROM fedora-base AS runtime
ARG CN_MIRROR

# 安装运行时依赖：Node.js + C++ libs + taglib + libcurl + ffmpeg-libs
RUN dnf install -y --setopt=install_weak_deps=False \
      nodejs npm \
      tini \
      openssl sqlite-libs \
      libstdc++ zlib-ng \
      taglib \
      libcurl \
      ffmpeg-libs && \
    dnf clean all

WORKDIR /app
RUN mkdir -p /app/bin /app/music /app/data /app/scrape

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
COPY --from=audio-engine-builder /out/splayer-audio-engine /app/bin/splayer-audio-engine

RUN cat > /usr/local/bin/splayer-entrypoint <<'EOF' && chmod +x /usr/local/bin/splayer-entrypoint
#!/bin/bash
set -eu

cmd="${1:-run}"
if [ "$#" -gt 0 ]; then
  shift
fi

# 在 server 目录下运行
cd /app/server

# Node.js 内存控制参数
NODE_ARGS=""
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
ENV SPLAYER_SUBSONIC_BACKEND_URL=http://127.0.0.1:8081
ENV SPLAYER_SUBSONIC_PORT=8081
ENV SPLAYER_MONITOR_ENABLED=true
ENV SPLAYER_MONITOR_BIN=/app/bin/splayer-monitor
ENV TZ=Asia/Shanghai

EXPOSE 8080
VOLUME ["/app/music", "/app/data", "/app/scrape"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/splayer-entrypoint"]
CMD ["run"]

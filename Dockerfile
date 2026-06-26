# SPlayer-Next Web 单容器 Dockerfile
# 多阶段构建：web-builder（SPA）→ server-builder（API）→ runtime
# 绕开根 package.json 的 postinstall（electron-rebuild），只装 server/ web/ 独立子包

# ===== Stage 1: 构建前端 SPA =====
FROM node:22-alpine AS web-builder
WORKDIR /app
# 先装 web 依赖（layer cache）
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm install --no-audit --no-fund
# 软链根 node_modules → web/node_modules
# 解决 src/ 的 bare import 向上解析 + 根 tsconfig extends @electron-toolkit/tsconfig
RUN ln -s web/node_modules node_modules
# 复制构建所需源码
COPY web/ ./web/
COPY src/ ./src/
COPY shared/ ./shared/
COPY public/ ./public/
COPY tsconfig.json tsconfig.web.json tsconfig.node.json ./
# 构建（产物输出到 /app/dist/web）
RUN cd web && npm run build

# ===== Stage 2: 构建后端 =====
FROM node:22-alpine AS server-builder
WORKDIR /app/server
# better-sqlite3 / sharp 编译依赖
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY server/ ./
COPY shared/ ../shared/
RUN npm run build
# 去掉 dev 依赖，保留生产依赖（含已编译的 native 模块）
RUN npm prune --production

# ===== Stage 3: 运行时 =====
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app

# 复制后端构建产物 + 生产依赖
COPY --from=server-builder /app/server/node_modules ./server/node_modules
COPY --from=server-builder /app/server/dist ./server
# 复制前端 SPA 构建产物
COPY --from=web-builder /app/dist/web ./public

# 环境变量（SPA_DIR 默认 /app/public，与 server/index.ts 默认值一致）
ENV NODE_ENV=production
ENV PORT=8080
ENV SPA_DIR=/app/public
ENV MUSIC_DIR=/app/music
ENV DATA_DIR=/app/data

EXPOSE 8080
VOLUME ["/app/music", "/app/data"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/index.js"]

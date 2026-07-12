import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import AutoImport from "unplugin-auto-import/vite";
import Icons from "unplugin-icons/vite";
import IconsResolver from "unplugin-icons/resolver";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import RekaResolver from "reka-ui/resolver";
import Components from "unplugin-vue-components/vite";

const rootDir = resolve(fileURLToPath(import.meta.url), "..", "..");
const webDir = resolve(fileURLToPath(import.meta.url), "..");

const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf-8"));

export default defineConfig({
  root: webDir,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REPO_URL__: JSON.stringify("https://github.com/SPlayer-Dev/SPlayer-Next"),
    __APP_REPO_NAME__: JSON.stringify("SPlayer-Next"),
    __APP_AUTHOR__: JSON.stringify("imsyy"),
    __APP_HOMEPAGE__: JSON.stringify("https://splayer.imsyy.top"),
    __APP_AUTHOR_URL__: JSON.stringify("https://imsyy.top"),
    __IS_ELECTRON__: JSON.stringify(false),
  },
  server: {
    port: 14558,
    proxy: {
      "/api": {
        target: process.env.SPLAYER_SERVER_URL ?? "http://localhost:8080",
        changeOrigin: true,
        // vite 模块请求（/api/*.ts 等本地 mock 文件）不代理，交回 vite 处理
        bypass: (req) => {
          if (req.url && /^\/api\/[^/]+\.(ts|vue)(\?|$)/.test(req.url)) {
            return req.url;
          }
        },
      },
      // WebSocket 代理（扫描进度 / 库变更等实时推送）
      "/ws": {
        target: process.env.SPLAYER_SERVER_URL ?? "http://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  publicDir: resolve(rootDir, "public"),
  // 内联 tsconfig，避免 vite/esbuild 读取根 tsconfig 的 references
  // （根 tsconfig.node.json extends @electron-toolkit/tsconfig，web/ 未装会解析失败）
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        experimentalDecorators: true,
        verbatimModuleSyntax: false,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(rootDir, "src"),
      "@shared": resolve(rootDir, "shared"),
      "@windows": resolve(rootDir, "windows"),
      "@root": rootDir,
    },
  },
  plugins: [
    vue(),
    UnoCSS(),
    AutoImport({
      imports: ["vue", "pinia", "vue-router", "@vueuse/core", "vue-i18n"],
      dts: resolve(webDir, "auto-imports.d.ts"),
    }),
    Icons({
      compiler: "vue3",
      scale: 1,
      customCollections: {
        sp: FileSystemIconLoader(resolve(rootDir, "src/assets/icons")),
      },
    }),
    Components({
      dirs: [resolve(rootDir, "src/components")],
      resolvers: [RekaResolver(), IconsResolver({ prefix: "icon", customCollections: ["sp"] })],
      dts: resolve(webDir, "components.d.ts"),
    }),
  ],
  build: {
    outDir: resolve(rootDir, "dist/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(webDir, "index.html"),
      },
    },
  },
});

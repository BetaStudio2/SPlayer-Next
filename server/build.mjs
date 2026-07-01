/**
 * 服务端打包脚本：用 esbuild 把 index.ts 及其依赖（含 @main/* @shared/* 别名）
 * 打成 ESM 单入口（splitting 处理动态 import），原生依赖标记为 external。
 */
import esbuild from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await esbuild.build({
  entryPoints: ["index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outdir: "dist",
  splitting: true,
  // 原生 / 第三方包保持 external，由 node_modules 解析
  packages: "external",
  tsconfig: "tsconfig.json",
  // 路径别名（与 tsconfig paths 同步，esbuild 不自动读取）
  alias: {
    "@main": ".",
    "@shared": "../shared",
  },
  sourcemap: true,
  // ESM 下提供 require（部分 CJS 依赖需要）
  banner: {
    js: "import { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);",
  },
});

console.log("server build → dist/index.js");

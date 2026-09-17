// esbuild 打包配置：把 src/*.ts 编译成单个 main.js
import esbuild from "esbuild";
import { existsSync, rmSync } from "fs";

const prod = process.argv[2] === "production";
const out = "main.js";

if (existsSync(out)) rmSync(out);

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: out,
  format: "cjs",          // Obsidian 需要 CommonJS
  target: "es2020",
  platform: "node",
  external: ["obsidian", "electron"],
  loader: { ".md": "text" },   // 内联 markdown 文本资源（如合并 prompt 前言）
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  logLevel: "info",
}).catch(() => process.exit(1));

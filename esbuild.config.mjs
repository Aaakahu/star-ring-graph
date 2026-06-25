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
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  logLevel: "info",
}).catch(() => process.exit(1));

/**
 * fts.ts — 进程内 FTS 索引
 *
 * 架构：view.ts → 直接调 FtsIndex 方法 → sql.js (sql-asm.js, in-memory) → wiki.db
 *
 * 设计选择：
 *   - 用 sql-asm.js（纯 JS 实现，1.3MB），不用 sql-wasm（需单独加载 .wasm 文件，Electron 里麻烦）
 *   - 表是普通表（非 FTS5 虚拟表，sql.js 默认编译不含 FTS5）；查询全用 LIKE
 *   - 列结构沿用历史 Python build_index.py 的 12 列定义（path/title/kind/subtype/chapter/section/topic/tags/mindtree/flash/errors/body）
 */

import * as fs from "fs";
import * as path from "path";

// ponytail: 直接 require 纯 JS 实现，避免 esbuild 处理 .wasm 资产。
// sql-asm.js 比 sql-wasm.js 大但零外部依赖，Electron 沙箱里最稳。
// 性能：收进懒加载函数——顶层 require 会在插件加载（含 Obsidian 每次启动）时执行整个
// sql-asm 引擎初始化（1.3MB 纯 JS）。esbuild 把 CJS 模块包成懒初始化闭包，首次建/查索引才执行。
// @ts-ignore - sql.js 自带类型走 sql-wasm.js，我们用 sql-asm.js，类型靠手动声明
let _initSqlJs: any = null;
function getSqlJs(): any {
  if (!_initSqlJs) {
    // @ts-ignore - 见上
    _initSqlJs = require("sql.js/dist/sql-asm.js");
  }
  return _initSqlJs;
}

// ============ 类型 ============
export type CardKind = "moc" | "flash" | "error";

export interface NoteRow {
  path: string;
  title: string;
  kind: CardKind | "";
  subtype: string;
  chapter: string;
  section: string;
  topic: string;
  tags: string;
  mindtree: string;
  flash: string;
  errors: string;
  body?: string; // /fts 返回时不带；内部 builder 用
  is_leaf?: number; // 1=叶子（真知识），0=导航（聚合 tags 空壳）；flash/error 恒为 1
}

export interface FtsHit {
  path: string;
  title: string;
  kind: string;
  subtype: string;
  chapter: string;
  section: string;
  topic: string;
  tags: string;
  mindtree: string;
  entity_name: string;
  body?: string; // searchDeep 用：喂给 GLM 理解语境
  is_leaf?: number; // 1=叶子，0=导航；view.ts 据此过滤导航不进星云
}

export interface DeepCandidate extends FtsHit {
  expand_reason: string;
}

export interface DeepResult {
  seeds: FtsHit[];
  candidates: DeepCandidate[];
  count: number;
  mode: string;
}

export interface TermItem {
  title: string;
  topic: string;
  kind: string;
  path: string;
}

// ============ 常量：目录约定（与历史 Python 版对齐）============
// ponytail: 硬编码默认源（与 settings.sources[0] 一致）；多源场景下 builder 接受外部传入
const DEFAULT_MOC_FOLDER = "1_高等数学Moc";
const DEFAULT_FLASH_FOLDER = "StudyGuide/Flash";
const DEFAULT_ERROR_FOLDER = "StudyGuide/Errors";

// ============ frontmatter 解析（移植自历史 Python 版）============
// FM_RE: ^---\n(...)\n---\n；WL_RE: [[xxx]] → xxx
const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const WL_RE = /\[\[([^\]]+)\]\]/g;

interface Frontmatter {
  [key: string]: string | string[];
}

/** 极简 frontmatter 解析。不处理嵌套 YAML，够用就行（与 Python 版等价）。 */
function parseFrontmatter(content: string): Frontmatter {
  const m = content.match(FM_RE);
  if (!m) return {};
  const fmText = m[1];
  const result: Frontmatter = {};
  let currentKey: string | null = null;

  for (const line of fmText.split("\n")) {
    if (!line.trim()) continue;
    // 列表项：  - [[xxx]] 或 - tag
    if (line.startsWith("  -") || line.startsWith("- ")) {
      const val = line.replace(/^[\s-]+/, "").trim();
      if (currentKey && Array.isArray(result[currentKey])) {
        const arr = result[currentKey] as string[];
        if (val.startsWith("[[")) {
          // 提取所有 [[xxx]]
          let mm: RegExpExecArray | null;
          const re = new RegExp(WL_RE);
          while ((mm = re.exec(val)) !== null) arr.push(mm[1]);
        } else {
          arr.push(val);
        }
      }
      continue;
    }
    // key: value 或 key:
    const colonIdx = line.indexOf(":");
    if (colonIdx >= 0) {
      const k = line.slice(0, colonIdx).trim();
      let v = line.slice(colonIdx + 1).trim();
      if (v === "") {
        result[k] = [];
        currentKey = k;
      } else {
        // 单行值：可能是 [a, b, c] 或标量
        if (v.startsWith("[") && v.endsWith("]")) {
          const inner = v.slice(1, -1);
          const items = inner.split(",")
            .map((x) => x.trim().replace(/^["']|["']$/g, ""))
            .filter((x) => x);
          result[k] = items;
          currentKey = null;
        } else {
          result[k] = v.replace(/^["']|["']$/g, "");
          currentKey = null;
        }
      }
    }
  }
  return result;
}

function stripFrontmatter(content: string): string {
  return content.replace(FM_RE, "");
}

function stripPrefix(name: string): string {
  return name.replace(/^[\d.]+_/, "");
}

/**
 * 判定节点是否为叶子（真知识载体）。MOC 改造后分导航（聚合 tags、只有 [[链接]]）和叶子（含公式或正文）。
 * 算法 v3（真实数据验证 8/8 边界 case）：
 *   - flash/error 永远叶子（自己就是知识）
 *   - 有数学公式（行内 $ 或块 $$）= 真 leaf
 *   - 无公式 + 无链接 + 行数<60 = 短定义（leaf）
 *   - 无公式 + 无链接 + 行数>=60 = 目录/映射表（nav）—— 防止笔记-习题映射表等伪装叶子
 *   - 有链接无公式 = 导航
 * ponytail: formula>=1 而非文档的 >=2，避免单 $$ 块的真叶子（分部积分法/万能代换）被误判
 */
function computeIsLeaf(kind: string, body: string): number {
  if (kind !== "moc") return 1;
  const formulaBlock = (body.match(/\$\$/g) || []).length / 2;
  const formulaInline = (body.match(/(?<!\$)\$(?!\$)/g) || []).length;
  const links = (body.match(/\[\[/g) || []).length;
  const lines = body.split("\n").filter((l) => l.trim()).length;
  if (formulaBlock >= 1 || formulaInline >= 1) return 1;
  if (links === 0) return lines >= 60 ? 0 : 1;
  return 0;
}

/** 从文件名前缀推章节号。返回 [顶层章, 完整段号]。
 *  '2.3.4_泰勒.md' → ['2', '2.3.4']
 *  'foo' → ['', ''] */
function chapterFromPrefix(name: string): [string, string] {
  const m = name.match(/^\W*(\d+)((?:\.\d+)*)/);
  if (!m) return ["", ""];
  const full = m[1] + (m[2] || "");
  return [m[1], full];
}

/** 清洗 wikilink 字段：list/scalar 都接受，去 [[]] 后空格分隔。 */
function cleanWikilinks(val: string | string[] | undefined): string {
  if (Array.isArray(val)) {
    const items: string[] = [];
    for (const x of val) {
      const s = String(x);
      const re = new RegExp(WL_RE);
      let mm: RegExpExecArray | null;
      let matched = false;
      while ((mm = re.exec(s)) !== null) {
        items.push(mm[1]);
        matched = true;
      }
      if (!s.startsWith("[[")) items.push(s.replace(/^["']|["']$/g, "").trim());
      // ponytail: 若 s 含 [[...]]，纯链接项的裸文本部分会重复，这里 matched=true 时跳过裸文本
      void matched;
    }
    return items.filter(Boolean).join(" ");
  }
  return val == null ? "" : String(val);
}

// ============ IndexBuilder：扫描 vault + 重建 wiki.db ============
export interface BuilderFolders {
  mocFolder: string;
  flashFolder: string;
  errorFolder: string;
}

export class IndexBuilder {
  constructor(private vaultRoot: string, private dbPath: string) {}

  /**
   * 扫描三层卡片 → 覆盖重建 wiki.db。
   * 返回 { ok, msg, count, byKind }。
   * 失败抛异常。
   */
  async build(folders: BuilderFolders): Promise<{
    ok: boolean;
    msg: string;
    count: number;
    byKind: Record<string, number>;
  }> {
    const SQL = await getSqlJs();
    const cards = this.collectCards(folders);

    const byKind: Record<string, number> = {};
    for (const [, kind] of cards) byKind[kind] = (byKind[kind] || 0) + 1;

    // 覆盖旧库（ ponytail: 写前确保目录存在，目录被清空后 IndexBuilder 要能自己重建 ）
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath);

    const db = new SQL.Database();
    // 普通表（非 FTS5 虚拟表）：sql.js 默认不含 FTS5，查询全用 LIKE
    // 列结构沿用历史 Python 版的 12 列定义
    db.run(`
      CREATE TABLE notes (
        path     TEXT,
        title    TEXT,
        kind     TEXT,
        subtype  TEXT,
        chapter  TEXT,
        section  TEXT,
        topic    TEXT,
        tags     TEXT,
        mindtree TEXT,
        flash    TEXT,
        errors   TEXT,
        body     TEXT,
        is_leaf  INTEGER
      )
    `);

    const rows: any[][] = [];
    for (const [cardPath, kind] of cards) {
      let content: string;
      try {
        content = fs.readFileSync(cardPath, "utf-8");
      } catch {
        continue; // 读不了的卡跳过（与 Python 行为一致）
      }
      const fm = parseFrontmatter(content);
      const body = stripFrontmatter(content).trim();
      const filename = path.basename(cardPath, ".md");

      let chapter = "", section = "", title = "", subtype = "", topic = "";
      let tags = "", mindtree = "", flashField = "", errorsField = "";

      if (kind === "moc") {
        [chapter, section] = chapterFromPrefix(filename);
        title = (typeof fm.title === "string" ? fm.title : "") || stripPrefix(filename);
        // MOC frontmatter 规范化后也带 topic/tags（由 gen-moc-frontmatter.mjs 自动生成）
        topic = typeof fm.topic === "string" ? fm.topic : "";
        const mocTagsVal = fm.tags;
        tags = Array.isArray(mocTagsVal) ? mocTagsVal.join(" ") : (mocTagsVal == null ? "" : String(mocTagsVal));
      } else {
        [chapter, section] = ["", ""];
        title = (typeof fm.title === "string" ? fm.title : "") || stripPrefix(filename);
        subtype = typeof fm.subtype === "string" ? fm.subtype : "";
        topic = typeof fm.topic === "string" ? fm.topic : "";
        const tagsVal = fm.tags;
        tags = Array.isArray(tagsVal) ? tagsVal.join(" ") : (tagsVal == null ? "" : String(tagsVal));

        mindtree = cleanWikilinks(fm.mindtree as any);
        flashField = cleanWikilinks(fm.flash as any);
        errorsField = cleanWikilinks(fm.errors as any);

        // Flash/Error 的章节归属：从 mindtree 第一项推（最具体的挂载点）
        if (mindtree && !chapter) {
          const firstMt = mindtree.split(/\s+/)[0] || "";
          [chapter, section] = chapterFromPrefix(firstMt);
        }
      }

      const relPath = path.relative(this.vaultRoot, cardPath).replace(/\\/g, "/");
      const isLeaf = computeIsLeaf(kind, body);
      rows.push([relPath, title, kind, subtype, chapter, section,
        topic, tags, mindtree, flashField, errorsField, body, isLeaf]);
    }

    // 批量插入（sql.js 没有真正 executemany，用 prepared statement 循环）
    const stmt = db.prepare("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    db.run("BEGIN");
    for (const r of rows) {
      stmt.run(r);
      stmt.reset();
    }
    db.run("COMMIT");
    stmt.free();

    // 写到磁盘
    const data = db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
    db.close();

    return {
      ok: true,
      msg: `索引重建完成（${rows.length} 条）`,
      count: rows.length,
      byKind,
    };
  }

  /** 收集三层卡片：[(绝对路径, kind), ...] */
  private collectCards(folders: BuilderFolders): [string, CardKind][] {
    const out: [string, CardKind][] = [];
    const pairs: [string, CardKind][] = [
      [folders.mocFolder || DEFAULT_MOC_FOLDER, "moc"],
      [folders.flashFolder || DEFAULT_FLASH_FOLDER, "flash"],
      [folders.errorFolder || DEFAULT_ERROR_FOLDER, "error"],
    ];
    for (const [folder, kind] of pairs) {
      const dir = path.join(this.vaultRoot, folder);
      if (!fs.existsSync(dir)) continue;
      this.walkMd(dir, (p) => {
        const name = path.basename(p);
        if (name.startsWith("0_")) return; // 思维树根跳过
        out.push([p, kind]);
      });
    }
    return out;
  }

  private walkMd(dir: string, cb: (p: string) => void): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        this.walkMd(full, cb);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        cb(full);
      }
    }
  }
}

// ============ FtsIndex：查询索引（三个公开方法对应历史三个 HTTP 端点）============
export class FtsIndex {
  private db: any = null;
  private dbPath: string;
  private mtime: number = 0; // wiki.db 上次加载时的 mtime，用于热重载判断
  // ponytail: statSync 防抖——搜索路径每次查之前都调 reloadIfStale，60s 内不重复 statSync
  private _lastStaleCheck: number = 0;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** 加载 wiki.db 到内存。失败抛异常。 */
  async load(): Promise<void> {
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`索引不存在：${this.dbPath}，请先在设置面板点「重建索引」`);
    }
    const SQL = await getSqlJs();
    const buf = fs.readFileSync(this.dbPath);
    this.db = new SQL.Database(new Uint8Array(buf));
    this.mtime = fs.statSync(this.dbPath).mtimeMs;
  }

  /** 如果 wiki.db 比上次加载新，重新加载（热重载，重建索引后自动生效）。 */
  async reloadIfStale(): Promise<void> {
    if (!this.db) return;
    // ponytail: 60s 防抖，避免搜索热路径每次都 statSync
    const now = Date.now();
    if (now - this._lastStaleCheck < 60000) return;
    this._lastStaleCheck = now;
    try {
      const m = fs.statSync(this.dbPath).mtimeMs;
      if (m !== this.mtime) await this.load();
    } catch { /* 文件可能正在被写，忽略 */ }
  }

  isLoaded(): boolean {
    return this.db != null;
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* */ }
      this.db = null;
    }
  }

  /** 行数（/health 用） */
  count(): number {
    if (!this.db) return 0;
    const r = this.db.exec("SELECT COUNT(*) FROM notes");
    return r.length ? (r[0].values[0][0] as number) : 0;
  }

  /** 返回所有卡标题（/terms 用，供 GLM 改写参考） */
  terms(): TermItem[] {
    if (!this.db) return [];
    const r = this.db.exec("SELECT title, topic, kind, path FROM notes ORDER BY kind, title");
    if (!r.length) return [];
    return r[0].values.map((row: any[]) => ({
      title: row[0] || "",
      topic: row[1] || "",
      kind: row[2] || "",
      path: row[3] || "",
    })).filter((t: TermItem) => t.title);
  }

  /** 按路径批量取卡片正文（去 frontmatter 的纯正文），供相似卡精读阶段用 */
  getBodiesByPaths(paths: string[]): Map<string, string> {
    if (!this.db || !paths.length) return new Map();
    const ph = paths.map(() => "?").join(",");
    const rows = this.queryRows(`SELECT path, body FROM notes WHERE path IN (${ph})`, paths);
    return new Map(rows.map(r => [r.path, r.body || ""]));
  }

  /** 模糊词扩展：搜索词 ≥4 字时，从 tag 库找出"搜索词是其子序列"的 tag（如 泰勒展开→泰勒公式展开）。
   *  避免中间插字（泰勒公式展开）导致的 LIKE '%泰勒展开%' 漏匹配。短词(<4字)太泛不扩展。 */
  private _tagCache: string[] | null = null;
  expandQueryTags(q: string): string[] {
    if (!this.db || q.length < 4) return [];
    if (!this._tagCache) {
      const r = this.db.exec("SELECT DISTINCT tags FROM notes WHERE tags != ''");
      const set = new Set<string>();
      for (const row of r[0]?.values || []) {
        for (const t of String(row[0]).split(/\s+/)) {
          if (t.length >= 2) set.add(t.trim());
        }
      }
      this._tagCache = [...set];
    }
    const isSubseq = (sub: string, full: string): boolean => {
      let i = 0;
      for (const ch of full) { if (ch === sub[i]) i++; if (i === sub.length) return true; }
      return i === sub.length;
    };
    return this._tagCache.filter(t => t.length > q.length && isSubseq(q, t));
  }

  /** /fts：字面 LIKE 搜索。返回 FtsHit[]。无 LIMIT——库小（数百条），全量返回让 tier ORDER BY 自然排序。 */
  search(query: string, opts: {
    kind?: string; chapter?: string; subtype?: string;
  } = {}): FtsHit[] {
    if (!this.db) return [];
    const q = (query || "").trim();
    const kind = (opts.kind || "").trim();
    const chapter = (opts.chapter || "").trim();
    const subtype = (opts.subtype || "").trim();

    if (!q && !kind && !chapter) return [];

    let sql = "SELECT path, title, kind, subtype, chapter, section, topic, tags, mindtree, is_leaf FROM notes WHERE 1=1";
    const args: any[] = [];
    if (q) {
      const kw = `%${q}%`;
      // 快速搜索只搜属性字段（title/topic/tags/mindtree/flash），不搜 body 全文。
      // body 里常有证明/示例题偶然提及搜索词（如"用到泰勒展开"），不是该卡的核心主题 → 噪音。
      // 深度检索才搜 body + LLM 语境理解，决定是否高亮。
      sql += " AND (title LIKE ? OR topic LIKE ? OR tags LIKE ? OR mindtree LIKE ? OR flash LIKE ?";
      args.push(kw, kw, kw, kw, kw);
      // 模糊词扩展：搜索词≥4字时，把 tag 库里的模糊匹配 tag 也加入 LIKE（如 泰勒展开→泰勒公式展开）
      for (const et of this.expandQueryTags(q)) {
        sql += " OR tags LIKE ?";
        args.push(`%${et}%`);
      }
      sql += ")";
    }
    if (kind) { sql += " AND kind = ?"; args.push(kind); }
    if (chapter) { sql += " AND chapter = ?"; args.push(chapter); }
    if (subtype) { sql += " AND subtype = ?"; args.push(subtype); }
    // rank 精排：tier 分层。叶子 title(0) > 卡 title(1) > 叶子 topic/tags(2) > 卡 topic/tags(3) > 导航聚合 tags(垫底)。
    // MOC 改造后导航挂聚合 tags（8-15个），靠 tags 命中≠相关，必须降到末尾。
    if (q) {
      const kw = `%${q}%`;
      sql += " ORDER BY " +
        "(CASE WHEN kind='moc' AND is_leaf=1 AND title LIKE ? THEN 0 ELSE 1 END), " +
        "(CASE WHEN kind!='moc' AND title LIKE ? THEN 0 ELSE 1 END), " +
        "(CASE WHEN kind='moc' AND is_leaf=1 AND (topic LIKE ? OR tags LIKE ?) THEN 0 ELSE 1 END), " +
        "(CASE WHEN kind!='moc' AND (topic LIKE ? OR tags LIKE ?) THEN 0 ELSE 1 END)";
      args.push(kw, kw, kw, kw, kw, kw);
    }

    const r = this.db.exec(sql, args);
    return this.toFtsHits(r);
  }

  /**
   * searchDeep：种子召回 top-5 + 属性扩展三梯队（移植自历史 Python 版）。
   * 纯 SQL，不调外部 API。GLM 精筛在 view.ts 做。
   */
  searchDeep(query: string, opts: {
    mode?: string; keywords?: string[];
  } = {}): DeepResult {
    if (!this.db) return { seeds: [], candidates: [], count: 0, mode: opts.mode || "concept" };
    const q = (query || "").trim();
    const mode = opts.mode || "concept";
    const keywords = opts.keywords || [];

    if (!q && !keywords.length) {
      return { seeds: [], candidates: [], count: 0, mode };
    }

    // Step 1: 种子召回 top-5（多关键词 OR / 单整句回退）
    // 模糊词扩展：对原始搜索词（整句或关键词）≥4 字的做 tag 子序列扩展（如 泰勒展开→泰勒公式展开）
    const baseKws = (keywords.length
      ? keywords.map((k) => k.trim()).filter((k) => k && k !== "%%").slice(0, 8)
      : [q]
    );
    const expandedKws: string[] = [];
    for (const bk of baseKws) {
      expandedKws.push(bk);
      for (const et of this.expandQueryTags(bk)) expandedKws.push(et);
    }
    const kwList = expandedKws.map((k) => `%${k}%`);
    if (!kwList.length) return { seeds: [], candidates: [], count: 0, mode };

    // 深度检索搜 body 全文（快速搜索不搜 body，但深度检索靠 GLM 理解语境，body 噪音可被 LLM 过滤）
    const perKwCond = Array(kwList.length)
      .fill("title LIKE ? OR body LIKE ? OR topic LIKE ? OR tags LIKE ? OR mindtree LIKE ?")
      .join(" OR ");
    const whereArgs: string[] = [];
    for (const kw of kwList) whereArgs.push(kw, kw, kw, kw, kw);
    const firstKw = kwList[0];

    const seedSql = `SELECT path, title, kind, subtype, chapter, section, topic, tags, mindtree, flash, errors, is_leaf
                     FROM notes WHERE ${perKwCond}
                     ORDER BY (CASE WHEN kind='moc' AND is_leaf=1 AND title LIKE ? THEN 0 ELSE 1 END),
                              (CASE WHEN kind!='moc' AND title LIKE ? THEN 0 ELSE 1 END),
                              (CASE WHEN kind='moc' AND is_leaf=1 AND (topic LIKE ? OR tags LIKE ?) THEN 0 ELSE 1 END),
                              (CASE WHEN kind!='moc' AND (topic LIKE ? OR tags LIKE ?) THEN 0 ELSE 1 END),
                              (CASE WHEN kind='moc' AND is_leaf=0 THEN 1 ELSE 0 END)`;
    const seedArgs = [...whereArgs, firstKw, firstKw, firstKw, firstKw, firstKw, firstKw];
    const seedR = this.db.exec(seedSql, seedArgs);
    const seeds = this.toNoteRows(seedR);

    if (!seeds.length) return { seeds: [], candidates: [], count: 0, mode };

    // Step 2: 属性扩展三梯队
    const candidates = new Map<string, DeepCandidate>();
    const seedTitles = new Set(seeds.map((s) => s.title));

    const addCandidate = (row: NoteRow, reason: string) => {
      const t = row.title;
      if (!t || candidates.has(t) || seedTitles.has(t)) return;
      candidates.set(t, { ...this.rowToHit(row), expand_reason: reason });
    };

    // 梯队 1a：mindtree 同最具体挂载点；梯队 1b：errors↔flash 双链
    for (const seed of seeds) {
      const smindtree = seed.mindtree || "";
      const serrors = seed.errors || "";
      const sflash = seed.flash || "";
      const stags = seed.tags || "";
      const stopic = seed.topic || "";
      const skind = seed.kind;
      const stitle = seed.title;

      if (smindtree) {
        const firstNode = smindtree.split(" ")[0];
        const rows = this.queryRows(
          "SELECT path,title,kind,subtype,chapter,section,topic,tags,mindtree,flash,errors " +
          "FROM notes WHERE mindtree LIKE ? AND title != ?",
          [`%${firstNode}%`, stitle]
        );
        for (const r of rows) addCandidate(r, "sibling");
      }

      // MOC 种子：标题会出现在子卡的 mindtree 里
      if (skind === "moc") {
        const rows = this.queryRows(
          "SELECT path,title,kind,subtype,chapter,section,topic,tags,mindtree,flash,errors " +
          "FROM notes WHERE (kind='flash' OR kind='error') AND mindtree LIKE ?",
          [`%${stitle}%`]
        );
        for (const r of rows) {
          addCandidate(r, "child_of_moc");
        }
      }

      // errors ↔ flash 双链
      for (const fieldVal of [serrors, sflash]) {
        if (!fieldVal) continue;
        const re = /\[\[([^\]]+)\]\]/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(fieldVal)) !== null) {
          const lt = mm[1];
          const rows = this.queryRows(
            "SELECT path,title,kind,subtype,chapter,section,topic,tags,mindtree,flash,errors " +
            "FROM notes WHERE title LIKE ? LIMIT 3",
            [`%${lt}%`]
          );
          for (const r of rows) addCandidate(r, "error_link");
        }
      }

      // 梯队 2：同 topic
      if (stopic) {
        const rows = this.queryRows(
          "SELECT path,title,kind,subtype,chapter,section,topic,tags,mindtree,flash,errors " +
          "FROM notes WHERE topic = ? AND title != ?",
          [stopic, stitle]
        );
        for (const r of rows) {
          addCandidate(r, "same_topic");
        }
      }

      // 梯队 3：共享 tags（排除导航：导航的聚合 tags 8-15 个，会让整章全互联成噪声）
      if (stags) {
        const tagList = stags.split(/\s+/).filter((t) => t.length >= 2);
        if (tagList.length) {
          const conds = tagList.map(() => "tags LIKE ?").join(" OR ");
          const params = tagList.map((t) => `%${t}%`).concat([stitle]);
          const rows = this.queryRows(
            "SELECT path,title,kind,subtype,chapter,section,topic,tags,mindtree,flash,errors " +
            `FROM notes WHERE (${conds}) AND title != ? AND (kind != 'moc' OR is_leaf = 1)`,
            params
          );
          for (const r of rows) {
            addCandidate(r, "shared_tags");
          }
        }
      }
    }

    const seedHits: FtsHit[] = seeds.map((s) => this.rowToHit(s));
    // 批量拉 body 喂 GLM（理解语境用，candidates 也补上）
    const allPaths = [...seeds.map(s => s.path), ...Array.from(candidates.values()).map(c => c.path)];
    const bodyMap = this.getBodiesByPaths(allPaths);
    seedHits.forEach(h => { h.body = bodyMap.get(h.path) || ""; });
    const candList = Array.from(candidates.values());
    candList.forEach(c => { c.body = bodyMap.get(c.path) || "" });
    return { seeds: seedHits, candidates: candList, count: candList.length, mode };
  }

  // ============ 内部工具 ============
  private queryRows(sql: string, args: any[]): NoteRow[] {
    const r = this.db.exec(sql, args);
    return this.toNoteRows(r);
  }

  private toNoteRows(r: any[]): NoteRow[] {
    if (!r.length) return [];
    const cols = r[0].columns;
    return r[0].values.map((row: any[]) => {
      const o: any = {};
      cols.forEach((c: string, i: number) => o[c] = row[i] ?? "");
      return o as NoteRow;
    });
  }

  private toFtsHits(r: any[]): FtsHit[] {
    if (!r.length) return [];
    const cols = r[0].columns;
    return r[0].values.map((row: any[]) => {
      const o: any = {};
      cols.forEach((c: string, i: number) => o[c] = row[i] ?? "");
      o.entity_name = o.title;
      return o as FtsHit;
    });
  }

  private rowToHit(row: NoteRow): FtsHit {
    return {
      path: row.path, title: row.title, kind: String(row.kind || ""),
      subtype: row.subtype || "", chapter: row.chapter || "",
      section: row.section || "", topic: row.topic || "",
      tags: row.tags || "", mindtree: row.mindtree || "",
      entity_name: row.title,
      is_leaf: row.is_leaf,
    };
  }
}

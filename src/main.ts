// 星环图谱插件入口
import { Plugin, PluginSettingTab, Setting, Notice, debounce, requestUrl } from "obsidian";
import { StarRingView, STAR_RING_VIEW_TYPE } from "./view";
import { buildChapterTree } from "./data";
import { FtsIndex, IndexBuilder } from "./fts";
import { loadPluginFonts } from "./font-loader";
import * as fs from "fs";
import * as path from "path";

// 一个数据源 = 一个 MOC 文件夹 + 对应的 Flash 文件夹 + Error 文件夹
// 未来扩线代时，加一组 sources 即可，互不干扰
export interface FolderSource {
  name: string;          // 显示名（如 "高数"）
  mocFolder: string;     // MOC/思维树笔记文件夹
  flashFolder: string;   // Flash 卡片文件夹
  errorFolder: string;   // 错题卡片文件夹
}

// 一套 LLM 站点配置（OpenAI 兼容）。站点池支持失败自动切换（故障转移）。
export interface LlmProfile {
  name: string;     // 显示名（如 "AgentRouter"）
  baseUrl: string;  // OpenAI 兼容地址，不含 /chat/completions
  apiKey: string;
  model: string;
  enabled: boolean; // 停用后不参与调用与故障转移
}

export interface StarRingSettings {
  sources: FolderSource[];
  activeSource: string;          // 学科联动：非空时图谱只显示该名数据源（空 = 全部）；由 StudyGuide 学科切换写入
  layout: 'fishbone' | 'sector'; // 鱼骨主干 / 星环扇区
  detailZoom: number;            // 预留（当前旭日图不消费，但 slider 保留）
  // ===== LLM 站点池（深度检索调用，OpenAI 兼容格式）=====
  llmProfiles: LlmProfile[];     // 站点池：当前站点失败时自动切到下一个启用的
  llmActive: number;             // 当前使用的站点下标
  llmProvider: string;           // 服务商预设：glm/deepseek/openai/claude/custom（custom=站点池成员）
  llmApiKey: string;             // 当前站点 key（= llmProfiles[llmActive] 的镜像，旧读取点直接用）
  llmBaseUrl: string;            // 当前站点地址
  llmModel: string;              // 当前站点模型名
}

// 服务商预设：选了自动填 base_url + 模型名。
// ponytail: v2 已删 LightRAG/embedding 配置，预设只剩 LLM 三件套。
const LLM_PRESETS: Record<string, {
  label: string;
  llmBaseUrl: string; llmModel: string;
  note?: string;
}> = {
  glm: {
    label: "智谱 GLM",
    llmBaseUrl: "https://open.bigmodel.cn/api/paas/v4", llmModel: "glm-4.5-air",
  },
  deepseek: {
    label: "DeepSeek",
    llmBaseUrl: "https://api.deepseek.com/v1", llmModel: "deepseek-chat",
  },
  openai: {
    label: "OpenAI",
    llmBaseUrl: "https://api.openai.com/v1", llmModel: "gpt-4o-mini",
  },
  claude: {
    label: "Claude（via OpenRouter）",
    llmBaseUrl: "https://openrouter.ai/api/v1", llmModel: "anthropic/claude-3.5-sonnet",
    note: "Claude 原生 API 非 OpenAI 兼容，通过 OpenRouter 代理",
  },
  custom: { label: "自定义", llmBaseUrl: "", llmModel: "" },
};

const DEFAULT_SETTINGS: StarRingSettings = {
  sources: [
    {
      name: "高等数学",
      mocFolder: "1_高等数学Moc",
      flashFolder: "StudyGuide/Flash",
      errorFolder: "StudyGuide/Errors",
    },
  ],
  activeSource: "",
  layout: "fishbone",
  detailZoom: 1.5,
  llmProfiles: [],
  llmActive: 0,
  llmProvider: "glm",
  llmApiKey: "",
  llmBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  llmModel: "glm-4.5-air",
};

export default class StarRingGraphPlugin extends Plugin {
  settings: StarRingSettings = DEFAULT_SETTINGS;
  // 进程内 FTS 索引（替代旧 Python serve.py 的 HTTP 服务）
  fts: FtsIndex | null = null;
  // ponytail: buildChapterTree 缓存——首次 onOpen 后，重开/刷新走缓存（只读 frontmatter，metadataCache 变更时失效）
  _cachedTree: any = null;
  // 进行中的树构建 promise（onload 预热与视图 onOpen 并发发起时共享同一次构建）
  private _treeBuildPromise: Promise<any> | null = null;

  /** 取树数据：有缓存直接用；没有就构建（并发调用共享同一 promise，只构建一次）。 */
  async ensureTree(): Promise<any> {
    if (this._cachedTree) return this._cachedTree;
    if (!this._treeBuildPromise) {
      this._treeBuildPromise = buildChapterTree(this.app, this.settings)
        .then(t => { this._cachedTree = t; this._treeBuildPromise = null; return t; })
        .catch(e => { this._treeBuildPromise = null; throw e; });
    }
    return this._treeBuildPromise;
  }

  /** 缓存失效（文件变更/设置变更）。所有原来直接置 `_cachedTree = null` 的地方统一走这里。 */
  invalidateTree() {
    this._cachedTree = null;
    this._treeBuildPromise = null;
  }
  // 数据源文件变更后的实时重建：批量导入/重命名会对每个文件触发一次事件，防抖 1.5s 合并成一次
  private scheduleLiveRebuild = debounce(() => this.refreshView(), 1500, true);

  async onload() {
    await this.loadSettings();
    loadPluginFonts(this);

    this.registerView(STAR_RING_VIEW_TYPE, (leaf) => new StarRingView(leaf, this));

    this.addCommand({
      id: "open-star-ring-graph",
      name: "打开星环图谱",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new StarRingSettingTab(this.app, this));

    // 跟随 Obsidian 明暗主题切换:监听 body.class 的 theme-dark/theme-light 变化,
    // 触发时重建已打开的图谱视图(draw 重读 CSS 变量 → 自动用新主题色)。
    // 只在主题真正切换时刷新——Obsidian 重载时 body.class 会连续变异多次（插件重载、
    // 布局恢复、主题类重应用），如果每次 class 变化都 refreshView，图谱会重绘 3-4 次。
    const getTheme = () => document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    let lastTheme = getTheme();
    const themeObserver = new MutationObserver(() => {
      const cur = getTheme();
      if (cur !== lastTheme) {
        lastTheme = cur;
        this.refreshView();
      }
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.register(() => themeObserver.disconnect());

    // ponytail: 监听 frontmatter 变更，失效 treeData 缓存。
    // buildChapterTree 只读 frontmatter（mindtree/flash/title/subtype），metadataCache.on('changed') 在 frontmatter 解析后触发。
    // 只 watch 配置的源文件夹，避免无关笔记改动清缓存。
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      if (!this._cachedTree) return;
      const folders = this.settings.sources.flatMap(s => [s.mocFolder, s.flashFolder, s.errorFolder]);
      if (folders.some(f => file.path.startsWith(f + '/') || file.path.startsWith(f + '\\'))) {
        this.invalidateTree();
        this.scheduleLiveRebuild();
      }
    }));
    // 改名/删除也失效缓存：文件名前缀就是树结构（1.1→1.1.1 父子靠文件名解析），
    // 外部批量改名（脚本重编号）只触发 vault rename，不触发 metadataCache 'changed'——
    // 不监听的话，改名瞬间构建的"半索引树"会被缓存住：父节点文件暂不可见，孩子全挂根上。
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!this._cachedTree) return;
      const folders = this.settings.sources.flatMap(s => [s.mocFolder, s.flashFolder, s.errorFolder]);
      const touches = (p: string) => folders.some(f => p.startsWith(f + '/') || p.startsWith(f + '\\'));
      if (touches(file.path) || touches(oldPath)) {
        this.invalidateTree();
        this.scheduleLiveRebuild();
      }
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (!this._cachedTree) return;
      const folders = this.settings.sources.flatMap(s => [s.mocFolder, s.flashFolder, s.errorFolder]);
      if (folders.some(f => file.path.startsWith(f + '/') || file.path.startsWith(f + '\\'))) {
        this.invalidateTree();
        this.scheduleLiveRebuild();
      }
    }));

    // 启动时加载 FTS 索引到内存（不阻塞 onload）
    // ponytail: v2 改成进程内 sql.js，不再 spawn Python、不再开端口。
    // 加载失败不致命（用户可能在首次使用前还没建索引），只是查询时报错。
    this.loadFtsIndex().catch((e) => {
      console.warn("[星环图谱] FTS 索引加载失败（查询时会再尝试）：", e?.message || e);
    });

    // 后台预热树缓存：布局就绪 + metadataCache 解析完成后构建一次。
    // 否则上次关闭时图谱 leaf 开着 → workspace 恢复在启动窗口内冷构建树，拖慢启动体感；
    // 预热后首次打开图谱直接命中缓存（ensureTree 并发去重，与 onOpen 撞车也只构建一次）。
    this.app.workspace.onLayoutReady(() => {
      const preheat = () => this.ensureTree().catch(() => { /* 预热失败静默，打开时再试 */ });
      if ((this.app.metadataCache as any).resolved) preheat();
      else this.registerEvent(this.app.metadataCache.on('resolved', () => preheat()));
    });

    console.log("[星环图谱] 插件已加载");
  }

  /** 解析插件目录的绝对路径。
   *  ponytail: manifest.dir 在 Windows 上返回相对路径（.obsidian\\plugins\\xxx），
   *  与 vault 根拼接必须用 getBasePath() 转绝对路径。 */
  pluginDir(): string {
    const vaultRoot = (this.app.vault.adapter as any).getBasePath?.() || '';
    return path.join(vaultRoot, this.manifest.dir || '');
  }

  /** vault 根绝对路径 */
  vaultRoot(): string {
    return (this.app.vault.adapter as any).getBasePath?.() || '';
  }

  /** 当前生效数据源（学科联动）：activeSource 命中取该源，否则 sources[0]。
   *  索引/检索/图谱全部只对这一源，保证学科间完全隔离。 */
  activeSourceConfig(): FolderSource | null {
    const sources = this.settings.sources || [];
    const active = this.settings.activeSource;
    const hit = active ? sources.find(s => s.name === active) : null;
    return hit || sources[0] || null;
  }

  /** 源 → 独立索引库文件：wiki.<mocFolder 安全化>.db，每学科一份，互不掺和 */
  ftsDbPathFor(src: FolderSource): string {
    const tag = (src.mocFolder || src.name || 'src').replace(/[\\/:*?"<>|\s]+/g, '_');
    return path.join(this.pluginDir(), 'fts', `wiki.${tag}.db`);
  }

  /** 当前学科索引库路径（旧 fts/wiki.db 仅作 sources[0] 的迁移来源保留） */
  ftsDbPath(): string {
    const src = this.activeSourceConfig();
    return src ? this.ftsDbPathFor(src) : path.join(this.pluginDir(), 'fts', 'wiki.db');
  }

  /** 加载当前学科索引到内存。旧版单库自动迁移一次（sources[0] 专用）。 */
  async loadFtsIndex(): Promise<FtsIndex | null> {
    const dbPath = this.ftsDbPath();
    // 旧库迁移：sources[0] 的独立库不存在而旧 wiki.db 在 → 复制为起始库，免重建
    const legacy = path.join(this.pluginDir(), 'fts', 'wiki.db');
    const first = this.settings.sources?.[0];
    if (first && !fs.existsSync(dbPath) && dbPath !== legacy && fs.existsSync(legacy)
      && this.ftsDbPathFor(first) === dbPath) {
      try {
        fs.copyFileSync(legacy, dbPath);
        console.log(`[星环图谱] 旧 wiki.db 已迁移为独立学科库：${path.basename(dbPath)}`);
      } catch { /* 迁移失败就走下面的重建路径 */ }
    }
    if (!fs.existsSync(dbPath)) {
      console.warn(`[星环图谱] 当前学科索引不存在：${dbPath}，请在设置面板点「重建索引」`);
      return null;
    }
    try {
      // 学科可能切换：dbPath 变了必须换新实例，旧实例闭着旧库不放
      this.fts?.close();
      this.fts = new FtsIndex(dbPath);
      await this.fts.load();
      console.log(`[星环图谱] FTS 索引已加载（${path.basename(dbPath)}，${this.fts.count()} 条）`);
      return this.fts;
    } catch (e: any) {
      console.error(`[星环图谱] FTS 索引加载失败：${e?.message || e}`);
      // 可能是旧版 FTS5 虚拟表格式（Python 版遗留），提示重建
      if (String(e?.message || '').includes('fts5') || String(e?.message || '').includes('no such module')) {
        console.warn("[星环图谱] 检测到旧版 FTS5 虚拟表，需重建索引（设置 → 重建索引）");
      }
      this.fts = null;
      return null;
    }
  }

  /** 确保当前学科索引可用：没有就现场重建。学科切换时由 StudyGuide 联动调用。 */
  async ensureFts(): Promise<FtsIndex | null> {
    await this.loadFtsIndex().catch(() => null);
    if (this.fts?.isLoaded()) return this.fts;
    const r = await this.rebuildIndex();
    if (!r.ok) console.warn(`[星环图谱] ${r.msg}`);
    return this.fts;
  }

  /** 重建 FTS 索引：为每个数据源分别建独立库，再加载当前学科那一份（学科隔离）。 */
  async rebuildIndex(): Promise<{ ok: boolean; msg: string }> {
    const sources = this.settings.sources || [];
    if (sources.length === 0) return { ok: false, msg: "未配置数据源" };
    try {
      const bySource: string[] = [];
      for (const src of sources) {
        const builder = new IndexBuilder(this.vaultRoot(), this.ftsDbPathFor(src));
        const result = await builder.build({
          mocFolder: src.mocFolder,
          flashFolder: src.flashFolder,
          errorFolder: src.errorFolder,
        });
        bySource.push(`${src.name}:${result.count}条`);
      }
      // 重建后重新加载当前学科
      this.fts?.close();
      this.fts = null;
      await this.loadFtsIndex();
      return {
        ok: true,
        msg: `索引重建完成，每学科独立库（${bySource.join('，')}）`,
      };
    } catch (e: any) {
      return {
        ok: false,
        msg: `重建失败：${e?.message || e}`,
      };
    }
  }

  async loadSettings() {
    const loaded: any = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 旧版迁移：检测到旧字段（mindTreeFolder 等）且 sources 缺失/空时，自动转成 sources[0]
    if ((!loaded.sources || loaded.sources.length === 0) && loaded.mindTreeFolder) {
      loaded.sources = [{
        name: loaded.rootName || "高数",
        mocFolder: loaded.mindTreeFolder,
        flashFolder: loaded.flashFolder || "StudyGuide/Flash",
        errorFolder: loaded.errorFolder || "StudyGuide/Errors",
      }];
      delete loaded.mindTreeFolder; delete loaded.flashFolder; delete loaded.errorFolder;
      delete loaded.chapterPrefix; delete loaded.rootName;
    }
    // v2 迁移：删除已废弃的 LightRAG/embedding 字段（保留在磁盘 data.json 无害，但内存里清掉）
    delete loaded.lightragUrl;
    delete loaded.lightragDir;
    delete loaded.embeddingApiKey;
    delete loaded.embeddingBaseUrl;
    delete loaded.embeddingModel;
    // 站点池迁移：旧版单站点字段 → 站点池第一个成员（名字尽量沿用服务商预设名）
    if (!Array.isArray(loaded.llmProfiles) || loaded.llmProfiles.length === 0) {
      const preset = Object.values(LLM_PRESETS).find(p => p.llmBaseUrl === loaded.llmBaseUrl);
      loaded.llmProfiles = [{
        name: preset?.label || "站点1",
        baseUrl: loaded.llmBaseUrl || "",
        apiKey: loaded.llmApiKey || "",
        model: loaded.llmModel || "",
        enabled: true,
      }];
      loaded.llmActive = 0;
    }
    this.settings = loaded;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ===== LLM 站点池：故障转移 =====
  // 进程内冷却表：baseUrl -> 冷却截止时间戳。失败站点冷却期内跳过，到期自动恢复。
  private llmCooldown: Record<string, number> = {};

  activeLlmProfile(): LlmProfile | null {
    return this.settings.llmProfiles?.[this.settings.llmActive] || null;
  }

  /** 切换当前站点：把站点池成员镜像到旧字段（llmApiKey/llmBaseUrl/llmModel），旧读取点不用改。 */
  async switchLlmProfile(i: number) {
    const p = this.settings.llmProfiles[i];
    if (!p) return;
    this.settings.llmActive = i;
    this.settings.llmProvider = "custom";
    this.settings.llmBaseUrl = p.baseUrl;
    this.settings.llmApiKey = p.apiKey;
    this.settings.llmModel = p.model;
    await this.saveSettings();
  }

  /** 站点池里至少有一个可用（启用 + 配齐地址/key）的站点。 */
  llmReady(): boolean {
    return (this.settings.llmProfiles || []).some(p => p.enabled && p.baseUrl && p.apiKey);
  }

  /** 深度检索统一 LLM 入口（OpenAI 兼容 /chat/completions），body 不含 model（各站点自带）。
   *  顺序：当前站点 → 其他启用站点。失败（网络错误/429 限流/4xx/5xx）→ 冷却后切下一个。
   *  429 冷却 1 分钟（免费站限流常态），其余失败冷却 10 分钟。全部失败返回最后一次结果。 */
  async llmChat(body: Record<string, any>): Promise<{ status: number; json: any; error?: string }> {
    const s = this.settings;
    const idxs = [s.llmActive, ...s.llmProfiles.map((_, i) => i).filter(i => i !== s.llmActive)];
    const now = Date.now();
    let last: { status: number; json: any; error?: string } = { status: 0, json: null, error: "站点池里没有可用站点" };
    for (const i of idxs) {
      const p = s.llmProfiles[i];
      if (!p?.enabled || !p.baseUrl || !p.apiKey) continue;
      if ((this.llmCooldown[p.baseUrl] || 0) > now) continue;
      let resp: any;
      try {
        resp = await requestUrl({
          url: `${p.baseUrl.replace(/\/+$/, "")}/chat/completions`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${p.apiKey}` },
          body: JSON.stringify({ ...body, model: p.model }),
          throw: false,
        });
      } catch (e: any) {
        this.llmCooldown[p.baseUrl] = now + 10 * 60_000;
        last = { status: 0, json: null, error: e?.message || String(e) };
        continue;
      }
      if (resp.status >= 200 && resp.status < 300) {
        if (i !== s.llmActive) {
          new Notice(`上一个站点不可用，深度检索已切换到「${p.name}」`, 4000);
          await this.switchLlmProfile(i);
        }
        return { status: resp.status, json: resp.json };
      }
      this.llmCooldown[p.baseUrl] = now + (resp.status === 429 ? 60_000 : 10 * 60_000);
      last = { status: resp.status, json: resp.json ?? null, error: `HTTP ${resp.status}` };
    }
    return last;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(STAR_RING_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("right");
      await leaf.setViewState({ type: STAR_RING_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // 设置变更后重建已打开的图谱
  refreshView() {
    // 学科/数据源切换可能改了 activeSource 过滤条件：先清插件级缓存，
    // 否则图谱关闭状态下切换，下次打开会吃旧缓存（视图首渲染只读 _cachedTree）
    this.invalidateTree();
    this.app.workspace.getLeavesOfType(STAR_RING_VIEW_TYPE)
      .forEach(leaf => (leaf.view as any).rerenderGraph?.());
  }

  async onunload() {
    this.fts?.close();
    console.log("[星环图谱] 插件已卸载");
  }
}

class StarRingSettingTab extends PluginSettingTab {
  plugin: StarRingGraphPlugin;

  constructor(app: any, plugin: StarRingGraphPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** 更新索引状态（卡数 + wiki.db 修改时间） */
  private async refreshIndexStatus(setting: any) {
    const dbPath = this.plugin.ftsDbPath();
    let count: number | string = '?';
    let mtimeStr = '';
    let loaded = !!this.plugin.fts;

    // 尝试确保索引已加载
    if (!loaded) {
      await this.plugin.loadFtsIndex();
      loaded = !!this.plugin.fts;
    }
    if (loaded && this.plugin.fts) {
      count = this.plugin.fts.count();
    }
    try {
      const stat = fs.statSync(dbPath);
      mtimeStr = ` | 更新：${stat.mtime.toLocaleString('zh-CN')}`;
    } catch { /* wiki.db 不存在 */ }

    if (loaded) {
      setting.setDesc(`[${this.plugin.activeSourceConfig()?.name || '?'}] 已索引 ${count} 张卡${mtimeStr}`);
    } else {
      setting.setDesc(`[${this.plugin.activeSourceConfig()?.name || '?'}] 索引未加载，点下方「重建索引」`);
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "星环图谱设置" });
    containerEl.createEl("p", {
      text: "每个数据源 = 一个 MOC 文件夹 + 对应的 Flash / Error 卡片文件夹。可添加多个源（如高数、线代）。",
      cls: "setting-item-description"
    });

    // 渲染每个 source 的设置块
    this.plugin.settings.sources.forEach((src, idx) => {
      const section = containerEl.createEl("div", { cls: "star-ring-source" });
      section.createEl("h4", { text: `数据源 ${idx + 1}：${src.name}` });

      new Setting(section)
        .setName("数据源名称")
        .setDesc("仅作显示标识（如 高数 / 线代）")
        .addText(t => t
          .setValue(src.name)
          .onChange(async v => {
            src.name = v;
            await this.plugin.saveSettings();
            this.display(); // 重渲染标题
          }));

      new Setting(section)
        .setName("MOC 思维树目录")
        .setDesc("章节/知识点笔记所在文件夹")
        .addText(t => t
          .setValue(src.mocFolder)
          .onChange(async v => { src.mocFolder = v; await this.plugin.saveSettings(); this.plugin.refreshView(); }));

      new Setting(section)
        .setName("Flash 卡片目录")
        .setDesc("闪念/二级结论卡片文件夹")
        .addText(t => t
          .setValue(src.flashFolder)
          .onChange(async v => { src.flashFolder = v; await this.plugin.saveSettings(); this.plugin.refreshView(); }));

      new Setting(section)
        .setName("Error 错题目录")
        .setDesc("错题卡片文件夹")
        .addText(t => t
          .setValue(src.errorFolder)
          .onChange(async v => { src.errorFolder = v; await this.plugin.saveSettings(); this.plugin.refreshView(); }));

      // 多于一个源时允许删除
      if (this.plugin.settings.sources.length > 1) {
        new Setting(section)
          .addButton(b => b
            .setButtonText("删除该数据源")
            .setClass("mod-warning")
            .onClick(async () => {
              this.plugin.settings.sources.splice(idx, 1);
              await this.plugin.saveSettings();
              this.display();
              this.plugin.refreshView();
            }));
      }
    });

    // 添加新源按钮
    new Setting(containerEl)
      .addButton(b => b
        .setButtonText("+ 添加数据源")
        .onClick(async () => {
          this.plugin.settings.sources.push({
            name: "新数据源",
            mocFolder: "",
            flashFolder: "",
            errorFolder: "",
          });
          await this.plugin.saveSettings();
          this.display();
        }));

    containerEl.createEl("h3", { text: "布局" });

    new Setting(containerEl)
      .setName("图谱布局")
      .setDesc("鱼骨主干（横向缩进树）/ 星环扇区（旭日图同心环）")
      .addDropdown(d => d
        .addOption("fishbone", "鱼骨主干")
        .addOption("sector", "星环扇区")
        .setValue(this.plugin.settings.layout)
        .onChange(async v => {
          this.plugin.settings.layout = v as 'fishbone' | 'sector';
          await this.plugin.saveSettings();
          this.plugin.refreshView();
        }));

    new Setting(containerEl)
      .setName("细节显现缩放（预留）")
      .setDesc("当前旭日图不消费该值；保留供未来 LOD 显隐功能使用")
      .addSlider(s => s
        .setLimits(1.0, 3.0, 0.1)
        .setValue(this.plugin.settings.detailZoom)
        .setDynamicTooltip()
        .onChange(async v => {
          this.plugin.settings.detailZoom = v;
          await this.plugin.saveSettings();
        }));

    // ============ 检索管理 ============
    containerEl.createEl("h3", { text: "检索管理" });
    containerEl.createEl("p", {
      text: "FTS 全文索引（进程内 sql.js，快捷搜索 + 深度检索的种子召回）。每个学科一份独立库，随学科切换自动换载；新增/修改笔记后点「重建索引」。",
      cls: "setting-item-description"
    });

    // 索引状态
    const statusSetting = new Setting(containerEl)
      .setName("索引状态")
      .setDesc("加载中…");
    this.refreshIndexStatus(statusSetting);

    // 重建索引按钮（v2：调 TS IndexBuilder，不 spawn Python）
    new Setting(containerEl)
      .setName("重建索引")
        .setDesc("扫描所有数据源三层卡片 → 每学科覆盖重建独立库 → 重载当前学科索引（1-2 秒）")
      .addButton(b => b
        .setButtonText("重建索引")
        .setCta()
        .onClick(async () => {
          b.setButtonText("重建中…");
          b.setDisabled(true);
          new Notice("正在重建索引…");
          const result = await this.plugin.rebuildIndex();
          b.setButtonText("重建索引");
          b.setDisabled(false);
          new Notice(result.msg, result.ok ? 4000 : 8000);
          if (result.ok) this.refreshIndexStatus(statusSetting);
        }));

    // 重新加载索引按钮（不重建，只重新读 wiki.db 到内存）
    new Setting(containerEl)
      .setName("重载索引")
      .setDesc("wiki.db 文件被外部更新后点此重新加载到内存")
      .addButton(b => b
        .setButtonText("重载索引")
        .onClick(async () => {
          b.setButtonText("重载中…");
          b.setDisabled(true);
          this.plugin.fts = null;
          await this.plugin.loadFtsIndex();
          b.setButtonText("重载索引");
          b.setDisabled(false);
          new Notice(this.plugin.fts ? "索引已重载" : "索引重载失败", 3000);
          this.refreshIndexStatus(statusSetting);
        }));

    // 深度检索 LLM 站点配置
    containerEl.createEl("h4", { text: "深度检索 · LLM 站点配置" });
    containerEl.createEl("p", {
      text: "深度检索模式：FTS 种子 → 属性扩展 → LLM 精筛 10 张。下方编辑当前使用的站点，站点池里的备用站点在失败时自动顶上。",
      cls: "setting-item-description"
    });

    // 服务商预设下拉
    new Setting(containerEl)
      .setName("LLM 服务商")
      .setDesc("选预设自动填下面的字段")
      .addDropdown(d => {
        for (const [key, preset] of Object.entries(LLM_PRESETS)) {
          d.addOption(key, preset.label);
        }
        d.setValue(this.plugin.settings.llmProvider || 'glm');
        d.onChange(async v => {
          this.plugin.settings.llmProvider = v;
          const preset = LLM_PRESETS[v];
          if (preset) {
            this.plugin.settings.llmBaseUrl = preset.llmBaseUrl;
            this.plugin.settings.llmModel = preset.llmModel;
            const cur = this.plugin.activeLlmProfile();
            if (cur) { cur.baseUrl = preset.llmBaseUrl; cur.model = preset.llmModel; }
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });

    // 预设的特殊提示
    const curPreset = LLM_PRESETS[this.plugin.settings.llmProvider];
    if (curPreset?.note) {
      containerEl.createEl("p", {
        text: "⚠ " + curPreset.note,
        cls: "setting-item-description"
      });
    }

    new Setting(containerEl)
      .setName("LLM API Key")
      .setDesc("深度检索调用 LLM 的密钥")
      .addText(t => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.llmApiKey)
          .onChange(async v => {
            this.plugin.settings.llmApiKey = v;
            const cur = this.plugin.activeLlmProfile();
            if (cur) cur.apiKey = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("LLM Base URL")
      .setDesc("OpenAI 兼容格式的 API 地址")
      .addText(t => t
        .setValue(this.plugin.settings.llmBaseUrl)
        .onChange(async v => {
          this.plugin.settings.llmBaseUrl = v;
          const cur = this.plugin.activeLlmProfile();
          if (cur) cur.baseUrl = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("LLM 模型名")
      .setDesc("如 glm-4.5-air / gpt-4o-mini / deepseek-chat，必须是站点模型清单里存在的")
      .addText(t => t
        .setValue(this.plugin.settings.llmModel)
        .onChange(async v => {
          this.plugin.settings.llmModel = v;
          const cur = this.plugin.activeLlmProfile();
          if (cur) cur.model = v;
          await this.plugin.saveSettings();
        }));

    // ===== 站点池（失败自动切换）=====
    containerEl.createEl("h4", { text: "站点池（失败自动切换）" });
    containerEl.createEl("p", {
      text: "深度检索调用失败（限流/欠费/网络错误）时自动切到下一个启用的站点；失败站点冷却 10 分钟（限流 1 分钟）后自动恢复。填新站点：点「设为当前」，再在上面的预设/Key/地址/模型里填写。",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("添加站点")
      .setDesc("把多个免费中转站都存进来，一个挂了自动换下一个")
      .addButton(b => b.setButtonText("＋ 添加站点").onClick(async () => {
        this.plugin.settings.llmProfiles.push({
          name: `站点${this.plugin.settings.llmProfiles.length + 1}`,
          baseUrl: "", apiKey: "", model: "", enabled: true,
        });
        await this.plugin.switchLlmProfile(this.plugin.settings.llmProfiles.length - 1);
        this.display();
      }));

    this.plugin.settings.llmProfiles.forEach((p, i) => {
      const active = i === this.plugin.settings.llmActive;
      new Setting(containerEl)
        .setName(`${active ? "● " : ""}${p.name || "未命名"}`)
        .setDesc(`${p.baseUrl || "（未配置地址）"} · ${p.model || "（未配置模型）"}${p.enabled ? "" : " · 已停用"}`)
        .addToggle(t => t
          .setTooltip("启用（参与自动切换）")
          .setValue(p.enabled)
          .onChange(async v => { p.enabled = v; await this.plugin.saveSettings(); this.display(); }))
        .addButton(b => b
          .setButtonText(active ? "使用中" : "设为当前")
          .setDisabled(active)
          .onClick(async () => { await this.plugin.switchLlmProfile(i); this.display(); }))
        .addExtraButton(b => b
          .setIcon("trash")
          .setTooltip("删除")
          .onClick(async () => {
            if (this.plugin.settings.llmProfiles.length <= 1) {
              new Notice("至少保留一个站点", 2000);
              return;
            }
            this.plugin.settings.llmProfiles.splice(i, 1);
            if (i < this.plugin.settings.llmActive) this.plugin.settings.llmActive--;
            if (this.plugin.settings.llmActive >= this.plugin.settings.llmProfiles.length)
              this.plugin.settings.llmActive = this.plugin.settings.llmProfiles.length - 1;
            await this.plugin.switchLlmProfile(this.plugin.settings.llmActive);
            this.display();
          }));
    });
  }
}

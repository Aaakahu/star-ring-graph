// 星环图谱插件入口
import { Plugin, PluginSettingTab, Setting, Notice } from "obsidian";
import { StarRingView, STAR_RING_VIEW_TYPE } from "./view";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

// 一个数据源 = 一个 MOC 文件夹 + 对应的 Flash 文件夹 + Error 文件夹
// 未来扩线代时，加一组 sources 即可，互不干扰
export interface FolderSource {
  name: string;          // 显示名（如 "高数"）
  mocFolder: string;     // MOC/思维树笔记文件夹
  flashFolder: string;   // Flash 卡片文件夹
  errorFolder: string;   // 错题卡片文件夹
}

export interface StarRingSettings {
  sources: FolderSource[];
  layout: 'fishbone' | 'sector'; // 鱼骨主干 / 星环扇区
  detailZoom: number;            // 预留（当前旭日图不消费，但 slider 保留）
  // ===== LightRAG 配置（方案 B：插件面板填 → 写 .env → 重启 server）=====
  lightragUrl: string;           // LightRAG server 地址（查询用）
  llmProvider: string;           // 服务商预设：glm/deepseek/openai/claude/custom
  llmApiKey: string;             // LLM API key（密码框，写进 .env）
  llmBaseUrl: string;            // LLM base URL
  llmModel: string;              // LLM 模型名
  embeddingApiKey: string;       // Embedding API key（留空=用 llmApiKey）
  embeddingBaseUrl: string;      // Embedding base URL（留空=用 llmBaseUrl）
  embeddingModel: string;        // Embedding 模型名
  lightragDir: string;           // lightrag/ 目录的绝对路径（含 venv + restart.sh）
}

// 服务商预设：选了自动填 base_url + 模型名。DeepSeek 无 embedding，Claude 走 OpenRouter。
const LLM_PRESETS: Record<string, {
  label: string;
  llmBaseUrl: string; llmModel: string;
  embeddingBaseUrl: string; embeddingModel: string;
  note?: string;
}> = {
  glm: {
    label: "智谱 GLM",
    llmBaseUrl: "https://open.bigmodel.cn/api/paas/v4", llmModel: "glm-4.5",
    embeddingBaseUrl: "https://open.bigmodel.cn/api/paas/v4", embeddingModel: "embedding-3",
  },
  deepseek: {
    label: "DeepSeek",
    llmBaseUrl: "https://api.deepseek.com/v1", llmModel: "deepseek-chat",
    embeddingBaseUrl: "https://api.openai.com/v1", embeddingModel: "text-embedding-3-small",
    note: "DeepSeek 无 embedding 模型，embedding 默认配 OpenAI（需另填 OpenAI key）",
  },
  openai: {
    label: "OpenAI",
    llmBaseUrl: "https://api.openai.com/v1", llmModel: "gpt-4o-mini",
    embeddingBaseUrl: "https://api.openai.com/v1", embeddingModel: "text-embedding-3-small",
  },
  claude: {
    label: "Claude（via OpenRouter）",
    llmBaseUrl: "https://openrouter.ai/api/v1", llmModel: "anthropic/claude-3.5-sonnet",
    embeddingBaseUrl: "https://api.openai.com/v1", embeddingModel: "text-embedding-3-small",
    note: "Claude 原生 API 非 OpenAI 兼容，通过 OpenRouter 代理；embedding 需另配",
  },
  custom: { label: "自定义", llmBaseUrl: "", llmModel: "", embeddingBaseUrl: "", embeddingModel: "" },
};

const DEFAULT_SETTINGS: StarRingSettings = {
  sources: [
    {
      name: "高数",
      mocFolder: "1_高等数学Moc",
      flashFolder: "StudyGuide/Flash",
      errorFolder: "StudyGuide/Errors",
    },
  ],
  layout: "fishbone",
  detailZoom: 1.5,
  lightragUrl: "http://127.0.0.1:9620",
  llmProvider: "glm",
  llmApiKey: "",
  llmBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  llmModel: "glm-4.5",
  embeddingApiKey: "",   // 留空 = 用 llmApiKey
  embeddingBaseUrl: "",  // 留空 = 用 llmBaseUrl
  embeddingModel: "embedding-3",
  lightragDir: "",
};

export default class StarRingGraphPlugin extends Plugin {
  settings: StarRingSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.registerView(STAR_RING_VIEW_TYPE, (leaf) => new StarRingView(leaf, this));

    this.addCommand({
      id: "open-star-ring-graph",
      name: "打开星环图谱",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new StarRingSettingTab(this.app, this));

    // 跟随 Obsidian 明暗主题切换:监听 body.class 的 theme-dark/theme-light 变化,
    // 触发时重建已打开的图谱视图(draw 重读 CSS 变量 → 自动用新主题色)。
    // ponytail: MutationObserver 只监听 class 属性,用户切主题才触发,频率低,无需防抖。
    const themeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'class') {
          this.refreshView();
          break;
        }
      }
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.register(() => themeObserver.disconnect());

    console.log("[星环图谱] 插件已加载");
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
    // lightragDir 默认值在常量里算不了（要用 vault 路径），这里补全
    if (!loaded.lightragDir) {
      const vaultRoot = (this.app.vault.adapter as any).getBasePath?.() || "";
      loaded.lightragDir = path.join(vaultRoot, ".obsidian", "plugins", "star-ring-graph", "lightrag");
    }
    this.settings = loaded;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * 按 embedding 模型名推断输出维度。
   * ponytail: 硬编码常见模型 → 维度映射。新模型加一行即可。
   * 维度不匹配会直接崩（IndexFlushError），所以宁可信模型表也不让用户手填错。
   */
  private getEmbeddingDim(): number {
    const m = (this.settings.embeddingModel || '').toLowerCase();
    if (m.includes('embedding-3')) return 2048;        // 智谱 embedding-3 默认 2048
    if (m.includes('embedding-2')) return 1024;        // 智谱 embedding-2 固定 1024
    if (m.includes('text-embedding-3-small')) return 1536;  // OpenAI small
    if (m.includes('text-embedding-3-large')) return 3072;  // OpenAI large
    if (m.includes('text-embedding-ada-002')) return 1536;  // OpenAI ada
    return 2048; // 兜底：按智谱 embedding-3 默认
  }

  /**
   * 方案 B 核心：把面板里的 GLM 配置写入 lightrag/.env，然后调 restart.sh 重启 server。
   * 调用时机：用户点设置面板的"应用并重启 LightRAG"按钮。
   */
  async applyLightragConfig(): Promise<{ ok: boolean; msg: string }> {
    const dir = this.settings.lightragDir;
    const envPath = path.join(dir, ".env");
    const restartScript = path.join(dir, "restart.sh");

    // 校验目录存在
    if (!fs.existsSync(dir)) {
      return { ok: false, msg: `LightRAG 目录不存在：${dir}。请先按 lightrag/README.md 部署。` };
    }
    // 校验关键字段非空
    if (!this.settings.llmApiKey) {
      return { ok: false, msg: "LLM API Key 不能为空" };
    }
    // embedding 最终用的 key（回退到 LLM key）
    const embKey = this.settings.embeddingApiKey || this.settings.llmApiKey;
    if (!embKey) {
      return { ok: false, msg: "Embedding API Key 不能为空（LLM key 为空时 embedding 必须单独填）" };
    }

    // 写 .env
    // 变量名覆盖 lightrag-hku 1.5.4 的所有读取路径（源码实证）：
    //   - LLM 调用 openai.py:192 硬读 os.environ["OPENAI_API_KEY"]
    //   - Embedding openai.py:1075 读 os.getenv("LLM_BINDING_API_KEY")
    //   - config.py 读 LLM_BINDING_HOST / LLM_MODEL / EMBEDDING_BINDING_HOST / EMBEDDING_MODEL
    // 所以为 LLM 同时写 OPENAI_API_KEY + LLM_API_KEY + LLM_BINDING_API_KEY，三路都不落空
    const embUrl = this.settings.embeddingBaseUrl || this.settings.llmBaseUrl;
    const envContent = [
      `# 由星环图谱插件自动生成 — ${new Date().toISOString()}`,
      `# 勿手动编辑（会被插件「应用并重启」覆盖）`,
      ``,
      `# LLM 配置（三个 KEY 变量名同值，覆盖 lightrag 所有读取路径）`,
      `LLM_BINDING=openai`,
      `OPENAI_API_KEY=${this.settings.llmApiKey}`,
      `LLM_API_KEY=${this.settings.llmApiKey}`,
      `LLM_BINDING_API_KEY=${this.settings.llmApiKey}`,
      `LLM_MODEL=${this.settings.llmModel}`,
      `LLM_BINDING_HOST=${this.settings.llmBaseUrl}`,
      ``,
      `# Embedding 配置（embKey 留空时已回退到 LLM key）`,
      `EMBEDDING_BINDING=openai`,
      `EMBEDDING_API_KEY=${embKey}`,
      `EMBEDDING_BINDING_API_KEY=${embKey}`,
      `EMBEDDING_MODEL=${this.settings.embeddingModel}`,
      `EMBEDDING_BINDING_HOST=${embUrl}`,
      `# EMBEDDING_DIM 必须匹配模型实际输出维度，否则维度不匹配崩`,
      `#   embedding-3 (智谱) = 2048, text-embedding-3-small (OpenAI) = 1536, embedding-2 (智谱) = 1024`,
      `EMBEDDING_DIM=${this.getEmbeddingDim()},`,
      ``,
      `# 存储配置`,
      `LIGHTRAG_DATA_DIR=${path.join(dir, "rag_storage").replace(/\\/g, "/")}`,
      ``,
      `# Server`,
      `HOST=127.0.0.1`,
      `PORT=9620`,
      ``,
      `# 日志`,
      `LIGHTRAG_LOG_LEVEL=INFO`,
      `MAX_ASYNC=4`,
      ``,
    ].join("\n");

    try {
      fs.writeFileSync(envPath, envContent, "utf-8");
    } catch (e: any) {
      return { ok: false, msg: `写 .env 失败：${e.message}。检查目录权限：${dir}` };
    }

    // 调 restart.sh 重启 server
    // ponytail: spawn bash 跑脚本，30 秒内看 exit code。失败提示用户手动重启。
    return new Promise((resolve) => {
      const child = spawn("bash", [restartScript], {
        cwd: dir,
        shell: false,
        windowsHide: true,
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", d => stdout += d);
      child.stderr.on("data", d => stderr += d);

      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, msg: `restart.sh 超时（30秒）。手动检查：cd "${dir}" && bash restart.sh` });
      }, 30000);

      child.on("close", code => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ ok: true, msg: "配置已写入，LightRAG server 已重启" });
        } else {
          resolve({
            ok: false,
            msg: `restart.sh 退出码 ${code}。${stderr || stdout}\n手动重试：cd "${dir}" && bash restart.sh`,
          });
        }
      });
      child.on("error", err => {
        clearTimeout(timer);
        resolve({ ok: false, msg: `无法启动 bash：${err.message}。手动执行：cd "${dir}" && bash restart.sh` });
      });
    });
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
    this.app.workspace.getLeavesOfType(STAR_RING_VIEW_TYPE)
      .forEach(leaf => (leaf.view as any).rerenderGraph?.());
  }

  async onunload() {
    console.log("[星环图谱] 插件已卸载");
  }
}

class StarRingSettingTab extends PluginSettingTab {
  plugin: StarRingGraphPlugin;

  constructor(app: any, plugin: StarRingGraphPlugin) {
    super(app, plugin);
    this.plugin = plugin;
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

    // ============ LightRAG 配置（方案 B）============
    containerEl.createEl("h3", { text: "LightRAG 知识库查询" });
    containerEl.createEl("p", {
      text: "选服务商预设自动填配置（填完可改），点「应用并重启」写入 .env 并重启 server。",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("LightRAG 服务地址")
      .setDesc("本地 LightRAG server 的 URL（查询用，一般不用改）")
      .addText(t => t
        .setValue(this.plugin.settings.lightragUrl)
        .onChange(async v => { this.plugin.settings.lightragUrl = v; await this.plugin.saveSettings(); }));

    // 服务商预设下拉：选了自动填 base_url + 模型名
    new Setting(containerEl)
      .setName("LLM 服务商")
      .setDesc("选预设自动填下面的字段；选「自定义」全部手填")
      .addDropdown(d => {
        Object.entries(LLM_PRESETS).forEach(([key, p]) => d.addOption(key, p.label));
        d.setValue(this.plugin.settings.llmProvider)
          .onChange(async v => {
            this.plugin.settings.llmProvider = v;
            const preset = LLM_PRESETS[v];
            if (preset) {
              this.plugin.settings.llmBaseUrl = preset.llmBaseUrl;
              this.plugin.settings.llmModel = preset.llmModel;
              this.plugin.settings.embeddingBaseUrl = preset.embeddingBaseUrl;
              this.plugin.settings.embeddingModel = preset.embeddingModel;
            }
            await this.plugin.saveSettings();
            this.display(); // 重渲染让下面的字段显示新值
          });
      });

    // 预设的特殊提示（DeepSeek/Claude 的 embedding 注意事项）
    const curPreset = LLM_PRESETS[this.plugin.settings.llmProvider];
    if (curPreset?.note) {
      containerEl.createEl("p", {
        text: "⚠ " + curPreset.note,
        cls: "setting-item-description"
      });
    }

    containerEl.createEl("h4", { text: "LLM（生成答案 + 抽实体）" });

    new Setting(containerEl)
      .setName("LLM API Key")
      .setDesc("对应所选服务商的 API key")
      .addText(t => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.llmApiKey)
          .onChange(async v => { this.plugin.settings.llmApiKey = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("LLM Base URL")
      .setDesc("OpenAI 兼容端点")
      .addText(t => t
        .setValue(this.plugin.settings.llmBaseUrl)
        .onChange(async v => { this.plugin.settings.llmBaseUrl = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("LLM 模型名")
      .setDesc("如 glm-4.5 / deepseek-chat / gpt-4o-mini")
      .addText(t => t
        .setValue(this.plugin.settings.llmModel)
        .onChange(async v => { this.plugin.settings.llmModel = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h4", { text: "Embedding（向量化）" });
    containerEl.createEl("p", {
      text: "留空 API Key / Base URL = 复用上面 LLM 的。DeepSeek/Claude 需另配（它们无 embedding）。",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Embedding API Key")
      .setDesc("留空 = 用 LLM 的 key")
      .addText(t => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.embeddingApiKey)
          .onChange(async v => { this.plugin.settings.embeddingApiKey = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName("Embedding Base URL")
      .setDesc("留空 = 用 LLM 的 URL")
      .addText(t => t
        .setValue(this.plugin.settings.embeddingBaseUrl)
        .onChange(async v => { this.plugin.settings.embeddingBaseUrl = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Embedding 模型名")
      .setDesc("如 embedding-3 / text-embedding-3-small")
      .addText(t => t
        .setValue(this.plugin.settings.embeddingModel)
        .onChange(async v => { this.plugin.settings.embeddingModel = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("LightRAG 目录")
      .setDesc("lightrag/ 文件夹的绝对路径（含 venv + restart.sh）")
      .addText(t => t
        .setValue(this.plugin.settings.lightragDir)
        .onChange(async v => { this.plugin.settings.lightragDir = v; await this.plugin.saveSettings(); }));

    // "应用并重启"按钮 — 方案 B 核心
    new Setting(containerEl)
      .setName("应用并重启 LightRAG")
      .setDesc("把上面的配置写入 .env 并重启 server（约 5-15 秒）")
      .addButton(b => b
        .setButtonText("应用并重启")
        .setCta()
        .onClick(async () => {
          b.setButtonText("重启中…");
          b.setDisabled(true);
          new Notice("正在写入 .env 并重启 LightRAG…");
          const result = await this.plugin.applyLightragConfig();
          b.setButtonText("应用并重启");
          b.setDisabled(false);
          new Notice(result.msg, result.ok ? 4000 : 8000);
          if (result.ok) this.display();
        }));
  }
}

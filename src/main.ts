// 星环图谱插件入口
import { Plugin, PluginSettingTab, Setting } from "obsidian";
import { StarRingView, STAR_RING_VIEW_TYPE } from "./view";

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
}

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
    this.settings = loaded;
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
  }
}

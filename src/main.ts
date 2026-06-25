// 星环图谱插件入口
import { Plugin, PluginSettingTab, Setting } from "obsidian";
import { StarRingView, STAR_RING_VIEW_TYPE } from "./view";

export interface StarRingSettings {
  mindTreeFolder: string;
  flashFolder: string;
  errorFolder: string;
  chapterPrefix: string;
  rootName: string;
}

const DEFAULT_SETTINGS: StarRingSettings = {
  mindTreeFolder: "1_高等数学Moc",
  flashFolder: "StudyGuide/Flash",
  errorFolder: "StudyGuide/Errors",
  chapterPrefix: "2",
  rootName: "极限与无穷小",
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
    console.log("[星环图谱] 插件已加载");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
      text: "配置数据源路径。默认值适配 StudyGuide 插件的 vault 结构，可按需修改。",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("思维树根目录")
      .setDesc("MOC/章节/知识点笔记所在的文件夹")
      .addText(t => t
        .setValue(this.plugin.settings.mindTreeFolder)
        .onChange(async v => { this.plugin.settings.mindTreeFolder = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Flash 卡片目录")
      .setDesc("碎片知识卡片所在的文件夹")
      .addText(t => t
        .setValue(this.plugin.settings.flashFolder)
        .onChange(async v => { this.plugin.settings.flashFolder = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Error 错题目录")
      .setDesc("错题笔记所在的文件夹")
      .addText(t => t
        .setValue(this.plugin.settings.errorFolder)
        .onChange(async v => { this.plugin.settings.errorFolder = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("章节前缀")
      .setDesc("要显示的章节文件名前缀（如 2 表示极限章）")
      .addText(t => t
        .setValue(this.plugin.settings.chapterPrefix)
        .onChange(async v => { this.plugin.settings.chapterPrefix = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("根节点名称")
      .setDesc("图谱中心根节点的显示名")
      .addText(t => t
        .setValue(this.plugin.settings.rootName)
        .onChange(async v => { this.plugin.settings.rootName = v; await this.plugin.saveSettings(); }));
  }
}

# 星环图谱 (Star Ring Graph)

Obsidian 插件 —— 把你的知识体系画成**三层同心圆星环图谱**：内环 MOC 体系、中环碎片知识、外环错题实战。悬停任意节点即可高亮其溯源链路，一眼看清"这道错题考的是什么知识点、属于哪个体系"。

## 功能

- **三层星环布局**：按知识类型分层（MOC → 碎片 → 错题），每层一条轨道
- **溯源高亮**：悬停节点，高亮其完整溯源链路（从错题 → 碎片 → 知识点 → 章节 → 根），其余暗化
- **按章节扇形分布**：每个章节占一个扇区，互不挤压，有呼吸感
- **动态轨道扩展**：某层节点超出单环容量时，自动新增同心环
- **分色背景区**：三种知识类型用淡蓝/橙/红区分
- **缩放与平移**：滚轮缩放，Ctrl + 拖拽平移

## 数据来源

适配 [StudyGuide](https://github.com/) 插件的 vault 结构：

| 类型 | 目录 | 说明 |
|---|---|---|
| 思维树 | `1_高等数学Moc/` | MOC/章节/知识点，层级靠文件名前缀编码（如 `2.1.1.2.4_标题.md`） |
| Flash 卡片 | `StudyGuide/Flash/` | 碎片知识，有 frontmatter（type/topic） |
| Error 错题 | `StudyGuide/Errors/` | 错题笔记，有 frontmatter（type/topic） |

所有路径可在插件设置中修改。

## 安装

### 手动安装
1. 下载 `main.js`、`manifest.json`、`styles.css`
2. 放到 `<vault>/.obsidian/plugins/star-ring-graph/`
3. Obsidian → 设置 → 第三方插件 → 启用「星环图谱」

### 从源码构建
```bash
git clone https://github.com/Aaakahu/star-ring-graph.git
cd star-ring-graph
npm install
npm run build
```

## 使用

1. 命令面板（Ctrl+P）→ `打开星环图谱`
2. 图谱在右侧面板打开，自动加载数据
3. 悬停任意节点查看溯源链路
4. 滚轮缩放，Ctrl + 拖拽平移

## 配置

设置 → 星环图谱：

| 设置项 | 默认值 | 说明 |
|---|---|---|
| 思维树根目录 | `1_高等数学Moc` | MOC 笔记所在文件夹 |
| Flash 卡片目录 | `StudyGuide/Flash` | 碎片卡片文件夹 |
| Error 错题目录 | `StudyGuide/Errors` | 错题文件夹 |
| 章节前缀 | `2` | 要显示的章节文件名前缀 |
| 根节点名称 | `极限与无穷小` | 图谱中心节点的显示名 |

## 技术栈

- **D3.js v7**：树形布局 + SVG 渲染
- **TypeScript + esbuild**：源码编译打包
- **Obsidian Plugin API**：数据读取 + View 集成

## 许可证

MIT

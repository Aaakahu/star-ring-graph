# 星环图谱 (Star Ring Graph)

Obsidian 插件 —— 把你的知识体系画成**径向星环图谱**：根节点居中，章节、知识点、碎片、错题按层级向外扩散。点击任意节点即可高亮其关联链路，一眼看清"这道错题考的是什么知识点、属于哪个体系"。

## 功能

- **径向布局**：按知识层级分层（根 → 章节 → 知识点 → 碎片/错题），节点呈放射状分布
- **密度自适应**：根据每层节点数量自动计算半径，避免节点拥挤
- **溯源高亮**：点击节点，高亮其完整关联链路，其余节点暗化
- **按层级着色**：根节点金色、章节蓝色、知识点青色、碎片/错题暗红，一目了然
- **智能文字显示**：根据缩放级别和节点层级自动显示/隐藏文字标签
- **长标题换行**：超长标题自动换行显示，避免文字重叠
- **小地图导航**：右下角小地图方便在大图谱中快速定位
- **交互优化**：点击节点自动居中放大，点击空白处重置视角

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

- **AntV G6 v4.8.24**：专业图可视化库，提供径向布局和高性能渲染
- **TypeScript + esbuild**：源码编译打包
- **Obsidian Plugin API**：数据读取 + View 集成

## 许可证

MIT

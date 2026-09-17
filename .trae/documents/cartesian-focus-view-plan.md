# 聚焦视图直角坐标系布局实现计划

## 摘要

将 `star-ring-graph` 插件的聚焦视图从扇区/星云布局改为直角坐标系布局：
- **X 轴** 表示匹配度，越靠右匹配度越高；
- **Y 轴** 表示知识层级，从上到下依次为 MOC → Flash → Error；
- 坐标轴始终可见，画布不再允许无限拖动；
- 仅做必要的代码改动，遵循 karpathy-guidelines：外科式修改、最小可行、验收标准明确。

## 当前状态分析

1. **聚焦视图现有布局**：`src/view.ts` 中 `focusOnMoc()` 和 `focusOnQueryHits()` 都通过 `layoutOverride: 'sector'` 进入 `renderGraph`，最终调用 `starRingSectorLayout` / `starNebulaClusterLayout`。
2. **匹配度数据已存在**：查询结果在 `cropG6DataByQueryHits()` 里已为每个节点写入 `_queryRank`（越小越匹配）。MOC 聚焦目前没有 rank，需要从子树深度推导。
3. **坐标轴与拖拽边界缺失**：G6 画布使用自定义右键拖拽 `drag-canvas-right`，没有边界限制；缩放由 `zoom-canvas` 接管，也没有针对聚焦视口的约束。
4. **subtype 未进数据层**：`src/data.ts` 未读取 frontmatter 的 `subtype`，导致查询模式对 Flash 的过滤不够精确。
5. **用户已认可的 demo**：`demo/focus-cartesian-demo.html` 已给出视觉与坐标语义。

## 拟议改动

### 1. `src/data.ts` — 透传 Flash 卡片的 `subtype`

**What**
- 在 `RingNode` 接口增加 `_subtype?: string`。
- 在 `buildSourceTree` 读取 Flash 卡片时，将 `fm.subtype` 写入 `flashNode._subtype`。
- 在 `G6Node` 接口增加 `_subtype?: string`。
- 在 `convertToG6Data` 中将 `node._subtype` 复制到 G6 节点。

**Why**
让查询模式能精确过滤 Flash：`know_what`（学概念）、`know_how`（找方法）、`know_why`（查错题）。

**How**
仅新增字段透传，不动树结构、颜色、层级规则。

---

### 2. `src/view.ts` — 新增直角坐标系聚焦布局

#### 2.1 新增 `focusCartesianLayout(nodes, edges, opts)`

**What**
一个独立布局函数，放在 `starRingSectorLayout` 附近。

**Why**
替代扇区布局，提供用户确认的直角坐标语义。

**How**
- 固定逻辑画布：`left=80, right=920, top=30, bottom=490`。
- X 轴：`x = right - (right-left) * (rank / maxRank)`，rank 越小越靠右。
- Y 轴：三等分高度，MOC 在上带、Flash 在中带、Error 在下带。用 `_originalType` 判断类型。
- 同带去重：同一类型内按 rank 排序，奇偶项向中心线上下错峰。
- 节点大小：复用 `_queryRank` 缩放；MOC 聚焦时按深度缩放。
- 边样式：父子边保留为虚线低透明度；aux 边更淡。
- 最佳匹配：rank 最小节点标记 `_topMatch = true`。

#### 2.2 MOC 聚焦入口改为直角坐标系

**What**
修改 `focusOnMoc(mocId)` 和 `focusOnQueryHits()` 的 `layoutOverride`。

**Why**
让两种聚焦入口都进入新布局。

**How**
- `focusOnMoc`：裁剪子树后，BFS 从该 MOC 出发给每个节点写 `_focusRank`（深度 = rank），然后 `layoutOverride: 'cartesian'`。
- `focusOnQueryHits`：直接改为 `layoutOverride: 'cartesian'`。

#### 2.3 渲染分支增加 `cartesian`

**What**
在 `renderGraph` 的布局分支中处理 `layout === 'cartesian'`。

**How**
```ts
if (layout === 'cartesian') {
  focusCartesianLayout(g6Data.nodes, g6Data.edges, { /* theme */ });
}
this._currentLayout = 'cartesian';
```

#### 2.4 坐标轴绘制

**What**
在 `renderGraph` 创建 G6 实例后、渲染节点前，若为 `cartesian`，在 `graph.get('group')` 添加 `axis-group` 并 `toBack()`。

**How**
绘制 X/Y 轴线、匹配度分区网格线、MOC/Flash/Error 水平引导线与文字标签。颜色通过 `readThemeVar` 读取 `--sr-axis` / `--sr-grid` / `--sr-text`。

#### 2.5 画布拖拽与缩放限制

**What**
新增 `clampCartesianViewport(graph, bounds)` 工具函数，限制视口矩阵 `tx/ty`。

**How**
- 在 `registerRightDrag` 的 `onMouseMove` 中，每次 `graph.translate` 后，若 `graph._cartesianBounds` 存在则 clamp。
- 自定义滚轮缩放 `wheelHandler` 增加 `cartesian` 分支：以鼠标位置为中心缩放，范围 `[0.5, 3]`，缩放后立即 clamp。
- `zoom-canvas` 的 `shouldBegin` 仅在 `this._currentLayout === 'sector'` 时启用。
- `drag-node` 仅在 `layout !== 'cartesian'` 时加入：聚焦态节点位置有语义，不可拖动。

#### 2.6 初始视角

**What**
在 `resetViewport` 增加 `cartesian` 分支。

**How**
计算“内容 + 坐标轴”包围盒，按容器大小等比缩放并居中，然后 clamp。不使用 `fitView` 以免裁掉坐标轴标签。

#### 2.7 查询模式过滤修正

**What**
在 `expandByStructure()` 中使用 `_subtype` 精确过滤 Flash。

**How**
- `concept`：仅保留 `_subtype === 'know_what'`。
- `method`：仅保留 `_subtype === 'know_how'`。
- `error`：保留 Error + `_subtype === 'know_why'` 的 Flash。
- `review`：保留全部。
- `_subtype` 为空时回退到当前行为。

---

### 3. `styles.css` — 补充坐标轴主题 token

**What**
新增 CSS 变量：`--sr-axis`、`--sr-grid`、`--sr-text-muted`。

**Why**
让坐标轴颜色跟随主题，避免硬编码。

**How**
在 `:root` 与暗色/亮色覆盖中定义变量，不改动现有样式。

---

### 4. `package.json` 脚本

**What**
验收时执行 `npm run build`。

**Why**
确保 TypeScript / esbuild 构建通过。

## 假设与决策

1. **MOC 聚焦的“匹配度”**：用“距离被聚焦 MOC 的树深度”作为 rank。深度越小越靠右。
2. **坐标轴绘制方式**：采用 G6 背景 group 绘制并随图移动，再通过边界限制保持可见。这与 demo 的静态 viewBox 语义最接近。
3. **subtype 字段**：假设 Flash 笔记 frontmatter 中存在 `subtype: know_what/know_how/know_why`。
4. **只做必要改动**：不重构 `fishboneLayout`、`starRingSectorLayout`、`starNebulaClusterLayout`。

## 验收标准

### 构建与回归
1. `npm run build` 通过，无 TypeScript / esbuild 错误。
2. 全局视图的 `fishbone` 与 `sector` 布局、hover 链路高亮、Alt+聚焦入口、minimap、折叠/展开、右键打开笔记保持原行为。

### 聚焦直角坐标系
3. Alt+点击 MOC 进入聚焦：被点击 MOC 出现在 MOC 带最右侧；直接子节点向左侧排布；Flash 与 Error 落在各自横带。
4. 查询后进入聚焦：`_queryRank=0` 节点位于最右侧，rank 越大越靠左；MOC/Flash/Error 分别位于上/中/下三条横带；最佳匹配节点有金色描边/发光。

### 坐标轴与边界
5. 聚焦态下，X/Y 轴线、低/中/高匹配区网格线、MOC/Flash/Error 层级标签始终可见。
6. 右键拖动画布时，不能把坐标轴或全部节点拖出可视区；松开后视图回到允许范围。
7. 滚轮缩放以鼠标位置为中心，范围 `[0.5, 3]`，缩放后仍受边界限制。
8. 节点在聚焦态不可被单独拖拽。

### 查询模式过滤
9. 选择不同查询模式后重新查询：
   - 学概念：只出现 MOC + `know_what` Flash。
   - 找方法：只出现 `know_how` Flash。
   - 查错题：出现 Error + `know_why` Flash。
   - 复习专题：出现 MOC + 全部 Flash + Error。

### 最小改动核查
10. 所有改动可追溯到本需求；不引入未来抽象或全局重构。

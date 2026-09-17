# 星环图谱性能优化计划（A 交互 + B 打开速度 + C 动画）— 含第 0 步备份

## 第 0 步：备份当前稳定版本（按你的要求，先做）

本插件目录本身是 git 仓库，当前未提交的工作区状态 = 你正在使用的稳定版本。备份方式：
- `git add -A && git commit`（提交信息：备份性能优化前的稳定版本），并打标签 `stable-before-perf-opt`；
- 之后任何改动都基于此快照，出 bug 时 `git checkout stable-before-perf-opt -- .` 或 `git reset --hard stable-before-perf-opt` 一键回退到现状。

## A. 交互性能（src/view.ts）

1. **消除 hover 重绘风暴**（最大收益）：`new G6.Graph` 加 `autoPaint: false`（view.ts:1222）；hover/leave 处理器（view.ts:1499-1546）缓存上次 active/inactive 集合，只对真正变化的 item 调 `setItemState`/`setLabelVisible`，批量后 `graph.paint()` 一次——一次 hover 从 ~2(V+E) 次全画布重绘降为 1 次。grep 所有 `setItemState`/`updateItem` 变更点补 paint，并给 viewportchange 事件挂 rAF 合帧 paint 兜底（覆盖内置 zoom-canvas/drag-node 行为）。
2. **拖拽/滚轮 rAF 合帧**：`setupNativeCanvasDrag`（view.ts:839-904）与自写 wheel handler（view.ts:1412-1429）改为 rAF 调度，每帧至多一次 `translate`/`zoomTo`。
3. **Minimap 交互抑制**（view.ts:1316-1322）：保存实例引用，交互开始 `removePlugin`，停止 150ms 防抖 `addPlugin` 恢复。
4. **折叠边 diff**：toggleCollapse 只对可见性真正变化的边 `updateItem`（view.ts:1571-1578）。
5. **日志门控**：标签避让诊断、引线穿障检测大对象构造（view.ts:591-673）、renderGraph/applyHighlight 日志统一包进模块级 `SRG_DEBUG=false` 开关。
6. **registerNode 只注册一次**（模块级标志位，view.ts:1034）。

## B. 打开/启动速度

1. **buildChapterTree 免读全文**（src/data.ts:162、202）：改用 `metadataCache.getFileCache(f)?.frontmatter` 取 mindtree/title/subtype/flash；frontmatter 缺失时回退现有 `vault.read`+`parseFrontmatter`。高数源首开从 393 次串行全文读降为≈0。
2. **onload 后台预热树缓存**（src/main.ts）：新增 `ensureTree()`（含并发去重 promise），onload fire-and-forget 调用；view.onOpen 复用；失效点统一走 `invalidateTree()`。
3. **字体改 Blob URL**（src/font-loader.ts:23-29）：`URL.createObjectURL(new Blob(...))` 替代 1.37MB 逐字节 base64 拼接。
4. **消灭第二次全量 render**（view.ts:1345-1357）：首渲前 `Promise.race([document.fonts.load(...), 250ms])`；仅超时罕见情况下保留一次补渲兜底。
5. **sql.js 懒执行**（src/fts.ts:18）：顶层 require 移入 memoized 函数，首次搜索/建索引才执行（G6 保守保留静态 import，避免 workspace 恢复时序风险）。
6. **收紧固定延迟**：双 RAF 改单 RAF（view.ts:1204-1205）；审查 400/600ms 收尾定时器（view.ts:1399、1403-1407）。
7. `npm uninstall d3`（遗留未用依赖）。

## C. 动画升级

1. **镜头推拉过渡**：新增 `animateViewport(targetMatrix, ~350ms, easeCubic)`（rAF 插值 9 元素仿射矩阵）；renderGraph 销毁旧图前捕获当前矩阵，重建后镜头从旧位置平滑推到新目标——聚焦进入/退出、布局切换获得连续过渡；用户滚轮/拖拽立即取消动画。首次打开无旧矩阵，直接就位不加动画。
2. fadeCanvas 220ms 淡入淡出保留衔接；hover 保持瞬时切换（canvas 状态无补间，明确不加）。

## 验证

- `npm run build` 通过；
- 需要你在 Obsidian 里回归：高数源首开速度、hover/拖拽/缩放流畅度、聚焦进出镜头动画、折叠展开、搜索浮层、重建索引、字体显示、Minimap 显隐、Ctrl 锁定高亮。

## 回退方式

出问题：`git reset --hard stable-before-perf-opt`（或单文件 `git checkout stable-before-perf-opt -- src/view.ts`）后重新 `npm run build`。
// 星环图谱视图 + 渲染逻辑（AntV G6）

import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice } from "obsidian";
import type StarRingGraphPlugin from "./main";
import G6 from '@antv/g6';
import { buildChapterTree, convertToG6Data } from "./data";
import type { RingNode, G6Data } from "./data";
// ponytail: 合并 prompt 前言（卡片属性规范/工作流/硬约束/取值表）放独立 md，
// esbuild 以 text loader 内联成字符串，避免在 TS 里转义大量反引号。
import mergePreamble from "./merge-preamble.md";

export const STAR_RING_VIEW_TYPE = "star-ring-view";

// 真旭日图布局（移植自 Collapse Tree Konva 的 _layoutRadial + _positionRadial）。
// 两趟递归：pass1 自底向上算角度权重（叶=0.5，folder=Σ子.sw+gap）；pass2 自顶向下按权重切分父扇区。
// 等差环间距 baseR + depth*levelGap；起始角 -π/2（12点钟）顺时针铺满 2π。
// Flash/Error 不另起云团，与 root/chapter/MOC 一样平铺进同一棵递归树。
function starRingSectorLayout(nodes: any[], edges: any[], baseR = 120, levelGap = 90) {
  if (nodes.length === 0) return;
  const byId = new Map<string, any>(nodes.map(n => [n.id, n]));
  const childrenOf = new Map<string, any[]>();
  // 只穿 tree 结构边,排除 aux 辅连线 —— 后者会形成环(flash 互指),
  // 进 layoutRadial 递归会爆栈。鱼骨视图的 fishboneLayout 已用 structuralKids 过滤,
  // 这里同样做法。
  edges.forEach(e => {
    if (e.relation === 'aux') return;
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    const t = byId.get(e.target);
    if (t) childrenOf.get(e.source)!.push(t);
  });

  const root = nodes.find(n => (n.level ?? 0) === 0) || nodes[0];

  // 兄弟间间隙（rad），等价于 Konva 版的 max(0.02, siblingGap/480)；叶节点等权 0.5
  const GAP = 0.05;
  const MIN_SPAN = 0.5;

  // 环检测防御：若数据里有循环引用(如 flash 互指的 aux 边未过滤干净),
  // layoutRadial 会无限递归爆栈。用 visited 集合兜底,已访问的节点跳过。
  const visited = new Set<string>();

  // pass1：自底向上权重。叶=MIN_SPAN；folder=Σ子.sw + GAP*(n-1)。
  const layoutRadial = (node: any) => {
    if (visited.has(node.id)) return; // 防循环引用爆栈
    visited.add(node.id);
    const kids = childrenOf.get(node.id) || [];
    if (kids.length === 0) { node.sw = MIN_SPAN; return; }
    let total = 0;
    kids.forEach(k => { layoutRadial(k); total += k.sw; });
    total += GAP * (kids.length - 1);
    node.sw = total;
  };
  layoutRadial(root);

  // pass2：自顶向下分扇区。父拥有 [a0,a1]，按 child.sw/totalW 切分给每个子。
  // 半径等差：depth=0 在中心，否则 baseR + depth*levelGap。
  const depthRadius = (depth: number) => depth === 0 ? 0 : baseR + depth * levelGap;
  const positionRadial = (node: any, a0: number, a1: number, depth: number) => {
    const r = depthRadius(depth);
    const mid = (a0 + a1) / 2;
    node._midAngle = mid; // 供 draw 沿辐射方向旋转标签
    node.x = Math.cos(mid) * r;
    node.y = Math.sin(mid) * r;
    const kids = childrenOf.get(node.id) || [];
    if (kids.length === 0) return;
    const sector = a1 - a0;
    const totalW = Math.max(node.sw, 0.01);
    let cursor = a0;
    kids.forEach(k => {
      const span = (k.sw / totalW) * sector;
      positionRadial(k, cursor, cursor + span, depth + 1);
      cursor += span;
    });
  };
  // 起始 -π/2（12点钟），顺时针铺满 2π
  positionRadial(root, -Math.PI / 2, Math.PI * 1.5, 0);

  // 孤儿兜底:不在 root 子树里的节点(无父子结构边的脱链笔记)。
  // 不处理的话 x/y 保持 undefined,G6 默认放 (0,0) → 全堆在根节点上,标签必然挤死。
  // 策略:把它们排成一个最外环,半径 = 现有最大半径 + levelGap,均匀分布,角度从 12 点钟开始。
  const orphans = nodes.filter(n => n.x === undefined && n.y === undefined);
  if (orphans.length > 0) {
    // 算当前已布局节点的最大半径(到圆心距离),孤儿环放在它之外
    let maxR = baseR;
    nodes.forEach(n => {
      if (n.x === undefined || n.y === undefined) return;
      const r = Math.sqrt(n.x * n.x + n.y * n.y);
      if (r > maxR) maxR = r;
    });
    const orphanR = maxR + levelGap;
    orphans.forEach((n, i) => {
      const a = -Math.PI / 2 + (i / orphans.length) * Math.PI * 2;
      n._midAngle = a;
      n.x = Math.cos(a) * orphanR;
      n.y = Math.sin(a) * orphanR;
    });
  }
}

// ===== 聚焦视图：直角坐标系布局（自适应） =====
// X 轴 = 匹配度（右高左低），Y 轴 = 知识层级（MOC 上 / Flash 中 / Error 下）。
//
// 核心设计：坐标系【宽度固定】（和少节点时一样），节点多时只在【Y 方向撑高】。
// 这样 zoom 永远按固定宽度算 ≈ 1，节点大小始终可读；高度超出视口靠滚轮上下看。
// 同 band 内节点按 rank 从右到左铺，固定宽度装不下就换行往下——像文字自动换行。
//   - 少节点：1 行铺开 = 原始效果，完全不拥挤
//   - 多节点：自动换行，band 变高，每节点间距恒定 NODE_ROW_H，永不挤
export type CartesianBounds = {
  left: number; right: number; top: number; bottom: number;
  bandY: { moc: number; flash: number; error: number };
};
const CART_LEFT = 80;       // 左留白（Y 轴标签 + 文字）
const CART_RIGHT = 1760;    // 右边界固定（宽度 1680px，放大一倍给避障更多空间）
const CART_TOP = 30;        // 顶留白（低/中/高匹配标签）
const CART_BOTTOM_PAD = 40; // 底留白（匹配度箭头文字）
const BAND_GAP = 50;        // band 之间的空白间隔
const NODE_W = 200;         // 每节点水平占位（放大一倍，标签有充足避障空间）
const NODE_ROW_H = 32;      // 每行垂直高度（标签~28px + 余量）

// band 内节点数 → 该 band 需要的高度（行数 × NODE_ROW_H + 上下边距）
// 每行能装 floor(宽度 / NODE_W) 个节点。
const bandHeightFor = (count: number): number => {
  const perRow = Math.max(1, Math.floor((CART_RIGHT - CART_LEFT) / NODE_W));
  const rows = Math.max(1, Math.ceil(count / perRow));
  return rows * NODE_ROW_H + 20; // +20 上下边距
};

// 根据节点集算坐标系 bounds + 三层 Y 中心。
// 宽度固定 840px；高度按各 band 节点数换行后累加。
function computeCartesianBounds(
  nodes: any[],
  typeOf: (n: any) => 'moc' | 'flash' | 'error',
): CartesianBounds {
  const counts = { moc: 0, flash: 0, error: 0 };
  nodes.forEach(n => { counts[typeOf(n)]++; });
  const mocH = bandHeightFor(counts.moc);
  const flashH = bandHeightFor(counts.flash);
  const errorH = bandHeightFor(counts.error);
  // band 中心 Y：从顶开始累加
  let cursor = CART_TOP;
  const mocY = cursor + mocH / 2;
  cursor += mocH + BAND_GAP;
  const flashY = cursor + flashH / 2;
  cursor += flashH + BAND_GAP;
  const errorY = cursor + errorH / 2;
  cursor += errorH + CART_BOTTOM_PAD;
  return {
    left: CART_LEFT, right: CART_RIGHT, top: CART_TOP, bottom: cursor,
    bandY: { moc: mocY, flash: flashY, error: errorY },
  };
}

function focusCartesianLayout(nodes: any[], edges: any[], bounds: CartesianBounds) {
  if (nodes.length === 0) return;

  const CART = bounds;
  const Y_BAND = bounds.bandY;

  const typeOf = (n: any): 'moc' | 'flash' | 'error' => {
    const t = (n._originalType || '').toLowerCase();
    if (t === 'moc' || t.startsWith('moc') || (n.level ?? 0) === 2) return 'moc';
    if (t === 'flash' || (n.level ?? 0) === 3) return 'flash';
    if (t === 'error' || (n.level ?? 0) === 4) return 'error';
    return 'moc';
  };

  const rankOf = (n: any): number => n._queryRank ?? n._focusRank ?? 999;
  const maxRank = Math.max(1, ...nodes.map(rankOf));

  const byType: Record<string, any[]> = { moc: [], flash: [], error: [] };
  nodes.forEach(n => {
    const t = typeOf(n);
    byType[t].push(n);
  });
  Object.values(byType).forEach(arr => arr.sort((a, b) => rankOf(a) - rankOf(b)));

  Object.entries(byType).forEach(([type, arr]) => {
    if (arr.length === 0) return;
    // 换行布局：同 band 内节点按 rank 排序后，从右（高匹配）到左铺，
    // 固定宽度装不下就换行往下。每行 perRow 个，行间距 NODE_ROW_H。
    const bandY = Y_BAND[type as 'moc' | 'flash' | 'error'];
    const perRow = Math.max(1, Math.floor((CART.right - CART.left) / NODE_W));
    // 第一行从 band 中心往上排（让 band 居中），后续行往下
    const rows = Math.ceil(arr.length / perRow);
    const topY = bandY - ((rows - 1) * NODE_ROW_H) / 2;
    arr.forEach((n, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      // X：每行内从右到左按 rank 递减（rank 小=高匹配=右侧）
      const x = CART.right - (col + 0.5) * NODE_W;
      const y = topY + row * NODE_ROW_H;
      n.x = x;
      n.y = y;
    });
  });

  // 连线：极淡灰色实线，细一倍。aux 和 tree 统一样式（聚焦视图里连线只起暗示作用，不抢视觉）
  edges.forEach(e => {
    e.style = { ...(e.style || {}), stroke: '#888888', lineWidth: 0.4, opacity: 0.35 };
  });

  const topMatch = nodes.reduce((best, n) => {
    if (!best) return n;
    return rankOf(n) < rankOf(best) ? n : best;
  }, null as any);
  if (topMatch) topMatch._topMatch = true;
}

// 在 G6 背景 group 绘制直角坐标系坐标轴、网格线与分区标签。
function drawCartesianAxes(graph: any, theme: Record<string, string>, bounds: CartesianBounds) {
  const group = graph?.get('group');
  if (!group) { console.warn('[星环图谱][drawCartesianAxes] 无 group，退出'); return; }
  group.findAll((s: any) => s.get('name') === 'axis-group').forEach((g: any) => g.remove());
  const axisGroup = group.addGroup({ name: 'axis-group' });
  axisGroup.toBack();
  console.log('[星环图谱][drawCartesianAxes] 开始画轴', { bounds: JSON.stringify(bounds), theme });

  const CART = bounds;
  const axisColor = theme.axis || 'rgba(255,255,255,0.35)';
  const gridColor = theme.grid || 'rgba(255,255,255,0.08)';
  const textColor = theme.text || 'rgba(255,255,255,0.6)';

  axisGroup.addShape('line', {
    attrs: { x1: CART.left, y1: CART.bottom, x2: CART.right, y2: CART.bottom, stroke: axisColor, lineWidth: 1.5 },
  });
  axisGroup.addShape('line', {
    attrs: { x1: CART.left, y1: CART.top, x2: CART.left, y2: CART.bottom, stroke: axisColor, lineWidth: 1.5 },
  });

  const xPart1 = CART.left + (CART.right - CART.left) * 0.33;
  const xPart2 = CART.left + (CART.right - CART.left) * 0.67;
  [xPart1, xPart2].forEach(x => {
    axisGroup.addShape('line', {
      attrs: { x1: x, y1: CART.top, x2: x, y2: CART.bottom, stroke: gridColor, lineWidth: 1, lineDash: [4, 4] },
    });
  });

  [bounds.bandY.moc, bounds.bandY.flash, bounds.bandY.error].forEach(y => {
    axisGroup.addShape('line', {
      attrs: { x1: CART.left, y1: y, x2: CART.right, y2: y, stroke: gridColor, lineWidth: 1, lineDash: [4, 4] },
    });
  });

  axisGroup.addShape('text', {
    attrs: { x: CART.right - 60, y: CART.bottom + 22, text: '匹配度 →', fill: textColor, fontSize: 12, fontWeight: 600 },
  });
  axisGroup.addShape('text', {
    attrs: { x: CART.left - 12, y: bounds.bandY.moc, text: 'MOC', fill: textColor, fontSize: 12, textAlign: 'end' },
  });
  axisGroup.addShape('text', {
    attrs: { x: CART.left - 12, y: bounds.bandY.flash, text: 'Flash', fill: textColor, fontSize: 12, textAlign: 'end' },
  });
  axisGroup.addShape('text', {
    attrs: { x: CART.left - 12, y: bounds.bandY.error, text: 'Error', fill: textColor, fontSize: 12, textAlign: 'end' },
  });

  axisGroup.addShape('text', {
    attrs: { x: CART.left + (CART.right - CART.left) * 0.16, y: CART.top + 16, text: '低匹配', fill: gridColor, fontSize: 11, textAlign: 'center' },
  });
  axisGroup.addShape('text', {
    attrs: { x: CART.left + (CART.right - CART.left) * 0.5, y: CART.top + 16, text: '中匹配', fill: gridColor, fontSize: 11, textAlign: 'center' },
  });
  axisGroup.addShape('text', {
    attrs: { x: CART.left + (CART.right - CART.left) * 0.84, y: CART.top + 16, text: '高匹配', fill: gridColor, fontSize: 11, textAlign: 'center' },
  });
}

// 鱼骨主干布局 → 纵向缩进树（文件树风格）：根在顶，章节/MOC/子知识点逐层缩进往下铺。
// ponytail: 旧版是横向主干（章节横排、子节点向上），现改为纵向缩进——DFS 前序，Y 按出现顺序递增，
// X 按树深度缩进。多兄弟 MOC 纵向堆叠（同缩进层、不同 Y）。空间宽松（indentW/rowH 都留大）。
function fishboneLayout(nodes: any[], edges: any[], step = 200, rowH = 28, clusterR = 35) {
  if (nodes.length === 0) return;
  const byId = new Map<string, any>(nodes.map(n => [n.id, n]));
  const childrenOf = new Map<string, any[]>();
  edges.forEach(e => {
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    const t = byId.get(e.target);
    if (t) childrenOf.get(e.source)!.push(t);
  });

  // 结构子节点：level≤2（root/chapter/moc 及子知识点 moc2/moc3）。Frag/Error(level≥3) 另作星团。
  const structuralKids = (id: string) =>
    (childrenOf.get(id) || []).filter(k => (k.level ?? 0) <= 2);

  // 找根（level===0），无则取首节点
  const root = nodes.find(n => (n.level ?? 0) === 0) || nodes[0];

  // DFS 前序：Y 按全局出现顺序递增，X 按深度缩进。placed 防重复（数据里可能有环或重复边）
  const INDENT_W = 110; // 每层缩进 110px（紧凑大纲风，原 220 太宽）
  const ROW_H = rowH;   // 行高（默认 28，纵向收紧）
  let rowY = 0;
  const placed = new Set<string>();
  const dfs = (node: any, depth: number) => {
    if (placed.has(node.id)) return;
    node.x = depth * INDENT_W;
    node.y = rowY;
    rowY += ROW_H;
    placed.add(node.id);
    structuralKids(node.id).forEach(k => dfs(k, depth + 1));
  };
  dfs(root, 0);

  // 兜底：未被 DFS 到达的节点（脱链孤儿）铺到下方
  nodes.filter(n => !placed.has(n.id)).forEach(n => {
    n.x = INDENT_W; n.y = rowY; rowY += ROW_H;
  });

  // Frag/Error 星团：围所属最近 moc 祖先成环（跨层收集，如 Error 挂 Frag 下）
  const collectDetails = (mocId: string): any[] => {
    const out: any[] = [];
    const queue: string[] = [mocId];
    while (queue.length) {
      const cur = queue.shift()!;
      (childrenOf.get(cur) || []).forEach(k => {
        if ((k.level ?? 0) >= 3) out.push(k);
        queue.push(k.id);
      });
    }
    return out;
  };
  nodes.filter(n => (n.level ?? 0) === 2).forEach(moc => {
    const kids = collectDetails(moc.id);
    if (kids.length === 0) return;
    const r = Math.max(clusterR, (kids.length * 10) / (2 * Math.PI));
    kids.forEach((k, i) => {
      const a = (2 * Math.PI) * (kids.length === 1 ? 0 : i / kids.length);
      k.x = (moc.x || 0) + Math.cos(a) * r;
      k.y = (moc.y || 0) + Math.sin(a) * r;
    });
  });

  // 兜底：仍未定位的孤儿节点铺到主干下方一行（等宽横排，原 nodeWidth 未定义，用固定间距替代）
  const orphans = nodes.filter(n => n.x === undefined && n.y === undefined);
  orphans.forEach((n, i) => { n.x = i * step; n.y = rowH * 2; });
}

// ============ 扇区视图标签避让工具 ============
// 标签恒水平放置,不再辐射旋转。8 候选位贪心 + AABB 检测 + 引线兜底。
// demo/label-avoidance.html 是参考实现,这里是其移植版。
// ponytail: 字符宽估算替代 canvas.measureText(后处理阶段无 ctx)。

// 8 候选位:右/右上/上/左上/左/左下/下/右下。dx/dy 是单位方向,ax/ay 是文本锚点。
const LABEL_CANDIDATES = [
  { dx:  1, dy:  0, ax: 'left',   ay: 'middle' },
  { dx:  1, dy: -1, ax: 'left',   ay: 'bottom' },
  { dx:  0, dy: -1, ax: 'center', ay: 'bottom' },
  { dx: -1, dy: -1, ax: 'right',  ay: 'bottom' },
  { dx: -1, dy:  0, ax: 'right',  ay: 'middle' },
  { dx: -1, dy:  1, ax: 'right',  ay: 'top' },
  { dx:  0, dy:  1, ax: 'center', ay: 'top' },
  { dx:  1, dy:  1, ax: 'left',   ay: 'top' },
];

// 字符宽估算:CJK=1.0×fs,ASCII=0.6×fs,末尾 +6px padding(跟 demo 一致)
function estimateLabelWidth(text: string, fs: number): number {
  const chars = [...text];
  const w = chars.reduce((s, c) => s + (c.charCodeAt(0) < 128 ? 0.6 : 1.0), 0);
  return w * fs + 6;
}

// 自适应字号:超过 6 字每字 -0.4px,封顶 -3px(守住下限,避免长标签过小)
function adaptiveFontSize(text: string, baseFs: number): number {
  const excess = Math.max(0, [...text].length - 6);
  return Math.max(baseFs - excess * 0.4, baseFs - 3);
}

// 算标签 AABB。ax/ay 是文本锚点位置,x/y 是 AABB 左上角。
function labelRect(ax: number, ay: number, w: number, h: number, alignX: string, alignY: string) {
  let x = ax, y = ay;
  if (alignX === 'center') x = ax - w / 2;
  else if (alignX === 'right') x = ax - w;
  if (alignY === 'middle') y = ay - h / 2;
  else if (alignY === 'bottom') y = ay - h;
  return { x, y, w, h };
}

// AABB 相交判定
function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

// 按层密度反推 baseR 和 levelGap。两者都按 demo 公式 r ≥ N·(avgW+gap)/(2π) - offset 自适应。
// 每层独立算自己的 rNeeded,取 max 作为该层实际半径,再反推 baseR/gap 组合。
// 封顶防半径爆炸,极端密度交给引线兜底。
function autoRadii(nodes: any[], baseFs: number): { baseR: number; levelGap: number } {
  const DEFAULT_BASE_R = 120;
  const DEFAULT_GAP = 90;
  const RING_GAP = 16;       // 标签间隙
  const SPLAY_OFFSET = 12;   // 标签外推距离
  const CAP_BASE_R = 280;    // 内环半径封顶
  const CAP_GAP = 220;       // 层间距封顶

  // 按 level 分组(只看 level≥1,level=0 是中心)
  const byLevel = new Map<number, any[]>();
  nodes.forEach(n => {
    const lv = n.level ?? 0;
    if (lv < 1) return;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(n);
  });

  // 每层算密度需求半径
  const rNeededByLevel = new Map<number, number>();
  byLevel.forEach((group, level) => {
    const N = group.length;
    if (N === 0) return;
    const avgW = group.reduce((s, n) => s + estimateLabelWidth(n.label || '', baseFs), 0) / N;
    rNeededByLevel.set(level, N * (avgW + RING_GAP) / (2 * Math.PI) - SPLAY_OFFSET);
  });

  // 先算 level 1(内环)需要的 baseR:level=1 时 r = baseR,所以 baseR = rNeeded[1]
  let baseR = DEFAULT_BASE_R;
  if (rNeededByLevel.has(1)) {
    baseR = Math.max(DEFAULT_BASE_R, rNeededByLevel.get(1)!);
  }
  baseR = Math.min(baseR, CAP_BASE_R);

  // 再算 levelGap:外层(level≥2)需要 r_level = baseR + level*gap ≥ rNeeded[level]
  //   → gap ≥ (rNeeded[level] - baseR) / level
  // 取所有外层的最大需求作为 gap
  let levelGap = DEFAULT_GAP;
  rNeededByLevel.forEach((rNeeded, level) => {
    if (level < 2) return;
    const currentR = baseR + level * DEFAULT_GAP;
    if (rNeeded > currentR) {
      const gapNeeded = (rNeeded - baseR) / level;
      levelGap = Math.max(levelGap, gapNeeded);
    }
  });
  levelGap = Math.min(levelGap, CAP_GAP);

  return { baseR, levelGap };
}

// 核心避让:为每个节点算出标签该放哪个候选位,写回 _labelCandidate。
// 算法:
//   1. level 升序(中心优先占位)
//   2. 每个节点按"径向外侧"权重排序 8 候选位
//   3. 第一轮 8 候选位试放(AABB vs 已放标签 + 其他节点)
//   4. 第二轮沿径向外推 14/26/38/50/62(只试前 3 候选位),成功 → 引线
//   5. 兜底:首个候选位
// 坐标系:全程用全局坐标算 AABB,写回时转成相对节点中心的偏移(draw 用)。
function resolveLabelOverlaps(nodes: any[], opts: { baseFs: number }) {
  // level 0(根/中心)单独处理:固定放正下方居中,不参与候选位竞争(它是唯一的,没邻居)
  // 之前 filter 掉 level===0 导致它走兜底分支被旋转 90° → 竖排,这是 bug 的根因。
  nodes.forEach(n => {
    if ((n.level ?? 0) !== 0 || n.x === undefined || n.y === undefined) return;
    const fs = adaptiveFontSize(n.label || '', opts.baseFs);
    const size = n.size || 12;
    n._labelCandidate = {
      dx: 0,
      dy: size / 2 + 8,
      ax: 'center', ay: 'top',
      leader: false, leaderDx: 0, leaderDy: 0,
      fs,
    };
  });

  const sorted = [...nodes]
    .filter(n => (n.level ?? 0) >= 1 && n.x !== undefined && n.y !== undefined)
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0));

  const placed: { x: number; y: number; w: number; h: number }[] = [];
  // 节点本身也作为障碍(标签不盖其他节点圆点)
  const nodeObstacles = nodes
    .filter(n => n.x !== undefined && n.y !== undefined)
    .map(n => ({ x: n.x - 8, y: n.y - 8, w: 16, h: 16, id: n.id }));

  let leaderCount = 0;
  let collisionCount = 0;

  sorted.forEach(node => {
    const fs = adaptiveFontSize(node.label || '', opts.baseFs);
    const w = estimateLabelWidth(node.label || '', fs);
    const h = fs + 4;
    const size = node.size || 12;
    const gap = 10; // 节点边缘到标签的间隙

    // 径向方向(从圆心指向节点)
    const angle = node._midAngle ?? 0;
    const dirX = Math.cos(angle), dirY = Math.sin(angle);

    // 半径感知权重:叶子(level≥3)强烈偏外(外推是无限空间),结构节点稍弱
    const lv = node.level ?? 0;
    const outwardWeight = lv >= 3 ? 3.0 : 1.6;
    const ranked = LABEL_CANDIDATES
      .map(c => ({ c, score: (c.dx * dirX + c.dy * dirY) * outwardWeight }))
      .sort((a, b) => b.score - a.score)
      .map(x => x.c);

    let resolved: { dx: number; dy: number; ax: string; ay: string; leader: boolean; leaderDx: number; leaderDy: number } | null = null;

    // 第一轮:8 候选位(全局坐标算 AABB)
    for (const c of ranked) {
      const ax = node.x + c.dx * gap;
      const ay = node.y + c.dy * gap;
      const rect = labelRect(ax, ay, w, h, c.ax, c.ay);
      const hitLabel = placed.some(r => rectsOverlap(rect, r));
      const hitNode = nodeObstacles.some(o => o.id !== node.id && rectsOverlap(rect, o));
      if (!hitLabel && !hitNode) {
        resolved = {
          dx: ax - node.x, dy: ay - node.y,
          ax: c.ax, ay: c.ay,
          leader: false, leaderDx: 0, leaderDy: 0,
        };
        placed.push(rect);
        break;
      }
    }

    // 第二轮:沿径向外推(只试前 3 候选位的径向方向)
    if (!resolved) {
      for (let extra = 14; extra <= 62; extra += 12) {
        for (const c of ranked.slice(0, 3)) {
          const ax = node.x + c.dx * (gap + extra);
          const ay = node.y + c.dy * (gap + extra);
          const rect = labelRect(ax, ay, w, h, c.ax, c.ay);
          const hitLabel = placed.some(r => rectsOverlap(rect, r));
          const hitNode = nodeObstacles.some(o => o.id !== node.id && rectsOverlap(rect, o));
          if (!hitLabel && !hitNode) {
            // 引线终点(标签朝节点方向缩进 2px,贴在标签边缘)
            const leaderDx = ax - dirX * 2 - node.x;
            const leaderDy = ay - dirY * 2 - node.y;
            resolved = {
              dx: ax - node.x, dy: ay - node.y,
              ax: c.ax, ay: c.ay,
              leader: true, leaderDx, leaderDy,
            };
            placed.push(rect);
            leaderCount++;
            break;
          }
        }
        if (resolved) break;
      }
    }

    // 兜底:8 候选位 + 外推全部失败 → 扫描所有候选位选"重叠面积最小"的,而非盲放首选。
    // 对极长标签或密集区,这能把"卡死重叠"降为"轻度触碰"。
    if (!resolved) {
      let bestRect: { x: number; y: number; w: number; h: number } | null = null;
      let bestC = ranked[0];
      let bestOverlap = Infinity;
      // 同时考虑正常位和 3 档外推位,全扫一遍选最优
      const offsets = [0, 14, 26, 38];
      for (const extra of offsets) {
        for (const c of ranked) {
          const ax = node.x + c.dx * (gap + extra);
          const ay = node.y + c.dy * (gap + extra);
          const rect = labelRect(ax, ay, w, h, c.ax, c.ay);
          // 算总重叠面积(标签-标签 + 标签-节点)
          let totalArea = 0;
          for (const r of placed) {
            if (rectsOverlap(rect, r)) {
              const xOverlap = Math.min(rect.x + rect.w, r.x + r.w) - Math.max(rect.x, r.x);
              const yOverlap = Math.min(rect.y + rect.h, r.y + r.h) - Math.max(rect.y, r.y);
              totalArea += Math.max(0, xOverlap) * Math.max(0, yOverlap);
            }
          }
          for (const o of nodeObstacles) {
            if (o.id === node.id) continue;
            if (rectsOverlap(rect, o)) {
              const xOverlap = Math.min(rect.x + rect.w, o.x + o.w) - Math.max(rect.x, o.x);
              const yOverlap = Math.min(rect.y + rect.h, o.y + o.h) - Math.max(rect.y, o.y);
              totalArea += Math.max(0, xOverlap) * Math.max(0, yOverlap);
            }
          }
          if (totalArea < bestOverlap) {
            bestOverlap = totalArea;
            bestRect = rect;
            bestC = c;
          }
        }
      }
      if (bestRect) {
        const ax = node.x + bestC.dx * gap;
        const ay = node.y + bestC.dy * gap;
        if (bestOverlap > 0) collisionCount++;
        placed.push(bestRect);
        resolved = {
          dx: ax - node.x, dy: ay - node.y,
          ax: bestC.ax, ay: bestC.ay,
          leader: false, leaderDx: 0, leaderDy: 0,
        };
      }
    }

    node._labelCandidate = { ...resolved, fs };
  });
  // 诊断：标签避让统计 + 每个标签的框坐标/引线详情（供调参定位重叠源）
  const _details = sorted.map(n => {
    const c = n._labelCandidate;
    if (!c || n.x === undefined) return null;
    const lx = n.x + c.dx, ly = n.y + c.dy;
    const w = estimateLabelWidth(n.label || '', c.fs);
    const h = c.fs + 4;
    const left = c.ax === 'center' ? lx - w/2 : (c.ax === 'right' ? lx - w : lx);
    const top = c.ay === 'middle' ? ly - h/2 : (c.ay === 'bottom' ? ly - h : ly);
    return {
      label: (n.label || '').slice(0, 14),
      节点坐标: `(${n.x|0},${n.y|0})`,
      标签框: `左上(${left|0},${top|0}) 尺寸${w|0}x${h|0}`,
      锚点: `${c.ax}/${c.ay}`,
      引线: c.leader ? `→(${(n.x + c.leaderDx)|0},${(n.y + c.leaderDy)|0})` : '无',
    };
  }).filter(Boolean);
  console.log(`[标签避让] 共 ${sorted.length} 个标签,引线 ${leaderCount} 条,残留重叠 ${collisionCount} 处`, _details);

  // 引线穿障诊断：每条引线检测是否穿过其他节点圆点 / 标签框 / 其他引线
  if (leaderCount > 0) {
    // 收集所有节点圆点（作为障碍）+ 标签框 + 引线段
    const _nodeCircles = sorted.map(n => ({ id: n.id, x: n.x || 0, y: n.y || 0, r: (n.size || 12) / 2 + 2, label: (n.label||'').slice(0,10) }));
    const _labelBoxes = sorted.map(n => {
      const c = n._labelCandidate; if (!c || n.x === undefined) return null;
      const lx = n.x + c.dx, ly = n.y + c.dy;
      const w = estimateLabelWidth(n.label || '', c.fs), h = c.fs + 4;
      const left = c.ax === 'center' ? lx - w/2 : (c.ax === 'right' ? lx - w : lx);
      const top = c.ay === 'middle' ? ly - h/2 : (c.ay === 'bottom' ? ly - h : ly);
      return { id: n.id, x: left, y: top, w, h, label: (n.label||'').slice(0,10) };
    }).filter(Boolean);
    const _leaders = sorted.filter(n => n._labelCandidate?.leader && n.x !== undefined).map(n => ({
      id: n.id, label: (n.label||'').slice(0,10),
      x1: n.x || 0, y1: n.y || 0,  // 起点（节点中心）
      x2: (n.x || 0) + (n._labelCandidate!.leaderDx),  // 终点（标签端）
      y2: (n.y || 0) + (n._labelCandidate!.leaderDy),
    }));

    // 线段-矩形相交（引线穿标签框/节点外接框）
    const segHitsRect = (x1:number,y1:number,x2:number,y2:number, rx:number,ry:number,rw:number,rh:number) => {
      // 端点在矩形内 → 穿
      const inRect = (x:number,y:number) => x>=rx && x<=rx+rw && y>=ry && y<=ry+rh;
      if (inRect(x1,y1) || inRect(x2,y2)) return true;
      // 检查线段和矩形四条边相交
      const segIntersect = (ax:number,ay:number,bx:number,by:number,cx:number,cy:number,dx:number,dy:number) => {
        const d1=(bx-ax), d2=(by-ay), d3=(dx-cx), d4=(dy-cy);
        const den=d1*d4-d2*d3; if(Math.abs(den)<1e-9) return false;
        const t=((cx-ax)*d4-(cy-ay)*d3)/den, s=((cx-ax)*d2-(cy-ay)*d1)/den;
        return t>=0&&t<=1&&s>=0&&s<=1;
      };
      return segIntersect(x1,y1,x2,y2, rx,ry, rx+rw,ry) ||    // 上边
             segIntersect(x1,y1,x2,y2, rx,ry+rh, rx+rw,ry+rh) || // 下边
             segIntersect(x1,y1,x2,y2, rx,ry, rx,ry+rh) ||       // 左边
             segIntersect(x1,y1,x2,y2, rx+rw,ry, rx+rw,ry+rh);   // 右边
    };
    // 线段-圆相交（引线穿节点圆点）
    const segHitsCircle = (x1:number,y1:number,x2:number,y2:number,cx:number,cy:number,r:number) => {
      const dx=x2-x1, dy=y2-y1;
      const fx=x1-cx, fy=y1-cy;
      const a=dx*dx+dy*dy, b=2*(fx*dx+fy*dy), c=fx*fx+fy*fy-r*r;
      let disc=b*b-4*a*c; if(disc<0) return false;
      disc=Math.sqrt(disc);
      const t1=(-b-disc)/(2*a), t2=(-b+disc)/(2*a);
      return (t1>=0&&t1<=1)||(t2>=0&&t2<=1);
    };

    const _leaderDiag = _leaders.map(L => {
      const thruNodes = _nodeCircles.filter(o => o.id !== L.id && segHitsCircle(L.x1,L.y1,L.x2,L.y2, o.x,o.y,o.r)).map(o=>o.label);
      const thruLabels = _labelBoxes.filter(b => b.id !== L.id && segHitsRect(L.x1,L.y1,L.x2,L.y2, b.x,b.y,b.w,b.h)).map(b=>b.label);
      const crossLeaders = _leaders.filter(M => M.id !== L.id &&
        (() => { const d1x=M.x2-M.x1,d1y=M.y2-M.y1,d2x=L.x2-L.x1,d2y=L.y2-L.y1;
          const den=d1x*d2y-d1y*d2x; if(Math.abs(den)<1e-9) return false;
          const t=((L.x1-M.x1)*d2y-(L.y1-M.y1)*d2x)/den, s=((L.x1-M.x1)*d1y-(L.y1-M.y1)*d1x)/den;
          return t>=0&&t<=1&&s>=0&&s<=1; })()
      ).map(M=>M.label);
      return {
        引线: `${L.label}: (${L.x1|0},${L.y1|0})→(${L.x2|0},${L.y2|0})`,
        穿过节点: thruNodes.length ? thruNodes : '无',
        穿过标签: thruLabels.length ? thruLabels : '无',
        交叉引线: crossLeaders.length ? crossLeaders : '无',
      };
    });
    console.log('[引线穿障诊断]', _leaderDiag);
  }
}

// 注册换行节点类型
// theme:从 CSS 变量读出的主题色(draw 时 G6 canvas 不读 CSS,必须 JS 传值)。
//   undefined 时用暗色兜底(防御)。
const registerWrappedLabelNode = (theme?: {
  labelFill: string;
}) => {
  const labelFill = theme?.labelFill || '#e6edf3';
  G6.registerNode('wrapped-label-node', {
    draw(cfg: any, group: any) {
      const size = cfg.size || 12;
      const level = cfg.level || 0;

      // 命中节点：size 在 applyHighlight 里已 ×1.6，这里照常读 size 即可，
      // 不再做额外 hitScale（避免双倍放大）、不加装饰环、不加粗描边（用户反馈黑乎乎一团）
      const keyShape = group.addShape('circle', {
        attrs: {
          x: 0,
          y: 0,
          r: size / 2,
          fill: cfg.style?.fill || '#C6E5FF',
          stroke: cfg.style?.stroke || '#5B8FF9',
          lineWidth: cfg.style?.lineWidth ?? 2,
          shadowColor: cfg.style?.shadowColor,
          shadowBlur: (level === 0 || level === 1 || (level === 2 && cfg._hasCloud))
            ? (cfg.style?.shadowBlur ?? 0) : 0,
        },
        name: 'node-circle',
      });

      // 非命中：_queryHide 标记 → 不画 halo 也不画 label，只保留灰色淡圆点占位
      if (cfg._queryHide) {
        return keyShape;
      }

      // MOC(level 2) halo：仅当该 MOC 挂着星云(_hasCloud)才画
      if (level === 2 && cfg._hasCloud) {
        group.addShape('circle', {
          attrs: {
            x: 0, y: 0,
            r: size / 2 + 10,
            fill: cfg.style?.fill || '#4fd1c5',
            opacity: 0.35,
          },
          name: 'node-halo',
          capture: false, // 装饰光圈不参与 hover 命中，命中范围只看节点圆
          draggable: false,
        });
      }

      const baseFs = level > 2 ? 8 : 10; // 碎片/错题节点小，字号也收一档
      const fontSize = baseFs;
      const label = String(cfg.label || '');

      if (!label) return keyShape;

      // 标签三分支:
      //   1. 鱼骨布局(_labelPos='right'):右侧水平,不动
      //   2. 扇区布局 + _labelCandidate:新避让算法,水平标签 + 候选位 + 引线
      //   3. 兜底(无 _labelCandidate 的扇区节点):旧辐射旋转逻辑(防御性保留)
      const labelPos = cfg._labelPos;
      if (labelPos === 'right') {
        // 鱼骨:右侧水平
        group.addShape('text', {
          attrs: {
            x: size / 2 + 6, y: 0,
            text: label,
            textAlign: 'left',
            textBaseline: 'middle',
            fontSize: fontSize,
            fontWeight: 400,
            fill: labelFill,
            opacity: 1,
            fontFamily: '"Sring UI Sans", system-ui, -apple-system, sans-serif',
          },
          name: 'node-label',
          capture: false, // 标签不参与 hover 命中（悬在文字上≠悬在节点上）
        });
      } else if (cfg._labelCandidate) {
        // 扇区新算法:水平标签,位置/字号由 _labelCandidate 决定
        const c = cfg._labelCandidate;
        // 引线:候选位用尽时外推,画一条绿色虚线连回节点
        if (c.leader) {
          const angle = cfg._midAngle || 0;
          const dirX = Math.cos(angle), dirY = Math.sin(angle);
          group.addShape('path', {
            attrs: {
              // 从节点边缘到引线终点(_labelCandidate 里存的是相对节点中心的偏移)
              path: [
                ['M', dirX * (size / 2 + 2), dirY * (size / 2 + 2)],
                ['L', c.leaderDx, c.leaderDy],
              ],
              stroke: '#34d399',
              lineWidth: 1,
              lineDash: [3, 3],
              opacity: 0.6,
            },
            name: 'node-leader',
            capture: false,
            draggable: false,
          });
        }
        group.addShape('text', {
          attrs: {
            x: c.dx, y: c.dy,
            text: label,
            textAlign: c.ax,
            textBaseline: c.ay,
            // 扇区分支字号：applyHighlight 已把命中节点 _labelCandidate.fs 直接放大
            fontSize: c.fs,
            fontWeight: 400,
            fill: labelFill,
            opacity: 1,
            fontFamily: '"Sring UI Sans", system-ui, -apple-system, sans-serif',
          },
          name: 'node-label',
          capture: false,
        });
      } else {
        // 兜底:旧辐射旋转逻辑(_labelCandidate 缺失时防御)
        const angle = (cfg._midAngle || 0);
        const leftSide = Math.cos(angle) < 0;
        const lx = leftSide ? -(size / 2 + 5) : (size / 2 + 5);
        const lAlign = leftSide ? 'right' : 'left';
        const textShape = group.addShape('text', {
          attrs: {
            x: lx, y: 0,
            text: label,
            textAlign: lAlign,
            textBaseline: 'middle',
            fontSize: fontSize,
            fontWeight: 400,
            fill: labelFill,
            opacity: 1,
            fontFamily: '"Sring UI Sans", system-ui, -apple-system, sans-serif',
          },
          name: 'node-label',
          capture: false,
        });
        if (cfg._midAngle !== undefined) {
          const deg = (angle * 180 / Math.PI) + (leftSide ? 180 : 0);
          textShape.rotate(deg * Math.PI / 180);
        }
      }

      return keyShape;
    },
  }, 'circle');
};

// 读 CSS 变量值。G6 画在 canvas 里不读 CSS,必须 JS 把值传给 canvas 绘制。
// 从 container 往上找最近的 .star-ring-view(变量定义在那),读 getComputedStyle。
// 找不到或变量未定义 → fallback。
function readThemeVar(container: HTMLElement, name: string, fallback: string): string {
  const scope = container.closest?.('.star-ring-view') as Element | null;
  const el = scope || container;
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

// 原生画布拖拽：绕过 G6 behavior 事件系统，直接在 container/window 监听 mouse 事件。
// 右键始终可拖画布；左键仅在直角坐标系聚焦态且未点到节点时拖动画布。
// mousemove/mouseup 挂 window，保证鼠标移出画布仍可继续拖动。
// nodeHitRef: 由 G6 'node:mousedown' 置 true，避免左键在节点上误触发画布拖拽。
const setupNativeCanvasDrag = (
  graph: any,
  container: HTMLElement,
  nodeHitRef: { value: boolean },
  onAltRightDrop?: () => void
): (() => void) => {
  let origin: { x: number; y: number } | null = null;
  let altHeldAtDown = false;

  const isCanvasArea = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target) return false;
    if (target === container) return true;
    if (target.tagName === 'CANVAS') return true;
    const closest = target.closest('.g6-container');
    if (closest === container && !target.closest('.sr-query-fab') && !target.closest('.sr-query-orb') && !target.closest('.star-ring-minimap')) {
      return true;
    }
    return false;
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!isCanvasArea(e)) return;
    const btn = e.button;
    const isCartesian = graph._currentLayout === 'cartesian';
    if (btn === 2) {
      e.preventDefault();
      origin = { x: e.clientX, y: e.clientY };
      altHeldAtDown = e.altKey;
    } else if (btn === 0 && isCartesian && !nodeHitRef.value) {
      origin = { x: e.clientX, y: e.clientY };
      altHeldAtDown = false;
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!origin) return;
    const isLeft = e.buttons & 1;
    const isRight = e.buttons & 2;
    if (!isLeft && !isRight) { origin = null; return; }
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    if (dx === 0 && dy === 0) return;
    origin = { x: e.clientX, y: e.clientY };
    graph.translate(dx, dy, false);
  };

  const onMouseUp = (e: MouseEvent) => {
    if (altHeldAtDown && onAltRightDrop) {
      onAltRightDrop();
    }
    origin = null;
    altHeldAtDown = false;
    nodeHitRef.value = false;
  };

  container.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  return () => {
    container.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
};

export class StarRingView extends ItemView {
  plugin: StarRingGraphPlugin;
  graph: any = null;
  container: HTMLElement | null = null;
  ctrlHeld = false; // 按住 Ctrl 时锁定链路高亮（阻止 activate-relations 的 deactivate）
  _cleanupKeyListeners: (() => void) | null = null;
  g6Data: G6Data | null = null;           // 供 dblclick 折叠 BFS 用（修原 this.g6Data 未赋值 bug）
  focusMode: { mocId: string; isQuery?: boolean } | null = null; // Alt+点击 MOC 聚焦 / 查询星云视图（isQuery 区分）
  private _resizeObserver: ResizeObserver | null = null; // 监听容器尺寸，变化时同步画布
  private _resizeFitTimer: any = null;    // 防抖：resize 后延迟 fitView，避免拖动分隔条时频繁重排
  private _currentTree: RingNode | null = null;   // 最近一次渲染的全局树，聚焦退出时回到它
  private _currentLayout: 'fishbone' | 'sector' | 'cartesian' = 'fishbone'; // 当前布局，供 wheel 事件判断
  private _cleanupWheel: (() => void) | null = null; // 重渲染前移除旧 wheel 监听
  private _cleanupCanvasDrag: (() => void) | null = null; // 重渲染前移除旧画布拖拽监听
  private _nodeHitOnMouseDown = false; // G6 node:mousedown 触发时置 true，用于原生拖拽避开节点
  private _rendering = false; // renderGraph 进行中/刚结束，抑制 ResizeObserver 的 fitView 抢占视角
  private _focusReturnTree: RingNode | null = null; // 进入聚焦前的全局树备份，exitFocus 用
  private _preFocusMatrix: number[] | null = null;  // 进入聚焦前的视图矩阵 [a,b,c,d,e,f]，退出时恢复
  private _fullG6Data: G6Data | null = null; // 全量 g6Data（鱼骨裁剪前），查询星云裁剪用
  // ===== LightRAG 查询浮层 =====
  private _queryOverlay: QueryOverlay | null = null;
  private _queryHighlightActive = false; // 查询高亮进行中时，抑制 hover 链路高亮

  constructor(leaf: WorkspaceLeaf, plugin: StarRingGraphPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return STAR_RING_VIEW_TYPE; }
  getDisplayText() { return "星环图谱"; }
  getIcon() { return "orbit"; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    this.container = container;
    container.empty();
    container.addClass("star-ring-view");
    
    // 创建 G6 容器
    const graphContainer = container.createEl("div", { cls: "g6-container" });
    graphContainer.style.width = "100%";
    graphContainer.style.height = "100%";
    // 屏蔽浏览器右键菜单，让右键专门用于拖动画布
    graphContainer.addEventListener("contextmenu", (e) => e.preventDefault());

    // LightRAG 查询浮层（叠加在 g6-container 上，不破坏现有布局）
    this._queryOverlay = new QueryOverlay(graphContainer, this);

    // 按住 Ctrl 锁定链路高亮：keydown 置位、keyup 清位 + 手动清高亮
    // 清状态时同步恢复所有 label 显示（hover 隐藏后松 Ctrl 必须把 label show 回来，否则文字永久消失）
    const clearHighlight = () => {
      if (!this.graph || this.graph.destroyed) return;
      this.graph.getNodes().forEach((n: any) => {
        this.graph.clearItemStates(n, ['active', 'inactive']);
        const group = n.getContainer?.();
        if (group) group.findAll((s: any) => s.get('name') === 'node-label').forEach((lab: any) => lab.show());
      });
      this.graph.getEdges().forEach((e: any) => this.graph.clearItemStates(e, ['active', 'inactive']));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') this.ctrlHeld = true;
      if (e.key === 'Escape') {
        if (this.focusMode) this.exitFocus();          // 已有：退聚焦
        else if (this._queryHighlightActive            // 新增：退查询高亮（不动相机）
                 && this._queryOverlay) {
          this._queryOverlay.clearHighlight();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        this.ctrlHeld = false;
        clearHighlight(); // 松开 Ctrl 立即清除冻结的高亮
      }
    };
    // ponytail: 挂 window 确保失焦/移出容器也能捕获 Ctrl 状态
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this._cleanupKeyListeners = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };

    try {
      // ponytail: 优先用插件级缓存（metadataCache.on('changed') 失效），首次后才秒开
      let treeData = this.plugin._cachedTree;
      if (!treeData) {
        treeData = await buildChapterTree(this.app, this.plugin.settings);
        this.plugin._cachedTree = treeData;
      }
      this.renderGraph(graphContainer, treeData);
    } catch (e) {
      container.empty();
      container.createEl("div", { text: "数据加载失败：" + (e as Error).message }).style.color = "#e55";
      console.error("[星环图谱] 数据加载失败", e);
    }
  }

  async onClose() {
    // 清理 G6 实例 + 键盘监听 + 尺寸监听，防止内存泄漏
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._resizeFitTimer) { clearTimeout(this._resizeFitTimer); this._resizeFitTimer = null; }
    if (this._cleanupKeyListeners) { this._cleanupKeyListeners(); this._cleanupKeyListeners = null; }
    if (this._cleanupWheel) { this._cleanupWheel(); this._cleanupWheel = null; }
    if (this._cleanupCanvasDrag) { this._cleanupCanvasDrag(); this._cleanupCanvasDrag = null; }
    if (this._queryOverlay) { this._queryOverlay.destroy(); this._queryOverlay = null; }
    if (this.graph) {
      this.graph.destroy();
      this.graph = null;
    }
  }

  // container: G6 挂载 div；treeData: 章节树；opts.layoutOverride 强制布局（聚焦态用 sector）；
  // opts.subtreeFocusId 传入 = 聚焦态，只渲染该 MOC 的子树（MOC 作为子图根，level→0 居中）
  async renderGraph(
    container: HTMLElement,
    treeData: RingNode,
    opts?: { layoutOverride?: 'fishbone' | 'sector' | 'cartesian'; subtreeFocusId?: string; restoreMatrix?: number[]; prebuiltG6Data?: G6Data },
  ) {
    this._rendering = true; // 抑制 ResizeObserver 的 fitView，避免重建画布时覆盖已设的视角
    let cartBounds: CartesianBounds | undefined; // cartesian 布局算一次，drawCartesianAxes / clamp / resetViewport 复用
    // 读主题色(CSS 变量 → JS,G6 canvas 不读 CSS)
    const labelFill = readThemeVar(container, '--sr-label-fill', '#e6edf3');
    const edgeColor = readThemeVar(container, '--sr-edge', '#7aa8d4');
    const auxEdgeColor = readThemeVar(container, '--sr-aux-edge', '#9bb3d1');
    const hoverShadow = readThemeVar(container, '--sr-hover-shadow', '#fff');
    const hoverEdge = readThemeVar(container, '--sr-hover-edge', '#a78bfa');
    // 注册自定义节点类型（画布拖拽改为原生 DOM 事件，避免 G6 behavior 事件被吞）
    registerWrappedLabelNode({ labelFill });

    // 记下全局树，供聚焦退出回到它
    if (!opts?.subtreeFocusId && !opts?.prebuiltG6Data) this._currentTree = treeData;

    // 转换数据格式
    const fullData: G6Data = convertToG6Data(treeData);
    // 存全量数据（鱼骨裁剪前），供查询星云裁剪命中节点 + aux 边用
    if (!opts?.subtreeFocusId && !opts?.prebuiltG6Data) this._fullG6Data = fullData;

    // 聚焦态：裁出该 MOC 子树并重标 level，让 starRingSectorLayout 正确分扇区
    //   MOC → level 0（sector 靠 level===0 找根居中）
    //   结构子节点（原 level===2 的 moc2/moc3）→ 按相对树深度重标为 depth+1（深度1→2, 深度2→3），
    //     这样 sector 的 structuralKids(level<=2) 把它们画进环；
    //   叶子（原 level>=3 的 Frag/Error）→ 保持原 level>=3，走 collectDetails 星团。
    //   不重标会导致子节点掉进 orphan 兜底横排，不是星环。
    // 预构建子图（查询星云用）：跳过 convert + subtreeFocusId 裁剪，直接用裁好的 g6Data
    let g6Data = fullData;
    if (opts?.prebuiltG6Data) {
      g6Data = opts.prebuiltG6Data;
    } else if (opts?.subtreeFocusId) {
      const mocId = opts.subtreeFocusId;
      const keep = this.collectDescendants(mocId, fullData);
      keep.add(mocId);
      // 子树边：只保留 tree 结构边（排除 aux 辅连线——聚焦态无需多挂载提示，且避免环）
      const subEdges = fullData.edges.filter((e: any) =>
        e.relation !== 'aux' && keep.has(e.source) && keep.has(e.target));
      const subNodes = fullData.nodes.filter(n => keep.has(n.id));

      // 父→子索引（仅子树内）
      const childrenOf = new Map<string, string[]>();
      subEdges.forEach(e => {
        if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
        childrenOf.get(e.source)!.push(e.target);
      });
      // BFS 算每个节点相对 MOC 的结构深度（只穿过原 level===2 的结构节点；叶子断链）
      const depthOf = new Map<string, number>([[mocId, 0]]);
      const queue: string[] = [mocId];
      while (queue.length) {
        const cur = queue.shift()!;
        const d = depthOf.get(cur)!;
        const curNode = subNodes.find(n => n.id === cur);
        const curStruct = cur === mocId || (curNode?.level ?? 0) === 2; // MOC 或结构节点才往下传深度
        (childrenOf.get(cur) || []).forEach(cid => {
          if (depthOf.has(cid)) return;
          if (curStruct) depthOf.set(cid, d + 1);
          else depthOf.set(cid, d); // 叶子下的叶子不增深度（极端兜底，通常叶子无子）
          queue.push(cid);
        });
      }

      g6Data = {
        nodes: subNodes.map(n => {
          const d = depthOf.get(n.id);
          if (n.id === mocId) return { ...n, level: 0, _focusRank: 0 };
          if ((n.level ?? 0) >= 3) return { ...n, _focusRank: d ?? 1 }; // 叶子保持原 level，走星团
          return { ...n, level: d !== undefined ? d + 1 : 2, _focusRank: d ?? 1 }; // 结构节点按深度重标（深度1→2）
        }),
        edges: subEdges,
      };
    }
    this.g6Data = g6Data; // 供 dblclick 折叠 BFS 用

    // 鱼骨视图（非聚焦）：隐藏碎片/错题(level≥3)节点及涉及它们的边。
    // 鱼骨视图里 MOC 靠 halo 光环暗示"点我进去看"；星环视图(全局 + focusMode)显示完整树。
    const pendingLayout = opts?.layoutOverride ?? this.plugin.settings.layout ?? 'fishbone';
    if (!opts?.subtreeFocusId && pendingLayout === 'fishbone') {
      const keepId = new Set(g6Data.nodes.filter(n => (n.level ?? 0) < 3).map(n => n.id));
      g6Data = {
        nodes: g6Data.nodes.filter(n => keepId.has(n.id)),
        edges: g6Data.edges.filter(e => keepId.has(e.source) && keepId.has(e.target)),
      };
      this.g6Data = g6Data;
    }

    // 布局：聚焦态强制 sector；否则读 settings.layout。两者都直接预算 x/y 写回节点（不配 G6 layout 字段）
    const layout = pendingLayout;
    this._currentLayout = layout; // 记录当前布局，供 wheel 事件判断是否拦截缩放
    if (layout === 'fishbone') {
      fishboneLayout(g6Data.nodes, g6Data.edges);
      // 鱼骨视图专属：MOC 子层级(moc1/moc2/moc3...)色阶大幅拉开区分大纲深度（1.1/1.1.1/...）。
      // 跨色相(浅蓝→青→绿→靛→墨)而非同色系微调，每级对比都足够明显。聚焦视图不动。
      const mocShades = [
        { fill: '#38bdf8', stroke: '#0284c7' }, // moc1 天蓝
        { fill: '#10b981', stroke: '#047857' }, // moc2 翠绿
        { fill: '#f59e0b', stroke: '#b45309' }, // moc3 琥珀
        { fill: '#ec4899', stroke: '#be185d' }, // moc4 玫红
        { fill: '#8b5cf6', stroke: '#6d28d9' }, // moc5+ 紫
      ];
      g6Data.nodes.forEach(n => {
        // 鱼骨布局标签放节点右侧（draw 的 wrapped-label-node 读 _labelPos 决定位置）
        (n as any)._labelPos = 'right';
        if ((n.level ?? 0) === 1) {
          n.style = { ...(n.style || {}), fill: '#7dd3fc', stroke: '#0284c7' }; // 章节浅蓝
        } else if ((n.level ?? 0) === 2) {
          const m = /^moc(\d+)$/.exec(n._originalType || '');
          const idx = m ? Math.min(parseInt(m[1]) - 1, mocShades.length - 1) : 0;
          const shade = mocShades[Math.max(0, idx)];
          n.style = { ...(n.style || {}), fill: shade.fill, stroke: shade.stroke };
        }
      });
    } else if (layout === 'cartesian') {
      // 聚焦视图：直角坐标系布局（坐标系区域按节点数自适应）
      const cartTypeOf = (n: any): 'moc' | 'flash' | 'error' => {
        const t = (n._originalType || '').toLowerCase();
        if (t === 'moc' || t.startsWith('moc') || (n.level ?? 0) === 2) return 'moc';
        if (t === 'flash' || (n.level ?? 0) === 3) return 'flash';
        if (t === 'error' || (n.level ?? 0) === 4) return 'error';
        return 'moc';
      };
      const counts = { moc: 0, flash: 0, error: 0 };
      g6Data.nodes.forEach(n => { counts[cartTypeOf(n)]++; });
      console.log('[星环图谱][renderGraph] cartesian 分支', { layout, nodeCount: g6Data.nodes.length, counts });
      const cartBoundsLocal = computeCartesianBounds(g6Data.nodes, cartTypeOf);
      cartBounds = cartBoundsLocal;
      console.log('[星环图谱][renderGraph] cartBounds', JSON.stringify(cartBoundsLocal));
      focusCartesianLayout(g6Data.nodes, g6Data.edges, cartBoundsLocal);
      console.log('[星环图谱][renderGraph] 布局后首节点坐标', g6Data.nodes[0] ? { id: g6Data.nodes[0].id, x: g6Data.nodes[0].x, y: g6Data.nodes[0].y } : '无节点');
    } else {
      // 扇区布局 + 标签避让(新算法):
      //   1. 分流:level===1 且无子节点的"孤立文件"单独识别,从布局 edges 里临时摘掉
      //      → starRingSectorLayout 只布有子章节(它们分满 2π,空间更宽裕)
      //   2. autoRadii 按密度反推 baseR 和 levelGap
      //   3. 跑布局(只布有子部分)
      //   4. 后处理:孤立文件放 baseR×0.5 内-内环,均匀分布
      //   5. resolveLabelOverlaps 对全部节点跑(含孤立文件)
      const root = g6Data.nodes.find(n => (n.level ?? 0) === 0);
      const byId = new Map(g6Data.nodes.map(n => [n.id, n]));
      // 用 tree 边建 childrenOf(排除 aux)
      const kidsOf = new Map<string, Set<string>>();
      g6Data.edges.forEach(e => {
        if (e.relation === 'aux') return;
        if (!kidsOf.has(e.source)) kidsOf.set(e.source, new Set());
        kidsOf.get(e.source)!.add(e.target);
      });
      // 孤立文件:root 的 level===1 子,且自己无任何 tree 子节点
      const orphanChapters = root
        ? (g6Data.edges as any[])
            .filter(e => e.relation !== 'aux' && e.source === root.id)
            .map(e => byId.get(e.target))
            .filter(n => n && (n.level ?? 0) === 1 && (kidsOf.get(n.id)?.size ?? 0) === 0)
        : [];
      const orphanIds = new Set(orphanChapters.map(n => n.id));

      // 临时 edges:摘掉 root→孤立文件 的边,让布局只走有子章节
      const layoutEdges = orphanIds.size > 0
        ? (g6Data.edges as any[]).filter(e =>
            !(e.source === root!.id && orphanIds.has(e.target) && e.relation !== 'aux'))
        : g6Data.edges;

      const { baseR, levelGap } = autoRadii(
        g6Data.nodes.filter(n => !orphanIds.has(n.id)), 10);
      starRingSectorLayout(g6Data.nodes, layoutEdges, baseR, levelGap);

      // 后处理:孤立文件放内-内环(baseR×0.5),均匀分布
      if (orphanChapters.length > 0) {
        const orphanR = baseR * 0.5;
        orphanChapters.forEach((n, i) => {
          const a = -Math.PI / 2 + (i / orphanChapters.length) * Math.PI * 2;
          n._midAngle = a;
          n.x = Math.cos(a) * orphanR;
          n.y = Math.sin(a) * orphanR;
        });
      }

      resolveLabelOverlaps(g6Data.nodes, { baseFs: 10 });
    }

    // ponytail: 等一帧让容器完成布局再取尺寸——onOpen 时 getBoundingClientRect 常返回 0/偏小值，
    // 导致 canvas 只渲染中间一小块、右侧大片空白
    await new Promise(r => requestAnimationFrame(() => r(null)));
    await new Promise(r => requestAnimationFrame(() => r(null))); // 双 RAF 确保布局稳定
    const rect = container.getBoundingClientRect();
    const width = Math.max(400, rect.width);
    const height = Math.max(400, rect.height);

    // 销毁现有图谱实例（先移除旧 wheel / 画布拖拽监听，避免指向已销毁 canvas 的悬空引用）
    if (this._cleanupWheel) { this._cleanupWheel(); this._cleanupWheel = null; }
    if (this._cleanupCanvasDrag) { this._cleanupCanvasDrag(); this._cleanupCanvasDrag = null; }
    if (this.graph) {
      this.graph.destroy();
      this.graph = null;
    }
    // 防御性清理：G6 destroy 链中途失败时旧 canvas 可能残留，新 canvas 叠上去 → 首次渲染小黑点
    // 只清理 container 直接子级的 canvas（不递归），避免误删 Minimap 等子元素
    Array.from(container.querySelectorAll(':scope > canvas')).forEach(c => c.remove());

    // 初始化 G6 图谱
    this.graph = new G6.Graph({
      container: container,
      width: width,
      height: height,
      fitView: false, // 渲染后按布局手动设初始视角（鱼骨聚焦根节点可读缩放、旭日图 fitView 全图）
      fitViewPadding: 40,
      minZoom: 0.02, // 允许 fitView 在旭日图全图时缩更小（原 0.1 导致大图 fitView 失败警告）
      maxZoom: 4, // 允许查询星云节点少时（如 3-4 张）放大填满，避免 ratio 3.x 截断警告
      
      // 交互模式
      modes: {
        default: [
          // 画布拖拽由原生 DOM 事件实现（setupNativeCanvasDrag），避免 G6 behavior 事件被吞。
          {
            // 缩放：旭日图布局下普通滚轮即缩放。
            // 鱼骨/直角坐标系布局下禁用 zoom-canvas，滚轮由 DOM wheel handler 接管：
            // 无 Alt 平移、Alt 缩放。两套机制互斥，避免与 G6 监听器的触发顺序竞争。
            type: 'zoom-canvas',
            shouldBegin: () => this._currentLayout === 'sector',
          },
          // 直角坐标系下节点位置具有语义（匹配度/层级），不允许拖拽
          ...(layout === 'cartesian' ? [] : ['drag-node']),
          // ponytail: 删掉 activate-relations behavior —— 它只高亮一跳邻居，
          // 做不到 root→chapter→moc→flash 祖先链路高亮。改成手动 node:mouseenter/leave 事件实现。
        ],
      },

      // ponytail: 不配 layout —— starRingSectorLayout 已把 x/y 写到节点上，
      // G6 v4.8 的 initPositions 会跳过已有坐标的节点，原样采用扇区布局

      // 节点状态样式（带发光效果）
      nodeStateStyles: {
        active: {
          lineWidth: 3,
          shadowColor: hoverShadow,
          shadowBlur: 20,
        },
        inactive: {
          opacity: 0.08,
        },
        // 查询高亮专用状态：和 hover 视觉强对比（hover=紫色发光，query=按类型彩色）
        // fill/stroke 不在这里写，因为状态样式不能按节点 level 动态变；
        // 改在 applyHighlight 里用 updateItem 直接改 style，这里只给发光描边
        'query-active': {
          lineWidth: 4,
          shadowColor: '#fbbf24',
          shadowBlur: 18,
        },
        'query-inactive': {
          opacity: 0.05, // 比 hover inactive(0.08) 更淡，凸显查询命中
        },
      },

      // 边状态样式（带发光效果）
      edgeStateStyles: {
        active: {
          stroke: hoverEdge,
          lineWidth: 2,
          shadowColor: hoverEdge,
          shadowBlur: 10,
          opacity: 1,
        },
        inactive: {
          opacity: 0.02,
        },
        // 查询命中边：金色加粗连线，和 hover 紫边区分
        'query-active': {
          stroke: '#fbbf24',
          lineWidth: 3,
          shadowColor: '#fbbf24',
          shadowBlur: 12,
          opacity: 1,
        },
        'query-inactive': {
          opacity: 0.02,
        },
      },

      // 默认节点配置
      defaultNode: {
        type: 'wrapped-label-node',
      },

      // 默认边配置（父子结构边）：黑底上要够亮够粗才看得清
      defaultEdge: {
        type: 'cubic',
        style: {
          stroke: edgeColor,
          lineWidth: 1.5,
          opacity: 0.85,
        },
      },
      
      // 插件：小地图
      plugins: [
        new G6.Minimap({
          size: [150, 100],
          className: 'star-ring-minimap',
          type: 'keyShape',
        }),
      ],
    });
    (this.graph as any)._currentLayout = layout;

    // 辅连线样式覆盖：aux 边（Flash/Error 多挂载的辅助连线）用虚线，
    // 比父子结构边弱（细、淡）但仍可见，区别于主结构实线。位置由主挂决定，aux 不参与布局。
    // 聚焦视图（cartesian）里连线已统一设为淡灰实线，跳过此覆盖。
    if (layout !== 'cartesian') {
      g6Data.edges.forEach(e => {
        if (e.relation === 'aux') {
          e.style = { ...(e.style || {}), stroke: auxEdgeColor, lineWidth: 0.8, opacity: 0.45, lineDash: [3, 3] };
        }
      });
    }

    // 加载数据并渲染
    this.graph.data(g6Data);
    this.graph.render();

    // 字体加载后重绘：确保 canvas 标签用自定义字体渲染。
    // ponytail: G6 的 render() 会重置 group 矩阵 + 擦掉手动加的 axis-group。
    // render 后重新 fitView + 重画坐标轴，修复摄像机归位原点 + 坐标轴消失两个 bug。
    // 不用 savedMatrix setMatrix——那会在字体加载延迟时覆盖用户已开始的拖动。
    document.fonts.load('13px "Sring UI Sans"', '样本AB12').then(() => {
      if (!this.graph || this.graph.destroyed) return;
      this.graph.render();
      // 重画坐标轴（修复坐标轴消失）——只在 cartesian 布局 + 有 bounds 时
      if (layout === 'cartesian' && cartBounds) {
        const axisColor = readThemeVar(container, '--sr-axis', 'rgba(255,255,255,0.35)');
        const gridColor = readThemeVar(container, '--sr-grid', 'rgba(255,255,255,0.08)');
        const textColor = readThemeVar(container, '--sr-text-muted', 'rgba(255,255,255,0.5)');
        drawCartesianAxes(this.graph, { axis: axisColor, grid: gridColor, text: textColor }, cartBounds);
      }
      // 重新 fitView（修复摄像机归位原点）——render 重置矩阵后重新算
      this.resetViewport(container, false);
    });

    // 原生画布拖拽：绕过 G6 behavior，避免事件被吞
    const nodeHitRef = { value: false };
    if (this._cleanupCanvasDrag) { this._cleanupCanvasDrag(); this._cleanupCanvasDrag = null; }
    this._cleanupCanvasDrag = setupNativeCanvasDrag(this.graph, container, nodeHitRef);
    this.graph.on('node:mousedown', () => { nodeHitRef.value = true; });

    // 直角坐标系聚焦态：绘制坐标轴、限制视口，保证坐标轴始终可见
    if (layout === 'cartesian' && cartBounds) {
      const axisColor = readThemeVar(container, '--sr-axis', 'rgba(255,255,255,0.35)');
      const gridColor = readThemeVar(container, '--sr-grid', 'rgba(255,255,255,0.08)');
      const textColor = readThemeVar(container, '--sr-text-muted', 'rgba(255,255,255,0.5)');
      console.log('[星环图谱][renderGraph] 画坐标轴', { axisColor, gridColor, textColor });
      drawCartesianAxes(this.graph, { axis: axisColor, grid: gridColor, text: textColor }, cartBounds);
      (this.graph as any)._cartesianBounds = cartBounds;
      // 最佳匹配节点加金色发光描边
      const topMatchNode = g6Data.nodes.find(n => (n as any)._topMatch);
      if (topMatchNode) {
        const item = this.graph.findById(topMatchNode.id);
        if (item) this.graph.setItemState(item, 'query-active', true);
      }
    }

    // 初始视角：退出聚焦时恢复进入前保存的视图矩阵；否则按布局设默认视角
    if (opts?.restoreMatrix && Array.isArray(opts.restoreMatrix) && opts.restoreMatrix.length >= 6) {
      this.graph.get('group').setMatrix(opts.restoreMatrix.slice());
      this.graph.get('group').set('lazyCheckSize', false);
    } else {
      this.resetViewport(container, true);
    }
    // 诊断：渲染收尾时检查 graph 状态 + 视口矩阵
    const _endMatrix = this.graph.get('group').getMatrix();
    const _nodeCount = this.graph.getNodes().length;
    console.log('[星环图谱][renderGraph] 渲染收尾', {
      layout, nodeCount: _nodeCount,
      graphDestroyed: this.graph.destroyed,
      matrix: _endMatrix ? _endMatrix.slice(0, 6) : null,
      containerSize: container.getBoundingClientRect(),
    });
    // 延迟解除渲染抑制：必须晚于 ResizeObserver 的 200ms 防抖窗口，
    // 让重建画布触发的尺寸变化 fitView 被吞掉，不覆盖刚设好的视角
    setTimeout(() => { this._rendering = false; }, 400);

    // 扇区布局：600ms 后再断言一次视角。fonts 回调里的 render() 会重置画布矩阵、
    // resize 防抖也可能晚到；手动矩阵重设是幂等操作，重跑无副作用（聚焦态除外）。
    if (layout === 'sector' && !opts?.subtreeFocusId) {
      setTimeout(() => {
        if (this.graph && !this.graph.destroyed && !this.focusMode) this.resetViewport(container, false);
      }, 600);
    }

    // 鱼骨/直角坐标系布局专属滚轮行为：无 Alt 时上下平移（保持当前缩放比例）；Alt 时手动缩放。
    // 统一在 DOM 层处理，不依赖 G6 zoom-canvas 与本监听器的触发顺序（两者都注册在 canvas 上，顺序不可靠）。
    // 旭日图布局滚轮即缩放（由 zoom-canvas 处理），这里直接 return。
    const wheelHandler = (e: WheelEvent) => {
      if (this._currentLayout !== 'fishbone' && this._currentLayout !== 'cartesian') return; // 旭日图交给 zoom-canvas
      if (!this.graph || this.graph.destroyed) return;
      e.preventDefault();
      if (e.altKey) {
        // Alt+滚轮：以鼠标位置为中心缩放。G6 zoomTo 的 ratio 是绝对值，需算出目标 zoom。
        const curZoom = this.graph.getZoom ? this.graph.getZoom() : 1;
        const ratio = e.deltaY < 0 ? 1.1 : 1 / 1.1; // 向上滚放大，向下滚缩小
        const [minZoom, maxZoom] = this._currentLayout === 'cartesian' ? [0.2, 3] : [0.1, 3];
        const newZoom = Math.max(minZoom, Math.min(maxZoom, curZoom * ratio));
        this.graph.zoomTo(newZoom, { x: e.offsetX, y: e.offsetY });
      } else {
        // 普通滚轮：上下平移，保持当前缩放比例
        const dy = e.deltaY > 0 ? 60 : -60;
        const zoom = this.graph.getZoom ? this.graph.getZoom() : 1;
        this.graph.translate(0, -dy / zoom); // 除以 zoom 让平移量与缩放比例解耦
      }
    };
    const canvasEl = this.graph.get('canvas').get('el') as HTMLElement;
    canvasEl.addEventListener('wheel', wheelHandler, { passive: false });
    this._cleanupWheel = () => canvasEl.removeEventListener('wheel', wheelHandler);

    // 监听容器尺寸变化：面板被拖宽/窗口缩放时同步画布尺寸，避免画布卡在初始尺寸留黑边
    // ponytail: ResizeObserver 比 window.resize 更准——Obsidian 拖动左右分隔条不触发 window resize
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._resizeObserver = new ResizeObserver(() => {
      if (!this.graph || this.graph.destroyed) return;
      const r = container.getBoundingClientRect();
      const w = Math.max(400, r.width);
      const h = Math.max(400, r.height);
      this.graph.changeSize(w, h);
      // 渲染中/刚结束不 fitView（renderGraph 已设好视角，重建画布的尺寸抖动不该覆盖它）
      // 查询星云态也不 fitView（切屏回来 resize 会把星云视角重置成全局）
      if (this._rendering || this.focusMode?.isQuery) return;
      // 防抖 fitView：拖动分隔条会连续触发多次，只在停下后重排一次
      if (this._resizeFitTimer) clearTimeout(this._resizeFitTimer);
      this._resizeFitTimer = setTimeout(() => {
        if (this.graph && !this.graph.destroyed) {
          // 各布局走各自的复位逻辑（扇区是手动矩阵，见 resetViewport；鱼骨回根节点视角）
          this.resetViewport(container, false);
        }
      }, 200);
    });
    this._resizeObserver.observe(container);

    // hover 链路高亮：自写替代 activate-relations（后者只一跳邻居，无法高亮祖先链）。
    // 沿 edges 反查祖先链（target→source 一路到 root）+ 后代子树（BFS 向下），active 置亮、其余 inactive。
    // 只用 tree 边（父子结构），排除 aux 辅连线——后者会形成环，且不是真正的层级关系。
    // Ctrl 锁定：ctrlHeld 时跳过新 hover（保留当前高亮），mouseleave 也不清；松 Ctrl 才清（见 clearHighlight）。
    const treeEdges = () => (this.g6Data.edges as any[]).filter(e => e.relation !== 'aux');
    const childToParent = new Map<string, string>();
    treeEdges().forEach(e => childToParent.set(e.target, e.source));
    const parentOfChildren = new Map<string, string[]>();
    treeEdges().forEach(e => {
      if (!parentOfChildren.has(e.source)) parentOfChildren.set(e.source, []);
      parentOfChildren.get(e.source)!.push(e.target);
    });

    // 从 nodeId 向上收集祖先链（不含自己），到 root 为止
    const ancestorChain = (id: string): Set<string> => {
      const out = new Set<string>();
      let cur = childToParent.get(id);
      while (cur && !out.has(cur)) { out.add(cur); cur = childToParent.get(cur); }
      return out;
    };
    // 从 nodeId 向下 BFS 收集所有后代（含 Error 等）
    const descendantSet = (id: string): Set<string> => {
      const out = new Set<string>();
      const q: string[] = parentOfChildren.get(id) || [];
      while (q.length) {
        const c = q.shift()!;
        if (out.has(c)) continue;
        out.add(c);
        (parentOfChildren.get(c) || []).forEach(k => q.push(k));
      }
      return out;
    };

    // 控制 wrapped-label-node 的文字标签显隐（多行 label shape name 都是 'node-label'）。
    // G6 状态样式改不到自定义 draw 画的 text shape，只能直接 hide/show 子 shape。
    const setLabelVisible = (nodeItem: any, visible: boolean) => {
      const group = nodeItem.getContainer();
      if (!group) return;
      const labels = group.findAll((s: any) => s.get('name') === 'node-label');
      labels.forEach((lab: any) => { visible ? lab.show() : lab.hide(); });
    };

    this.graph.on('node:mouseenter', (evt: any) => {
      if (this.ctrlHeld) return; // Ctrl 锁定：不切换高亮
      if (!this.graph || this.graph.destroyed) return;
      const model = evt.item?.getModel();
      if (!model) return;
      const activeIds = new Set<string>([model.id]);
      ancestorChain(model.id).forEach(x => activeIds.add(x));
      descendantSet(model.id).forEach(x => activeIds.add(x));

      // 收集 active 链上的边（两端都在 activeIds 内）
      const activeEdges = new Set<string>();
      this.g6Data.edges.forEach((e: any, idx: number) => {
        if (activeIds.has(e.source) && activeIds.has(e.target)) activeEdges.add(String(idx));
      });

      this.graph.getNodes().forEach((n: any) => {
        const m = n.getModel();
        if (!m) return;
        if (activeIds.has(m.id)) {
          this.graph.setItemState(n, 'active', true);
          this.graph.setItemState(n, 'inactive', false);
          setLabelVisible(n, true); // active 链路文字保持显示
        } else {
          this.graph.setItemState(n, 'active', false);
          this.graph.setItemState(n, 'inactive', true);
          setLabelVisible(n, false); // 非链路文字直接隐藏
        }
      });
      this.graph.getEdges().forEach((ed: any, idx: number) => {
        if (activeEdges.has(String(idx))) {
          this.graph.setItemState(ed, 'active', true);
          this.graph.setItemState(ed, 'inactive', false);
        } else {
          this.graph.setItemState(ed, 'active', false);
          this.graph.setItemState(ed, 'inactive', true);
        }
      });
    });

    this.graph.on('node:mouseleave', (evt: any) => {
      if (this.ctrlHeld) return; // Ctrl 锁定：移出不清
      if (!this.graph || this.graph.destroyed) return;
      this.graph.getNodes().forEach((n: any) => {
        this.graph.clearItemStates(n, ['active', 'inactive']);
        setLabelVisible(n, true); // 恢复所有文字标签显示
      });
      this.graph.getEdges().forEach((e: any) => this.graph.clearItemStates(e, ['active', 'inactive']));
    });

    // 节点交互：单击 = 折叠/展开子树；双击 = 打开对应笔记；右键 = 打开对应笔记
    // ponytail: G6 click 总在 dblclick 前触发，用 220ms 延迟区分 —— 单击延迟执行折叠，
    //           双击在延迟期内触发则取消折叠 timer、改执行打开笔记
    let clickTimer: any = null;
    const toggleCollapse = (model: any) => {
      const collapsed = !model.collapsed;
      model.collapsed = collapsed;
      // BFS 沿 tree 边收集所有后代 id（排除 aux 辅连线，避免环和误折叠）
      const dblEdges = (this.g6Data!.edges as any[]).filter(e => e.relation !== 'aux');
      const descendants = new Set<string>();
      const queue: string[] = [];
      dblEdges.forEach(e => { if (e.source === model.id) queue.push(e.target); });
      while (queue.length) {
        const cur = queue.shift()!;
        if (descendants.has(cur)) continue;
        descendants.add(cur);
        dblEdges.forEach(e => { if (e.source === cur) queue.push(e.target); });
      }
      descendants.forEach(id => {
        const item = this.graph!.findById(id);
        if (item) this.graph!.updateItem(item, { visible: !collapsed });
      });
      // 边同步：任一端点不可见则隐藏
      this.graph!.getEdges().forEach(edge => {
        const sModel = edge.getSource()?.getModel();
        const tModel = edge.getTarget()?.getModel();
        if (!sModel || !tModel) return;
        const sVisible = sModel.visible !== false;
        const tVisible = tModel.visible !== false;
        this.graph!.updateItem(edge, { visible: sVisible && tVisible });
      });
    };

    this.graph.on('node:click', (evt) => {
      const node = evt.item;
      const model = node?.getModel();
      if (!model) return;

      // 查询高亮时：禁止折叠/展开子节点（会破坏高亮视图）
      // 双击打开笔记、右键打开源文件不受影响（见 node:dblclick / node:contextmenu）
      if (this._queryHighlightActive) return;

      // Alt+左键：进入/退出聚焦模式（立即触发，不走延迟）
      const altKey = (evt.originalEvent as MouseEvent)?.altKey;
      if (altKey) {
        if (this.focusMode?.mocId === model.id) { this.exitFocus(); return; }
        if (!this.focusMode && model.level === 2) { this.focusOnMoc(model.id); return; }
      }

      // 单击：延迟 220ms 执行折叠，若期间双击则被取消
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        toggleCollapse(model);
        clickTimer = null;
      }, 220);
    });

    // 双击：取消单击的折叠动作，改为打开对应笔记
    this.graph.on('node:dblclick', (evt) => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      const model = evt.item?.getModel();
      const filePath = model?._filePath;
      if (filePath) void this.openNodeFile(filePath);
    });

    // 右键节点：直接打开对应笔记源文件（查询期间也生效，提供命中节点的快速跳转）
    this.graph.on('node:contextmenu', (evt) => {
      evt.preventDefault?.();
      const model = evt.item?.getModel();
      const filePath = model?._filePath;
      if (filePath) void this.openNodeFile(filePath);
    });

    // Minimap 点击跳转(在所有 plugin 注册 + render 之后挂载)
    this.attachMinimapClick();
  }

  // 图谱专属标签页：首个节点新建一页，之后双击/右键都在这一页里切换文件，不再堆标签
  private graphLeaf: WorkspaceLeaf | null = null;

  private async openNodeFile(filePath: string) {
    const file = this.app.metadataCache.getFirstLinkpathDest(filePath, "");
    if (!file) return;
    // 标签页被用户手动关掉后，下次双击回落到新建
    if (this.graphLeaf && !this.app.workspace.getLeavesOfType('markdown').includes(this.graphLeaf)) {
      this.graphLeaf = null;
    }
    if (!this.graphLeaf) this.graphLeaf = this.app.workspace.getLeaf('tab');
    await this.graphLeaf.openFile(file);
    this.app.workspace.revealLeaf(this.graphLeaf);
  }

  // Minimap 点击跳转:点击 minimap 空白处(非 viewport 矩形),该点立即成为主图视口中心。
  // 保留 G6 原生的 viewport 矩形拖动。坐标映射从 G6 源码反推:
  //   1px minimap = (container.clientWidth / zoom) / viewport.width 个主图像素
  // 调用点:renderGraph 末尾(每次重建 graph 后自动重挂,dataset 防重复)
  private attachMinimapClick() {
    if (!this.graph || this.graph.destroyed) return;
    const plugins = this.graph.get('plugins') || [];
    const minimap = plugins.find((p: any) => p && typeof p.getViewport === 'function');
    if (!minimap) return;
    const container = (minimap as any).getContainer?.() as HTMLElement | undefined;
    const viewport = (minimap as any).getViewport?.() as HTMLElement | undefined;
    if (!container || !viewport) return;
    // 防重复挂载(理论上 graph 重建后 container 是新的,dataset 标记会自动失效)
    if (container.dataset.minimapClickBound === '1') return;
    container.dataset.minimapClickBound = '1';

    container.addEventListener('click', (e: MouseEvent) => {
      // 点 viewport 矩形本身交给原生拖动,不抢事件
      if (e.target === viewport || viewport.contains(e.target as Node)) return;
      if (!this.graph || this.graph.destroyed) return;

      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      // viewport 矩形当前位置(minimap 坐标系)
      const vLeft = parseFloat(viewport.style.left) || 0;
      const vTop = parseFloat(viewport.style.top) || 0;
      const vW = parseFloat(viewport.style.width) || rect.width;
      const vH = parseFloat(viewport.style.height) || rect.height;
      const vCenterX = vLeft + vW / 2;
      const vCenterY = vTop + vH / 2;

      // 点击点相对当前视口中心的偏移(minimap 坐标系)
      const dCx = cx - vCenterX;
      const dCy = cy - vCenterY;

      // 转 main graph 平移量:
      //   viewport 矩形宽 vW = 主图视口宽(minimap 缩放后)
      //   主图视口实际宽 = container.clientWidth / zoom
      //   → 1px minimap = (container.clientWidth / zoom) / vW 主图像素
      // 负号:viewport 中心右移 = 看主图右侧 = 主图往左移
      const zoom = this.graph.getZoom() || 1;
      const containerW = container.clientWidth || 150;
      const containerH = container.clientHeight || 100;
      // viewport 矩形可能因 fitView 充满整个 minimap(vW≈containerW),此时点空白无意义
      if (vW >= containerW - 1 && vH >= containerH - 1) return;
      const mainPerPixel = (containerW / zoom) / vW;
      const mainPerPixelY = (containerH / zoom) / vH;
      const dx = -dCx * mainPerPixel;
      const dy = -dCy * mainPerPixelY;

      this.graph.translate(dx, dy, false);
    });
  }

  // 重置视角：鱼骨布局 → 聚焦根节点 + 固定可读缩放（1.0），根节点停在左上 padding 处；
  // 旭日图布局 → fitView 全图。animate=true 用于初始渲染（有过渡），false 用于点击重置（即时）。
  private resetViewport(container: HTMLElement, animate: boolean) {
    if (!this.graph || this.graph.destroyed) return;
    if (this._currentLayout === 'fishbone' && this.g6Data) {
      const rootModel = this.g6Data.nodes.find(n => (n.level ?? 0) === 0);
      const targetZoom = 1.0;
      if (rootModel && typeof rootModel.x === 'number') {
        // 先以根节点为中心缩放，再平移把根节点挪到视口左上 padding 处
        this.graph.zoomTo(targetZoom, { x: rootModel.x, y: rootModel.y });
        const r = container.getBoundingClientRect();
        const matrix = this.graph.get('group').getMatrix() || [1,0,0,0,1,0,0,0,1];
        const zoom = matrix[0];
        const dx = (rootModel.x * zoom) - 60;  // 根节点投影到视口左边 60px
        const dy = (rootModel.y * zoom) - 60;  // 根节点投影到视口顶部 60px
        this.graph.translate(dx, dy);
      } else {
        this.graph.zoomTo(targetZoom, { x: (container.getBoundingClientRect().width) / 2, y: 0 });
      }
    } else if (this._currentLayout === 'cartesian') {
      // 聚焦视角：缩放 + 平移让整个坐标系 bounds 刚好落入视口（体现远近大小）。
      // 手动算仿射矩阵 [a,0,0,d,e,f]：a/d=缩放，e/f=平移。给 padding 让坐标轴标签不被切。
      const CART = (this.graph as any)._cartesianBounds as CartesianBounds
        || { left: CART_LEFT, right: CART_RIGHT, top: CART_TOP, bottom: 490, bandY: { moc: 100, flash: 260, error: 420 } };
      const r = container.getBoundingClientRect();
      const vpW = Math.max(400, r.width);
      const vpH = Math.max(300, r.height);
      const PAD = 60; // 视口边距，让坐标轴标签不被切
      const worldW = CART.right - CART.left;
      const worldH = CART.bottom - CART.top;
      const scale = Math.min((vpW - PAD * 2) / worldW, (vpH - PAD * 2) / worldH, 3); // 限制最大 3 倍避免空旷
      // 世界中心 → 视口中心
      const worldCx = (CART.left + CART.right) / 2;
      const worldCy = (CART.top + CART.bottom) / 2;
      const vpCx = vpW / 2;
      const vpCy = vpH / 2;
      const mtxE = vpCx - worldCx * scale;
      const mtxF = vpCy - worldCy * scale;
      // ponytail: G6 v4/gl-matrix 用 9 元素列优先矩阵 [a,b,0, c,d,0, e,f,1]，不能写 6 元素，否则 translate() 读到 undefined 算出 NaN 冻结画布
      this.graph.get('group').setMatrix([scale, 0, 0, 0, scale, 0, mtxE, mtxF, 1]);
      this.graph.get('group').set('lazyCheckSize', false);
    } else {
      // 旭日图（扇区）：不走 G6 fitView。它的实现是 translate+zoom 两段式加补间动画，
      // 在大树上有多个静默失效点（bbox 无效/NaN 直接 return、zoom 超范围被拒、
      // 动画被 fonts 回调里的 render() 重入打断停在半路），任一命中视口就停在 ≈1 的
      // 缩放——只能看到内环（root+章），外环 MOC 全在屏外（信号 8 层深树首当其冲）。
      // 改为一次算节点 bbox → 手动设 9 元素矩阵（cartesian 分支同款，确定性生效）。
      const nodes = this.g6Data?.nodes ?? [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach((n: any) => {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') return;
        if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
      });
      if (minX === Infinity) {
        this.graph.fitView(40, undefined, true, animate ? { easing: 'easeCubic', duration: 300 } : undefined);
        return;
      }
      const r = container.getBoundingClientRect();
      const vpW = Math.max(400, r.width);
      const vpH = Math.max(300, r.height);
      const PAD = 90; // 视口边距：给外推标签/引线留空间
      const worldW = Math.max(maxX - minX, 1);
      const worldH = Math.max(maxY - minY, 1);
      const scale = Math.min((vpW - PAD * 2) / worldW, (vpH - PAD * 2) / worldH, 3);
      const worldCx = (minX + maxX) / 2;
      const worldCy = (minY + maxY) / 2;
      const mtxE = vpW / 2 - worldCx * scale;
      const mtxF = vpH / 2 - worldCy * scale;
      // ponytail: G6 v4 用 9 元素列优先矩阵，6 元素会让 translate 读到 undefined 算出 NaN 冻结画布
      this.graph.get('group').setMatrix([scale, 0, 0, 0, scale, 0, mtxE, mtxF, 1]);
      this.graph.get('group').set('lazyCheckSize', false);
      // setMatrix 不一定触发重绘（取决于 autoPaint 时机），显式 paint 保证矩阵立即生效
      if (typeof this.graph.paint === 'function') this.graph.paint();
      console.log('[星环图谱][resetViewport] 扇区手动矩阵', {
        scale: +scale.toFixed(3),
        bbox: `${Math.round(minX)},${Math.round(minY)} ~ ${Math.round(maxX)},${Math.round(maxY)}`,
        vp: `${Math.round(vpW)}x${Math.round(vpH)}`,
      });
    }
  }

  // BFS 沿 tree 边收集某节点的所有后代 id（含跨多级）。供 focusOnMoc 子树裁剪用。
  // 只穿父子结构边（relation !== 'aux'），辅连线会形成环且不是层级关系，必须排除。
  private collectDescendants(rootId: string, data?: G6Data): Set<string> {
    const allEdges = (data?.edges ?? this.g6Data!.edges) as any[];
    const edges = allEdges.filter(e => e.relation !== 'aux');
    const out = new Set<string>();
    const queue: string[] = [];
    edges.forEach(e => { if (e.source === rootId) queue.push(e.target); });
    while (queue.length) {
      const cur = queue.shift()!;
      if (out.has(cur)) continue;
      out.add(cur);
      edges.forEach(e => { if (e.source === cur) queue.push(e.target); });
    }
    return out;
  }

  // 淡入/淡出 G6 容器，掩盖聚焦切换时的销毁+重建。ponytail: 纯 CSS opacity transition，无动画库
  private fadeCanvas(enter: boolean): Promise<void> {
    const gc = this.container?.querySelector('.g6-container') as HTMLElement | null;
    if (!gc) return Promise.resolve();
    gc.style.transition = 'opacity 220ms ease';
    gc.style.opacity = enter ? '1' : '0';
    return new Promise(r => setTimeout(r, 230));
  }

  /**
   * 按命中节点 ID 集合裁剪全量 g6Data（鱼骨裁剪前），保留原始 level + 原始边 relation。
   * 不造虚拟根。造虚拟根会导致 G6 渲染 size:0 的残留圆点 → 小黑点。
   * 命中间的边保留原始 relation(tree 实线 / aux 虚线)。
   * ponytail: 必须从 _fullG6Data 裁，不能从 this.g6Data（鱼骨模式已裁掉 level≥3 的 Flash/Error + aux 边）
   */
  private cropG6DataByQueryHits(finalMap: Map<string, number>): G6Data {
    const src = this._fullG6Data || this.g6Data;
    if (!src) return { nodes: [], edges: [] };
    const hitNodes = src.nodes.filter(n => finalMap.has(n.id));
    // 命中节点间的边：保留原始 relation（tree/aux），沿用全局 cubic 曲线
    const hitEdges = (src.edges as any[])
      .filter(e => finalMap.has(e.source) && finalMap.has(e.target));
    // rank 线性映射到体积缩放 [0.8, 1.6]：rank=0（最相关）→1.6×，rank=max→0.8×
    const maxRank = Math.max(...finalMap.values(), 1);
    return {
      // 只放命中节点（保留原 level + _originalType + chapterId，布局需要）+ 写 _queryRank + 按 rank 缩放 size
      // 清除全局图谱的旧坐标/布局属性，让星云布局从干净状态开始（否则旧 x/y 会让节点飞到几百 px 外）
      nodes: hitNodes.map(n => {
        const rank = finalMap.get(n.id) ?? 999;
        const scale = 1.6 - (rank / maxRank) * 0.8; // rank=0→1.6，rank=max→0.8
        const { x, y, _midAngle, _labelCandidate, _labelPos, ...clean } = n;
        return { ...clean, _queryRank: rank, size: (n.size || 12) * scale };
      }),
      edges: [...hitEdges],
    };
  }

  /**
   * 查询星云视图：用命中节点集合重建 sector 子图。
   * 复用 focusOnMoc 的双画布切换外壳（存矩阵→fade→renderGraph→置 focusMode→fade）。
   * ESC 唯一退出（exitFocus），Alt+左键被 isQuery 守卫拦截。
   */
  private async focusOnQueryHits(finalMap: Map<string, number>, skipFade = false) {
    console.log('[星环图谱][focusOnQueryHits] 进入', { finalMapSize: finalMap.size, hasGraph: !!this.graph, skipFade });
    if (!this.graph || finalMap.size === 0) {
      console.warn('[星环图谱][focusOnQueryHits] 早退', { noGraph: !this.graph, emptyMap: finalMap.size === 0 });
      return;
    }
    const gc = this.container?.querySelector('.g6-container') as HTMLElement | null;
    if (!gc) { console.warn('[星环图谱][focusOnQueryHits] 找不到 .g6-container'); return; }
    // 只在从全局进入时备份矩阵+树；种子→picks 切换时 focusMode 已存在，不覆盖备份
    if (!this.focusMode) {
      this._preFocusMatrix = (this.graph.get('group').getMatrix() || [1,0,0,0,1,0,0,0,1]).slice();
      this._focusReturnTree = this._currentTree;
    }
    // skipFade: 种子→picks 切换时跳过淡出淡入（已在星云态，直接重建避免闪烁）
    if (!skipFade) await this.fadeCanvas(false);
    const subG6Data = this.cropG6DataByQueryHits(finalMap);
    console.log('[星环图谱][focusOnQueryHits] 裁剪后', { nodes: subG6Data.nodes.length, edges: subG6Data.edges.length });
    await this.renderGraph(gc, this._currentTree!, {
      layoutOverride: 'cartesian',
      prebuiltG6Data: subG6Data,
    });
    this.focusMode = { mocId: '__query_root__', isQuery: true };
    this.container?.classList.add('is-focused');
    if (!skipFade) await this.fadeCanvas(true);
  }

  // Alt+点击 MOC 进入聚焦：销毁鱼骨画布 → 用直角坐标系布局重建只含该 MOC 子树的新画布
  // 双画布切换：不再在原画布上隐藏/重排节点，聚焦态就是一张干净的直角坐标系子图
  private async focusOnMoc(mocId: string) {
    if (!this.graph || !this._currentTree) return;
    const gc = this.container?.querySelector('.g6-container') as HTMLElement | null;
    if (!gc) return;
    // 销毁前保存当前视图矩阵，退出聚焦时恢复（保持用户进入前的缩放/平移，而非重置）
    this._preFocusMatrix = (this.graph.get('group').getMatrix() || [1,0,0,0,1,0,0,0,1]).slice();
    await this.fadeCanvas(false);                 // 淡出旧画布
    this._focusReturnTree = this._currentTree;    // 备份全局树，退出用
    await this.renderGraph(gc, this._currentTree, { layoutOverride: 'cartesian', subtreeFocusId: mocId });
    this.focusMode = { mocId };
    this.container?.classList.add('is-focused');
    await this.fadeCanvas(true);                  // 淡入新画布
  }

  // 退出聚焦：销毁 sector 子图画布 → 用备份的全局树重建鱼骨画布，fitView 全局复位
  private async exitFocus() {
    if (!this.graph) return;
    const gc = this.container?.querySelector('.g6-container') as HTMLElement | null;
    if (!gc) return;
    await this.fadeCanvas(false);
    const wasQuery = this.focusMode?.isQuery;
    this.focusMode = null;
    if (wasQuery) this._queryHighlightActive = false; // 查询星云退出时同步清高亮标志
    this.container?.classList.remove('is-focused');
    const tree = this._focusReturnTree ?? this._currentTree;
    const restoreMatrix = this._preFocusMatrix;
    this._focusReturnTree = null;
    this._preFocusMatrix = null;
    if (tree) await this.renderGraph(gc, tree, { restoreMatrix: restoreMatrix || undefined });
    await this.fadeCanvas(true);                  // 淡入（补回：否则 opacity 卡 0 → 黑屏）
  }

  // 设置变更（布局切换 / 阈值调整）后重建图谱：重新读树 + 重新布局渲染
  // renderGraph 顶部会 destroy 旧 graph，键盘监听不动
  async rerenderGraph() {
    // 查询星云视图期间跳过重建（切屏/resize 触发，会丢弃星云态意外退出）
    if (this.focusMode?.isQuery) return;
    const gc = this.container?.querySelector('.g6-container') as HTMLElement | null;
    if (!gc) return;
    try {
      // ponytail: rerenderGraph 由设置/主题变更触发，强制清缓存重读（设置可能改了源文件夹）
      this.plugin._cachedTree = null;
      const treeData = await buildChapterTree(this.app, this.plugin.settings);
      this.plugin._cachedTree = treeData;
      this.renderGraph(gc, treeData);
    } catch (e) {
      console.error("[星环图谱] 重建失败", e);
    }
  }

  // 数据更新方法：当 Obsidian 中更新笔记时调用
  async updateGraph() {
    if (!this.container) return;
    // 查询星云视图期间跳过（changeData 会把星云子图替换成全量数据）
    if (this.focusMode?.isQuery) return;
    
    try {
      const treeData = await buildChapterTree(this.app, this.plugin.settings);
      const g6Data: G6Data = convertToG6Data(treeData);
      
      if (this.graph) {
        // 增量更新：尝试保持原有节点位置，仅计算变化部分
        this.graph.changeData(g6Data);
      }
    } catch (e) {
      console.error("[星环图谱] 数据更新失败", e);
    }
  }
}

// ============================================================================
// QueryOverlay — LightRAG 查询浮层（Astryx 设计语言）
// 封装：浮层 DOM + 4 动作自定义下拉 + 查询逻辑（调 LightRAG）+ 实体匹配 + 结构扩展 + 高亮
// 参考：plan/reference/star-ring-preview.html（UI）、plan/03-query-algorithm.md（算法）
// ============================================================================

// 4 动作 → 目标卡片类型（替代 LightRAG 默认 5 模式，对齐三层卡片结构）
// 相似卡片扫描：LLM 返回的冗余组结构

// 提取章节归属，供合并 prompt 的"章节归属"行 + 闸门核查用。
// MOC 卡：从文件名提取节点编号前缀（如 5.3.1_奇偶性 → "5.3.1"）。
// Flash/Error 卡：无编号前缀，用 topic 字段（如 "积分/定积分"）。
function extractChapter(term: { path: string; topic: string; kind: string }): string {
  if (term.kind === 'moc') {
    const base = term.path.split('/').pop() || '';
    const m = base.match(/^(\d+(?:\.\d+)*)_/);
    if (m) return m[1];
  }
  return term.topic || '（无 topic）';
}

interface SimilarGroup {
  indices: number[];        // LLM 返回的清单序号（1-based）
  titles: string[];         // 由序号反查 terms 得到的权威标题
  paths: string[];          // 由序号反查得到的文件路径（可能为空）
  chapters: string[];       // 由序号反查得到的章节归属（MOC=节点前缀，Flash/Error=topic）
  isMoc: boolean;           // 组内是否全为 MOC 卡（决定走哪条工作流）
  overlap_percent: number;
  shared_concepts: string;
  merge_suggestion: string;
  keep_separate: boolean;
  _refineFailed?: boolean;  // 运行时标记：精读阶段 GLM 调用失败（不进合并 prompt，仅渲染提示）
}

const ACTION_TARGET: Record<string, {
  moc: boolean; flashSubtypes: string[]; error: boolean; label: string;
}> = {
  concept: { moc: true,  flashSubtypes: ['know_what'],                       error: false, label: '学概念' },
  method:  { moc: false, flashSubtypes: ['know_how'],                        error: false, label: '找方法' },
  error:   { moc: false, flashSubtypes: ['know_why'],                        error: true,  label: '查错题' },
  review:  { moc: true,  flashSubtypes: ['know_what','know_how','know_why'], error: true,  label: '复习专题' },
  // similar 走自己的 runSimilarScan 分支，不消费结构扩展字段（expandByStructure 有守卫兜底）
  similar: { moc: false, flashSubtypes: [],                                  error: false, label: '找相似卡' },
};

class QueryOverlay {
  private host: HTMLElement;          // 浮层挂载点（g6-container）
  private view: StarRingView;
  private el: HTMLElement;            // 浮层根元素
  private mode = 'concept';           // 当前选中的动作
  private deepMode = false;           // false=快速检索（FTS5）, true=深度检索（FTS5 + GLM）
  private modeLabel: HTMLElement;
  private dropdownEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private ansLabelEl: HTMLElement;    // 「GLM 回答」/「命中笔记」标签（随模式切换）
  private ansBodyEl: HTMLElement;
  private hitsSummaryEl: HTMLElement;
  private chipMocEl: HTMLElement;
  private chipFlashEl: HTMLElement;
  private _lastFinalMap: Map<string, number> | null = null; // 上次命中节点 id→rank（供 renderFtsResults 用，和星云一致）
  private chipErrorEl: HTMLElement;
  private _termsCache: any[] | null = null; // 术语表缓存（FtsIndex.terms() 首次调用后复用，供 GLM 改写参考）
  private orbEl: HTMLElement;         // 收起态悬浮 orb
  private pos = { x: 16, y: 16 };     // orb 与卡片共享的锚点（展开/收起原位切换）

  constructor(host: HTMLElement, view: StarRingView) {
    this.host = host;
    this.view = view;
    this.el = host.createEl("div", { cls: "sr-query-fab" });
    this.el.innerHTML = `
      <div class="sr-query-header">
        <svg class="sr-icon" viewBox="0 0 24 24" width="16" height="16"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m21 21-4.35-4.35" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <span class="sr-query-title">知识库查询</span>
      </div>
      <div class="sr-query-body">
        <div class="sr-query-row">
          <div class="sr-input-wrap">
            <input type="text" class="sr-query-input" placeholder="输入知识点 / 套路 / 错题关键词…">
          </div>
          <div class="sr-dropdown">
            <button class="sr-dropdown-trigger" type="button">
              <span class="sr-mode-label">学概念</span>
              <svg class="sr-icon sr-icon-sm sr-chevron" viewBox="0 0 24 24" width="14" height="14"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div class="sr-dropdown-menu">
              <div class="sr-dropdown-item selected" data-value="concept">
                <div><div class="sr-item-label">学概念</div><div class="sr-item-desc">MOC + 是什么</div></div>
                <svg class="sr-icon sr-icon-sm sr-check" viewBox="0 0 24 24" width="14" height="14"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
              <div class="sr-dropdown-item" data-value="method">
                <div><div class="sr-item-label">找方法</div><div class="sr-item-desc">怎么做 Flash</div></div>
                <svg class="sr-icon sr-icon-sm sr-check" viewBox="0 0 24 24" width="14" height="14"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
              <div class="sr-dropdown-item" data-value="error">
                <div><div class="sr-item-label">查错题</div><div class="sr-item-desc">错题 + 错因</div></div>
                <svg class="sr-icon sr-icon-sm sr-check" viewBox="0 0 24 24" width="14" height="14"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
              <div class="sr-dropdown-item" data-value="review">
                <div><div class="sr-item-label">复习专题</div><div class="sr-item-desc">全套</div></div>
                <svg class="sr-icon sr-icon-sm sr-check" viewBox="0 0 24 24" width="14" height="14"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
              <div class="sr-dropdown-item" data-value="similar">
                <div><div class="sr-item-label">找相似卡</div><div class="sr-item-desc">合并冗余</div></div>
                <svg class="sr-icon sr-icon-sm sr-check" viewBox="0 0 24 24" width="14" height="14"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
            </div>
          </div>
          <button class="sr-query-btn" type="button">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12h14M13 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            查询
          </button>
        </div>
        <div class="sr-mode-toggle">
          <label class="sr-deep-toggle">
            <input type="checkbox" class="sr-deep-checkbox">
            <span class="sr-deep-label">深度检索</span>
          </label>
          <span class="sr-mode-hint">快速（FTS5, &lt;10ms） · 勾选=AI 详解</span>
        </div>
        <div class="sr-answer-box">
          <div class="sr-ans-label">命中笔记</div>
          <div class="sr-ans-body">输入问题，选择学习动作，查询你的三层卡片知识库。</div>
        </div>
        <div class="sr-hits-summary" style="display:none">
          <span class="sr-chip sr-chip-moc">MOC 0</span>
          <span class="sr-chip sr-chip-flash">Flash 0</span>
          <span class="sr-chip sr-chip-error">Error 0</span>
          <button class="sr-chip sr-copy-paths" type="button" title="复制所有高亮节点的文件路径">复制路径</button>
        </div>
      </div>
    `;

    // 绑定元素引用
    this.modeLabel = this.el.querySelector('.sr-mode-label')!;
    this.dropdownEl = this.el.querySelector('.sr-dropdown')!;
    this.inputEl = this.el.querySelector('.sr-query-input')!;
    this.ansLabelEl = this.el.querySelector('.sr-ans-label')!;
    this.ansBodyEl = this.el.querySelector('.sr-ans-body')!;
    this.hitsSummaryEl = this.el.querySelector('.sr-hits-summary')!;
    this.chipMocEl = this.el.querySelector('.sr-chip-moc')!;
    this.chipFlashEl = this.el.querySelector('.sr-chip-flash')!;
    this.chipErrorEl = this.el.querySelector('.sr-chip-error')!;

    this.bindEvents();
    this.initOrb(); // 默认收起为悬浮 orb，不遮挡画布
  }

  private bindEvents() {
    // 收起为悬浮 orb（单击 orb 展开）
    const header = this.el.querySelector('.sr-query-header') as HTMLElement;
    header.addEventListener('click', () => this.collapse());

    // 下拉开关
    const trigger = this.el.querySelector('.sr-dropdown-trigger') as HTMLElement;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dropdownEl.classList.toggle('open');
    });

    // 下拉项选择
    this.el.querySelectorAll('.sr-dropdown-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = (item as HTMLElement).dataset.value!;
        this.mode = val;
        this.modeLabel.textContent = ACTION_TARGET[val].label;
        this.el.querySelectorAll('.sr-dropdown-item').forEach(i =>
          i.classList.toggle('selected', i === item));
        this.dropdownEl.classList.remove('open');
        // similar 模式：禁用输入框（全库扫描不需要查询词），其他模式恢复
        if (val === 'similar') {
          this.inputEl.disabled = true;
          this.inputEl.value = '';
          this.inputEl.placeholder = '全库扫描，无需输入';
        } else {
          this.inputEl.disabled = false;
          this.inputEl.placeholder = '输入知识点 / 套路 / 错题关键词…';
        }
      });
    });

    // 点外部关闭下拉
    this.host.ownerDocument.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.sr-dropdown')) {
        this.dropdownEl.classList.remove('open');
      }
    });

    // 查询按钮
    const btn = this.el.querySelector('.sr-query-btn') as HTMLElement;
    btn.addEventListener('click', () => this.runQuery());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.runQuery();
    });

    // 深度检索复选框：切换 ans-label 文字（随 LLM 服务商动态显示）
    const deepCb = this.el.querySelector('.sr-deep-checkbox') as HTMLInputElement;
    deepCb.addEventListener('change', () => {
      this.deepMode = deepCb.checked;
      this.ansLabelEl.textContent = this.deepMode ? `${this.providerLabel()} 详解` : '命中笔记';
    });

    // 复制路径按钮：把当前所有高亮节点的 _filePath 复制到剪贴板（每行一个）
    const copyBtn = this.el.querySelector('.sr-copy-paths') as HTMLButtonElement;
    if (copyBtn) {
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const g6Data = this.view.g6Data;
        if (!g6Data) {
          new Notice('图谱未就绪，无节点可复制', 3000);
          return;
        }
        // 星云视图里所有节点都是命中节点（子图只含命中节点 + 虚拟根）。
        // 排除虚拟根(__query_root__)，取所有有 _filePath 的节点。
        const paths = Array.from(new Set(
          g6Data.nodes
            .filter((n: any) => n.id !== '__query_root__' && n._filePath)
            .map((n: any) => n._filePath as string)
        ));
        if (!paths.length) {
          new Notice('当前无高亮节点', 3000);
          return;
        }
        try {
          await navigator.clipboard.writeText(paths.join('\n'));
          new Notice(`已复制 ${paths.length} 个路径`, 3000);
        } catch {
          new Notice('复制失败，请检查浏览器剪贴板权限', 3000);
        }
      });
    }
  }

  // ============ 悬浮 orb（收起态）============
  // 收起态是一颗可拖动的小圆球：单击展开卡片，Ctrl+单击刷新图谱，按住拖动换位置。
  // orb 与卡片共享同一锚点 pos，展开/收起在原位切换，视觉连续。
  private initOrb() {
    this.orbEl = this.host.createEl("div", {
      cls: "sr-query-orb",
      attr: { "aria-label": "知识库查询（单击展开，Ctrl+单击刷新图谱）" },
    });
    this.orbEl.innerHTML =
      `<svg class="sr-icon" viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m21 21-4.35-4.35" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

    let drag: { px: number; py: number; ox: number; oy: number; moved: boolean } | null = null;
    this.orbEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { px: e.clientX, py: e.clientY, ox: this.pos.x, oy: this.pos.y, moved: false };
      this.orbEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.orbEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return; // 位移阈值：区分点击与拖动
      drag.moved = true;
      const rect = this.host.getBoundingClientRect();
      this.pos.x = Math.max(0, Math.min(rect.width - 40, drag.ox + dx));
      this.pos.y = Math.max(0, Math.min(rect.height - 40, drag.oy + dy));
      this.applyPos();
    });
    this.orbEl.addEventListener('pointerup', (e) => {
      const d = drag;
      drag = null;
      if (!d || d.moved) return;
      if (e.ctrlKey || e.metaKey) {
        new Notice('星环图谱刷新中…', 1500);
        this.view.rerenderGraph();
      } else {
        this.expand();
      }
    });
    this.orbEl.addEventListener('pointercancel', () => { drag = null; });

    this.collapse();
  }

  private applyPos() {
    this.orbEl.style.left = `${this.pos.x}px`;
    this.orbEl.style.top = `${this.pos.y}px`;
    this.el.style.left = `${this.pos.x}px`;
    this.el.style.top = `${this.pos.y}px`;
  }

  private expand() {
    this.orbEl.style.display = 'none';
    this.el.style.display = '';
    // 卡片宽 400px，orb 拖到右/下边缘时展开会把卡片顶出容器：按实测尺寸 clamp 回来
    const rect = this.host.getBoundingClientRect();
    this.pos.x = Math.max(0, Math.min(rect.width - this.el.offsetWidth - 8, this.pos.x));
    this.pos.y = Math.max(0, Math.min(rect.height - this.el.offsetHeight - 8, this.pos.y));
    this.applyPos();
    this.inputEl.focus();
  }

  private collapse() {
    this.el.style.display = 'none';
    this.orbEl.style.display = 'flex';
    this.applyPos();
  }

  // ============ 查询主流程 ============
  /** 当前 LLM 显示名（站点池成员名 / 服务商预设名），用于 UI 文案与错误提示。 */
  private providerLabel(): string {
    const prof = this.view.plugin.activeLlmProfile();
    if (prof?.name) return prof.name;
    const map: Record<string,string> = {
      glm: 'GLM', deepseek: 'DeepSeek', openai: 'OpenAI', claude: 'Claude', custom: 'AI',
    };
    return map[this.view.plugin.settings.llmProvider] || 'AI';
  }

  /** 确保进程内 FTS 索引已加载。未加载时尝试一次 loadFtsIndex。
   *  返回 null 表示索引不可用（调用方自行报错）。 */
  private async ensureFts() {
    const plugin = this.view.plugin;
    if (plugin.fts?.isLoaded()) {
      await plugin.fts.reloadIfStale();
      return plugin.fts;
    }
    await plugin.loadFtsIndex();
    return plugin.fts?.isLoaded() ? plugin.fts : null;
  }

  private async runQuery() {
    const q = this.inputEl.value.trim();
    // similar 模式允许空输入触发（全库扫描不依赖查询词）
    if (!q && this.mode !== 'similar') return;
    const action = ACTION_TARGET[this.mode];

    // 重新查询前先清旧高亮（避免色叠加 + _origState 丢失）
    if (this.view._queryHighlightActive) this.clearHighlight();
    this.ansBodyEl.innerHTML = `<span class="sr-ans-loading">⟳ 检索中…</span>`;
    this.hitsSummaryEl.style.display = 'none';

    // similar 模式走自己的分支：全库 LLM 扫描找冗余组，不用 FTS 召回
    if (this.mode === 'similar') {
      await this.runSimilarScan();
      return;
    }

    // 🧠 深度检索：直接走 runDeepQuery（searchDeep 搜 body + GLM 精筛）。
    // 不先跑 fts.search()——它不搜 body，结果残缺且会多渲染一次星云（闪烁）。
    if (this.deepMode) {
      await this.runDeepQuery(q);
      return;
    }

    // ⚡ 快速检索：fts.search（不搜 body，只搜属性字段）+ 高亮 + 列表
    let ftsHits: any[] = [];
    try {
      const fts = await this.ensureFts();
      ftsHits = fts ? fts.search(q) : [];
    } catch (e: any) {
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-text-dim,#c6a6a2)">FTS 检索失败：${e.message}（请在设置 → 检索管理 → 重建索引）</span>`;
      return;
    }

    // 提取实体名（标题）给图谱高亮（过滤导航节点 is_leaf=0：导航是聚合 tags 空壳，进星云只有干扰）
    const entityNames = ftsHits.filter((h: any) => h.is_leaf !== 0).map((h: any) => h.title).filter(Boolean);
    const ftsHitPaths = new Set(ftsHits.map((h: any) => h.path).filter(Boolean));
    await this.applyHighlight(entityNames, this.mode, q, ftsHitPaths);
    this.renderFtsResults(ftsHits);
  }

  // 渲染命中笔记列表——用结构扩展后的 finalMap 对应的 G6 节点，和星云高亮完全一致
  private renderFtsResults(hits: any[]) {
    // 从 _lastFinalMap 取最终命中节点（和星云视图同源），否则退化到 FTS 原始命中
    const g6Data = this.view._fullG6Data || this.view.g6Data;
    const finalMap = this._lastFinalMap;
    let nodes: any[] = [];
    if (g6Data && finalMap && finalMap.size > 0) {
      // 按 rank 排序（最相关在前），和星云中心化逻辑一致
      nodes = g6Data.nodes
        .filter(n => finalMap.has(n.id))
        .sort((a, b) => (finalMap.get(a.id) ?? 999) - (finalMap.get(b.id) ?? 999));
    } else {
      if (!hits.length) {
        this.ansBodyEl.innerHTML = `<span style="color:var(--sr-info-text,#96A0AB)">未命中。换个关键词试试。</span>`;
        return;
      }
      // 退化：FTS 原始命中（无图谱数据时）。同样过滤导航（is_leaf=0）
      const typeLabel: Record<string,string> = { moc:'MOC', flash:'Flash', error:'错题' };
      const visibleHits = hits.filter((h: any) => h.is_leaf !== 0);
      if (!visibleHits.length) {
        this.ansBodyEl.innerHTML = `<span style="color:var(--sr-info-text,#96A0AB)">未命中。换个关键词试试。</span>`;
        return;
      }
      const subtypeBadge: Record<string,string> = { know_what:'是什么', know_how:'怎么做', know_why:'为什么' };
      const html = visibleHits.slice(0, 10).map((h: any) => {
        const type = typeLabel[h.kind] || h.kind;
        const sub = h.subtype ? ` · ${subtypeBadge[h.subtype] || h.subtype}` : '';
        const chap = h.chapter ? `<span class="sr-hit-chap">第${h.chapter}章</span> ` : '';
        const topic = h.topic ? `<span class="sr-hit-topic">${this.escapeHtml(h.topic)}</span>` : '';
        return `<div class="sr-hit-item">
          <div class="sr-hit-title">${chap}${this.escapeHtml(h.title)}</div>
          <div class="sr-hit-meta">${type}${sub} ${topic}</div>
        </div>`;
      }).join('');
      this.ansBodyEl.innerHTML = `<div class="sr-hits-list">${html}</div>`;
      return;
    }
    if (!nodes.length) {
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-info-text,#96A0AB)">未命中。换个关键词试试。</span>`;
      return;
    }
    // 节点 → 命中列表项。type 从 level 推（2=MOC, 3=Flash, 4=错题），chapter 从 chapterId 查父章节名
    const nodeById = new Map(g6Data.nodes.map(n => [n.id, n]));
    const typeOfLevel: Record<number, string> = { 2: 'MOC', 3: 'Flash', 4: '错题' };
    const chapNameCache = new Map<string, string>();
    const getChapName = (chapterId: string): string => {
      if (chapNameCache.has(chapterId)) return chapNameCache.get(chapterId)!;
      const chapNode = nodeById.get(chapterId);
      // 章节节点 label 通常形如 "2.极限与连续"，取数字部分当章号
      const m = (chapNode?.label || '').match(/^(\d+)/);
      const name = m ? m[1] : '';
      chapNameCache.set(chapterId, name);
      return name;
    };
    const html = nodes.slice(0, 20).map(n => {
      const lvl = n.level ?? 0;
      const type = typeOfLevel[lvl] || '';
      const chapNum = getChapName(n.chapterId || '');
      const chap = chapNum ? `<span class="sr-hit-chap">第${chapNum}章</span> ` : '';
      return `<div class="sr-hit-item">
        <div class="sr-hit-title">${chap}${this.escapeHtml(n.label || '')}</div>
        <div class="sr-hit-meta">${type}</div>
      </div>`;
    }).join('');
    this.ansBodyEl.innerHTML = `<div class="sr-hits-list">${html}</div>`;
  }

  // GLM 改写 query：把用户自然语言查询拆成 3-8 个关键词，喂给 FTS5 做多词 OR 召回。
  // 关键：把库里真实标题表喂给 GLM，让它参考真实术语（不凭空编造）。
  // 失败直接 throw，由 runDeepQuery catch 后报错退出（用户决定不降级）。
  private async rewriteQuery(q: string): Promise<string[]> {
    // 拉取术语表（首次查询缓存，之后复用；进程内 FtsIndex.terms()，零网络）
    if (!this._termsCache) {
      const fts = await this.ensureFts();
      if (!fts) {
        throw new Error(`FTS 索引未加载。请在设置 → 检索管理 → 重建索引`);
      }
      this._termsCache = fts.terms();
      if (!this._termsCache.length) {
        throw new Error(`FTS 索引为空。请在设置 → 检索管理 → 重建索引`);
      }
    }
    // 拼术语表文本（标题 + topic，压缩成一行一条）
    const termsText = this._termsCache
      .map((t: any, i: number) => `${i+1}. ${t.title}${t.topic ? `（${t.topic}）` : ''}`)
      .join('\n')
      .slice(0, 6000); // 截断防 token 爆炸（238 张约 4000 字）

    const userPrompt = `用户查询："${q}"

知识库真实存在的知识点标题（只能参考这些，不要编造标题里没有的词）：
${termsText}

从用户查询中提取 3-8 个搜索关键词，用于在知识库里检索。关键词要：
- 覆盖查询的核心概念（如"导数""极限"）
- 包含库里标题可能出现的同义词/相关术语（如"瞬时变化率""切线斜率"）
- 必须是标题里真实存在的或高度可能出现的词

严格输出 JSON（不要 markdown 代码块）：
{"keywords": ["词1", "词2", ...]}`;

    // 站点池故障转移：失败（限流/欠费/网络错误）自动切下一个站点
    const resp = await this.view.plugin.llmChat({
      messages: [
        { role: "system", content: "你是数学学习助手，擅长把用户的自然语言查询拆解成检索关键词。" },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    if (resp.status === 0) throw new Error(`请求失败：${resp.error}`);
    if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
    const content = resp.json?.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('返回非 JSON');
    const parsed = JSON.parse(m[0]);
    const kws = Array.isArray(parsed.keywords) ? parsed.keywords.filter((x:any) => typeof x === 'string' && x.trim()) : [];
    if (!kws.length) throw new Error('返回空关键词');
    return kws.slice(0, 8);
  }

  // 深度检索：GLM 改写 query → FTS 种子 → 属性扩展 → GLM 精筛 10 张 + 答案 + 使用说明
  // 不调 LightRAG，直调 LLM API（OpenAI 兼容格式）
  private async runDeepQuery(q: string) {
    const prov = this.providerLabel(); // UI 文案随站点池当前站点变化

    // 秒计数器：显示当前步骤编号 + 阶段名，让用户清楚卡在哪一步
    const startTime = Date.now();
    const timerEl = document.createElement('span');
    timerEl.className = 'sr-ans-loading';
    const tickTimer = (step: string, phase: string) => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      timerEl.innerHTML = `⟳ ${step} ${phase} <span style="opacity:0.6">${sec}s</span>`;
    };
    tickTimer('[1/3]', `${prov} 分析意图中`);
    this.ansBodyEl.innerHTML = '';
    this.ansBodyEl.appendChild(timerEl);
    const timer = window.setInterval(() => tickTimer('[1/3]', `${prov} 分析意图中`), 500);

    // ===== Step 1/3: LLM 改写 query（把整句拆成关键词，喂给 FTS 做多词召回）=====
    if (!this.view.plugin.llmReady()) {
      window.clearInterval(timer);
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-text-dim,#c6a6a2)">深度检索需要至少一个已配置 Key 的站点（设置 → 检索管理 → 站点池）</span>`;
      return;
    }
    let keywords: string[] = [];
    try {
      keywords = await this.rewriteQuery(q);
    } catch (e: any) {
      window.clearInterval(timer);
      const msg = e.message.includes('429')
        ? `${prov} 调用被限流（429），请等几秒后重试。`
        : `${prov} 改写失败：${e.message}`;
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-text-dim,#c6a6a2)">${msg}<br><span style="font-size:11px;opacity:0.7">失败步骤：[1/3] ${prov} 分析意图</span></span>`;
      return;
    }

    // ===== Step 2/3: FTS 种子 + 属性扩展（用 GLM 改写的关键词做多词 OR 召回）=====
    window.clearInterval(timer);
    const timer2 = window.setInterval(() => tickTimer('[2/3]', 'FTS 种子 + 属性扩展中'), 500);
    let seeds: any[] = [];
    let candidates: any[] = [];
    try {
      tickTimer('[2/3]', 'FTS 种子 + 属性扩展中');
      const fts = await this.ensureFts();
      if (!fts) throw new Error('FTS 索引未加载（请在设置 → 检索管理 → 重建索引）');
      const deep = fts.searchDeep(q, { mode: this.mode, keywords });
      seeds = deep.seeds || [];
      candidates = deep.candidates || [];
    } catch (e: any) {
      window.clearInterval(timer2);
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-text-dim,#c6a6a2)">FTS 检索失败：${e.message}<br><span style="font-size:11px;opacity:0.7">失败步骤：[2/3] FTS 种子召回</span></span>`;
      return;
    }

    // 种子秒高亮（不等 GLM，让用户立刻看到结果）。过滤导航（is_leaf=0）：种子保留喂 GLM，但高亮只显示叶子
    const seedTitles = seeds.filter((s: any) => s.is_leaf !== 0).map((s: any) => s.title).filter(Boolean);
    if (seedTitles.length) {
      await this.applyHighlight(seedTitles, this.mode, undefined, undefined, false, false, 'seed');
      tickTimer('[2/3]', `种子 ${seedTitles.length} 张已高亮`);
    } else {
      window.clearInterval(timer2);
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-info-text,#96A0AB)">未命中。换个关键词试试。</span>`;
      return;
    }

    // ===== Step 2: 拼 GLM 候选清单（带 body 全文）+ 调 GLM 精筛 =====
    // 标题和元数据分行，避免 GLM 把类型标注当标题一部分返回（如「泰勒公式展开（moc）」）
    const candText = [...seeds, ...candidates]
      .filter((c, i, arr) => arr.findIndex(x => x.title === c.title) === i) // 去重
      .map((c: any, i: number) => {
        const meta = [c.kind, c.subtype, c.topic].filter(Boolean).join('/');
        const body = (c.body || '').trim();
        return `【卡片${i+1}】\n标题：${c.title}\n类型：${meta || '未知'}\n正文：${body}`;
      }).join('\n\n---\n\n');

    const modePrompt: Record<string,string> = {
      concept: '你是数学辅导老师。用户在复习数学概念。你要优先帮用户找到该主题的概念总纲（MOC 卡），再补充具体的方法/公式卡。',
      method:  '你是数学辅导老师。用户在找解题方法。',
      error:   '你是数学辅导老师。用户在查错题/易错点。',
      review:  '你是数学辅导老师。用户在做专题复习。',
    };
    const sysPrompt = modePrompt[this.mode] || modePrompt.concept;

    const userPrompt = `用户问题："${q}"

以下是候选卡片，每张包含标题和完整正文。请阅读正文理解语境，判断该卡片是否真正与用户问题相关。

筛选规则：
1. 类型为 moc 的卡片是该主题的概念总纲（如"泰勒公式展开"是泰勒展开概念的纲）。只要它的标题或正文与用户问题直接相关，【必须选入】，不可遗漏。
2. 如果一张卡片的正文只是顺带提及搜索词（如例题中偶然用到某方法），但该卡的核心主题不是用户问的，应当排除。
3. 宁可多选不要漏选——漏掉用户真正需要的概念总纲是严重错误。
${candText}

请从以上候选中选出与用户问题真正相关的卡片，把所有相关的全部选出，不要自行限制数量。
重要：picks 必须是上面"标题："行的原文，不要添加任何后缀（如"（moc）""（flash）"）或修改标题内容。
并：
1. answer：50 字以内回答用户的问题
2. usage：100 字以内解释为什么选这些卡 + 它们之间有什么关系（概念递进/对比/依赖等）

严格输出 JSON（不要 markdown 代码块）：
{"answer": "...", "picks": ["标题1", "标题2", ...], "usage": "..."}`;

    let glmRaw = '';
    window.clearInterval(timer2);
    const timer3 = window.setInterval(() => tickTimer('[3/3]', `${prov} 精筛中`), 500);
    try {
      tickTimer('[3/3]', `${prov} 精筛中`);
      const resp = await this.view.plugin.llmChat({
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      });
      if (resp.status === 0) throw new Error(`请求失败：${resp.error}`);
      if (resp.status >= 400) throw new Error(`${prov} HTTP ${resp.status}`);
      glmRaw = resp.json?.choices?.[0]?.message?.content || '';
    } catch (e: any) {
      window.clearInterval(timer3);
      const msg = e.message.includes('429')
        ? `${prov} 精筛被限流（429），种子高亮已保留，请等几秒后重新查询。`
        : `${prov} 精筛失败：${e.message}`;
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-text-dim,#c6a6a2)">${msg}<br><span style="font-size:11px;opacity:0.7">失败步骤：[3/3] ${prov} 精筛（种子高亮已保留）</span></span>`;
      return;
    }
    window.clearInterval(timer3);

    // ===== 解析 GLM JSON，用 picks 重新高亮 =====
    const parsed = this.parseGLMJson(glmRaw);
    const answer = parsed.answer || '（无答案）';
    const usage = parsed.usage || '';
    const picks: string[] = Array.isArray(parsed.picks) ? parsed.picks.filter((x:any) => typeof x === 'string') : [];

    // 渲染：picks 用纯文本（标题列表），answer + usage 用 MarkdownRenderer（支持 LaTeX/列表/加粗）
    this.ansBodyEl.innerHTML = '';
    const answerEl = this.ansBodyEl.createDiv({ cls: 'sr-ans-answer' });
    // ponytail: MarkdownRenderer.renderMarkdown 异步，支持 $...$/$$...$$ 数学公式和 Markdown 语法
    // this.view 是 ItemView（继承 Component），作为 renderMarkdown 的 component 参数
    await MarkdownRenderer.renderMarkdown(answer, answerEl, '', this.view as any);
    if (picks.length) {
      this.ansBodyEl.createDiv({
        cls: 'sr-ans-picks',
        text: `精筛 ${picks.length} 张：${picks.join('、')}`,
      });
    }
    if (usage) {
      const usageEl = this.ansBodyEl.createDiv({ cls: 'sr-ans-usage' });
      await MarkdownRenderer.renderMarkdown(usage, usageEl, '', this.view as any);
    }

    // 用 GLM picks 重新高亮——不调 clearHighlight（会 exitFocus 回全局导致闪烁）。
    // skipTypeFilter: GLM 已语境精筛，跳过模式类型过滤。
    // skipFade: 已在星云态（种子渲染的），直接重建不淡出淡入。
    if (picks.length) {
      await this.applyHighlight(picks, this.mode, undefined, undefined, true, true, 'GLM-picks');
    }
  }

  // 相似卡片扫描：全库清单喂 LLM → 找出重合度 ≥50% 的卡片组 → 图谱高亮 + Markdown 预览 + 一键复制合并 prompt
  // 产出三合一：① 图谱高亮所有冗余卡（review mode 全套扩展）② 答案面板渲染冗余组详情 ③ 复制按钮导出外部 AI prompt 包
  private async runSimilarScan() {
    const prov = this.providerLabel();

    // 强制深度模式（相似扫描必须有 LLM）
    if (!this.deepMode) {
      this.deepMode = true;
      const cb = this.el.querySelector('.sr-deep-checkbox') as HTMLInputElement;
      if (cb) cb.checked = true;
      this.ansLabelEl.textContent = `${prov} 详解`;
    }

    if (!this.view.plugin.llmReady()) {
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-text-dim,#c6a6a2)">找相似卡需要至少一个已配置 Key 的站点（设置 → 检索管理 → 站点池）</span>`;
      return;
    }

    // ===== Step [1/4]: 拉全库清单 =====
    const startTime = Date.now();
    const timerEl = document.createElement('span');
    timerEl.className = 'sr-ans-loading';
    const tickTimer = (step: string, phase: string) => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      timerEl.innerHTML = `⟳ ${step} ${phase} <span style="opacity:0.6">${sec}s</span>`;
    };
    tickTimer('[1/4]', `${prov} 扫描全库中`);
    this.ansBodyEl.innerHTML = '';
    this.ansBodyEl.appendChild(timerEl);
    const timer = window.setInterval(() => tickTimer('[1/4]', `${prov} 扫描全库中`), 500);

    let terms: any[] = [];
    try {
      const fts = await this.ensureFts();
      if (!fts) throw new Error('FTS 索引未加载（请在设置 → 检索管理 → 重建索引）');
      terms = fts.terms();
      if (!terms.length) throw new Error('FTS 索引为空');
    } catch (e: any) {
      window.clearInterval(timer);
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-text-dim,#c6a6a2)">${prov} 扫描失败：${e.message}<br><span style="font-size:11px;opacity:0.7">失败步骤：[1/4] 拉取全库清单</span></span>`;
      return;
    }

    // 拼全库清单（标题 | kind | topic | tags）
    const termsText = terms
      .map((t: any, i: number) => `${i+1}. ${t.title} | ${t.kind || ''} | ${t.topic || ''}`)
      .join('\n');

    // ===== Step [2/4]: 调 LLM 粗筛冗余组（仅凭标题/topic，宁多勿漏）=====
    window.clearInterval(timer);
    const timer2 = window.setInterval(() => tickTimer('[2/4]', `${prov} 粗筛冗余组中`), 500);

    const sysPrompt = '你是知识库整理助手，专门识别内容高度重合的冗余卡片。你的输出会被直接用于卡片合并任务，必须严格按 JSON 格式输出。';

    const userPrompt = `扫描下方完整的知识库卡片清单，找出知识点重合度 ≥ 50% 的卡片组（每组 2-4 张）。

完整卡片清单（每行格式：序号. 标题 | 类型 | topic）：
${termsText}

判定标准：
- 相同的数学概念（如「极限」「导数定义」被多张卡分别讲解）
- 相同的题型套路（如「求极限的洛必达法则」被多张卡重复示范）
- 相同的解题方法（如「泰勒展开」被多张卡用相同例子说明）
- 可合并的近义表述（如「函数极限的性质」和「极限计算性质」实际讲一件事）
- 逐对扫描，不要漏判；宁可多报几组让用户筛选，也不要遗漏

对每组输出（关键：card_indices 必须是清单里的序号数字，不要复述标题文字）：
- card_indices：组内所有卡片的清单序号（如 [12, 45, 89]）
- overlap_percent：估计的内容重合百分比（50-95）
- shared_concepts：详细列出共享的核心知识点（3-5 个，具体到概念名）
- merge_suggestion：详细的合并方案 —— 保留哪张为主卡（用清单序号指代，如"以清单第 12 张为主卡"，不要用 #NN 写法）、把其他卡的哪些段落并入主卡的哪个位置、合并后建议的新标题、为什么这样合（段落级描述，不限字数）。注意：此方案仅基于标题和 topic 的粗判，最终是否合并须由执行方读全文后自行核实
- keep_separate：true=表面重合但实际不应合并（如同一概念的不同深度讲解）；false=建议合并

严格输出 JSON（不要 markdown 代码块）：
{"groups": [{"card_indices": [12, 45], "overlap_percent": 70, "shared_concepts": "...", "merge_suggestion": "...", "keep_separate": false}], "summary": "整体冗余度评估 + 合并后预计减少的卡片数"}`;

    let glmRaw = '';
    try {
      tickTimer('[2/4]', `${prov} 粗筛冗余组中`);
      const resp = await this.view.plugin.llmChat({
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      });
      if (resp.status === 0) throw new Error(`请求失败：${resp.error}`);
      if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
      glmRaw = resp.json?.choices?.[0]?.message?.content || '';
    } catch (e: any) {
      window.clearInterval(timer2);
      const msg = e.message.includes('429')
        ? `${prov} 被限流（429），请等几秒后重试。`
        : `${prov} 粗筛失败：${e.message}`;
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-text-dim,#c6a6a2)">${msg}<br><span style="font-size:11px;opacity:0.7">失败步骤：[2/4] ${prov} 粗筛冗余组</span></span>`;
      return;
    }
    window.clearInterval(timer2);

    // ===== 解析粗筛结果 + 序号反查（反查前移到精读前，精读需要 paths 取 body）=====
    const parsed = this.parseSimilarJson(glmRaw);
    const groups: SimilarGroup[] = parsed.groups || [];
    const summary: string = parsed.summary || '';

    if (!groups.length) {
      this.ansBodyEl.innerHTML = `<span style="color:var(--sr-info-text,#96A0AB)">${prov} 未找出重合度 ≥50% 的卡片组。知识库当前比较干净。</span>`;
      return;
    }

    // 序号（1-based）反查 terms 数组，填充权威 titles + paths + chapters + isMoc
    // ponytail: 不依赖 LLM 复述标题（引号/破折号/LaTeX 会被改写），用序号 100% 可靠。
    // 章节归属：MOC 卡从文件名提取节点编号前缀（如 5.3.1）；Flash/Error 卡用 topic 字段。
    groups.forEach(g => {
      g.indices.forEach(idx => {
        const term = terms[idx - 1]; // 1-based → 0-based
        if (term) {
          g.titles.push(term.title);
          g.paths.push(term.path || `[路径未找到：${term.title}]`);
          g.chapters.push(extractChapter(term));
        }
      });
      // 组内只要有任一非 MOC 卡，整组按 Flash/Error 工作流提示（跨类组标 ⚠️）
      const kinds = g.indices.map(i => terms[i - 1]?.kind).filter(Boolean);
      g.isMoc = kinds.length > 0 && kinds.every(k => k === 'moc');
    });

    // ===== Step [3/4]: 逐组精读全文，判定真冗余 vs 假阳性 =====
    // ponytail: 粗筛只看标题/topic 会误报（如一元定积分 vs 二重积分都叫"奇偶性"）。
    // 精读阶段对每个候选组读全文，让 GLM 判 is_redundant；假阳性的置 keep_separate=true。
    // 失败兜底：某组 GLM 调用失败 → 不改 keep_separate，标 _refineFailed，保留进合并 prompt。
    const timer3 = window.setInterval(() => tickTimer('[3/4]', `${prov} 精读核实中`), 500);
    try {
      const fts = await this.ensureFts();
      // 一次性取所有候选组涉及的全部卡片正文
      const allPaths = Array.from(new Set(groups.flatMap(g => g.paths.filter(p => !p.startsWith('[')))));
      const bodyMap = fts ? fts.getBodiesByPaths(allPaths) : new Map<string, string>();

      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        if (g.keep_separate === true) continue; // 粗筛已标假阳性的跳过
        tickTimer('[3/4]', `${prov} 精读 ${gi+1}/${groups.length} 组`);

        // 拼该组卡片正文
        const cardTexts = g.paths.map((p, ci) => {
          const body = bodyMap.get(p) || '（正文未找到）';
          return `### 卡片 ${ci+1}：${g.titles[ci] || ''}\n路径：${p}\n章节归属：${g.chapters[ci] || '未知'}\n\n${body}`;
        }).join('\n\n---\n\n');

        const refineSys = '你是数学知识库冗余核实助手。你会看到一组卡片的完整正文，判断它们是否真的内容冗余（可合并），还是只是标题相似但分属不同章节或不同数学对象。必须严格按 JSON 格式输出。';
        const refineUser = `判断以下卡片组是否真的内容冗余（可合并为一张）。

${cardTexts}

判定标准（严格）：
- is_redundant=true：同章节 + 同数学对象 + 内容实质重合（如同一判定流程的不同表述、同一方法的步骤拆解）
- is_redundant=false：以下任一即判 false ——
  - 不同章节（章节归属不同，如一元积分 vs 二重积分、偏导数 vs 隐函数）
  - 不同数学对象（即使同名，如两张都叫"奇偶性"但一张讲函数奇偶性一张讲积分奇偶性）
  - 父子包含但子卡有独立价值（如 MOC 父卡是索引、子卡是详细内容）

只输出 JSON（不要 markdown 代码块）：
{"is_redundant": true/false, "reason": "一句话说明判定依据（如：同属积分/定积分，均讲变上限积分奇偶性判定 → true；或：分属第5章一元积分与第8章二重积分，不同数学对象 → false）"}`;

        try {
          const resp = await this.view.plugin.llmChat({
            messages: [
              { role: "system", content: refineSys },
              { role: "user", content: refineUser },
            ],
            temperature: 0.2,
            response_format: { type: "json_object" },
          });
          if (resp.status === 0 || resp.status >= 400) {
            g._refineFailed = true;
            continue;
          }
          const raw = resp.json?.choices?.[0]?.message?.content || '';
          const verdict = this.parseVerdictJson(raw);
          if (verdict.is_redundant === false) {
            g.keep_separate = true; // 假阳性，排除出合并清单
          }
          // is_redundant=true 或解析失败 → 保持原状（进入合并清单）
        } catch {
          g._refineFailed = true; // 单组失败不影响其他组
        }
      }
    } catch (e: any) {
      // 精读整体失败（如 FTS 不可用）→ 全部标 _refineFailed，降级为纯粗筛结果
      groups.forEach(g => { if (g.keep_separate !== true) g._refineFailed = true; });
    }
    window.clearInterval(timer3);

    // ===== Step [4/4]: 渲染 + 高亮 + 复制按钮 =====
    // 只处理建议合并的组（keep_separate !== true 且至少 2 张卡成功反查到标题）
    const mergeGroups = groups.filter(g => g.keep_separate !== true && g.titles.length >= 2);

    // 图谱高亮：所有冗余组涉及的卡片标题（去重）
    const allTitles = Array.from(new Set(mergeGroups.flatMap(g => g.titles).filter(Boolean)));
    if (allTitles.length) {
      if (this.view._queryHighlightActive) this.clearHighlight();
      await this.applyHighlight(allTitles, 'review');
    }

    // 答案面板渲染
    this.ansBodyEl.innerHTML = '';

    // 顶部「复制合并 prompt」按钮（只有 mergeGroups 非空才显示）
    if (mergeGroups.length) {
      const copyBtn = this.ansBodyEl.createEl('button', {
        cls: 'sr-sim-copy-btn',
        text: `复制合并 prompt（${mergeGroups.length} 组冗余）`,
      });
      copyBtn.addEventListener('click', () => {
        const prompt = this.buildMergePrompt(mergeGroups);
        navigator.clipboard.writeText(prompt).then(() => {
          const cardCnt = mergeGroups.reduce((n, g) => n + g.titles.length, 0);
          new Notice(`已复制合并 prompt（${mergeGroups.length} 组冗余，${cardCnt} 张卡）`, 3000);
        }).catch(() => {
          new Notice('复制失败，请手动选择文本复制', 3000);
        });
      });
    }

    // summary
    if (summary) {
      const sumEl = this.ansBodyEl.createDiv({ cls: 'sr-ans-usage' });
      await MarkdownRenderer.renderMarkdown(summary, sumEl, '', this.view as any);
    }

    // 逐组渲染
    mergeGroups.forEach((g, i) => {
      const groupEl = this.ansBodyEl.createDiv({ cls: 'sr-sim-group' });
      const badge = g.overlap_percent ? `<span class="sr-sim-overlap">${g.overlap_percent}%</span>` : '';
      const refineTag = g._refineFailed ? ' <span style="color:var(--sr-text-dim,#c6a6a2);font-size:11px">（精读未完成）</span>' : '';
      groupEl.createEl('div', {
        cls: 'sr-sim-group-title',
        text: `冗余组 ${i+1} ${badge}${refineTag}`,
      });
      const cardsEl = groupEl.createDiv({ cls: 'sr-sim-cards' });
      g.titles.forEach(t => cardsEl.createEl('span', { cls: 'sr-sim-card', text: t }));
      if (g.shared_concepts) {
        const sc = groupEl.createDiv({ cls: 'sr-sim-shared' });
        MarkdownRenderer.renderMarkdown(`**共享概念：** ${g.shared_concepts}`, sc, '', this.view as any);
      }
      if (g.merge_suggestion) {
        const ms = groupEl.createDiv({ cls: 'sr-sim-merge' });
        MarkdownRenderer.renderMarkdown(`**合并建议：** ${g.merge_suggestion}`, ms, '', this.view as any);
      }
    });

    // keep_separate 警告（精读判定的假阳性 + 粗筛标记的）
    const separateGroups = groups.filter(g => g.keep_separate === true || g.titles.length < 2);
    const separateCount = separateGroups.length;
    if (separateCount > 0) {
      const refined = separateGroups.filter(g => g.keep_separate === true && !g._refineFailed).length;
      const hint = refined > 0
        ? `（${refined} 组经精读核实为不同章节/对象，已排除；${separateCount - refined} 组未纳入）`
        : `（另有 ${separateCount} 组表面重合但建议保留独立，未纳入导出）`;
      this.ansBodyEl.createDiv({
        cls: 'sr-sim-separate',
        text: hint,
      });
    }
  }

  /**
   * 拼完整的外部 AI 合并 prompt 包（chapters/paths 已在 runSimilarScan 由序号反查得到）。
   * 关键设计：除文件路径与章节归属外，其余字段（重合度/共享概念/合并建议）一律降级标注
   * "初看印象（不可信）"，强制执行 AI 读全文后自行重新核实。
   */
  private buildMergePrompt(groups: SimilarGroup[]): string {
    // 检测重叠组（两组共享同一张卡），输出警示
    const pathToGroups = new Map<string, number[]>();
    groups.forEach((g, gi) => g.paths.forEach(p => {
      const arr = pathToGroups.get(p) || [];
      arr.push(gi);
      pathToGroups.set(p, arr);
    }));
    const overlapPairs = Array.from(pathToGroups.entries())
      .filter(([, gis]) => gis.length > 1)
      .map(([p, gis]) => `G${gis.map(g => g + 1).join('/')} 共享 \`${p}\``);

    const sections = groups.map((g, i) => {
      const chapters = g.chapters.map((ch, ci) => `- ${g.paths[ci]}　【${ch}】`).join('\n');

      // 章节差异预警：取各卡 chapter，检测是否同章/同节
      const distinctCh = Array.from(new Set(g.chapters));
      let chapterWarn = '';
      if (distinctCh.length > 1) {
        // MOC 卡按编号前缀比对章（第一个点之前）；Flash/Error 按 topic 整串比对
        const mocPrefixes = g.isMoc
          ? Array.from(new Set(g.chapters.map(c => c.split('.')[0])))
          : [];
        const crossChapter = g.isMoc && mocPrefixes.length > 1;
        chapterWarn = crossChapter
          ? `\n**⚠️ 章节不同，重点核查**：组内 MOC 节点前缀分属不同章（${mocPrefixes.map(p => `第${p}章`).join(' vs ')}），疑似不同数学对象，大概率应跳过，严禁直接按"重合度"硬合。`
          : `\n**⚠️ 章节不同，重点核查**：组内卡片 topic/节点前缀不完全一致（${distinctCh.join('、')}），须读全文确认是否同对象后再决定。`;
      }

      // MOC 父子编号检测（编号互为前缀关系，如 5.3.1 与 5.3.1.1）
      let parentChildHint = '';
      if (g.isMoc && distinctCh.length > 1) {
        const prefixes = g.chapters.slice().sort();
        const isParentChild = prefixes.some((p, idx) =>
          prefixes.slice(idx + 1).some(q => q.startsWith(p + '.'))
        );
        if (isParentChild) parentChildHint = '\n**编号呈父子关系**：优先查"父卡是否已逐字包含子卡全文"，若是则直接删子卡。';
      }

      // 组类型标签
      let typeTag = '';
      if (!g.isMoc) {
        const allFlash = g.paths.every(p => p.includes('/Flash/'));
        const allError = g.paths.every(p => p.includes('/Errors/'));
        if (allFlash) typeTag = 'Flash 组';
        else if (allError) typeTag = 'Errors 组';
        else typeTag = '⚠️ 跨类组（Flash+Error）';
      }

      const overlap = g.overlap_percent ? `（标注重合度 ${g.overlap_percent}%，待核实）` : '';
      const concepts = g.shared_concepts
        ? `\n- 重合度：${g.overlap_percent || '?'}%（仅标题匹配猜测，不可信）\n- 共享概念：${g.shared_concepts}`
        : '';
      const suggestion = g.merge_suggestion
        ? `\n- 合并建议：${g.merge_suggestion}`
        : '';

      return `## 候选组 ${i+1}（待核实）${typeTag ? `［${typeTag}］` : ''}\n**章节归属**：\n${chapters}${chapterWarn}${parentChildHint}\n**初看印象（不可信，必须读全文重新核实）**：${concepts}${suggestion}`;
    }).join('\n\n---\n\n');

    const overlapNote = overlapPairs.length
      ? `\n> 注意：以下候选组之间存在卡片重叠（${overlapPairs.join('；')}）。发现重叠时以覆盖更全的一组为准处理，避免对同一张卡重复操作。\n`
      : '';

    // 前言（卡片属性规范/工作流/闸门）+ 候选组任务清单
    return `${mergePreamble}

---

# 知识库卡片合并任务（候选组，待核实）

以下为本次识别的**候选组（待核实）**。除文件路径与章节归属外，其余字段均为初看印象、未经核实，**不得直接采信**。请逐张读全文后自行判断。
${overlapNote}
---
${sections}`;
  }

  // ponytail: GLM 经常在 JSON 外面包 markdown 代码块或加前后文字，提取第一个 {...}
  private parseSimilarJson(raw: string): { groups?: SimilarGroup[]; summary?: string } {
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return {};
      const obj = JSON.parse(m[0]);
      const groups: SimilarGroup[] = Array.isArray(obj.groups)
        ? obj.groups.filter((g: any) => g && Array.isArray(g.card_indices)).map((g: any) => ({
            indices: g.card_indices.filter((x: any) => typeof x === 'number' && x >= 1),
            titles: [],    // 由 runSimilarScan 反查 terms 填充
            paths: [],     // 同上
            chapters: [],  // 同上（MOC=节点前缀，Flash/Error=topic）
            isMoc: false,  // 同上
            overlap_percent: typeof g.overlap_percent === 'number' ? g.overlap_percent : 0,
            shared_concepts: typeof g.shared_concepts === 'string' ? g.shared_concepts : '',
            merge_suggestion: typeof g.merge_suggestion === 'string' ? g.merge_suggestion : '',
            keep_separate: g.keep_separate === true,
          }))
        : [];
      return {
        groups,
        summary: typeof obj.summary === 'string' ? obj.summary : '',
      };
    } catch { return {}; }
  }

  // 精读阶段 GLM 返回的冗余判定：{is_redundant, reason}
  // ponytail: 照抄 parseSimilarJson 的正则提 {...} + JSON.parse + 字段守卫套路
  private parseVerdictJson(raw: string): { is_redundant?: boolean; reason?: string } {
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return {};
      const obj = JSON.parse(m[0]);
      return {
        is_redundant: typeof obj.is_redundant === 'boolean' ? obj.is_redundant : undefined,
        reason: typeof obj.reason === 'string' ? obj.reason : '',
      };
    } catch { return {}; }
  }

  // ponytail: GLM 经常在 JSON 外面包 markdown 代码块或加前后文字，提取第一个 {...}
  // 新 schema: {answer, picks, usage}（替代旧的 extra_hits）
  private parseGLMJson(raw: string): { answer?: string; picks?: string[]; usage?: string } {
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return {};
      const obj = JSON.parse(m[0]);
      return {
        answer: typeof obj.answer === 'string' ? obj.answer : undefined,
        picks: Array.isArray(obj.picks) ? obj.picks.filter((x:any) => typeof x === 'string') : undefined,
        usage: typeof obj.usage === 'string' ? obj.usage : undefined,
      };
    } catch { return {}; }
  }

  // ponytail: GLM 输出后处理 - 砍 References/LaTeX/限长。
  // bug 修复：之前正则只砍 ### References 标题行，砍不掉下面的 - [1] xxx.md 列表项
  // 现在：从 ### References 或 ### 参考文献 关键字开始，砍掉之后所有内容
  private cleanAnswer(raw: string): string {
    let s = raw;
    // 砍掉 References 整段（标题 + 下面所有引用列表项）
    s = s.replace(/^#+\s*(References|参考文献)[\s\S]*$/m, '');
    s = s.replace(/\$\$[\s\S]*?\$\$/g, '');
    s = s.replace(/\$[^$\n]+\$/g, '');
    s = s.replace(/\n{2,}/g, '\n').trim();
    return s.slice(0, 100);
  }

  // ============ 实体匹配 + 结构扩展 + 星云视图 ============
  // query + ftsHitPaths 仅快速搜索传入：反向匹配（name.includes(stripped)）命中后做属性验证，
  // 检查节点 path 是否在 FTS 真命中集合里，不在就剔除（避免短名 MOC 如"极限"被含"极限"的标题误匹配）。
  // 深度检索/similar 传的 entityNames 已经过 LLM 精筛，不需要验证。
  // skipTypeFilter: GLM picks 已经过语境精筛，跳过模式类型过滤（concept 不再误杀 error 卡）。
  // skipFade: 种子→picks 切换时跳过淡出淡入（已在星云态，直接重建避免闪烁）。
  private async applyHighlight(entityNames: string[], mode: string, query?: string, ftsHitPaths?: Set<string>, skipTypeFilter = false, skipFade = false, sourceLabel = 'fts') {
    // 用 _fullG6Data（鱼骨裁剪前的完整数据）——鱼骨模式下 g6Data 被裁掉 level≥3 的 flash/error，
    // 导致实体匹配找不到 flash/error、结构扩展拿不到 MOC 的子节点 → 四个模式全只命中 MOC。
    const g6Data = this.view._fullG6Data || this.view.g6Data;
    if (!g6Data) {
      this.ansBodyEl.innerHTML += '<br><span style="color:var(--sr-info-text,#96A0AB);font-size:11px">（图谱未就绪，无法高亮）</span>';
      return;
    }

    // Pass 1: 实体名 → 节点 basename 三级匹配
    // 去标点规范化：GLM 返回的标题和 G6 label 可能有标点差异（「」vs ""、→vs -> 等）
    const normalize = (s: string) => s.replace(/[「」『』""''《》【】()（）\-—－·,，。！？；：\s]/g, '');
    // hitMap: id → rank（rank = 命中的 entity 在 entityNames 里的下标，越小越相关）。
    // entityNames 由调用方传入时已排序（FTS ORDER BY / GLM picks 顺序），下标即匹配度。
    const hitMap = new Map<string, number>();
    g6Data.nodes.forEach(n => {
      // 导航节点（中间节点 _isNav）不参与匹配：它们是归纳/枢纽，靠聚合 tags 命中≠相关，
      // 即使被 reverseMatch 反向匹配到也跳过。真正的知识在叶子节点。
      if (n._isNav) return;
      const label = String(n.label || '');
      // basename 去前缀（2.1.1_数列极限 → 数列极限）
      const stripped = label.replace(/^[\d.]+_/, '');
      const labelNorm = normalize(stripped);
      for (let ei = 0; ei < entityNames.length; ei++) {
        const name = entityNames[ei];
        if (!name || name.length < 2) continue;
        const nameNorm = normalize(name);
        // 前两个方向：节点名包含搜索实体名（正向匹配，精准）
        const forwardMatch = labelNorm.includes(nameNorm) || stripped.includes(name);
        // 反向匹配只在快速搜索启用（有 ftsHitPaths 验证兜底）；GLM picks / seeds 的标题即卡名，正向匹配即可，
        // 反向会误命中短名 MOC（如 pick「加减复合极限…」→ includes("极限")→ 误命中 MOC「极限」）
        const reverseMatch = !!ftsHitPaths && nameNorm.includes(labelNorm) && stripped.length >= 2;
        if (!forwardMatch && !reverseMatch) continue;

        // 反向匹配 + 有 FTS 真命中集合 → 验证：节点 path 必须在 FTS 结果里
        // （快速搜索精确度：FTS 已经在 tags/topic/body 上做了 LIKE，path 在集合里才算真命中）
        if (reverseMatch && !forwardMatch && ftsHitPaths && n._filePath) {
          if (!ftsHitPaths.has(n._filePath)) continue; // 属性不含搜索词 → 剔除
        }
        // 记录最小 rank（一个节点可能被多个 entity 命中，取最相关的）
        const cur = hitMap.get(n.id);
        if (cur === undefined || ei < cur) hitMap.set(n.id, ei);
        break;
      }
    });

    // Pass 2: 类型过滤——GLM picks 已经过语境精筛，跳过模式类型过滤
    const finalMap = skipTypeFilter ? hitMap : this.expandByStructure(g6Data, hitMap, mode).finalMap;
    this._lastFinalMap = finalMap;
    // 诊断：hitMap 里 moc 节点的匹配情况（排查 moc 被过滤问题）
    const _hitMocs = [...hitMap.entries()].map(([id, rank]) => {
      const n = g6Data.nodes.find(x => x.id === id);
      return n && (n.level ?? 0) === 2 ? { rank, label: n.label, level: n.level, isNav: n._isNav, inFinal: finalMap.has(id) } : null;
    }).filter(Boolean);
    console.log('[星环图谱] applyHighlight 诊断:', {
      source: sourceLabel,
      mode,
      entityNames,
      hitIdsSize: hitMap.size,
      finalIdsSize: finalMap.size,
      hitMap里的moc: _hitMocs,
      finalNodes: [...finalMap.entries()].sort((a,b) => a[1] - b[1]).map(([id, rank]) => {
        const n = g6Data.nodes.find(x => x.id === id);
        return n ? { rank, label: n.label, level: n.level, path: n._filePath || '' } : id;
      }),
    });

    // 用命中节点集合重建独立星云视图（替代旧的"主图谱叠高亮状态"）
    this.view._queryHighlightActive = true;
    await this.view.focusOnQueryHits(finalMap, skipFade);
  }

  // ============ 档2 结构扩展算法（对齐 plan/03-query-algorithm.md）============
  private expandByStructure(g6Data: G6Data, hitMap: Map<string, number>, mode: string): { finalMap: Map<string, number> } {
    const action = ACTION_TARGET[mode];
    // ponytail: 未知 mode（如 similar 借用 review 高亮时误传）直接返回原始命中，不做结构扩展
    if (!action) return { finalMap: new Map(hitMap) };
    const finalMap = new Map<string, number>();

    const nodeById = new Map<string, any>();
    g6Data.nodes.forEach(n => nodeById.set(n.id, n));

    // 节点类型判断：level 2=moc, 3=flash, 4=error；flash 的 subtype 从 _subtype 读
    const nodeType = (n: any): 'moc'|'flash'|'error'|'other' => {
      const lvl = n.level ?? 0;
      if (lvl === 2) return 'moc';
      if (lvl === 3) return 'flash';
      if (lvl === 4) return 'error';
      return 'other';
    };

    // 只高亮直接命中的节点——不做任何结构扩展（不爬祖先、不找兄弟、不拉父 Flash）。
    // 节点之间的连接只保留"两端都被命中"的边：由 focusCartesianLayout 按类型分带自然处理。
    // 四个模式的区别只在 Pass 1 的类型过滤：
    //   concept 只收 MOC + know_what Flash
    //   method  只收 know_how Flash
    //   error   只收 Error + know_why Flash
    //   review  全收
    hitMap.forEach((rank, id) => {
      const node = nodeById.get(id);
      if (!node) return;
      const t = nodeType(node);
      if (t === 'moc' && action.moc) finalMap.set(id, rank);
      else if (t === 'flash' && action.flashSubtypes.length > 0) {
        const sub = (node._subtype || '').toLowerCase();
        // _subtype 为空时回退到“接受所有 Flash”，避免旧数据异常
        if (!sub || action.flashSubtypes.includes(sub)) finalMap.set(id, rank);
      }
      else if (t === 'error' && action.error) finalMap.set(id, rank);
    });

    return { finalMap };
  }

  // 清除查询高亮（外部调用：点空白/Esc/重新查询时）
  // 退出查询星云视图：ESC 或重新查询时调用。委托 exitFocus 恢复全局图谱。
  clearHighlight() {
    this.hitsSummaryEl.style.display = 'none';
    if (this.view.focusMode?.isQuery) {
      this.view.exitFocus(); // async 但不 await（clearHighlight 本身非 async，退出动画在后台跑）
    } else {
      // 兜底：非星云态（如图谱刚加载还没进过星云），只清标志
      this.view._queryHighlightActive = false;
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  destroy() {
    this.clearHighlight();
    this.el.remove();
  }
}

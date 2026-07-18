// 星环图谱视图 + 渲染逻辑（AntV G6）

import { ItemView, WorkspaceLeaf } from "obsidian";
import type StarRingGraphPlugin from "./main";
import G6 from '@antv/g6';
import { buildChapterTree, convertToG6Data } from "./data";
import type { RingNode, G6Data } from "./data";

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

  // 开发期诊断:标签总数 / 引线数 / 残留碰撞数。稳定后可删。
  console.log(`[标签避让] 共 ${sorted.length} 个标签,引线 ${leaderCount} 条,残留重叠 ${collisionCount} 处`);
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

      // MOC(level 2) halo：仅当该 MOC 挂着星云(_hasCloud)才画——光环是"里面有内容"的提醒，
      // 空的 MOC 不该高亮误导。必须在 keyShape 之前 addShape，垫在下层；keyShape 仍是主形状。
      // 只用半透明 fill 做柔和光晕，不画 stroke（描边会在边缘形成一圈硬细环，视觉不好看）。
      if (level === 2 && cfg._hasCloud) {
        group.addShape('circle', {
          attrs: {
            x: 0, y: 0,
            r: size / 2 + 10,                    // 比 keyShape 大 10px，缩小后仍有可见环
            fill: cfg.style?.fill || '#4fd1c5',
            opacity: 0.35,                       // 0.18 太透，提到 0.35 保证缩小时可见
          },
          name: 'node-halo',
          draggable: false,
        });
      }

      const keyShape = group.addShape('circle', {
        attrs: {
          x: 0,
          y: 0,
          r: size / 2,
          fill: cfg.style?.fill || '#C6E5FF',
          stroke: cfg.style?.stroke || '#5B8FF9',
          lineWidth: cfg.style?.lineWidth ?? 2,
          // 光影：根/章节(level0/1)始终发光点睛；MOC(level2)只有挂星云(_hasCloud)才发光，
          // 空的 MOC 不发光，缩小后才分得清谁有星团。碎片/错题(level≥3)无 shadow。
          shadowColor: cfg.style?.shadowColor,
          shadowBlur: (level === 0 || level === 1 || (level === 2 && cfg._hasCloud))
            ? (cfg.style?.shadowBlur ?? 0) : 0,
        },
        name: 'node-circle',
      });

      const fontSize = level > 2 ? 8 : 10; // 碎片/错题节点小，字号也收一档
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
            fill: labelFill,
            opacity: 1,
            fontFamily: 'system-ui, -apple-system, sans-serif',
          },
          name: 'node-label',
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
            draggable: false,
          });
        }
        group.addShape('text', {
          attrs: {
            x: c.dx, y: c.dy,  // 相对节点中心的偏移
            text: label,
            textAlign: c.ax,
            textBaseline: c.ay,
            fontSize: c.fs,
            fill: labelFill,
            opacity: 1,
            fontFamily: 'system-ui, -apple-system, sans-serif',
          },
          name: 'node-label',
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
            fill: labelFill,
            opacity: 1,
            fontFamily: 'system-ui, -apple-system, sans-serif',
          },
          name: 'node-label',
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

// 右键拖动画布：G6 自带 drag-canvas 硬绑左键 + HTML5 drag 事件（右键永不触发），
// 所以写一个自定义 behavior，监听 mouse 事件并过滤 button===2（右键）。
// 必须持续按住右键才拖：onMouseMove 用 buttons & 2 校验右键当前确实按着，
// 松开瞬间 buttons 归零，立即停止 —— 不依赖 mouseup（右键 mouseup 易被 contextmenu 流程吞掉）。
// 扩展：按住 Alt + 右键拖动，松手时触发"聚焦视野中心最近 MOC"（onAltRightDrop 回调）
const registerRightDrag = (onAltRightDrop?: () => void) => {
  G6.registerBehavior('drag-canvas-right', {
    getEvents() {
      return {
        mousedown: 'onMouseDown',
        mousemove: 'onMouseMove',
        mouseup: 'onMouseUp',
        'canvas:mouseleave': 'onMouseUp',
      };
    },
    onMouseDown(e: any) {
      if (!e.originalEvent || e.originalEvent.button !== 2) return; // 只认右键按下
      e.originalEvent.preventDefault?.(); // 阻止 contextmenu 流程启动，mouseup 不被吞
      this.origin = { x: e.clientX, y: e.clientY };
      this._altHeldAtDown = !!(e.originalEvent as MouseEvent).altKey; // 记录按下时是否按着 Alt
    },
    onMouseMove(e: any) {
      if (!this.origin) return;
      // 关键：校验右键"现在还按着"。buttons 是位掩码，bit2(=2)=右键。松开后 buttons=0 → 立即终止。
      const buttons = e.originalEvent?.buttons ?? 0;
      if (!(buttons & 2)) { this.origin = null; return; }
      const dx = e.clientX - this.origin.x;
      const dy = e.clientY - this.origin.y;
      this.origin = { x: e.clientX, y: e.clientY };
      this.graph.translate(dx, dy, false);
    },
    onMouseUp(e: any) {
      // Alt+右键松手：触发聚焦视野中心最近 MOC
      if (this._altHeldAtDown && onAltRightDrop) {
        onAltRightDrop();
      }
      this.origin = null;
      this._altHeldAtDown = false;
    },
  });
};

export class StarRingView extends ItemView {
  plugin: StarRingGraphPlugin;
  graph: any = null;
  container: HTMLElement | null = null;
  ctrlHeld = false; // 按住 Ctrl 时锁定链路高亮（阻止 activate-relations 的 deactivate）
  _cleanupKeyListeners: (() => void) | null = null;
  g6Data: G6Data | null = null;           // 供 dblclick 折叠 BFS 用（修原 this.g6Data 未赋值 bug）
  focusMode: { mocId: string } | null = null; // Alt+点击进入的聚焦模式（双画布：聚焦态=sector 子图）
  private _resizeObserver: ResizeObserver | null = null; // 监听容器尺寸，变化时同步画布
  private _resizeFitTimer: any = null;    // 防抖：resize 后延迟 fitView，避免拖动分隔条时频繁重排
  private _currentTree: RingNode | null = null;   // 最近一次渲染的全局树，聚焦退出时回到它
  private _currentLayout: 'fishbone' | 'sector' = 'fishbone'; // 当前布局，供 wheel 事件判断
  private _cleanupWheel: (() => void) | null = null; // 重渲染前移除旧 wheel 监听
  private _rendering = false; // renderGraph 进行中/刚结束，抑制 ResizeObserver 的 fitView 抢占视角
  private _focusReturnTree: RingNode | null = null; // 进入聚焦前的全局树备份，exitFocus 用
  private _preFocusMatrix: number[] | null = null;  // 进入聚焦前的视图矩阵 [a,b,c,d,e,f]，退出时恢复

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
      if (e.key === 'Escape' && this.focusMode) this.exitFocus(); // Esc 退出聚焦
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
      const treeData = await buildChapterTree(this.app, this.plugin.settings);
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
    opts?: { layoutOverride?: 'fishbone' | 'sector'; subtreeFocusId?: string; restoreMatrix?: number[] },
  ) {
    this._rendering = true; // 抑制 ResizeObserver 的 fitView，避免重建画布时覆盖已设的视角
    // 读主题色(CSS 变量 → JS,G6 canvas 不读 CSS)
    const labelFill = readThemeVar(container, '--sr-label-fill', '#e6edf3');
    const edgeColor = readThemeVar(container, '--sr-edge', '#7aa8d4');
    const auxEdgeColor = readThemeVar(container, '--sr-aux-edge', '#9bb3d1');
    const hoverShadow = readThemeVar(container, '--sr-hover-shadow', '#fff');
    const hoverEdge = readThemeVar(container, '--sr-hover-edge', '#a78bfa');
    // 注册自定义节点类型 + 右键拖拽 behavior（右键拖动画布仍保留；Alt+右键聚焦已删，回调不传）
    registerWrappedLabelNode({ labelFill });
    registerRightDrag();

    // 记下全局树，供聚焦退出回到它
    if (!opts?.subtreeFocusId) this._currentTree = treeData;

    // 转换数据格式
    const fullData: G6Data = convertToG6Data(treeData);

    // 聚焦态：裁出该 MOC 子树并重标 level，让 starRingSectorLayout 正确分扇区
    //   MOC → level 0（sector 靠 level===0 找根居中）
    //   结构子节点（原 level===2 的 moc2/moc3）→ 按相对树深度重标为 depth+1（深度1→2, 深度2→3），
    //     这样 sector 的 structuralKids(level<=2) 把它们画进环；
    //   叶子（原 level>=3 的 Frag/Error）→ 保持原 level>=3，走 collectDetails 星团。
    //   不重标会导致子节点掉进 orphan 兜底横排，不是星环。
    let g6Data = fullData;
    if (opts?.subtreeFocusId) {
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
          if (n.id === mocId) return { ...n, level: 0 };
          if ((n.level ?? 0) >= 3) return n; // 叶子保持原 level，走星团
          const d = depthOf.get(n.id);
          return { ...n, level: d !== undefined ? d + 1 : 2 }; // 结构节点按深度重标（深度1→2）
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

    // 销毁现有图谱实例（先移除旧 wheel 监听，避免指向已销毁 canvas 的悬空引用）
    if (this._cleanupWheel) { this._cleanupWheel(); this._cleanupWheel = null; }
    if (this.graph) {
      this.graph.destroy();
    }

    // 初始化 G6 图谱
    this.graph = new G6.Graph({
      container: container,
      width: width,
      height: height,
      fitView: false, // 渲染后按布局手动设初始视角（鱼骨聚焦根节点可读缩放、旭日图 fitView 全图）
      fitViewPadding: 40,
      minZoom: 0.02, // 允许 fitView 在旭日图全图时缩更小（原 0.1 导致大图 fitView 失败警告）
      maxZoom: 3,
      
      // 交互模式
      modes: {
        default: [
          'drag-canvas-right', // 右键拖动画布（自定义 behavior）
          {
            // 缩放：旭日图布局下普通滚轮即缩放。
            // 鱼骨布局下完全禁用 zoom-canvas（shouldBegin 恒返回 false），滚轮由 DOM wheel handler 接管：
            // 无 Alt 平移、Alt 缩放。两套机制互斥，避免与 G6 监听器的触发顺序竞争。
            type: 'zoom-canvas',
            shouldBegin: () => this._currentLayout !== 'fishbone',
          },
          'drag-node',
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

    // 辅连线样式覆盖：aux 边（Flash/Error 多挂载的辅助连线）用虚线，
    // 比父子结构边弱（细、淡）但仍可见，区别于主结构实线。位置由主挂决定，aux 不参与布局。
    g6Data.edges.forEach(e => {
      if (e.relation === 'aux') {
        e.style = { ...(e.style || {}), stroke: auxEdgeColor, lineWidth: 0.8, opacity: 0.45, lineDash: [3, 3] };
      }
    });

    // 加载数据并渲染
    this.graph.data(g6Data);
    this.graph.render();

    // 初始视角：退出聚焦时恢复进入前保存的视图矩阵；否则按布局设默认视角
    if (opts?.restoreMatrix && Array.isArray(opts.restoreMatrix) && opts.restoreMatrix.length >= 6) {
      this.graph.get('group').setMatrix(opts.restoreMatrix.slice());
      this.graph.get('group').set('lazyCheckSize', false);
    } else {
      this.resetViewport(container, true);
    }
    // 延迟解除渲染抑制：必须晚于 ResizeObserver 的 200ms 防抖窗口，
    // 让重建画布触发的尺寸变化 fitView 被吞掉，不覆盖刚设好的视角
    setTimeout(() => { this._rendering = false; }, 400);

    // 鱼骨布局专属滚轮行为：无 Alt 时上下平移（保持当前缩放比例）；Alt 时手动缩放。
    // 统一在 DOM 层处理，不依赖 G6 zoom-canvas 与本监听器的触发顺序（两者都注册在 canvas 上，顺序不可靠）。
    // 旭日图布局滚轮即缩放（由 zoom-canvas 处理），这里直接 return。
    const wheelHandler = (e: WheelEvent) => {
      if (this._currentLayout !== 'fishbone') return; // 旭日图交给 zoom-canvas
      if (!this.graph || this.graph.destroyed) return;
      e.preventDefault();
      if (e.altKey) {
        // Alt+滚轮：以鼠标位置为中心缩放。G6 zoomTo 的 ratio 是绝对值，需算出目标 zoom。
        const curZoom = this.graph.getZoom ? this.graph.getZoom() : 1;
        const ratio = e.deltaY < 0 ? 1.1 : 1 / 1.1; // 向上滚放大，向下滚缩小
        const newZoom = Math.max(0.1, Math.min(3, curZoom * ratio));
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
      if (this._rendering) return;
      // 防抖 fitView：拖动分隔条会连续触发多次，只在停下后重排一次
      if (this._resizeFitTimer) clearTimeout(this._resizeFitTimer);
      this._resizeFitTimer = setTimeout(() => {
        if (this.graph && !this.graph.destroyed) {
          this.graph.fitView(40, undefined, true, { easing: 'easeCubic', duration: 300 });
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

    this.graph.on('node:mouseleave', () => {
      if (this.ctrlHeld) return; // Ctrl 锁定：移出不清
      if (!this.graph || this.graph.destroyed) return;
      this.graph.getNodes().forEach((n: any) => {
        this.graph.clearItemStates(n, ['active', 'inactive']);
        setLabelVisible(n, true); // 恢复所有文字标签显示
      });
      this.graph.getEdges().forEach((e: any) => this.graph.clearItemStates(e, ['active', 'inactive']));
    });

    // 节点点击事件：自动居中放大 + 打开对应笔记
    // ponytail: 单击/双击共用 canvas，用 220ms 延迟区分 —— 双击时取消单击的打开动作
    let clickTimer: any = null;
    this.graph.on('node:click', (evt) => {
      const node = evt.item;
      const model = node?.getModel();
      if (!model) return;

      // Alt+左键：进入/退出聚焦模式
      //   全局画布：点 level===2 的 MOC 进入；聚焦画布里 MOC 被重标为 level0，靠 focusMode.mocId 匹配退出
      const altKey = (evt.originalEvent as MouseEvent)?.altKey;
      if (altKey) {
        if (this.focusMode?.mocId === model.id) { this.exitFocus(); return; }
        if (!this.focusMode && model.level === 2) { this.focusOnMoc(model.id); return; }
      }

      // 普通点击：自动居中并放大到该节点
      this.graph.focusItem(node, true, {
        easing: 'easeCubic',
        duration: 400,
      });
      this.graph.zoomTo(1.2, { x: model.x, y: model.y }, true, {
        easing: 'easeCubic',
        duration: 400,
      });

      // 打开对应笔记：延迟，若 220ms 内双击则取消（留给折叠动作）
      const filePath = model._filePath;
      if (filePath) {
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          this.app.workspace.openLinkText(filePath, "");
          clickTimer = null;
        }, 220);
      }
    });
    
    // 空白处点击：聚焦模式下退出，否则重置到可读视角
    this.graph.on('canvas:click', () => {
      if (this.focusMode) { this.exitFocus(); return; }
      this.resetViewport(this.container!, false); // false = 无动画（点击重置要快）
    });

    // 双击节点：折叠/展开所有后代（含连线同步隐藏）
    // ponytail: 折叠状态挂在 model.collapsed，不另建状态机；后代用 edges 做 BFS，不重建父子表
    this.graph.on('node:dblclick', (evt) => {
      const node = evt.item;
      if (!node) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } // 取消单击的打开动作
      const model = node.getModel();
      const collapsed = !model.collapsed;
      model.collapsed = collapsed;

      // BFS 沿 tree 边收集所有后代 id（排除 aux 辅连线，避免环和误折叠）
      const dblEdges = (this.g6Data.edges as any[]).filter(e => e.relation !== 'aux');
      const childToParent = new Map<string, string>(); // child -> 直接 source
      dblEdges.forEach(e => childToParent.set(e.target, e.source));
      const descendants = new Set<string>();
      const queue: string[] = [];
      dblEdges.forEach(e => {
        if (e.source === model.id) queue.push(e.target);
      });
      while (queue.length) {
        const cur = queue.shift()!;
        if (descendants.has(cur)) continue;
        descendants.add(cur);
        dblEdges.forEach(e => {
          if (e.source === cur) queue.push(e.target);
        });
      }

      // 切换后代可见性
      descendants.forEach(id => {
        const item = this.graph.findById(id);
        if (item) this.graph.updateItem(item, { visible: !collapsed });
      });

      // 边同步：任一端点不可见则隐藏
      this.graph.getEdges().forEach(edge => {
        const sModel = edge.getSource()?.getModel();
        const tModel = edge.getTarget()?.getModel();
        if (!sModel || !tModel) return;
        const sVisible = sModel.visible !== false;
        const tVisible = tModel.visible !== false;
        this.graph.updateItem(edge, { visible: sVisible && tVisible });
      });
    });

    // Minimap 点击跳转(在所有 plugin 注册 + render 之后挂载)
    this.attachMinimapClick();
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
        const matrix = this.graph.get('group').getMatrix() || [1,0,0,1,0,0];
        const zoom = matrix[0];
        const dx = (rootModel.x * zoom) - 60;  // 根节点投影到视口左边 60px
        const dy = (rootModel.y * zoom) - 60;  // 根节点投影到视口顶部 60px
        this.graph.translate(dx, dy);
      } else {
        this.graph.zoomTo(targetZoom, { x: (container.getBoundingClientRect().width) / 2, y: 0 });
      }
    } else {
      this.graph.fitView(40, undefined, true, animate ? { easing: 'easeCubic', duration: 300 } : undefined);
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

  // Alt+点击 MOC 进入聚焦：销毁鱼骨画布 → 用 sector 布局重建只含该 MOC 子树的新画布（MOC 居中）
  // 双画布切换：不再在原画布上隐藏/重排节点，聚焦态就是一张干净的 sector 子图
  private async focusOnMoc(mocId: string) {
    if (!this.graph || !this._currentTree) return;
    const gc = this.container?.querySelector('.g6-container') as HTMLElement | null;
    if (!gc) return;
    // 销毁前保存当前视图矩阵，退出聚焦时恢复（保持用户进入前的缩放/平移，而非重置）
    this._preFocusMatrix = (this.graph.get('group').getMatrix() || [1,0,0,1,0,0]).slice();
    await this.fadeCanvas(false);                 // 淡出旧画布
    this._focusReturnTree = this._currentTree;    // 备份全局树，退出用
    await this.renderGraph(gc, this._currentTree, { layoutOverride: 'sector', subtreeFocusId: mocId });
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
    this.focusMode = null;
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
    const gc = this.container?.querySelector('.g6-container') as HTMLElement | null;
    if (!gc) return;
    try {
      const treeData = await buildChapterTree(this.app, this.plugin.settings);
      this.renderGraph(gc, treeData);
    } catch (e) {
      console.error("[星环图谱] 重建失败", e);
    }
  }

  // 数据更新方法：当 Obsidian 中更新笔记时调用
  async updateGraph() {
    if (!this.container) return;
    
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

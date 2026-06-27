// 星环图谱视图 + 渲染逻辑（AntV G6）

import { ItemView, WorkspaceLeaf } from "obsidian";
import type StarRingGraphPlugin from "./main";
import G6 from '@antv/g6';
import { buildChapterTree, convertToG6Data } from "./data";
import type { RingNode, G6Data } from "./data";

export const STAR_RING_VIEW_TYPE = "star-ring-view";

// 扇区星环布局：按真实树形递归分扇区，标签长度参与角度加权，半径自适应补足弧长。
// ponytail: 旧版按子树节点数加权 → 大子树吃掉角度，长标签叶子节点（"等价无穷小、无穷大代换"等）
// 被挤到小角度 → 弧长不够放标签 → 视觉重合。改用 max(子树结构权重, 标签所需弧长) 取大者，
// 且当节点分到的弧长 < 标签需要时放大该节点半径（保角度、增弧长），彻底防标签压盖。
function starRingSectorLayout(nodes: any[], edges: any[], baseRadius = 220, minArc = 56) {
  if (nodes.length === 0) return;
  const byId = new Map<string, any>(nodes.map(n => [n.id, n]));
  const childrenOf = new Map<string, any[]>();
  edges.forEach(e => {
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    const t = byId.get(e.target);
    if (t) childrenOf.get(e.source)!.push(t);
  });

  const root = nodes.find(n => (n.level ?? 0) === 0) || nodes[0];
  root.x = 0;
  root.y = 0;

  // 结构子节点：level≤2（root/chapter/moc）。Frag/Error(level≥3) 另作星团。
  const structuralKids = (id: string) =>
    (childrenOf.get(id) || []).filter(k => (k.level ?? 0) <= 2);

  // 标签所需最小弧长（px）：字数 × 字宽 + 间隙
  const CHAR_W = 10, GAP = 6;
  const minLabelArc = (label: string) => (label || '').length * CHAR_W + GAP;

  // 子树角度权重 = max(自身标签所需弧长, 所有子节点权重之和)
  // 取 max 而非相加：长标签叶子节点不会被大子树挤压，也不会独占角度
  const wCache = new Map<string, number>();
  const subtreeWeight = (id: string): number => {
    if (wCache.has(id)) return wCache.get(id)!;
    const node = byId.get(id);
    const selfNeed = minLabelArc(node.label);
    let kidsSum = 0;
    structuralKids(id).forEach(k => { kidsSum += subtreeWeight(k.id); });
    const w = Math.max(selfNeed, kidsSum);
    wCache.set(id, w);
    return w;
  };

  // 放子树：父节点拥有角度 [a0,a1]，按子节点权重切分。
  // 半径默认按深度 baseRadius*depth；若该节点弧长 < 标签需要，放大半径补足。
  const placeSubtree = (node: any, a0: number, a1: number, depth: number) => {
    const span = a1 - a0;
    const baseR = depth === 0 ? 0 : baseRadius * depth;
    let r = baseR;
    const need = minLabelArc(node.label);
    if (depth > 0 && r * span < need) {
      r = need / span; // 放大半径补足弧长（父子连线会斜一点，可接受）
    }
    const mid = (a0 + a1) / 2;
    node.x = Math.cos(mid) * r;
    node.y = Math.sin(mid) * r;

    const kids = structuralKids(node.id);
    if (kids.length === 0) return;
    const totalW = kids.reduce((s, k) => s + subtreeWeight(k.id), 0);
    let cursor = a0;
    kids.forEach(k => {
      const w = subtreeWeight(k.id) / totalW;
      placeSubtree(k, cursor, cursor + span * w, depth + 1);
      cursor += span * w;
    });
  };

  placeSubtree(root, 0, 2 * Math.PI, 0);

  // Frag/Error 星团：每个 moc 收集其下所有 level≥3 后代（含跨层，如 Error 挂 Frag 下），围 moc 成环
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
    const r = Math.max(35, (kids.length * 10) / (2 * Math.PI));
    kids.forEach((k, i) => {
      const a = (2 * Math.PI) * (kids.length === 1 ? 0 : i / kids.length);
      k.x = (moc.x || 0) + Math.cos(a) * r;
      k.y = (moc.y || 0) + Math.sin(a) * r;
    });
  });

  // 兜底：仍未定位的孤儿节点铺到远处一行
  const orphans = nodes.filter(n => n.x === undefined && n.y === undefined);
  orphans.forEach((n, i) => { n.x = i * minArc; n.y = baseRadius * 4; });
}

// 鱼骨主干布局：level 0/1 横向铺主干，level 2(MoC) 斜下分刺，level≥3(碎片/错题) 围父节点成星团
// ponytail: 复用已有 level + _originalType，不重解析文件名；parent 从 edges 反查
function fishboneLayout(nodes: any[], edges: any[], step = 180, spurLen = 90, clusterR = 35) {
  if (nodes.length === 0) return;
  const byId = new Map<string, any>(nodes.map(n => [n.id, n]));
  // edges: source=parent, target=child
  const childrenOf = new Map<string, any[]>();
  edges.forEach(e => {
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)!.push(byId.get(e.target)!);
  });
  // 父节点表（找直接父节点 + 根节点集合）
  const parentOf = new Map<string, string>();
  edges.forEach(e => { if (byId.has(e.target)) parentOf.set(e.target, e.source); });

  // 1. 主干：level 0/1 按 nodes 数组顺序（≈文件名前缀序）从左到右铺，Y=0
  const spine = nodes.filter(n => (n.level ?? 0) <= 1);
  if (spine.length === 0) {
    // 兜底：无根/章节时把第一个节点放原点，其余随分支
    spine.push(nodes[0]);
    nodes[0].x = 0; nodes[0].y = 0;
  }
  spine.forEach((n, i) => { n.x = i * step; n.y = 0; });

  // 2. 鱼骨刺：从父节点 ±45° 延伸（MoC 节点 + 进一步嵌套的 mocN）
  // 同级子节点交替上下避免重叠；沿同方向链式递归
  const placeSpur = (node: any, fromX: number, fromY: number, dir: number, depth: number) => {
    const angle = dir > 0 ? Math.PI / 4 : -Math.PI / 4; // +45° / -45°
    const reach = spurLen + depth * (spurLen * 0.5);     // 越深刺越长，拉开层次
    node.x = fromX + Math.cos(angle) * reach;
    node.y = fromY + Math.sin(angle) * reach;
  };

  // 3. 星团：level≥3 围父节点成小圆环（密度自适应半径）
  const placeCluster = (parent: any) => {
    const kids = (childrenOf.get(parent.id) || []).filter(k => (k.level ?? 0) >= 3);
    if (kids.length === 0) return;
    const r = Math.max(clusterR, (kids.length * 8) / (2 * Math.PI));
    kids.forEach((k, i) => {
      const a = (2 * Math.PI) * (kids.length === 1 ? 0 : i / kids.length);
      k.x = (parent.x || 0) + Math.cos(a) * r;
      k.y = (parent.y || 0) + Math.sin(a) * r;
    });
  };

  // DFS：每个节点先放自己（刺），再处理 mocN 子孙（继续分刺），最后给本节点挂星团
  const visited = new Set<string>();
  const walk = (node: any, parent: any | null, dir: number, depth: number) => {
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    const lv = node.level ?? 0;
    // 非主干节点需要显式定位（主干已在 step 1 铺好）
    if (lv >= 2 && parent) {
      placeSpur(node, parent.x || 0, parent.y || 0, dir, depth);
    }
    // 子节点：MoC 系继续分刺（交替方向），碎片/错题交给星团统一放
    const mocKids = (childrenOf.get(node.id) || []).filter(k => (k.level ?? 0) === 2);
    mocKids.forEach((k, i) => walk(k, node, i % 2 === 0 ? 1 : -1, depth + 1));
    // 本节点的星团（碎片/错题）
    if (lv >= 2) placeCluster(node);
  };

  // 从每个主干节点出发
  spine.forEach(s => {
    const mocKids = (childrenOf.get(s.id) || []).filter(k => (k.level ?? 0) === 2);
    mocKids.forEach((k, i) => walk(k, s, i % 2 === 0 ? 1 : -1, 0));
    // 主干节点自己也可能直接挂碎片/错题（无 MoC 中转）
    placeCluster(s);
  });

  // 兜底：仍未定位的节点（孤儿/无父）铺到主干下方一行
  const orphans = nodes.filter(n => n.x === undefined && n.y === undefined);
  orphans.forEach((n, i) => { n.x = i * 60; n.y = 200; });
}

// 注册换行节点类型
const registerWrappedLabelNode = () => {
  G6.registerNode('wrapped-label-node', {
    draw(cfg: any, group: any) {
      const size = cfg.size || 12;
      const keyShape = group.addShape('circle', {
        attrs: {
          x: 0,
          y: 0,
          r: size / 2,
          fill: cfg.style?.fill || '#C6E5FF',
          stroke: cfg.style?.stroke || '#5B8FF9',
          lineWidth: 2,
        },
        name: 'node-circle',
      });

      const maxWidth = 100;
      const level = cfg.level || 0;
      const fontSize = level > 2 ? 8 : 10; // 碎片/错题节点小，字号也收一档
      const label = String(cfg.label || '');

      if (!label) return keyShape;

      // ponytail: level>2（碎片/错题）文字默认隐藏，由 viewportchange 的 LOD 在 zoom>=1.5 时点亮
      const labelOpacity = level > 2 ? 0 : 1;

      // 简易换行逻辑
      const words = label.split('');
      let line = '';
      const lines: string[] = [];
      for (let i = 0; i < words.length; i++) {
        const testLine = line + words[i];
        const width = testLine.length * fontSize * 0.6; // 中文字符估算
        if (width > maxWidth && i > 0) {
          lines.push(line);
          line = words[i];
        } else {
          line = testLine;
        }
      }
      lines.push(line);

      lines.forEach((l, index) => {
        group.addShape('text', {
          attrs: {
            x: 0,
            y: size / 2 + 8 + index * (fontSize + 2),
            text: l,
            textAlign: 'center',
            textBaseline: 'top',
            fontSize: fontSize,
            fill: '#e6edf3',
            opacity: labelOpacity,
            fontFamily: 'system-ui, -apple-system, sans-serif',
          },
          name: 'node-label',
        });
      });

      return keyShape;
    },
  }, 'circle');
};

// 右键拖动画布：G6 自带 drag-canvas 硬绑左键 + HTML5 drag 事件（右键永不触发），
// 所以写一个自定义 behavior，监听 mouse 事件并过滤 button===2（右键）。
// 必须持续按住右键才拖：onMouseMove 用 buttons & 2 校验右键当前确实按着，
// 松开瞬间 buttons 归零，立即停止 —— 不依赖 mouseup（右键 mouseup 易被 contextmenu 流程吞掉）。
const registerRightDrag = () => {
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
    onMouseUp() { this.origin = null; },
  });
};

export class StarRingView extends ItemView {
  plugin: StarRingGraphPlugin;
  graph: any = null;
  container: HTMLElement | null = null;
  ctrlHeld = false; // 按住 Ctrl 时锁定链路高亮（阻止 activate-relations 的 deactivate）
  _cleanupKeyListeners: (() => void) | null = null;
  g6Data: G6Data | null = null;           // 供 dblclick 折叠 BFS 用（修原 this.g6Data 未赋值 bug）
  private _detailsVisible = false;        // 语义缩放状态：碎片/错题当前是否显示
  activeMocId: string | null = null;      // 当前活跃 MOC：放大过阈值时只显它的星云（按子树分批）
  focusMode: { mocId: string } | null = null; // Alt+点击进入的聚焦模式

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
    const clearHighlight = () => {
      if (!this.graph || this.graph.destroyed) return;
      this.graph.getNodes().forEach((n: any) => this.graph.clearItemStates(n, ['active', 'inactive']));
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
    // 清理 G6 实例 + 键盘监听，防止内存泄漏
    if (this._cleanupKeyListeners) { this._cleanupKeyListeners(); this._cleanupKeyListeners = null; }
    if (this.graph) {
      this.graph.destroy();
      this.graph = null;
    }
  }

  renderGraph(container: HTMLElement, treeData: RingNode) {
    // 注册自定义节点类型 + 右键拖拽 behavior
    registerWrappedLabelNode();
    registerRightDrag();
    
    // 转换数据格式
    const g6Data: G6Data = convertToG6Data(treeData);
    this.g6Data = g6Data; // 供 dblclick 折叠 BFS 用（修原 this.g6Data 未赋值 bug）

    // 布局：设置可选 鱼骨主干 / 星环扇区，二者都直接预算 x/y 写回节点（不配 G6 layout 字段）
    const layout = this.plugin.settings.layout ?? 'fishbone';
    if (layout === 'fishbone') {
      fishboneLayout(g6Data.nodes, g6Data.edges);
    } else {
      starRingSectorLayout(g6Data.nodes, g6Data.edges, 220, 56);
    }
    // 重建后重置语义缩放状态，让首次 applyLod 重新判定
    this._detailsVisible = false;

    // 获取容器尺寸
    const rect = container.getBoundingClientRect();
    const width = Math.max(400, rect.width || 900);
    const height = Math.max(400, rect.height || 800);

    // 销毁现有图谱实例
    if (this.graph) {
      this.graph.destroy();
    }

    // 初始化 G6 图谱
    this.graph = new G6.Graph({
      container: container,
      width: width,
      height: height,
      fitView: true,
      fitViewPadding: 40,
      minZoom: 0.1,
      maxZoom: 3,
      
      // 交互模式
      modes: {
        default: [
          'drag-canvas-right', // 右键拖动画布（自定义 behavior）
          'zoom-canvas',
          'drag-node',
          {
            type: 'activate-relations',
            activeState: 'active',
            inactiveState: 'inactive',
            resetSelected: true,
            // ponytail: behavior 自带的 shouldUpdate 钩子，按住 Ctrl 时完全冻结 ——
            // 既不 deactivate（不清当前高亮），也不 activate（hover 别的节点不切换高亮）。
            shouldUpdate: (_item: any, cfg: any) => {
              if (this.ctrlHeld) return false;
              return true;
            },
          },
        ],
      },

      // ponytail: 不配 layout —— starRingSectorLayout 已把 x/y 写到节点上，
      // G6 v4.8 的 initPositions 会跳过已有坐标的节点，原样采用扇区布局

      // 节点状态样式（带发光效果）
      nodeStateStyles: {
        active: {
          lineWidth: 3,
          shadowColor: '#fff',
          shadowBlur: 20,
        },
        inactive: {
          opacity: 0.08,
        },
      },
      
      // 边状态样式（带发光效果）
      edgeStateStyles: {
        active: {
          stroke: '#a78bfa',
          lineWidth: 2,
          shadowColor: '#a78bfa',
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
      
      // 默认边配置
      defaultEdge: {
        type: 'cubic',
        style: {
          stroke: '#3d4f6f',
          lineWidth: 0.8,
          opacity: 0.35,
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

    // 加载数据并渲染
    this.graph.data(g6Data);
    this.graph.render();
    this.applyLod(); // 渲染后立刻同步一次 LOD（碎片/错题初始该是隐藏的）

    // 视口变化事件：按层级控制标签显示
    this.graph.on('viewportchange', () => this.applyLod());

    // 节点点击事件：自动居中放大 + 打开对应笔记
    // ponytail: 单击/双击共用 canvas，用 220ms 延迟区分 —— 双击时取消单击的打开动作
    let clickTimer: any = null;
    this.graph.on('node:click', (evt) => {
      const node = evt.item;
      const model = node?.getModel();
      if (!model) return;

      // Alt+左键点击 MOC：进入/退出聚焦模式（不再走居中+打开笔记）
      const altKey = (evt.originalEvent as MouseEvent)?.altKey;
      if (altKey && model.level === 2) {
        if (this.focusMode?.mocId === model.id) this.exitFocus();
        else this.focusOnMoc(model.id);
        return;
      }

      // 普通点击：追溯当前活跃 MOC（放大过阈值时只显它的星云）
      this.activeMocId = this.findMocAncestor(model.id);
      this.applyLod();

      // 自动居中并放大到该节点
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
    
    // 空白处点击：聚焦模式下退出，否则重置视角
    this.graph.on('canvas:click', () => {
      if (this.focusMode) { this.exitFocus(); return; }
      this.graph.fitView(20, undefined, true, {
        easing: 'easeCubic',
        duration: 500,
      });
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

      // BFS 沿 edges 收集所有后代 id
      const childToParent = new Map<string, string>(); // child -> 直接 source
      this.g6Data.edges.forEach(e => childToParent.set(e.target, e.source));
      const descendants = new Set<string>();
      const queue: string[] = [];
      this.g6Data.edges.forEach(e => {
        if (e.source === model.id) queue.push(e.target);
      });
      while (queue.length) {
        const cur = queue.shift()!;
        if (descendants.has(cur)) continue;
        descendants.add(cur);
        this.g6Data.edges.forEach(e => {
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
  }

  // 语义缩放：① 碎片/错题(level≥3) 可见性仅在跨阈值时翻转一次；
  //          ② 标签透明度每次滚动都同步（廉价的 attr 突变）
  applyLod() {
    if (!this.graph) return;
    // 聚焦模式：显隐由 focusMode 接管，这里只同步标签透明度（全显）
    if (this.focusMode) {
      this.graph.getNodes().forEach((node: any) => {
        node.getContainer().find((e: any) => e.get('name') === 'node-label')?.attr('opacity', 1);
      });
      return;
    }
    const zoom = this.graph.getZoom();
    const detailZoom = this.plugin.settings.detailZoom ?? 1.5;

    // ① 节点/边可见性 —— 仅在跨阈值时执行（避免每次滚动 updateItem 全图）
    // 按 MOC 子树分批：有 activeMocId 时只显它的星云，无则退回原行为（显全部）
    const shouldShow = zoom >= detailZoom;
    if (shouldShow !== this._detailsVisible) {
      this._detailsVisible = shouldShow;
      const visibleIds = this.activeMocId ? this.collectDescendants(this.activeMocId) : null;
      this.graph.getNodes().forEach((node: any) => {
        const model = node.getModel();
        if ((model.level ?? 0) >= 3) {
          const show = shouldShow && (!visibleIds || visibleIds.has(model.id));
          this.graph.updateItem(node, { visible: show });
        }
      });
      // 边同步：任一端点 level≥3 则跟随碎片/错题显隐（且需在可见子树内）
      this.graph.getEdges().forEach((edge: any) => {
        const sModel = edge.getSource()?.getModel();
        const tModel = edge.getTarget()?.getModel();
        const sLv = sModel?.level ?? 0;
        const tLv = tModel?.level ?? 0;
        if (sLv >= 3 || tLv >= 3) {
          let show = shouldShow;
          if (show && visibleIds) {
            // 至少一端 level≥3 且该端在可见子树内
            const sOk = sLv >= 3 ? visibleIds.has(sModel.id) : true;
            const tOk = tLv >= 3 ? visibleIds.has(tModel.id) : true;
            show = sOk && tOk;
          }
          this.graph.updateItem(edge, { visible: show });
        }
      });
    }

    // ② 标签透明度 —— 每次都跑
    this.graph.getNodes().forEach((node: any) => {
      const model = node.getModel();
      const level = model.level || 0;
      let opacity = 0;
      if (zoom >= detailZoom) opacity = 1;                     // 放大后全显示（含碎片/错题）
      else if (zoom >= 0.8 && level <= 2) opacity = 1;         // 中等缩放：到知识点
      else if (zoom >= 0.5 && level <= 1) opacity = 1;         // 小缩放：到章节
      else if (zoom < 0.5 && level === 0) opacity = 1;         // 极小：只根节点
      node.getContainer().find((e: any) => e.get('name') === 'node-label')
        ?.attr('opacity', opacity);
    });
  }

  // BFS 沿 edges 收集某节点的所有后代 id（含跨多级）。供 applyLod 分批 + focusOnMoc 共用
  // ponytail: 不重建父子表，直接反查 edges；dblclick 折叠用同样的遍历
  private collectDescendants(rootId: string): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [];
    this.g6Data!.edges.forEach(e => { if (e.source === rootId) queue.push(e.target); });
    while (queue.length) {
      const cur = queue.shift()!;
      if (out.has(cur)) continue;
      out.add(cur);
      this.g6Data!.edges.forEach(e => { if (e.source === cur) queue.push(e.target); });
    }
    return out;
  }

  // 沿 edges 向上找最近的 level===2 祖先（含自己）。供 node:click 追溯活跃 MOC
  private findMocAncestor(nodeId: string): string | null {
    const childToParent = new Map<string, string>();
    this.g6Data!.edges.forEach(e => childToParent.set(e.target, e.source));
    const byId = new Map<string, any>(this.g6Data!.nodes.map(n => [n.id, n]));
    let cur: string | undefined = nodeId;
    let guard = 0;
    while (cur && guard++ < 1000) {
      const node = byId.get(cur);
      if (node && (node.level ?? 0) === 2) return cur;
      cur = childToParent.get(cur);
    }
    return null;
  }

  // Alt+点击 MOC 进入聚焦：该 MOC 居中、其星云环绕、其他 MOC 隐藏、根/章节压暗保留
  private focusOnMoc(mocId: string) {
    if (!this.graph || !this.g6Data) return;
    const visibleIds = this.collectDescendants(mocId);
    visibleIds.add(mocId);

    this.graph.getNodes().forEach((node: any) => {
      const model = node.getModel();
      const lv = model.level ?? 0;
      if (lv === 2 && model.id !== mocId) {
        // 其他 MOC 隐藏
        this.graph.updateItem(node, { visible: false });
      } else if (lv <= 1) {
        // 根/章节压暗保留（空间定位感）
        this.graph.updateItem(node, { style: { opacity: 0.15 } });
      } else if (visibleIds.has(model.id)) {
        // 该 MOC 及其星云：显示并点亮
        this.graph.updateItem(node, { visible: true, style: { opacity: 1 } });
      }
    });

    // 边：两端都在可见集合内才显示
    const isShown = (id: string) => {
      const node = this.g6Data!.nodes.find(n => n.id === id);
      const lv = node?.level ?? 0;
      if (lv === 2) return id === mocId;
      if (lv <= 1) return true; // 根/章节边保留（压暗）
      return visibleIds.has(id);
    };
    this.graph.getEdges().forEach((edge: any) => {
      const sId = edge.getSource()?.getModel()?.id;
      const tId = edge.getTarget()?.getModel()?.id;
      this.graph.updateItem(edge, { visible: sId && tId ? isShown(sId) && isShown(tId) : false });
    });

    this.focusMode = { mocId };
    this.container?.classList.add('is-focused');

    // 居中到该 MOC（其位置仍在原布局处，平滑聚焦过去）
    this.graph.focusItem(mocId, true, { easing: 'easeCubic', duration: 500 });
    this.applyLod(); // 聚焦态下走短路分支，点亮所有标签
  }

  // 退出聚焦：还原全部节点显隐/透明，重建 LOD，重置视角
  private exitFocus() {
    if (!this.graph) return;
    this.focusMode = null;
    this.container?.classList.remove('is-focused');
    // 先把所有节点还原到"全可见"，再交 applyLod 按 LOD 重新裁定
    this.graph.getNodes().forEach((node: any) => {
      this.graph.updateItem(node, { visible: true, style: { opacity: 1 } });
    });
    this.graph.getEdges().forEach((edge: any) => {
      this.graph.updateItem(edge, { visible: true });
    });
    // _detailsVisible 状态可能已被 focus 覆盖，强制重算：先置反再调 applyLod
    this._detailsVisible = !this._detailsVisible;
    this.applyLod();
    this.graph.fitView(20, undefined, true, { easing: 'easeCubic', duration: 500 });
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

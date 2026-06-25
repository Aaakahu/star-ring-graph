// 星环图谱视图 + 渲染逻辑（D3.js）

import { ItemView, WorkspaceLeaf } from "obsidian";
import type StarRingGraphPlugin from "./main";
import * as d3 from "d3";
import { buildChapterTree } from "./data";
import type { RingNode } from "./data";

export const STAR_RING_VIEW_TYPE = "star-ring-view";

const WIDTH = 900, HEIGHT = 800;

const RING_GAP = 200;
const NODES_PER_RING = 6;

const COLOR_MAP: Record<string, string> = {
  root: "#7c5fff",
  chapter: "#5297ff",
  MOC: "#5297ff",
  moc1: "#5297ff",
  moc2: "#6ba3ff",
  moc3: "#85afff",
  moc4: "#9fbcff",
  moc: "#5297ff",
  Frag: "#f08c00",
  Error: "#e05555"
};

const BG_FILL_MAP: Record<string, string> = {
  moc: "rgba(82, 151, 255, 0.07)",
  moc1: "rgba(82, 151, 255, 0.07)",
  moc2: "rgba(82, 151, 255, 0.07)",
  moc3: "rgba(82, 151, 255, 0.07)",
  moc4: "rgba(82, 151, 255, 0.07)",
  Frag: "rgba(240, 140, 0, 0.07)",
  Error: "rgba(224, 85, 85, 0.07)"
};

// ========== 工具函数 ==========

function countLeaves(node: d3.HierarchyNode<RingNode>): number {
  if (!node.children || node.children.length === 0) return 1;
  return d3.sum(node.children, d => countLeaves(d));
}

function getNodeType(d: d3.HierarchyNode<RingNode>): string {
  return d.data.type || "";
}

// 按子树大小分配扇区角度：节点多的章节占的角度大
function assignByChapterSector(root: d3.HierarchyNode<RingNode>) {
  const chapters = root.children || [];
  const n = chapters.length;
  if (n === 0) {
    (root as any)._angle = 0;
    return;
  }

  const FULL = 2 * Math.PI;
  const SECTOR_GAP = 10 * Math.PI / 180;
  const totalGap = n > 1 ? (n - 1) * SECTOR_GAP : 0;
  const availableAngle = FULL - totalGap;

  const weights = chapters.map(d => Math.max(countLeaves(d), 1));
  const totalWeight = d3.sum(weights);

  let cursor = -Math.PI / 2;

  chapters.forEach((chapter, i) => {
    const weight = weights[i];
    const sectorWidth = (weight / totalWeight) * availableAngle;
    assignSectorAngles(chapter, cursor, sectorWidth);
    cursor += sectorWidth + SECTOR_GAP;
  });

  (root as any)._angle = 0;
}

// 递归分配：父节点在扇区中心，子节点按子树大小瓜分扇区
function assignSectorAngles(node: d3.HierarchyNode<RingNode>, startAngle: number, sectorWidth: number) {
  (node as any)._angle = startAngle + sectorWidth / 2;

  if (!node.children || node.children.length === 0) return;

  const children = node.children;
  const weights = children.map(d => Math.max(countLeaves(d), 1));
  const totalWeight = d3.sum(weights);

  let cursor = startAngle;
  children.forEach((child, i) => {
    const weight = weights[i];
    const childWidth = sectorWidth * (weight / totalWeight);
    assignSectorAngles(child, cursor, childWidth);
    cursor += childWidth;
  });
}

// 计算每种类型节点的半径范围
function computeRingLayout(root: d3.HierarchyNode<RingNode>) {
  const typeNodes: Record<string, d3.HierarchyNode<RingNode>[]> = {};

  root.descendants().forEach(n => {
    const t = getNodeType(n);
    if (!t || t === "root" || t === "chapter") return;
    if (!typeNodes[t]) typeNodes[t] = [];
    typeNodes[t].push(n);
  });

  const typeOrder = Object.keys(typeNodes).sort((a, b) => {
    const rank = (t: string) => {
      if (t.startsWith("moc")) return parseInt(t.slice(3)) || 1;
      if (t === "Frag") return 100;
      if (t === "Error") return 200;
      return 50;
    };
    return rank(a) - rank(b);
  });

  const FIRST_RING = 160;
  let cursorR = FIRST_RING;
  const typeRadii: Record<string, { minR: number; maxR: number }> = {};

  typeOrder.forEach(type => {
    const nodes = typeNodes[type];
    // 按角度排序，同一环上的节点按圆周顺序排列，减少连线交叉
    nodes.sort((a, b) => ((a as any)._angle || 0) - ((b as any)._angle || 0));

    const ringCount = Math.max(1, Math.ceil(nodes.length / NODES_PER_RING));
    const minR = cursorR;
    const maxR = minR + (ringCount - 1) * RING_GAP;
    typeRadii[type] = { minR, maxR };

    nodes.forEach((n, i) => {
      const ringIdx = Math.floor(i / NODES_PER_RING);
      (n as any)._actualRadius = minR + ringIdx * RING_GAP;
    });

    cursorR = maxR + RING_GAP;
  });

  return typeRadii;
}

// 把角度和半径转成笛卡尔坐标
function computeNodePositions(
  root: d3.HierarchyNode<RingNode>,
  typeRadii: Record<string, { minR: number; maxR: number }>
) {
  const ROOT_RADIUS = 30;

  root.each(d => {
    const anyD = d as any;

    if (d.depth === 0) {
      anyD.radius = ROOT_RADIUS;
      anyD.cartX = 0;
      anyD.cartY = 0;
      anyD.x = 0;
      anyD.y = 0;
      return;
    }

    if (d.depth === 1) {
      anyD.radius = 70;
    } else if (anyD._actualRadius) {
      anyD.radius = anyD._actualRadius;
    } else {
      anyD.radius = ROOT_RADIUS;
    }

    const angle = anyD._angle != null ? anyD._angle : 0;
    anyD.cartX = anyD.radius * Math.cos(angle);
    anyD.cartY = anyD.radius * Math.sin(angle);
    anyD.x = anyD.cartX;
    anyD.y = anyD.cartY;
  });
}

export class StarRingView extends ItemView {
  plugin: StarRingGraphPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: StarRingGraphPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return STAR_RING_VIEW_TYPE; }
  getDisplayText() { return "星环图谱"; }
  getIcon() { return "orbit"; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("star-ring-view");
    container.createEl("div", { text: "加载数据中..." }).style.color = "#888";

    try {
      const treeData = await buildChapterTree(this.app, this.plugin.settings);
      this.renderGraph(container, treeData);
    } catch (e) {
      container.empty();
      container.createEl("div", { text: "数据加载失败：" + (e as Error).message }).style.color = "#e55";
      console.error("[星环图谱] 数据加载失败", e);
    }
  }

  async onClose() {}

  renderGraph(container: HTMLElement, treeData: RingNode) {
    const rect = container.getBoundingClientRect();
    const w = Math.max(400, rect.width || WIDTH);
    const h = Math.max(400, rect.height || HEIGHT);
    const center = { x: w / 2, y: h / 2 };

    const svg = d3.select(container).append("svg")
      .attr("id", "star-ring-svg")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("viewBox", `0 0 ${w} ${h}`)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .style("cursor", "grab");

    // 定义滤镜和渐变
    const defs = svg.append("defs");

    // 节点发光滤镜
    const glowFilter = defs.append("filter")
      .attr("id", "node-glow")
      .attr("x", "-50%")
      .attr("y", "-50%")
      .attr("width", "200%")
      .attr("height", "200%");
    glowFilter.append("feGaussianBlur")
      .attr("stdDeviation", "2.5")
      .attr("result", "coloredBlur");
    const feMerge = glowFilter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    const g = svg.append("g")
      .attr("class", "star-ring-content")
      .attr("transform", `translate(${center.x},${center.y})`);

    // Zoom：滚轮缩放 + Ctrl 拖拽平移
    let zoomRaf = 0;
    const applyZoom = (transform: d3.ZoomTransform) => {
      if (zoomRaf) cancelAnimationFrame(zoomRaf);
      zoomRaf = requestAnimationFrame(() => {
        zoomRaf = 0;
        g.attr("transform", transform.toString());
        const k = transform.k;
        g.classed("zoom-far", k < 0.5);
        g.classed("zoom-mid", k >= 0.5 && k < 1.5);
        g.classed("zoom-close", k >= 1.5);
      });
    };

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 5])
      .wheelDelta((event: any) => -event.deltaY * (event.deltaMode === 1 ? 0.2 : 0.01))
      .filter((event: any) => {
        if (event.type === "wheel") return true;
        return event.ctrlKey || event.metaKey;
      })
      .on("zoom", (event) => applyZoom(event.transform));

    svg.call(zoom).on("dblclick.zoom", null);

    const initialTransform = d3.zoomIdentity.translate(center.x, center.y);
    svg.call(zoom.transform, initialTransform);

    // ========== 布局计算 ==========
    const root = d3.hierarchy(treeData as any);

    assignByChapterSector(root);
    const typeRadii = computeRingLayout(root);
    computeNodePositions(root, typeRadii);

    // ========== 背景环 ==========
    const typeKeys = Object.keys(typeRadii).sort((a, b) => typeRadii[a].minR - typeRadii[b].minR);

    const getAnnulusPath = (r1: number, r2: number) =>
      `M ${-r1},0 a ${r1},${r1} 0 1,0 ${r1 * 2},0 a ${r1},${r1} 0 1,0 ${-r1 * 2},0
       M ${-r2},0 a ${r2},${r2} 0 1,1 ${r2 * 2},0 a ${r2},${r2} 0 1,1 ${-r2 * 2},0 Z`;

    typeKeys.forEach((type, i) => {
      const { minR, maxR } = typeRadii[type];
      const fill = BG_FILL_MAP[type] || BG_FILL_MAP["moc"];
      if (i === 0) {
        g.append("circle")
          .attr("class", "bg-region")
          .attr("r", maxR)
          .attr("fill", fill);
      } else {
        const prev = typeRadii[typeKeys[i - 1]].maxR;
        g.append("path")
          .attr("class", "bg-region")
          .attr("d", getAnnulusPath(maxR, prev))
          .attr("fill", fill)
          .attr("fill-rule", "evenodd");
      }
    });

    // ========== 轨道虚线 ==========
    const allRadii = [30, 70];
    typeKeys.forEach(type => {
      const { minR, maxR } = typeRadii[type];
      for (let r = minR; r <= maxR + 0.1; r += RING_GAP) {
        allRadii.push(r);
      }
    });

    allRadii.forEach(r => {
      g.append("circle")
        .attr("class", "ring-circle bg-region")
        .attr("r", r);
    });

    // ========== 环标签 ==========
    if (typeRadii["moc1"]) {
      g.append("text")
        .attr("class", "ring-label")
        .attr("y", -typeRadii["moc1"].minR + 25)
        .text("内环 · MOC");
    }
    if (typeRadii["Frag"]) {
      g.append("text")
        .attr("class", "ring-label")
        .attr("y", -typeRadii["Frag"].minR + 25)
        .text("中环 · 碎片");
    }
    if (typeRadii["Error"]) {
      g.append("text")
        .attr("class", "ring-label")
        .attr("y", -typeRadii["Error"].minR + 25)
        .text("外环 · 错题");
    }

    // ========== 黑色蒙版层（HTML div，支持毛玻璃 backdrop-filter）==========
    // 独立于 SVG：盖在整张图谱之上，高亮时淡入。SVG rect 不支持 backdrop-filter，故用 div。
    const overlay = document.createElement("div");
    overlay.className = "interact-overlay";
    container.appendChild(overlay);

    // ========== 连线（贝塞尔曲线） ==========
    const visibleLinks = root.links().filter(l => l.source.depth >= 1 && l.target.depth >= 1);

    const linkPath = (d: any) => {
      const sx = d.source.x, sy = d.source.y;
      const tx = d.target.x, ty = d.target.y;
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      // 控制点向圆心方向弯曲，让连线顺着环走
      const bend = 0.3;
      const cx = mx * (1 - bend);
      const cy = my * (1 - bend);
      return `M ${sx},${sy} Q ${cx},${cy} ${tx},${ty}`;
    };

    const link = g.append("g").selectAll("path")
      .data(visibleLinks)
      .join("path")
      .attr("class", "link")
      .attr("d", linkPath);

    // ========== 普通节点（depth >= 2） ==========
    const visibleNodes = root.descendants().filter(n => n.depth >= 2);

    const node = g.append("g").selectAll("g")
      .data(visibleNodes)
      .join("g")
      .attr("class", "node")
      .attr("transform", (d: any) => `translate(${d.cartX},${d.cartY})`)
      .style("cursor", "pointer");

    // 命中区：扩大点击范围
    node.append("circle")
      .attr("class", "hit-area")
      .attr("r", 16)
      .attr("fill", "transparent");

    // 可见圆：大小随子树叶子数变化
    node.append("circle")
      .attr("class", "node-circle")
      .attr("r", (d: any) => {
        const type = getNodeType(d);
        const base = type === "MOC" ? 7 : (type === "Frag" ? 5 : 4);
        const leaves = countLeaves(d);
        return base + Math.min(leaves * 0.5, 4);
      })
      .attr("fill", (d: any) => COLOR_MAP[getNodeType(d)] || "#888")
      .attr("filter", "url(#node-glow)");

    // 文字标签：沿半径方向摆放
    node.append("text")
      .attr("class", "node-label")
      .attr("data-type", (d: any) => getNodeType(d))
      .attr("x", (d: any) => Math.cos(d._angle || 0) * 12)
      .attr("y", (d: any) => Math.sin(d._angle || 0) * 12 + 4)
      .attr("text-anchor", (d: any) => Math.cos(d._angle || 0) >= 0 ? "start" : "end")
      .text((d: any) => d.data.name);

    // ========== 章节节点（depth = 1） ==========
    const chapters = root.descendants().filter(n => n.depth === 1);

    const chapterNodes = g.append("g").selectAll("g")
      .data(chapters)
      .join("g")
      .attr("class", "node chapter-node")
      .attr("transform", (d: any) => `translate(${d.cartX},${d.cartY})`)
      .style("cursor", "pointer");

    chapterNodes.append("circle")
      .attr("r", (d: any) => 8 + Math.min(countLeaves(d) * 0.3, 6))
      .attr("fill", "#5297ff")
      .attr("stroke", "#1e1e1e")
      .attr("stroke-width", 2)
      .attr("filter", "url(#node-glow)");

    chapterNodes.append("text")
      .attr("class", "chapter-label")
      .attr("dy", (d: any) => d.cartY > 0 ? 18 : -12)
      .attr("text-anchor", "middle")
      .text((d: any) => d.data.name);

    // ========== 根节点（depth = 0） ==========
    const rootNodes = g.append("g").selectAll("g")
      .data([root])
      .join("g")
      .attr("class", "node root-node")
      .attr("transform", "translate(0,0)")
      .style("cursor", "pointer");

    rootNodes.append("circle")
      .attr("r", 12)
      .attr("fill", "#7c5fff")
      .attr("stroke", "#1e1e1e")
      .attr("stroke-width", 2)
      .attr("filter", "url(#node-glow)");

    rootNodes.append("text")
      .attr("class", "chapter-label")
      .attr("dy", -20)
      .attr("text-anchor", "middle")
      .text((d: any) => d.data.name);

    // ========== 高亮交互 ==========
    const highlightPath = (d: any) => {
      g.classed("interacting", true);
      const connected = new Set<any>(d.ancestors());
      d.descendants().forEach((desc: any) => connected.add(desc));

      const visibleConnected = new Set([...connected].filter((n: any) => n.depth >= 0));
      const connectedLinks = new Set<any>();

      visibleLinks.forEach(l => {
        if (visibleConnected.has(l.source) && visibleConnected.has(l.target)) {
          connectedLinks.add(l);
        }
      });

      node.classed("node-active", (n: any) => visibleConnected.has(n))
        .classed("node-dimmed", (n: any) => !visibleConnected.has(n));
      chapterNodes.classed("node-active", (n: any) => visibleConnected.has(n))
        .classed("node-dimmed", (n: any) => !visibleConnected.has(n));
      rootNodes.classed("node-active", (n: any) => visibleConnected.has(n))
        .classed("node-dimmed", (n: any) => !visibleConnected.has(n));
      link.classed("link-active", (l: any) => connectedLinks.has(l))
        .classed("link-dimmed", (l: any) => !connectedLinks.has(l));
    };

    const clearHighlight = () => {
      g.classed("interacting", false);
      node.classed("node-active", false).classed("node-dimmed", false);
      chapterNodes.classed("node-active", false).classed("node-dimmed", false);
      rootNodes.classed("node-active", false).classed("node-dimmed", false);
      link.classed("link-active", false).classed("link-dimmed", false);
    };

    // ========== 绑定事件：hover + 点击打开笔记 ==========
    const bindEvents = (selection: any) => {
      selection
        .on("mouseover", (event: any, d: any) => highlightPath(d))
        .on("mouseout", clearHighlight)
        .on("click", (event: any, d: any) => {
          const filePath = d.data ? d.data._filePath : d._filePath;
          if (filePath) {
            this.app.workspace.openLinkText(filePath, "");
          }
        });
    };

    bindEvents(node);
    bindEvents(chapterNodes);
    bindEvents(rootNodes);
  }
}

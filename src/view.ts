// 星环图谱视图 + 渲染逻辑（D3.js）
import { ItemView, WorkspaceLeaf } from "obsidian";
import type StarRingGraphPlugin from "./main";
import * as d3 from "d3";
import { buildChapterTree } from "./data";
import type { RingNode } from "./data";

export const STAR_RING_VIEW_TYPE = "star-ring-view";

// 硬编码测试数据（先跑通视觉，后续接 data.ts 真实数据）
const MOCK_DATA = {
  name: "数学体系",
  children: [
    {
      name: "第一章：极限",
      children: [
        { name: "MOC: 1.1 极限定义", type: "MOC", children: [
          { name: "Frag: 等价无穷小替换", type: "Frag", children: [
            { name: "Error: 0/0型化简错误", type: "Error" }
          ]},
          { name: "Frag: 洛必达使用条件", type: "Frag", children: [
            { name: "Error: 洛必达法则误用", type: "Error" }
          ]}
        ]},
        { name: "MOC: 1.2 连续性", type: "MOC", children: [
          { name: "Frag: 间断点分类SOP", type: "Frag", children: [
            { name: "Error: 间断点判断漏解", type: "Error" }
          ]}
        ]}
      ]
    },
    {
      name: "第二章：导数",
      children: [
        { name: "MOC: 2.1 导数定义", type: "MOC", children: [
          { name: "Frag: 隐函数求导模板", type: "Frag", children: [
            { name: "Error: 隐函数求导漏项", type: "Error" }
          ]}
        ]},
        { name: "MOC: 2.2 微分法则", type: "MOC", children: [
          { name: "Frag: 链式法则二级结论", type: "Frag", children: [
            { name: "Error: 复合函数求导错", type: "Error" },
            { name: "Error: 参数方程求导错", type: "Error" }
          ]}
        ]}
      ]
    },
    {
      name: "第三章：积分",
      children: [
        { name: "MOC: 3.1 积分基本法", type: "MOC", children: [
          { name: "Frag: 换元法SOP", type: "Frag", children: [
            { name: "Error: 凑微分漏系数", type: "Error" }
          ]},
          { name: "Frag: 分部积分模板", type: "Frag", children: [
            { name: "Error: 分部积分循环错", type: "Error" }
          ]}
        ]}
      ]
    }
  ]
};

const WIDTH = 900, HEIGHT = 800;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };
const RING_GAP = 130;                                   // 相邻环间距（增大，给每层足够周长）
const NODES_PER_RING = 8;                               // 每环最多节点数，超出开新环
const BASE_RADIUS_MAP: Record<string, number> = { MOC: 160, Frag: 290, Error: 390 };
const COLOR_MAP: Record<string, string> = {
  root: "#7c5fff", chapter: "#5297ff",
  moc1: "#5297ff", moc2: "#6ba3ff", moc3: "#85afff", moc4: "#9fbcff",
  moc: "#5297ff",
  Frag: "#f08c00", Error: "#e05555"
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

// 类型在环上的排列顺序（内到外）：root < chapter < moc1 < moc2 < ... < Frag < Error
// 动态生成：扫描数据里出现的所有 type，排序后依次分配半径

// 计算动态轨道布局：返回每节点实际半径 + 每种类型的半径范围
function computeRingLayout(root: any) {
  // 收集所有非 root/chapter 的 type
  const typeNodes: Record<string, any[]> = {};
  root.descendants().forEach((n: any) => {
    const t = n.data.type;
    if (!t || t === "root" || t === "chapter") return;
    if (!typeNodes[t]) typeNodes[t] = [];
    typeNodes[t].push(n);
  });

  // type 排序：moc1 < moc2 < ... < Frag < Error
  const typeOrder = Object.keys(typeNodes).sort((a, b) => {
    const rank = (t: string) => {
      if (t.startsWith("moc")) return parseInt(t.slice(3)) || 1;
      if (t === "Frag") return 100;
      if (t === "Error") return 200;
      return 50;
    };
    return rank(a) - rank(b);
  });

  // 起始半径（chapter 在 70，moc1 从 160 起）
  const CHAPTER_RADIUS = 70;
  const FIRST_RING = 160;
  let cursorR = FIRST_RING;
  const typeRadii: Record<string, { minR: number; maxR: number }> = {};

  typeOrder.forEach((type) => {
    const nodes = typeNodes[type];
    const ringCount = Math.max(1, Math.ceil(nodes.length / NODES_PER_RING));
    const minR = cursorR;
    const maxR = minR + (ringCount - 1) * RING_GAP;
    typeRadii[type] = { minR, maxR };
    nodes.forEach((n: any, i: number) => {
      const ringIdx = Math.floor(i / NODES_PER_RING);
      n._actualRadius = minR + ringIdx * RING_GAP;
    });
    cursorR = maxR + RING_GAP;  // 下一个 type 从这里开始
  });

  return typeRadii;
}

// 按章节扇形分配：每个章节占一个扇区，章内从外向内均匀展开
// 扇区等分 + 留间隔（呼吸感），章内各 depth 在扇区内均匀分布
function assignByChapterSector(root: any) {
  const chapters = root.children || [];
  const n = chapters.length;
  if (n === 0) return;

  const FULL = 2 * Math.PI;
  const SECTOR_GAP = 10 * Math.PI / 180;   // 扇区间隔 10°（呼吸感）
  const totalGap = n > 1 ? (n - 1) * SECTOR_GAP : 0;
  const sectorWidth = (FULL - totalGap) / n;

  let cursor = -Math.PI / 2;  // 从顶部开始
  chapters.forEach((chapter: any, ci: number) => {
    const startAngle = cursor;
    assignSectorAngles(chapter, startAngle, sectorWidth);
    cursor += sectorWidth + SECTOR_GAP;
  });
  root._angle = 0;  // 根节点中心
}

// 单个章节扇区内，从外向内均匀分配角度
function assignSectorAngles(chapterNode: any, startAngle: number, sectorWidth: number) {
  // 章节节点自己放在扇区中心
  chapterNode._angle = startAngle + sectorWidth / 2;

  // 收集该章节子树（不含章节本身）按 depth 分桶
  const descendants = chapterNode.descendants ? chapterNode.descendants() : [];
  const subtree = descendants.filter((d: any) => d !== chapterNode);
  if (subtree.length === 0) return;

  const byDepth: Record<number, any[]> = {};
  let maxDepth = 0;
  subtree.forEach((d: any) => {
    if (!byDepth[d.depth]) byDepth[d.depth] = [];
    byDepth[d.depth].push(d);
    if (d.depth > maxDepth) maxDepth = d.depth;
  });

  const minDepth = chapterNode.depth + 1;  // 章节下一层开始

  // 从最外层向内：在该章节扇区内均匀分布
  for (let depth = maxDepth; depth >= minDepth; depth--) {
    const nodes = byDepth[depth];
    if (!nodes || nodes.length === 0) continue;

    // 排序：按子节点平均角度（让父对齐子，减少连线斜跨）
    nodes.sort((a: any, b: any) => avgChildAngle(a) - avgChildAngle(b));

    // 在扇区内均匀分布
    const m = nodes.length;
    nodes.forEach((node: any, i: number) => {
      node._angle = startAngle + (i + 0.5) / m * sectorWidth;
    });
  }
}

// 计算节点所有子节点的平均角度（用于排序对齐）
function avgChildAngle(node: any): number {
  if (!node.children || node.children.length === 0) {
    return node._angle != null ? node._angle : 0;
  }
  const angles = node.children.map((c: any) => avgChildAngle(c));
  return angles.reduce((a: number, b: number) => a + b, 0) / angles.length;
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

  async onClose() {
    // 清理
  }

  renderGraph(container: HTMLElement, treeData: RingNode) {
    // 自适应容器尺寸
    const rect = container.getBoundingClientRect();
    const w = Math.max(400, rect.width || WIDTH);
    const h = Math.max(400, rect.height || HEIGHT);
    const center = { x: w / 2, y: h / 2 };
    const ROOT_RADIUS = 30;   // 根节点轨道半径（最内）

    const svg = d3.select(container).append("svg")
      .attr("id", "star-ring-svg")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("viewBox", `0 0 ${w} ${h}`)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .style("cursor", "grab");

    // 主 g：承载所有内容，被 zoom 行为控制
    const g = svg.append("g").attr("class", "star-ring-content")
      .attr("transform", `translate(${center.x},${center.y})`);

    // d3-zoom：滚轮缩放 + 拖拽平移（rAF 节流避免卡顿）
    const TEXT_HIDE_THRESHOLD = 0.6;
    let zoomRaf = 0;
    const applyZoom = (transform: d3.ZoomTransform) => {
      if (zoomRaf) return;  // 已有帧在排队，跳过
      zoomRaf = requestAnimationFrame(() => {
        zoomRaf = 0;
        g.attr("transform", transform.toString());
        g.classed("hide-text", transform.k < TEXT_HIDE_THRESHOLD);
      });
    };
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 5])
      .wheelDelta((event: any) => -event.deltaY * (event.deltaMode === 1 ? 0.2 : 0.01))
      // 滚轮缩放始终可用；拖拽平移只在按住 Ctrl 时触发（避免与节点拖拽冲突）
      .filter((event: any) => {
        if (event.type === "wheel") return true;           // 滚轮：始终缩放
        return event.ctrlKey || event.metaKey;              // 鼠标拖拽：仅 Ctrl 时平移画布
      })
      .on("zoom", (event) => applyZoom(event.transform));

    svg.call(zoom)
      .on("dblclick.zoom", null);

    const initialTransform = d3.zoomIdentity.translate(center.x, center.y);
    svg.call(zoom.transform, initialTransform);

    // 0. 先构建层级 + 算动态轨道布局
    const root = d3.hierarchy(treeData as any);

    // 0.1 从外向内的扇形角度分配（每层均匀 360°，外层优先不挤压）
    assignByChapterSector(root);

    const typeRadii = computeRingLayout(root);

    // 1. 分色背景区域（动态遍历所有 type，按出现顺序）
    const typeKeys = Object.keys(typeRadii);
    const getAnnulusPath = (r1: number, r2: number) =>
      `M ${-r1},0 a ${r1},${r1} 0 1,0 ${r1*2},0 a ${r1},${r1} 0 1,0 ${-r1*2},0 
       M ${-r2},0 a ${r2},${r2} 0 1,1 ${r2*2},0 a ${r2},${r2} 0 1,1 ${-r2*2},0 Z`;

    typeKeys.forEach((type, i) => {
      const { minR, maxR } = typeRadii[type];
      const fill = BG_FILL_MAP[type] || BG_FILL_MAP["moc"];
      if (i === 0) {
        // 最内 type：实心圆（到中心）
        g.append("circle").attr("class", "bg-region").attr("r", maxR).attr("fill", fill);
      } else {
        // 外层：环形（前一 type 外缘 到 当前外缘）
        const prev = typeRadii[typeKeys[i - 1]].maxR;
        g.append("path").attr("class", "bg-region")
          .attr("d", getAnnulusPath(maxR, prev))
          .attr("fill", fill).attr("fill-rule", "evenodd");
      }
    });

    // 2. 轨道虚线（根 + 章 + 各类型每个环）
    const allRadii = [ROOT_RADIUS, 70];
    typeKeys.forEach(type => {
      const { minR, maxR } = typeRadii[type];
      for (let r = minR; r <= maxR + 0.1; r += RING_GAP) {
        allRadii.push(r);
      }
    });
    allRadii.forEach(r => {
      g.append("circle").attr("class", "ring-circle bg-region").attr("r", r);
    });
    // 标签（只标三个主要的）
    if (typeRadii["moc1"]) g.append("text").attr("class", "ring-label").attr("y", -typeRadii["moc1"].minR + 25).text("内环 · MOC");
    if (typeRadii["Frag"]) g.append("text").attr("class", "ring-label").attr("y", -typeRadii["Frag"].minR + 25).text("中环 · 碎片");
    if (typeRadii["Error"]) g.append("text").attr("class", "ring-label").attr("y", -typeRadii["Error"].minR + 25).text("外环 · 错题");

    // 3. 按 type 设半径，算笛卡尔坐标（_angle 已是绝对角度，从顶部起）
    (root as any).each((d: any) => {
      if (d.depth === 0) { d.radius = ROOT_RADIUS; d.cartX = 0; d.cartY = 0; d.x = 0; d.y = 0; return; }
      if (d.depth === 1) { d.radius = 70; }
      else if (d._actualRadius) { d.radius = d._actualRadius; }
      const angle = d._angle != null ? d._angle : 0;
      d.cartX = d.radius * Math.cos(angle);
      d.cartY = d.radius * Math.sin(angle);
      d.x = d.cartX;
      d.y = d.cartY;
    });

    // 5. 连线（章→MOC 及更深，排除根→章，章之间不连线）
    const visibleLinks = (root as any).links().filter((l: any) =>
      l.source.depth >= 1 && l.target.depth >= 1
    );
    const link = g.append("g").selectAll("line")
      .data(visibleLinks)
      .join("line")
      .attr("class", "link")
      .attr("x1", (d: any) => d.source.x)
      .attr("y1", (d: any) => d.source.y)
      .attr("x2", (d: any) => d.target.x)
      .attr("y2", (d: any) => d.target.y);

    // 6. 节点（depth>=2）
    const visibleNodes = (root as any).descendants().filter((n: any) => n.depth >= 2);
    const node = g.append("g").selectAll("g")
      .data(visibleNodes)
      .join("g")
      .attr("class", "node")
      .attr("transform", (d: any) => `translate(${d.cartX},${d.cartY})`);

    // 命中圆：透明，比可见圆大很多，扩大点击区
    node.append("circle")
      .attr("class", "hit-area")
      .attr("r", 16)
      .attr("fill", "transparent");

    // 可见圆
    node.append("circle")
      .attr("r", (d: any) => d.data.type === "MOC" ? 7 : (d.data.type === "Frag" ? 5 : 4))
      .attr("fill", (d: any) => COLOR_MAP[d.data.type] || "#888");

    node.append("text")
      .attr("dy", (d: any) => d.cartY > 0 ? 15 : -10)
      .attr("text-anchor", "middle")
      .text((d: any) => d.data.name);

    // 7. 章节节点（depth=1，内环，固定不参与力导向）
    const chapters = (root as any).descendants().filter((n: any) => n.depth === 1);
    const chapterNodes = g.append("g").selectAll("g")
      .data(chapters)
      .join("g")
      .attr("class", "node chapter-node")
      .attr("transform", (d: any) => `translate(${d.cartX},${d.cartY})`);
    chapterNodes.append("circle")
      .attr("r", 8)
      .attr("fill", "#5297ff")
      .attr("stroke", "#1e1e1e")
      .attr("stroke-width", 2);
    chapterNodes.append("text")
      .attr("class", "chapter-label")
      .attr("dy", (d: any) => d.cartY > 0 ? 18 : -12)
      .attr("text-anchor", "middle")
      .text((d: any) => d.data.name);

    // 7.5 根节点（depth=0，最内，中心点）
    const rootNodes = g.append("g").selectAll("g")
      .data([root])
      .join("g")
      .attr("class", "node root-node")
      .attr("transform", "translate(0,0)");
    rootNodes.append("circle")
      .attr("r", 10)
      .attr("fill", "#5297ff")
      .attr("stroke", "#1e1e1e")
      .attr("stroke-width", 2);
    rootNodes.append("text")
      .attr("class", "chapter-label")
      .attr("dy", -16)
      .attr("text-anchor", "middle")
      .text((d: any) => d.data.name);

    // 高亮函数：只高亮"当前节点到根的路径 + 当前节点的子树"，其余暗化
    // connected 含根节点(depth=0)和章节点(depth=1)
    const highlightPath = (d: any) => {
      g.classed("interacting", true);
      const connected = new Set<any>(d.ancestors());
      d.descendants().forEach((desc: any) => connected.add(desc));
      // 纳入 depth>=0 的节点（含根节点）
      const visibleConnected = new Set([...connected].filter((n: any) => n.depth >= 0));
      const connectedLinks = new Set<any>();
      visibleLinks.forEach((l: any) => {
        if (visibleConnected.has(l.source) && visibleConnected.has(l.target)) connectedLinks.add(l);
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

    // 9. hover 高亮链路 —— 普通节点 + 章节点 + 根节点
    node.on("mouseover", function (event: any, d: any) {
      highlightPath(d);
    }).on("mouseout", function () {
      clearHighlight();
    });
    chapterNodes.on("mouseover", function (event: any, d: any) {
      highlightPath(d);
    }).on("mouseout", function () {
      clearHighlight();
    });
    rootNodes.on("mouseover", function (event: any, d: any) {
      highlightPath(d);
    }).on("mouseout", function () {
      clearHighlight();
    });
  }
}

// 星环图谱视图 + 渲染逻辑（AntV G6）

import { ItemView, WorkspaceLeaf } from "obsidian";
import type StarRingGraphPlugin from "./main";
import G6 from '@antv/g6';
import { buildChapterTree, convertToG6Data } from "./data";
import type { RingNode, G6Data } from "./data";

export const STAR_RING_VIEW_TYPE = "star-ring-view";

export class StarRingView extends ItemView {
  plugin: StarRingGraphPlugin;
  graph: G6.Graph | null = null;
  container: HTMLElement | null = null;

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
    // 清理 G6 实例，防止内存泄漏
    if (this.graph) {
      this.graph.destroy();
      this.graph = null;
    }
  }

  renderGraph(container: HTMLElement, treeData: RingNode) {
    // 转换数据格式
    const g6Data: G6Data = convertToG6Data(treeData);

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
      
      // 交互模式
      modes: {
        default: [
          'drag-canvas',   // 允许拖拽画布
          'zoom-canvas',   // 允许缩放画布
          'drag-node',     // 允许手动微调节点
          {
            type: 'activate-relations', // 关联高亮
            activeState: 'active',
            inactiveState: 'inactive',
            resetSelected: true,
          },
        ],
      },
      
      // 布局配置：径向布局
      layout: {
        type: 'radial',
        unitRadius: 100,         // 每一圈的半径距离
        preventOverlap: true,    // 开启防止重叠
        maxIteration: 1000,      // 静态计算的最大迭代次数
        sortBy: 'data',          // 节点排序依据
      },
      
      // 节点状态样式
      nodeStateStyles: {
        active: {
          opacity: 1,
          lineWidth: 3,
        },
        inactive: {
          opacity: 0.2, // 未关联节点变透明
        },
      },
      
      // 边状态样式
      edgeStateStyles: {
        active: {
          opacity: 1,
          lineWidth: 2,
        },
        inactive: {
          opacity: 0.1,
        },
      },
      
      // 默认节点配置
      defaultNode: {
        type: 'circle',
        size: 20,
        style: {
          fill: '#C6E5FF',
          stroke: '#5B8FF9',
          lineWidth: 2,
        },
        labelCfg: {
          style: {
            fontSize: 10,
            fill: '#333',
          },
        },
      },
      
      // 默认边配置
      defaultEdge: {
        type: 'cubic',
        style: {
          stroke: '#999',
          lineWidth: 1,
        },
      },
    });

    // 加载数据并渲染
    this.graph.data(g6Data);
    this.graph.render();

    // 视口变化事件：缩放小于 0.5 时隐藏标签
    this.graph.on('viewportchange', (e) => {
      if (this.graph && this.graph.getZoom() < 0.5) {
        // 缩放小于 0.5 时隐藏文本标签，提升流畅度
        this.graph.getNodes().forEach(node => {
          node.update({ labelCfg: { style: { opacity: 0 } } });
        });
      } else {
        this.graph.getNodes().forEach(node => {
          node.update({ labelCfg: { style: { opacity: 1 } } });
        });
      }
    });

    // 节点点击事件：打开对应笔记
    this.graph.on('node:click', (evt) => {
      const node = evt.item;
      const model = node?.getModel();
      const filePath = model?._filePath;
      if (filePath) {
        this.app.workspace.openLinkText(filePath, "");
      }
    });

    console.log("[星环图谱] G6 图谱渲染完成，节点数:", g6Data.nodes.length, "边数:", g6Data.edges.length);
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

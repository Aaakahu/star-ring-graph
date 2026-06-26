// 星环图谱视图 + 渲染逻辑（AntV G6）

import { ItemView, WorkspaceLeaf } from "obsidian";
import type StarRingGraphPlugin from "./main";
import G6 from '@antv/g6';
import { buildChapterTree, convertToG6Data } from "./data";
import type { RingNode, G6Data } from "./data";

export const STAR_RING_VIEW_TYPE = "star-ring-view";

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
      const fontSize = 10;
      const label = String(cfg.label || '');
      
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
            fontFamily: 'system-ui, -apple-system, sans-serif',
          },
          name: 'node-label',
        });
      });

      return keyShape;
    },
  }, 'circle');
};

export class StarRingView extends ItemView {
  plugin: StarRingGraphPlugin;
  graph: any = null;
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
    // 注册自定义节点类型
    registerWrappedLabelNode();
    
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
      fitView: true,
      fitViewPadding: 40,
      minZoom: 0.1,
      maxZoom: 3,
      
      // 交互模式
      modes: {
        default: [
          { type: 'drag-canvas', enableOptimize: true },
          'zoom-canvas',
          'drag-node',
          {
            type: 'activate-relations',
            activeState: 'active',
            inactiveState: 'inactive',
            resetSelected: true,
          },
        ],
      },
      
      // 布局配置：径向布局
      layout: {
        type: 'radial',
        unitRadius: 140,
        preventOverlap: true,
        maxIteration: 2000,
        sortBy: 'data',
        linkDistance: 100,
      },
      
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
        size: 12,
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

    // 视口变化事件：按层级控制标签显示
    this.graph.on('viewportchange', () => {
      if (!this.graph) return;
      const zoom = this.graph.getZoom();
      this.graph.getNodes().forEach(node => {
        const model = node.getModel();
        const level = model.level || 0;
        let opacity = 0;
        if (zoom >= 1.5) opacity = 1;
        else if (zoom >= 0.8 && level <= 2) opacity = 1;
        else if (zoom >= 0.5 && level <= 1) opacity = 1;
        else if (zoom < 0.5 && level === 0) opacity = 1;
        node.getContainer().find(element => element.get('name') === 'node-label')
          ?.attr('opacity', opacity);
      });
    });

    // 节点点击事件：自动居中放大 + 打开对应笔记
    this.graph.on('node:click', (evt) => {
      const node = evt.item;
      const model = node?.getModel();
      
      // 自动居中并放大到该节点
      this.graph.focusItem(node, true, {
        easing: 'easeCubic',
        duration: 400,
      });
      this.graph.zoomTo(1.2, { x: model.x, y: model.y }, true, {
        easing: 'easeCubic',
        duration: 400,
      });
      
      // 打开对应笔记
      const filePath = model?._filePath;
      if (filePath) {
        this.app.workspace.openLinkText(filePath, "");
      }
    });
    
    // 空白处点击：重置视角
    this.graph.on('canvas:click', () => {
      this.graph.fitView(20, undefined, true, {
        easing: 'easeCubic',
        duration: 500,
      });
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

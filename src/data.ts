// 数据管道：从 vault 读取极限章数据，组装成 d3.hierarchy 需要的树结构
import { App, TFile, TFolder } from "obsidian";

// 星环节点类型
export interface RingNode {
  name: string;
  type: string;        // root / chapter / moc1..mocN / Frag / Error
  children?: RingNode[];
  _filePath?: string;  // 对应的 md 文件路径（用于点击打开）
}

// 思维树前缀 → {depth, 父前缀}
// "2.1.1.2.4_标题" → {nums:[2,1,1,2,4], depth:5, parent:"2.1.1.2"}
function parsePrefix(name: string): { nums: number[]; depth: number; parentKey: string | null } | null {
  // 去掉路径和扩展名
  const base = name.split("/").pop()!.replace(/\.md$/, "");
  // 匹配 2.1.1.2.4_ 前缀（章封面 2_(01-A) 特殊处理）
  const m = base.match(/^(\d+(?:\.\d+)*)_/);
  if (!m) return null;
  const nums = m[1].split(".").map(Number);
  const depth = nums.length;
  const parentKey = depth > 1 ? nums.slice(0, -1).join(".") : null;
  return { nums, depth, parentKey };
}

// 解析 frontmatter（简易 YAML 解析，只取顶层 key:value）
function parseFrontmatter(content: string): Record<string, any> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm: Record<string, any> = {};
  let curKey = "";
  let inList = false;
  for (const line of m[1].split(/\r?\n/)) {
    const listMatch = line.match(/^\s*-\s+(.+)/);
    if (listMatch && curKey && inList) {
      if (!Array.isArray(fm[curKey])) fm[curKey] = [];
      fm[curKey].push(listMatch[1].trim().replace(/^"(.*)"$/, "$1"));
      continue;
    }
    const kv = line.match(/^([^:#\s][^:]*):\s*(.*)$/);
    if (kv) {
      curKey = kv[1].trim();
      const val = kv[2].trim().replace(/^"(.*)"$/, "$1");
      if (val === "" || val === "[]") {
        fm[curKey] = val === "[]" ? [] : "";
        inList = true;
      } else if (val.startsWith("[") && val.endsWith("]")) {
        fm[curKey] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
        inList = false;
      } else {
        fm[curKey] = val;
        inList = false;
      }
    }
  }
  return fm;
}

// 提取正文里的 wikilink（含 %%[[...]]%% 注释形式）
function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  // 匹配 [[xxx]] 或 [[xxx|alias]] 或 %%[[xxx]]%%
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    links.push(m[1].trim());
  }
  return [...new Set(links)];
}

// depth → type 映射
function depthToType(depth: number): string {
  if (depth === 0) return "root";
  if (depth === 1) return "chapter";
  return "moc" + (depth - 1);  // moc1, moc2, moc3...
}

// 主入口：构建指定章节的完整树
export async function buildChapterTree(app: App, settings: any): Promise<RingNode> {
  const chapterRegex = new RegExp("^" + settings.chapterPrefix + "[_\\.]");
  // topic 筛选关键词：用根节点名的第一个词（如"极限与无穷小"→"极限"）
  const topicKeyword = settings.rootName.split(/[\s与]/)[0] || settings.rootName;
  // ========== 1. 读思维树 ==========
  const mocFolder = app.vault.getAbstractFileByPath(settings.mindTreeFolder);
  const mindTreeFiles: TFile[] = [];
  if (mocFolder instanceof TFolder) {
    collectMarkdownFiles(mocFolder, mindTreeFiles);
  }
  // 只取指定章节前缀的文件（如 2_ 开头 = 极限章）
  const limitFiles = mindTreeFiles.filter(f => {
    const base = f.name.replace(/\.md$/, "");
    return chapterRegex.test(base);
  });

  // 用前缀做 key，构建思维树节点 map
  interface MTNode { node: RingNode; nums: number[]; parentKey: string | null; prefix: string; file: TFile }
  const mtMap = new Map<string, MTNode>();
  for (const f of limitFiles) {
    const parsed = parsePrefix(f.path);
    const base = f.name.replace(/\.md$/, "");
    if (!parsed) {
      // 章封面（如 2_(01-A) 极限与无穷小），无标准前缀，作为根
      if (chapterRegex.test(base)) {
        mtMap.set("root", {
          node: { name: settings.rootName, type: "root", _filePath: f.path, children: [] },
          nums: [parseInt(settings.chapterPrefix)], parentKey: null, prefix: settings.chapterPrefix, file: f
        });
      }
      continue;
    }
    const prefix = parsed.nums.join(".");
    mtMap.set(prefix, {
      node: {
        name: base.replace(/^[\d.]+_/, ""),
        type: depthToType(parsed.depth),
        _filePath: f.path,
        children: []
      },
      nums: parsed.nums,
      parentKey: parsed.parentKey,
      prefix,
      file: f
    });
  }

  // 组装父子关系
  const roots: RingNode[] = [];
  for (const [prefix, mt] of mtMap) {
    if (mt.parentKey && mtMap.has(mt.parentKey)) {
      mtMap.get(mt.parentKey)!.node.children!.push(mt.node);
    } else if (mt.parentKey === null) {
      roots.push(mt.node);
    } else {
      // 父不在 map（如 2.1 的父是 root）
      const rootMt = mtMap.get("root");
      if (rootMt) rootMt.node.children!.push(mt.node);
      else roots.push(mt.node);
    }
  }

  const rootNode = roots[0] || { name: settings.rootName, type: "root", children: [] };

  // ========== 2. 读 Flash ==========
  const flashFolder = app.vault.getAbstractFileByPath(settings.flashFolder);
  const flashFiles: TFile[] = [];
  if (flashFolder instanceof TFolder) {
    for (const f of flashFolder.children) {
      if (f instanceof TFile && f.extension === "md") flashFiles.push(f);
    }
  }

  // 找最大思维树 depth（决定 Frag 接在哪一环之后）
  let maxMTDepth = 1;
  for (const [, mt] of mtMap) {
    if (mt.nums.length > maxMTDepth) maxMTDepth = mt.nums.length;
  }

  // 构建 name→node 的扁平查找表（用于 flash 挂载）
  const nodeByName = new Map<string, RingNode>();
  const indexTree = (n: RingNode) => {
    nodeByName.set(n.name, n);
    nodeByName.set(n.name.toLowerCase(), n);
    n.children?.forEach(indexTree);
  };
  indexTree(rootNode);

  // flash 挂载：parent 字段优先，否则 topic 降级匹配
  const flashNodes: RingNode[] = [];
  for (const f of flashFiles) {
    const content = await app.vault.read(f);
    const fm = parseFrontmatter(content);
    if (!fm.topic || !String(fm.topic).includes(topicKeyword)) continue;
    const flashNode: RingNode = {
      name: fm.title || f.basename,
      type: "Frag",
      _filePath: f.path,
      children: []
    };
    // 挂载点
    let mountNode: RingNode | undefined;
    if (fm.parent) {
      mountNode = nodeByName.get(String(fm.parent)) || nodeByName.get(String(fm.parent).toLowerCase());
    }
    if (!mountNode) {
      // topic 降级：极限/函数极限 → 找含"函数极限"的节点
      const topicParts = String(fm.topic).split("/");
      const keyword = topicParts[topicParts.length - 1]; // 如 "函数极限"
      for (const [name, node] of nodeByName) {
        if (name.includes(keyword)) { mountNode = node; break; }
      }
    }
    if (!mountNode) mountNode = rootNode; // 兜底挂根
    mountNode.children!.push(flashNode);
    flashNodes.push(flashNode);
  }

  // ========== 3. 读 Error ==========
  const errorFolder = app.vault.getAbstractFileByPath(settings.errorFolder);
  const errorFiles: TFile[] = [];
  if (errorFolder instanceof TFolder) {
    for (const f of errorFolder.children) {
      if (f instanceof TFile && f.extension === "md") errorFiles.push(f);
    }
  }

  // flash name → node 查找表
  const flashByName = new Map<string, RingNode>();
  flashNodes.forEach(fn => {
    flashByName.set(fn.name, fn);
    flashByName.set(fn.name.toLowerCase(), fn);
  });

  for (const f of errorFiles) {
    const content = await app.vault.read(f);
    const fm = parseFrontmatter(content);
    if (!fm.topic || !String(fm.topic).includes(topicKeyword)) continue;
    const errorNode: RingNode = {
      name: fm.title || f.basename,
      type: "Error",
      _filePath: f.path,
      children: []
    };
    // 挂载点：正文 %%[[flash名]]%% 链接
    const links = extractWikilinks(content);
    let mounted = false;
    for (const link of links) {
      const flashNode = flashByName.get(link) || flashByName.get(link.toLowerCase());
      if (flashNode) {
        flashNode.children!.push(errorNode);
        mounted = true;
        break;
      }
    }
    if (!mounted) {
      // 兜底：挂到第一个 flash
      if (flashNodes.length > 0) flashNodes[0].children!.push(errorNode);
    }
  }

  return rootNode;
}

// 递归收集文件夹下所有 md
function collectMarkdownFiles(folder: TFolder, out: TFile[]) {
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      // 排除配置/索引文件（0_ 和 1x_ 开头）
      const base = child.name.replace(/\.md$/, "");
      if (/^0_/.test(base) || /^1[0-9]_/.test(base)) continue;
      out.push(child);
    } else if (child instanceof TFolder) {
      collectMarkdownFiles(child, out);
    }
  }
}

// ========== G6 数据转换 ==========

export interface G6Node {
  id: string;
  label: string;
  type?: string;
  size?: number;
  style?: any;
  labelCfg?: any;
  _filePath?: string;
  _originalType?: string; // 保留原始类型信息
  level?: number; // 层级：0=根, 1=章节, 2=MOC/知识点, 3=碎片, 4=错题
  chapterId?: string; // 所属章节节点 id（level≤1 用自身 id）
  x?: number;
  y?: number;
  collapsed?: boolean;
}

export interface G6Edge {
  source: string;
  target: string;
  style?: any;
}

export interface G6Data {
  nodes: G6Node[];
  edges: G6Edge[];
}

// 将 RingNode 树结构转换为 G6 的 nodes/edges 格式
export function convertToG6Data(rootNode: RingNode): G6Data {
  const nodes: G6Node[] = [];
  const edges: G6Edge[] = [];
  const nodeIdMap = new Map<string, string>(); // name -> id

  // 递归遍历树，生成节点和边
  let nodeIdCounter = 0;
  const generateNodeId = (name: string): string => {
    if (nodeIdMap.has(name)) {
      return nodeIdMap.get(name)!;
    }
    const id = `node_${nodeIdCounter++}`;
    nodeIdMap.set(name, id);
    return id;
  };

  const traverse = (node: RingNode, parentId: string | null = null, chapterId: string | null = null) => {
    const nodeId = generateNodeId(node.name);

    // 按层级着色：0=根, 1=章节, 2=MOC/知识点, 3=碎片, 4=错题
    let level = 0;
    if (node.type === "root") level = 0;
    else if (node.type === "chapter") level = 1;
    else if (node.type === "MOC" || node.type.startsWith("moc")) level = 2;
    else if (node.type === "Frag") level = 3;
    else if (node.type === "Error") level = 4;
    else level = 2;

    // level≤1 的节点（根/章节）作为自己后代归属的章节，向下传
    const myChapter = level <= 1 ? nodeId : (chapterId || nodeId);

    // 按层级颜色映射
    const levelColorMap: Record<number, { fill: string; stroke: string; shadowBlur: number }> = {
      0: { fill: "#f0a94f", stroke: "#c4883f", shadowBlur: 12 }, // 根节点：金色
      1: { fill: "#4f8ff7", stroke: "#3d7bd4", shadowBlur: 8 },  // 章节：蓝色
      2: { fill: "#4fd1c5", stroke: "#3db8ad", shadowBlur: 0 },  // 知识点：青色
      3: { fill: "#e06c75", stroke: "#c4555e", shadowBlur: 0 },  // 碎片：暗红
      4: { fill: "#c678dd", stroke: "#a35bb8", shadowBlur: 0 },  // 错题：粉紫（区别于碎片暗红）
    };

    const color = levelColorMap[level] || levelColorMap[2];

    // 按层级差异化节点大小和文字
    const levelConfig = [
      { size: 32, font: 13, opacity: 1 },      // 0 根
      { size: 22, font: 10, opacity: 1 },       // 1 章节
      { size: 14, font: 9, opacity: 0.85 },    // 2 知识点
      { size: 9, font: 0, opacity: 0 },         // 3 碎片/错题默认隐藏文字
    ][Math.min(level, 3)];

    const g6Node: G6Node = {
      id: nodeId,
      label: node.name,
      // ponytail: 不设 type，让 G6 的 defaultNode.type('wrapped-label-node') 生效；否则硬编码 circle 会覆盖它
      size: levelConfig.size,
      style: {
        fill: color.fill,
        stroke: color.stroke,
        lineWidth: level <= 1 ? 2 : 1,
        shadowColor: color.fill,
        shadowBlur: color.shadowBlur,
      },
      labelCfg: {
        style: {
          fontSize: levelConfig.font,
          fill: "#d0d0d0",
          opacity: levelConfig.opacity,
        },
        position: 'bottom',
      },
      _filePath: node._filePath,
      _originalType: node.type,
      level: level, // 添加层级字段
      chapterId: myChapter, // 扇区布局按此归扇区
    };

    nodes.push(g6Node);

    // 如果有父节点，创建边
    if (parentId) {
      edges.push({
        source: parentId,
        target: nodeId,
        style: {
          stroke: "#999",
          lineWidth: 1,
          endArrow: false
        }
      });
    }

    // 递归处理子节点（把当前章节 id 传下去）
    if (node.children && node.children.length > 0) {
      node.children.forEach(child => traverse(child, nodeId, myChapter));
    }
  };

  traverse(rootNode);

  return { nodes, edges };
}

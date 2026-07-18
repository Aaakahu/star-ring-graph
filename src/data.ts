// 数据管道：从 vault 读思维树 + Flash/Error 卡片，按 frontmatter 双链组装树结构。
// 挂载证据来自 StudyGuide 写入的 frontmatter 字段（mindtree / flash），不运行时重算匹配。
// 文档参考：MOUNTING_DESIGN.md
import { App, TFile, TFolder } from "obsidian";

// 星环节点类型
export interface RingNode {
  name: string;
  type: string;        // root / chapter / moc1..mocN / flash / error
  children?: RingNode[];
  _filePath?: string;  // 对应的 md 文件路径（用于点击打开）
  _auxLinks?: string[]; // 辅助连线目标 basename 列表（mindtree[1..] 或 flash[1..]，不进树结构，只画装饰边）
}

// 思维树前缀 → {depth, 父前缀}
function parsePrefix(name: string): { nums: number[]; depth: number; parentKey: string | null } | null {
  const base = name.split("/").pop()!.replace(/\.md$/, "");
  const m = base.match(/^(\d+(?:\.\d+)*)_/);
  if (!m) return null;
  const nums = m[1].split(".").map(Number);
  const depth = nums.length;
  const parentKey = depth > 1 ? nums.slice(0, -1).join(".") : null;
  return { nums, depth, parentKey };
}

// 解析 frontmatter（简易 YAML 解析，只取顶层 key:value + 列表项）
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

// depth → type 映射
function depthToType(depth: number): string {
  if (depth === 0) return "root";
  if (depth === 1) return "chapter";
  return "moc" + (depth - 1);  // moc1, moc2, moc3...
}

// wikilink 字符串 → basename。 "[[2.3.4_泰勒公式展开]]" → "2.3.4_泰勒公式展开"
const wikilinkToBasename = (wl: string): string => {
  const m = wl.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
  return m ? m[1].trim() : wl.trim();
};

// 递归收集文件夹下所有 md（排除 0_ 思维树根文件，文档 §2.3 要求排除）
function collectMarkdownFiles(folder: TFolder, out: TFile[]) {
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      const base = child.name.replace(/\.md$/, "");
      if (/^0_/.test(base)) continue; // 思维树根（0_思维树.md）不参与挂载/显示
      out.push(child);
    } else if (child instanceof TFolder) {
      collectMarkdownFiles(child, out);
    }
  }
}

// ============ 单源构建 ============
// 一个 source = { mocFolder, flashFolder, errorFolder }
// 返回该源的根 RingNode（章封面作根，或合成根）
interface SourceConfig { name: string; mocFolder: string; flashFolder: string; errorFolder: string; }

async function buildSourceTree(app: App, src: SourceConfig): Promise<RingNode | null> {
  // ========== 1. 读思维树 ==========
  const mocFolder = app.vault.getAbstractFileByPath(src.mocFolder);
  const mindTreeFiles: TFile[] = [];
  if (mocFolder instanceof TFolder) collectMarkdownFiles(mocFolder, mindTreeFiles);

  if (mindTreeFiles.length === 0) return null;

  // mtMap: prefix → { node, parentKey, file }
  interface MTNode { node: RingNode; parentKey: string | null; file: TFile; basename: string }
  const mtMap = new Map<string, MTNode>();
  let chapterCover: RingNode | null = null; // 章封面（如 2_(01-A) 极限与无穷小）作根

  for (const f of mindTreeFiles) {
    const parsed = parsePrefix(f.path);
    const base = f.name.replace(/\.md$/, "");
    if (!parsed) {
      // 无标准前缀 → 章封面（如 2_(01-A)...），作根。若已有根，跳过多余的
      if (!chapterCover) {
        chapterCover = { name: base.replace(/^[\d.]*[_\s]*/, "").replace(/^\([\dA-Z\-]+\)\s*/, "") || base, type: "root", _filePath: f.path, children: [] };
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
      parentKey: parsed.parentKey,
      file: f,
      basename: base,  // 含前缀的 basename，用于匹配 wikilink
    });
  }

  // 合成根（无章封面时兜底）
  const rootNode: RingNode = chapterCover || { name: src.name, type: "root", children: [] };

  // 组装父子关系
  for (const [, mt] of mtMap) {
    if (mt.parentKey && mtMap.has(mt.parentKey)) {
      mtMap.get(mt.parentKey)!.node.children!.push(mt.node);
    } else {
      // 父不在 map（如 2.1 的父是 root 章），挂根
      rootNode.children!.push(mt.node);
    }
  }

  // basename → RingNode 查找表（用于 Flash.mindtree 匹配 MOC）
  // 含前缀 basename（"2.3.4_泰勒公式展开"）和纯标题名（"泰勒公式展开"）都建索引
  const mocByBasename = new Map<string, RingNode>();
  for (const [, mt] of mtMap) {
    mocByBasename.set(mt.basename, mt.node);
    mocByBasename.set(mt.basename.toLowerCase(), mt.node);
  }

  // ========== 2. 读 Flash ==========
  const flashFolder = app.vault.getAbstractFileByPath(src.flashFolder);
  const flashFiles: TFile[] = [];
  if (flashFolder instanceof TFolder) {
    for (const f of flashFolder.children) {
      if (f instanceof TFile && f.extension === "md") flashFiles.push(f);
    }
  }

  // flash basename → RingNode（供 Error.flash 匹配）
  const flashByBasename = new Map<string, RingNode>();

  for (const f of flashFiles) {
    const content = await app.vault.read(f);
    const fm = parseFrontmatter(content);
    // 挂载目标来自 frontmatter 的 mindtree 字段（文档 §5.2）
    const mindtree: string[] = Array.isArray(fm.mindtree) ? fm.mindtree : [];
    if (mindtree.length === 0) continue; // 文档 §4.3：无匹配不挂载

    const flashNode: RingNode = {
      name: fm.title || f.basename,
      type: "flash",
      _filePath: f.path,
      children: []
    };

    // 主挂：mindtree[0] → MOC 节点
    const primaryTarget = wikilinkToBasename(mindtree[0]);
    const primaryMoc = mocByBasename.get(primaryTarget) || mocByBasename.get(primaryTarget.toLowerCase());
    if (!primaryMoc) continue; // 目标 MOC 不存在（可能跨学科），跳过

    primaryMoc.children!.push(flashNode);

    // 辅连线：mindtree[1..4] 记录到 _auxLinks，后续转成 aux 边
    if (mindtree.length > 1) {
      flashNode._auxLinks = mindtree.slice(1).map(wikilinkToBasename);
    }

    flashByBasename.set(f.basename, flashNode);
    flashByBasename.set(f.basename.toLowerCase(), flashNode);
  }

  // ========== 3. 读 Error ==========
  const errorFolder = app.vault.getAbstractFileByPath(src.errorFolder);
  const errorFiles: TFile[] = [];
  if (errorFolder instanceof TFolder) {
    for (const f of errorFolder.children) {
      if (f instanceof TFile && f.extension === "md") errorFiles.push(f);
    }
  }

  for (const f of errorFiles) {
    const content = await app.vault.read(f);
    const fm = parseFrontmatter(content);
    // 挂载目标来自 frontmatter 的 flash 字段（文档 §5.3）
    const flashLinks: string[] = Array.isArray(fm.flash) ? fm.flash : [];
    if (flashLinks.length === 0) continue; // 无匹配不挂载

    const errorNode: RingNode = {
      name: fm.title || f.basename,
      type: "error",
      _filePath: f.path,
      children: []
    };

    // 主挂：flash[0] → Flash 节点
    const primaryTarget = wikilinkToBasename(flashLinks[0]);
    const primaryFlash = flashByBasename.get(primaryTarget) || flashByBasename.get(primaryTarget.toLowerCase());
    if (!primaryFlash) continue; // 目标 Flash 不存在，跳过

    primaryFlash.children!.push(errorNode);

    // 辅连线：flash[1..2] → 其他 Flash 节点
    if (flashLinks.length > 1) {
      errorNode._auxLinks = flashLinks.slice(1).map(wikilinkToBasename);
    }
    // 注意：Error.mindtree 字段不读、不画边（图谱不画 Error→MOC 参考边，方案 Y 共识）
  }

  return rootNode;
}

// ============ 主入口：合并多源 ============
export async function buildChapterTree(app: App, settings: any): Promise<RingNode> {
  const sources: SourceConfig[] = settings.sources || [];
  if (sources.length === 0) {
    return { name: "空", type: "root", children: [] };
  }

  // 单源：直接返回该源根
  if (sources.length === 1) {
    const tree = await buildSourceTree(app, sources[0]);
    return tree || { name: sources[0].name, type: "root", children: [] };
  }

  // 多源：合成根，各源作为子树
  const syntheticRoot: RingNode = { name: "Vault", type: "root", children: [] };
  for (const src of sources) {
    const tree = await buildSourceTree(app, src);
    if (tree) syntheticRoot.children!.push(tree);
  }
  return syntheticRoot;
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
  _originalType?: string;
  level?: number;
  chapterId?: string;
  x?: number;
  y?: number;
  collapsed?: boolean;
}

export interface G6Edge {
  source: string;
  target: string;
  style?: any;
  relation?: 'tree' | 'aux';  // tree=父子结构边（参与布局），aux=辅连线装饰边（不参与布局）
}

export interface G6Data {
  nodes: G6Node[];
  edges: G6Edge[];
}

// 将 RingNode 树结构转换为 G6 的 nodes/edges 格式
export function convertToG6Data(rootNode: RingNode): G6Data {
  const nodes: G6Node[] = [];
  const edges: G6Edge[] = [];
  // id 纯自增：同名节点（不同 Flash 卡同名、不同源同名 MOC）也分配独立 id。
  // 旧版用 name 去重会导致 G6 报 "id node_X is unique" 警告，第二个同名节点被吞。
  let nodeIdCounter = 0;
  const generateNodeId = (): string => `node_${nodeIdCounter++}`;
  // basename → id（辅连线目标用 basename 匹配；同名取最后注册的，是合理 fallback）
  const idByBasename = new Map<string, string>();

  // 先收集所有节点 id（含 basename 索引），再处理辅连线
  const nodeMeta: { node: RingNode; id: string; basename: string }[] = [];

  const traverse = (node: RingNode, parentId: string | null = null, chapterId: string | null = null) => {
    const nodeId = generateNodeId();

    // basename 从 _filePath 推（含前缀的文件名，MOC 辅连线匹配用）
    const basename = node._filePath ? node._filePath.split("/").pop()!.replace(/\.md$/, "") : node.name;
    idByBasename.set(basename, nodeId);
    idByBasename.set(basename.toLowerCase(), nodeId);
    nodeMeta.push({ node, id: nodeId, basename });

    let level = 0;
    if (node.type === "root") level = 0;
    else if (node.type === "chapter") level = 1;
    else if (node.type === "MOC" || node.type.startsWith("moc")) level = 2;
    else if (node.type === "flash") level = 3;
    else if (node.type === "error") level = 4;
    else level = 2;

    const myChapter = level <= 1 ? nodeId : (chapterId || nodeId);

    const levelColorMap: Record<number, { fill: string; stroke: string; shadowBlur: number }> = {
      0: { fill: "#f0a94f", stroke: "#c4883f", shadowBlur: 12 },
      1: { fill: "#4f8ff7", stroke: "#3d7bd4", shadowBlur: 8 },
      2: { fill: "#4fd1c5", stroke: "#3db8ad", shadowBlur: 10 },
      3: { fill: "#e06c75", stroke: "#c4555e", shadowBlur: 0 },  // flash：暗红
      4: { fill: "#c678dd", stroke: "#a35bb8", shadowBlur: 0 },  // error：粉紫
    };
    const color = levelColorMap[level] || levelColorMap[2];

    const levelConfig = [
      { size: 32, font: 13, opacity: 1 },
      { size: 22, font: 10, opacity: 1 },
      { size: 14, font: 9, opacity: 0.85 },
      { size: 9, font: 0, opacity: 0 },
    ][Math.min(level, 3)];

    nodes.push({
      id: nodeId,
      label: node.name,
      size: levelConfig.size,
      style: {
        fill: color.fill,
        stroke: color.stroke,
        lineWidth: level <= 1 ? 2 : 1,
        shadowColor: color.fill,
        shadowBlur: color.shadowBlur,
      },
      labelCfg: {
        style: { fontSize: levelConfig.font, fill: "#d0d0d0", opacity: levelConfig.opacity },
        position: 'bottom',
      },
      _filePath: node._filePath,
      _originalType: node.type,
      level,
      chapterId: myChapter,
    });

    if (parentId) {
      edges.push({ source: parentId, target: nodeId, relation: 'tree' });
    }

    if (node.children && node.children.length > 0) {
      node.children.forEach(child => traverse(child, nodeId, myChapter));
    }
  };

  traverse(rootNode);

  // 辅连线：遍历每个节点的 _auxLinks，转成 aux 边
  // 目标可能不在当前图里（跨学科、文件不存在），找不到就跳过
  for (const { node, id } of nodeMeta) {
    if (!node._auxLinks || node._auxLinks.length === 0) continue;
    for (const targetBasename of node._auxLinks) {
      const targetId = idByBasename.get(targetBasename) || idByBasename.get(targetBasename.toLowerCase());
      if (targetId && targetId !== id) {
        edges.push({ source: id, target: targetId, relation: 'aux' });
      }
    }
  }

  // _hasCloud halo 标记（保留原逻辑：MOC 有 level≥3 后代则发光）
  const childrenOf = new Map<string, string[]>();
  edges.forEach(e => {
    if (e.relation !== 'tree') return; // 辅连线不参与 halo 判定
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)!.push(e.target);
  });
  const hasCloudDescendant = (startId: string): boolean => {
    const queue: string[] = [startId];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const n = nodes.find(x => x.id === cur);
      if (n && cur !== startId && (n.level ?? 0) >= 3) return true;
      (childrenOf.get(cur) || []).forEach(c => queue.push(c));
    }
    return false;
  };
  nodes.forEach(n => {
    if ((n.level ?? 0) === 2) (n as any)._hasCloud = hasCloudDescendant(n.id);
  });

  return { nodes, edges };
}

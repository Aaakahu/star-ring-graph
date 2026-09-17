// MOC 文件 frontmatter 自动批量生成
// 用法:
//   node scripts/gen-moc-frontmatter.mjs <vaultRoot>           生成 frontmatter
//   node scripts/gen-moc-frontmatter.mjs --clean <vaultRoot>   清除脚本生成的 moc frontmatter（保留手写的）
// 扫描 1_高等数学Moc/ 下所有 .md（排除 0_思维树.md），从文件名前缀 + 正文内联 tag + Flash 卡反查
// 自动生成 type/chapter/section/title/topic/tags frontmatter，写到文件头部。
// 已有 frontmatter 的文件跳过（不覆盖）。

import fs from 'fs';
import path from 'path';

const isCleanMode = process.argv[2] === '--clean';
const vaultRoot = isCleanMode ? process.argv[3] : process.argv[2];
if (!vaultRoot) {
  console.error('用法: node scripts/gen-moc-frontmatter.mjs [--clean] <vaultRoot>');
  process.exit(1);
}

const MOC_FOLDER = '1_高等数学Moc';
const FLASH_FOLDER = 'StudyGuide/Flash';
const mocDir = path.join(vaultRoot, MOC_FOLDER);
const flashDir = path.join(vaultRoot, FLASH_FOLDER);

// ===== 工具函数（和 fts.ts 对齐）=====

// 简易 YAML frontmatter 解析（只取顶层 key:value + 列表项）
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null; // null = 无 frontmatter
  const fm = {};
  let curKey = '';
  let inList = false;
  for (const line of m[1].split(/\r?\n/)) {
    const listMatch = line.match(/^\s*-\s+(.+)/);
    if (listMatch && curKey && inList) {
      if (!Array.isArray(fm[curKey])) fm[curKey] = [];
      fm[curKey].push(listMatch[1].trim().replace(/^"(.*)"$/, '$1').replace(/^\[\[(.+)\]\]$/, '$1'));
      continue;
    }
    const kv = line.match(/^([^:#\s][^:]*):\s*(.*)$/);
    if (kv) {
      curKey = kv[1].trim();
      const val = kv[2].trim().replace(/^"(.*)"$/, '$1');
      if (val === '' || val === '[]') {
        fm[curKey] = val === '[]' ? [] : '';
        inList = true;
      } else if (val.startsWith('[') && val.endsWith(']')) {
        fm[curKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
        inList = false;
      } else {
        fm[curKey] = val;
        inList = false;
      }
    }
  }
  return fm;
}

function stripPrefix(name) {
  return name.replace(/^[\d.]+_/, '');
}

function chapterFromPrefix(name) {
  const m = name.match(/^\W*(\d+)((?:\.\d+)*)/);
  if (!m) return ['', ''];
  return [m[1], m[1] + (m[2] || '')];
}

// wikilink → basename
function wikilinkToBasename(wl) {
  const m = wl.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
  return m ? m[1].trim() : wl.trim().replace(/^\[\[|\]\]$/g, '').trim();
}

// 正文提取内联 #tag（Obsidian 格式，排除标题 # 和颜色 #xxx=）
function extractInlineTags(body) {
  const tags = new Set();
  // 匹配 #中文/英文/数字 标签，排除标题行(## ###)和 hex color(#ffffff)
  const re = /(?:^|\s)#([^\s#{][^\s{#]+)/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    let tag = m[1].replace(/[，。、！？；：]/g, '');
    // 过滤纯数字、太短、含 LaTeX 符号的
    if (tag.length >= 2 && !/^\d+$/.test(tag) && !/[{}\\]/.test(tag)) {
      tags.add(tag);
    }
  }
  return [...tags];
}

// 标题分词：按顿号/逗号/空格/破折号拆
function splitTitleWords(title) {
  return title
    .split(/[、，,/\-—－·]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && !/^\d+$/.test(s));
}

// ===== Pass 0: 读所有 Flash 卡，建 basename → { topic, tags } 映射 =====
const flashMeta = new Map(); // mocBasename → [{ topic, tags }]
function loadFlashData() {
  if (!fs.existsSync(flashDir)) {
    console.warn(`Flash 文件夹不存在: ${flashDir}`);
    return;
  }
  const files = fs.readdirSync(flashDir).filter(f => f.endsWith('.md'));
  for (const f of files) {
    const content = fs.readFileSync(path.join(flashDir, f), 'utf-8');
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    const mindtree = Array.isArray(fm.mindtree) ? fm.mindtree : [];
    const topic = typeof fm.topic === 'string' ? fm.topic : '';
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    // 只取主挂点（mindtree[0]）反查——辅连线（mindtree[1..]）只是"有关联"，
    // 不代表那个 MOC 的主题就是这张卡的 tags。用辅连线反查会把宽泛章节（如 2.1_极限）
    // 污染上不相关的 tags（如"泰勒展开""变上限积分"）。
    if (mindtree.length > 0) {
      const basename = wikilinkToBasename(String(mindtree[0]));
      if (!flashMeta.has(basename)) flashMeta.set(basename, []);
      flashMeta.get(basename).push({ topic, tags });
    }
  }
  console.log(`读取 ${files.length} 张 Flash 卡，建立 ${flashMeta.size} 个 MOC → Flash 反查映射`);
}

// 多数投票取 topic
function voteTopic(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!e.topic) continue;
    counts.set(e.topic, (counts.get(e.topic) || 0) + 1);
  }
  if (counts.size === 0) return '';
  let best = '', bestCount = 0;
  for (const [t, c] of counts) {
    if (c > bestCount) { best = t; bestCount = c; }
  }
  return best;
}

// ===== Pass 1: 扫描 MOC 文件，生成 frontmatter =====
let processed = 0, skipped = 0, noPrefix = 0;
const stats = { totalTags: 0, withTopic: 0, withInlineTags: 0 };

function processMocFiles() {
  const files = fs.readdirSync(mocDir).filter(f => f.endsWith('.md'));
  console.log(`扫描到 ${files.length} 个 MOC 文件`);

  for (const f of files) {
    const filePath = path.join(mocDir, f);
    const basename = f.replace(/\.md$/, '');
    const content = fs.readFileSync(filePath, 'utf-8');

    // 跳过 0_思维树.md
    if (f === '0_思维树.md') { skipped++; continue; }

    // 已有 frontmatter → 跳过
    if (parseFrontmatter(content) !== null) {
      skipped++;
      continue;
    }

    // 从文件名推 chapter/section/title
    const [chapter, section] = chapterFromPrefix(basename);
    if (!chapter) { noPrefix++; continue; } // 无标准前缀（如 N_(01-A) 章封面），跳过
    const title = stripPrefix(basename);

    // 正文（去可能的残留）
    const body = content.replace(/^---[\s\S]*?---/, '').trim();

    // 提取 tags：三来源合并
    const tagSet = new Set();

    // 来源 1: 正文内联 #tag
    const inlineTags = extractInlineTags(body);
    inlineTags.forEach(t => tagSet.add(t));
    if (inlineTags.length > 0) stats.withInlineTags++;

    // 来源 2: Flash 卡 tags 反查
    const flashEntries = flashMeta.get(basename) || [];
    for (const e of flashEntries) {
      e.tags.forEach(t => tagSet.add(t));
    }

    // 来源 3: 标题分词
    splitTitleWords(title).forEach(t => tagSet.add(t));

    // 过滤通用无意义 tag
    const STOP_TAGS = new Set(['烤鸭数学', '数学', '考研', '高数']);
    const tags = [...tagSet].filter(t => !STOP_TAGS.has(t));

    // topic: Flash 卡反查多数投票
    const topic = voteTopic(flashEntries);
    if (topic) stats.withTopic++;

    stats.totalTags += tags.length;

    // 生成 frontmatter YAML
    const fm = [
      '---',
      'type: moc',
      `chapter: ${chapter}`,
      `section: "${section}"`,
      `title: "${title.replace(/"/g, '\\"')}"`,
    ];
    if (topic) fm.push(`topic: "${topic}"`);
    if (tags.length > 0) {
      fm.push('tags:');
      tags.forEach(t => fm.push(`  - ${t}`));
    } else {
      fm.push('tags: []');
    }
    fm.push('---', '');

    const newContent = fm.join('\n') + '\n' + content;
    fs.writeFileSync(filePath, newContent, 'utf-8');
    processed++;
  }
}

// ===== --clean 模式：清除脚本生成的 moc frontmatter =====
let cleaned = 0;
function cleanMocFrontmatter() {
  const files = fs.readdirSync(mocDir).filter(f => f.endsWith('.md'));
  console.log(`扫描到 ${files.length} 个 MOC 文件`);
  for (const f of files) {
    if (f === '0_思维树.md') continue;
    const filePath = path.join(mocDir, f);
    const content = fs.readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    // 只删 type=moc 的 frontmatter（脚本生成的）；手写的非 moc frontmatter 保留
    if (fm && fm.type === 'moc') {
      const body = content.replace(/^---[\s\S]*?---\r?\n?/, '');
      fs.writeFileSync(filePath, body, 'utf-8');
      cleaned++;
    }
  }
}

// ===== 主流程 =====
console.log(`Vault root: ${vaultRoot}`);
console.log(`MOC dir: ${mocDir}`);
console.log('');

if (isCleanMode) {
  cleanMocFrontmatter();
  console.log('');
  console.log(`===== 清除完成: ${cleaned} 个文件已去掉 moc frontmatter =====`);
  process.exit(0);
}

loadFlashData();
processMocFiles();

console.log('');
console.log('===== 统计 =====');
console.log(`处理: ${processed} 个文件`);
console.log(`跳过(已有 frontmatter / 配置文件): ${skipped} 个`);
console.log(`跳过(无前缀): ${noPrefix} 个`);
console.log(`有 topic: ${stats.withTopic} 个`);
console.log(`有内联 tag: ${stats.withInlineTags} 个`);
console.log(`总 tag 数: ${stats.totalTags}`);

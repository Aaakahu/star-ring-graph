// 给缺 mindtree 的 flash 卡补挂载点
// 规则：按标题关键词 + topic + tags 匹配到最具体的 MOC
// 用法：node scripts/fix-flash-mindtree.mjs --dry-run（预览） / 无参数（落盘）
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const VAULT = 'C:/Users/34547/Desktop/新版sg构建测试';
const FLASH_DIR = join(VAULT, 'StudyGuide/Flash');

// 标题关键词 → MOC 映射（优先级从上到下，先匹配先用）
const TITLE_RULES = [
  // 精确方法类
  [/泰勒/, '2.3.4_泰勒公式展开'],
  [/洛必达/, '2.3.3_洛必达法则'],
  [/夹逼/, '2.1.1.2.4_夹逼准则和单调有界定理'],
  [/定积分定义|定积分.*定义/, '5.1_定积分的定义'],
  // 等价无穷小类（代换/构造/条件/加减法）
  [/等价无穷小/, '2.3.2_等价无穷小、无穷大代换'],
  [/幂指函数/, '2.3_函数极限代换'],
  [/连续性/, '2.4_连续函数与间断点'],
  [/无穷远|负无穷|趋向无穷/, '2.1_极限'],
  // 数列极限类
  [/自然常数e|数列.*极限/, '2.1.1_数列极限'],
  // 兜底：按 topic 分流
];

// topic → MOC 兜底映射
const TOPIC_FALLBACK = {
  '极限/函数极限': '2.1_极限',
  '极限/数列极限': '2.1.1_数列极限',
  '极限/无穷小比较': '2.3.2_等价无穷小、无穷大代换',
  '积分/定积分': '5.1_定积分的定义',
};

const isDry = process.argv.includes('--dry-run');

const files = readdirSync(FLASH_DIR).filter(f => f.endsWith('.md'));
const results = [];

for (const file of files) {
  const path = join(FLASH_DIR, file);
  const content = readFileSync(path, 'utf-8');

  // 已有 mindtree 的跳过
  if (/^mindtree:/m.test(content)) continue;

  // 解析 frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;
  const fm = fmMatch[1];

  const topicMatch = fm.match(/^topic:\s*(.+)$/m);
  const topic = topicMatch ? topicMatch[1].trim() : '';

  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, '');

  // 规则匹配
  let moc = '';
  for (const [re, m] of TITLE_RULES) {
    if (re.test(title)) { moc = m; break; }
  }
  if (!moc && topic) {
    moc = TOPIC_FALLBACK[topic] || '';
  }

  if (!moc) {
    results.push({ file, title, topic, moc: '⚠️ 未匹配', action: 'skip' });
    continue;
  }

  results.push({ file, title, topic, moc, action: 'add' });
}

// 输出映射表
console.log(`\n${isDry ? '【预览】' : '【落盘】'}${results.length} 张缺 mindtree 的 flash 卡：\n`);
for (const r of results) {
  const flag = r.action === 'skip' ? '⚠️ ' : '  ';
  console.log(`${flag}${r.title}`);
  console.log(`     topic: ${r.topic}`);
  console.log(`     → mindtree[0]: [[${r.moc}]]\n`);
}

if (isDry) {
  console.log('预览模式，未修改文件。去掉 --dry-run 落盘。');
  process.exit(0);
}

// 落盘：在 frontmatter 末尾（--- 之前）插入 mindtree
let modified = 0;
for (const r of results) {
  if (r.action === 'skip') continue;
  const path = join(FLASH_DIR, r.file);
  let content = readFileSync(path, 'utf-8');
  // 在 frontmatter 的 --- 之前插入 mindtree（如果 frontmatter 最后一行是 tags: 空或 errors:，插在 --- 前）
  const mindtreeBlock = `mindtree:\n  - "[[${r.moc}]]"`;
  content = content.replace(/^---\n([\s\S]*?)\n---/m, (match, fm) => {
    // 如果 fm 末尾有 errors: [] 之类，插在 errors 后；否则追加到末尾
    if (/^errors:/m.test(fm)) {
      return match.replace(/^(errors:.*)$/m, `$1\n${mindtreeBlock}`);
    }
    return `---\n${fm}\n${mindtreeBlock}\n---`;
  });
  writeFileSync(path, content, 'utf-8');
  modified++;
}
console.log(`✓ 已修改 ${modified} 个文件。`);

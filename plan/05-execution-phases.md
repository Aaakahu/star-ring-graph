# 执行阶段（6 阶段，从零开始）

> 每阶段完成后：git commit + git tag + 物理备份（用户要求）。
> 文件路径都相对于插件根目录 `star-ring-graph/`。

## 阶段 0：备份 + 部署 LightRAG 后端

### 0.1 初始备份（执行任何代码前必做）
```bash
# 物理备份
cp -r . "../star-ring-graph.backup.$(date +%Y%m%d_%H%M%S)"
rm -rf "../star-ring-graph.backup.*/node_modules"  # 省 space

# git 备份分支 + tag
git checkout -b backup/pre-lightrag-retry
git add -A && git commit -m "Backup before LightRAG integration retry"
git tag pre-lightrag-retry-backup
git checkout main  # 回主分支继续工作
```

### 0.2 部署 LightRAG 后端

**前置**：先读 `04-environment-pitfalls.md`（坑 1-3，避免装包失败）。

```bash
# 1. 建虚拟环境（必须用官方 Python 3.11，不是 MSYS2）
PY="C:/Users/34547/AppData/Local/Programs/Python/Python311/python.exe"
mkdir -p lightrag && "$PY" -m venv lightrag/venv

# 2. 装 lightrag-hku（包名不是 lightrag）
lightrag/venv/Scripts/python.exe -m pip install --upgrade pip
lightrag/venv/Scripts/python.exe -m pip install "lightrag-hku[api]"

# 3. 验证
lightrag/venv/Scripts/python.exe -c "from lightrag.api import lightrag_server; print('OK')"
lightrag/venv/Scripts/python.exe -c "import nano_vectordb, openai; print('deps OK')"
```

### 0.3 交付物
- `lightrag/venv/`（官方 Python 3.11.9 + lightrag-hku[api] 1.5.4）
- `lightrag/.env.minimal`（模板，LLM 字段留空，**变量名用 `LLM_BINDING_HOST`**）
- `lightrag/restart.sh`（重启脚本：停旧→起新→轮询 /health）
- `lightrag/README.md`（部署文档）

### 0.4 验证
```bash
cd lightrag && cp .env.minimal .env && bash restart.sh
# 期望：2 秒内 server 就绪，curl /health 返回 200，status: healthy
```

### 0.5 备份
```bash
git add -A && git commit -m "阶段0完成：部署 LightRAG 后端"
git tag stage0-lightrag-deployed
```

`.gitignore` 排除：`lightrag/venv/`、`lightrag/.env`、`lightrag/rag_storage/`、`lightrag/inputs/`、`lightrag/__pycache__/`、`lightrag/*.pyc`、`lightrag/ingest_state.json`、`lightrag/lightrag.{pid,log}`。

---

## 阶段 2：插件设置面板（方案 B 核心）

### 改 `src/main.ts`

1. `StarRingSettings` 接口加字段：
   ```typescript
   lightragUrl: string;      // 默认 http://127.0.0.1:9620
   llmApiKey: string;        // 密码框
   llmBaseUrl: string;       // 默认 https://open.bigmodel.cn/api/paas/v4
   llmModel: string;         // 默认 glm-4.5
   embeddingModel: string;   // 默认 embedding-3
   lightragDir: string;      // lightrag/ 绝对路径，loadSettings 时补全
   ```

2. 设置面板末尾加 "LightRAG 知识库查询" section：
   - 6 个输入框（lightragUrl / API key 密码框 / llmBaseUrl / llmModel / embeddingModel / lightragDir）
   - "应用并重启 LightRAG" 按钮（CTA 样式）

3. `applyLightragConfig()` 方法（关键）：
   - 校验目录存在 + API key 非空
   - 写 `lightrag/.env`（**变量名 `LLM_BINDING_HOST` / `EMBEDDING_BINDING_HOST`**，见坑 4）
   - `spawn("bash", [restartScript])`，30 秒超时
   - 失败时降级：提示用户手动执行 `cd lightrag && bash restart.sh`

4. `import * as fs from "fs"; import * as path from "path"; import { spawn } from "child_process";`
   esbuild 配置 `platform: "node"` 已支持这些 Node 内置模块。

### 验证
- 编译通过：`npm run build`
- Obsidian 里面板显示 6 个输入框 + 按钮
- 填 test key → 点应用 → `.env` 被写入 → server 重启 → `/health` 的 `llm_binding_host` 变成智谱 URL

### 备份
```bash
git commit -m "阶段2完成：插件设置面板 + .env 写入 + 重启"
git tag stage2-plugin-config
```

---

## 阶段 1：数据导入脚本（档1 结构提示）

### 写 `lightrag/ingest.py`

- 路径：`VAULT_ROOT = SCRIPT_DIR.parents[3]`（lightrag→star-ring-graph→plugins→.obsidian→vault）
- 收集三类卡片：`1_高等数学Moc`（MOC）/ `StudyGuide/Flash`（Flash）/ `StudyGuide/Errors`（Error）
- 档1 结构提示（见 `03-query-algorithm.md`）：
  - MOC: `【MOC 知识点：{name}，章节层级 {prefix}（第 {depth} 层）】\n\n{body}`
  - Flash: `【Flash 二级结论：{title}｜类型：{subtype}｜主题：{topic}｜挂在 MOC：{mindtree}｜相关错题：{errors}】\n\n{body}`
  - Error: `【Error 错题：{title}｜主题：{topic}｜标签：{tags}｜暴露的 Flash 套路盲点：{flash}】\n\n{body}`
- frontmatter 解析（对齐 `src/data.ts` 的 parseFrontmatter）
- 增量：mtime 记录到 `ingest_state.json`，重跑只灌新增/改动
- 分批：`POST /documents/texts`，每批 5 个，轮询 `/documents/track-status`

### 验证
```bash
cd lightrag
venv/Scripts/python.exe ingest.py --dry-run --limit 3
# 期望：找到 238 个文件（149 MOC + 52 Flash + 37 Error），打印前 2 个结构提示样本
```

### 备份
```bash
git commit -m "阶段1完成：数据导入脚本 ingest.py"
git tag stage1-ingest-script
```

---

## 阶段 3：查询浮层 UI（Astryx）

### 改 `src/view.ts` + `styles.css`

**参考实现**：`plan/reference/star-ring-preview.html`（已验证 UI 完整，CSS/DOM 1:1 抄）

1. `styles.css` 追加（见 `02-astryx-design-tokens.md`）：
   - Astryx 双主题 CSS 变量（`[data-theme="dark"]` Gothic + `[data-theme="light"]` Neutral）
   - 浮层容器 `.query-fab`
   - Input wrap（focus inset ring）
   - Button primary（active scale 0.98）
   - 自定义 Dropdown + Item（替代原生 select）
   - Chip（分类色 pill）
   - SVG icon 样式
   - 跟随 Obsidian 主题：监听 `body.theme-dark`/`body.theme-light` 切 `data-theme`

2. `src/view.ts` 的 `StarRingView.onOpen`：
   - 在 `.g6-container` 上方插入浮层 DOM（结构抄 star-ring-preview.html 的 `.query-fab`）
   - 浮层含：标题栏（可折叠）+ 输入框 + 4 动作自定义下拉 + 查询按钮 + 答案区 + 命中 chip
   - 4 动作下拉用自定义 Dropdown（不原生 select），每个动作带描述

3. SVG icon 全部 inline（零 emoji），`stroke: currentColor`

### 验证
- Obsidian 里打开星环图，浮层显示在左上
- 切换 Obsidian 明暗主题，浮层 + 星环 + 下拉全部正确变色
- 4 动作下拉可展开/收起，hover 有 overlay，selected 有 accent-muted

### 备份
```bash
git commit -m "阶段3完成：查询浮层 UI（Astryx）"
git tag stage3-query-ui
```

---

## 阶段 4：实体高亮 + 4 动作逻辑（档2 结构扩展）

### 改 `src/view.ts` 加查询逻辑（~200 行）

**参考实现**：`plan/reference/lightrag-compare.html`（4 动作逻辑可视化验证）+ `03-query-algorithm.md`（完整算法）

1. `runQuery()` 方法：
   - 并发 `requestUrl` 打 `/query`（拿答案）+ `/query/data`（拿实体名集合）
   - 用 Obsidian 内置 `requestUrl`（不用 fetch，避开 CSP）

2. `matchEntitiesToNodes()`：实体名 → 节点 basename 三级匹配
   - basename 去前缀子串包含
   - aliases 表命中
   - 兜底子串模糊

3. `expandByStructure(g6Data, hitIds, mode)`：见 `03-query-algorithm.md` 的完整代码
   - 按 ACTION_TARGET 筛选
   - 沿 mindtree 双链扩展（climbMOC / siblings / errors / flash-cause）
   - **aux 边必须过滤**（防环）

4. 命中节点复用 `graph.setItemState(node, 'active', true)`（view.ts 已有，约 1084 行）
   未命中 `inactive`（已有的 0.08 透明度）
   命中边 `active`（已有的紫色高亮）

### 防回归
`src/lightrag-algorithm.selfcheck.mjs`（纯算法自检，不依赖 G6/Obsidian）：
- `node src/lightrag-algorithm.selfcheck.mjs` 应全部通过
- 关键断言：aux 边过滤、4 动作命中范围差异化

### 验证
输入"泰勒展开"分别切 4 动作：
- 学概念：只亮 MOC + know_what Flash
- 找方法：只亮 know_how Flash
- 查错题：亮 Error + 反查 know_why Flash
- 复习专题：MOC + 全 Flash + Error 全亮

### 备份
```bash
git commit -m "阶段4完成：实体高亮 + 4 动作逻辑"
git tag stage4-query-logic
```

---

## 阶段 5：self-check（手动跑完整链路）

### 前置
**必须用户提供 GLM API key**（去 open.bigmodel.cn 申请）。其他阶段可用占位 key，本阶段必须真 key。

### 验证清单
1. **配置链路**：面板填 key → 应用 → server 重启 → `/health` 绿灯 + `llm_binding_host` 是智谱
2. **导入**：`python ingest.py --limit 5` 导入 5 篇 → 查 `/query/data` 能返回 entity_name
3. **查询答案**：浮层输入"数列极限怎么求" → 3 秒内出 GLM 答案
4. **4 动作差异化**：同查询切 4 动作，命中范围不同（见阶段 4 验证）
5. **跳转**：点高亮节点能跳原笔记（已有的 `_filePath` → `openLinkText` 链路不动）
6. **主题**：明暗切换，浮层 + 星环 + 下拉全部正确变色
7. **回归**：你原有的星环/鱼骨布局、hover 链路高亮、Alt+聚焦 全部不受影响
8. **冲突**：查询高亮与 hover 链路高亮不冲突（查询态设标志位，hover 跳过）

### 备份（最终）
```bash
git commit -m "阶段5完成：self-check 全部通过"
git tag lightrag-integration-complete
```

---

## 紧急回滚（任何阶段出问题）

```bash
# 回到某个 tag
git checkout stage0-lightrag-deployed   # 或其他 tag

# 或回到开始前
git checkout pre-lightrag-retry-backup

# 物理备份
ls -d ../star-ring-graph.backup.*
```

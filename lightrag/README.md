# LightRAG 后端部署

星环图谱插件的查询大脑。本目录运行一个本地 LightRAG server，插件通过 HTTP 调用它做实体抽取和向量检索。

## 架构

```
[Obsidian 插件面板] --填 GLM key--> [插件] --写 .env + 重启--> [LightRAG server :9620]
                                                                          |
[插件查询浮层] ---/query + /query/data---> [LightRAG server] ---抽实体/向量检索---> [GLM]
       |
       v
[星环图高亮命中节点]
```

## 首次部署

### 1. Python 环境（已建好）

虚拟环境在 `lightrag/venv/`，用**官方 Windows Python 3.11**（不是 MSYS2）：

```bash
PY="lightrag/venv/Scripts/python.exe"
"$PY" --version  # Python 3.11.9
```

> **关键**：必须用官方 MSVC 编译的 Python（`AppData/Local/Programs/Python/Python311/`）。
> LightRAG 依赖 numpy/tiktoken 等带 C 扩展的包，只有官方 Python 才能用 PyPI 预编译 wheel。
> 详见 `plan/04-environment-pitfalls.md`。

### 2. LightRAG（已装好）

```bash
PY="lightrag/venv/Scripts/python.exe"
"$PY" -m pip install "lightrag-hku[api]"
```

> **包名是 `lightrag-hku`**（HKUDS/LightRAG 官方包），不是 `lightrag`（那是 SylphAI 的同名项目）。

### 3. 配置 GLM（在插件面板填，不手动改 .env）

打开 Obsidian → 星环图谱设置面板，填：
- GLM API Key
- LLM Base URL（默认 `https://open.bigmodel.cn/api/paas/v4`）
- LLM 模型名（如 `glm-4.5`）
- Embedding 模型名（如 `embedding-3`）

点"应用并重启 LightRAG"按钮，插件会自动写入 `.env` 并重启 server。

### 4. 验证

```bash
curl http://127.0.0.1:9620/health
# 返回 status: healthy 即正常
```

## 日常使用

- **导入笔记**：`venv/Scripts/python.exe ingest.py`（增量导入 vault 的 MOC/Flash/Error）
- **查询**：在 Obsidian 星环图浮层输入问题
- **改配置**：插件面板改 → 点"应用并重启"

## 文件清单

| 文件 | 用途 |
|---|---|
| `.env.minimal` | 模板，LLM 字段留空 |
| `.env` | 实际配置，**由插件自动生成**，勿手动改 |
| `venv/` | Python 3.11 虚拟环境 |
| `rag_storage/` | 知识库索引数据（实体/关系/向量），自动生成 |
| `ingest.py` | vault 笔记导入脚本 |
| `restart.sh` | server 重启脚本（被插件调用） |

## 故障排查

### server 启动报 LLM 配置错
`.env` 的 `LLM_API_KEY` 等字段为空。回插件面板填 GLM 配置并点"应用并重启"。

### 改了配置不生效
LightRAG server 只在启动时读 `.env`。必须重启 server（插件面板的"应用并重启"按钮会自动做）。

### 变量名问题
lightrag-hku 1.5.4 用 `LLM_BINDING_HOST` / `EMBEDDING_BINDING_HOST`（不是 `LLM_BASE_URL`）。

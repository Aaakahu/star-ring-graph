# LightRAG HTTP API 契约

> 已从 lightrag-hku 1.5.4 源码逐行确认（`lightrag/api/routers/*.py`）。
> 所有路径根路径挂载（无 prefix）。

## 关键端点

| 端点 | 方法 | 用途 | 返回 |
|---|---|---|---|
| `/health` | GET | 健康检查 | `{"status":"healthy","configuration":{...}}` |
| `/query` | POST | LLM 生成答案 | `{response: "..."}` |
| `/query/data` | POST | 命中实体+关系（**不调 LLM**） | `{data:{entities,relationships,chunks}}` |
| `/documents/texts` | POST | 批量插入文本 | `{track_id, status}` |
| `/documents/track-status?track_id=` | GET | 轮询插入进度 | `{status, progressed, total}` |
| `/graph/label/list` | GET | 全实体名列表 | `["name1","name2",...]` |

## `/query` 请求体

```json
{
  "query": "泰勒展开怎么用",
  "mode": "mix"
}
```

- `mode`: `"local" | "global" | "hybrid" | "naive" | "mix" | "bypass"`，默认 `mix`
- 返回 `{response: "LLM 生成的答案文本"}`

## `/query/data` 请求体（同 `/query`）

返回结构（**核心，查询高亮的数据源**）：

```json
{
  "data": {
    "entities": [
      {
        "entity_name": "泰勒展开",      // 实体主键是名字字符串（无 ID）
        "entity_type": "CONCEPT",
        "description": "...",
        "source_id": "chunk-123",
        "file_path": "1_高等数学Moc/2.3.4_泰勒公式.md"  // 反查回原笔记的键
      }
    ],
    "relationships": [
      {
        "src_id": "泰勒展开",
        "tgt_id": "等价无穷小",
        "description": "...",
        "weight": 0.85,
        "file_path": "..."
      }
    ],
    "chunks": [{"content":"...", "file_path":"...", "chunk_id":"..."}]
  },
  "metadata": {
    "keywords": {"high_level": [...], "low_level": [...]},
    "processing_info": {"total_entities_found": N, ...}
  }
}
```

**关键点**：
- 实体主键是 `entity_name`（字符串），不是数字 ID —— 适配"实体名→节点 basename"映射
- `file_path` 来自插入时的 `file_source`，是反查回 vault 原笔记的键
- `naive` 模式 entities 通常为空（只返回 chunks）
- `global` 模式 entities 常为空（主要返回 relationships）

## `/documents/texts` 请求体（批量导入）

```json
{
  "texts": ["笔记1正文", "笔记2正文"],
  "file_sources": ["vault/笔记1.md", "vault/笔记2.md"]
}
```

- `file_sources` 与 `texts` 一一对应，**必填**（缺失返回 400）
- 返回 `{track_id: "upload_xxx", status: "success"}`
- 插入是**异步**的，用 `track_id` 轮询 `/documents/track-status`
- `file_source` 是文档唯一标识，**同名重复插入返回 409**（要先删才能重插）

## 关键约束（决定架构）

1. **LightRAG server 不支持请求级覆盖 LLM 配置** —— `/query` 和 `/documents/texts` 的请求 schema 里没有 `llm_api_key`/`llm_base_url` 字段，server 启动时从 `.env` 读一次就绑死。
   - 这是方案 B（插件写 .env + 重启）的技术依据，方案 A（请求传参）被源码证伪。
2. **无 metadata/tags 字段** —— `InsertTextsRequest` 只有 `texts`/`file_sources`/`chunking`。但 `file_source` 本身就是反查键，够用。
3. **环境变量名（lightrag-hku 1.5.4 config.py）**：
   - `LLM_BINDING_HOST`（**不是** `LLM_BASE_URL`）
   - `EMBEDDING_BINDING_HOST`（**不是** `EMBEDDING_BASE_URL`）
   - `LLM_BINDING` / `EMBEDDING_BINDING`（值如 `openai`）
   - `LLM_API_KEY` / `EMBEDDING_API_KEY`
   - `LLM_MODEL` / `EMBEDDING_MODEL`

## 实体→节点映射（三级降级）

LightRAG 抽取的实体名是 LLM 自由文本（如"数列极限"），插件节点 basename 是 `2.1.1_数列极限`。匹配策略：

1. **basename 去前缀子串包含**：`2.1.1_数列极限` 去掉前缀 → "数列极限"，含实体名即命中
2. **frontmatter aliases 表命中**：实体名 ∈ aliases（Flash 卡的 frontmatter 都写了）
3. **兜底：实体名 ≥2 字子串反向匹配节点 label**

## 调用方式（避开 Obsidian CSP）

用 Obsidian 内置 `requestUrl`（绕过 CSP），不用 `fetch`：

```typescript
import { requestUrl } from "obsidian";
const resp = await requestUrl({
  url: `${settings.lightragUrl}/query`,
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, mode }),
});
const answer = resp.json.response;
```

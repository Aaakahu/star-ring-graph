# 星环图谱 × LightRAG 集成 — 重新执行计划

> 本文件夹是集成的唯一弹药包。删除仓库里其他所有文件，只留 plan/ 即可重新开始。
> 上次集成全部产物作废（基于错误版本应用），本次从零重来。
>
> **最后更新**：2026-07-18

---

## 本文件夹内容

```
plan/
├── README.md                       # 本文件 — 总入口
├── 01-lightrag-api-contract.md     # LightRAG HTTP API 契约（已从源码确认）
├── 02-astryx-design-tokens.md      # Astryx Gothic/Neutral 设计规范（已从源码摘录）
├── 03-query-algorithm.md           # 4 动作查询算法（档1+2 结构优化）
├── 04-environment-pitfalls.md      # 环境踩坑记录（必读，避免重蹈）
├── 05-execution-phases.md          # 6 个执行阶段（每阶段交付物+验证）
└── reference/
    ├── star-ring-preview.html      # 阶段3 UI 参考（Astryx 浮层高保真）
    └── lightrag-compare.html       # 阶段4 算法参考（4 动作对比演示）
```

## 阅读顺序

1. **先读本 README**（决策清单 + 架构总览）
2. **必读 04-environment-pitfalls.md**（环境陷阱，否则会卡在装包上）
3. 按 `05-execution-phases.md` 逐阶段执行
4. 每阶段需要技术细节时查对应文档（01/02/03）

---

## 架构（一句话）

**LightRAG 当大脑（Python 服务，GLM 抽实体+向量检索），星环图当脸（保留布局，加查询浮层，命中节点发光）。**

```
[vault 笔记] --ingest.py--> [LightRAG server :9620] <--/query + /query/data-- [插件浮层]
        ↑                          ↑  (GLM-4.5 + embedding-3 via 智谱 OpenAI 兼容 API)
        源数据                     独立 Python 进程
```

## 决策清单（全部已验证，执行时不再讨论）

| # | 决策 | 验证来源 |
|---|---|---|
| 1 | 架构：A 互补（不替换星环图） | 对话 |
| 2 | 数据：LLM 自动抽取实体 | 对话 |
| 3 | LLM：GLM-4.5（智谱 OpenAI 兼容） | 对话 |
| 4 | 结构优化：档1（导入喂结构）+ 档2（查询沿双链扩展） | lightrag-compare.html |
| 5 | 4 动作查询（学概念/找方法/查错题/复习专题）替代 LightRAG 默认 5 模式 | lightrag-compare.html |
| 6 | subtype 智能权重（know_what/know_how/know_why） | lightrag-compare.html |
| 7 | 浮层 UI + 图上高亮（不开独立标签页） | star-ring-preview.html |
| 8 | Astryx 设计语言（Gothic 深 + Neutral 浅）双主题 | star-ring-preview.html |
| 9 | 全 SVG icon（零 emoji） | star-ring-preview.html |
| 10 | 自定义下拉（替代原生 select） | star-ring-preview.html |
| 11 | GLM 配置全进插件面板（API key/URL/模型） | 对话 |
| 12 | 配置传递：方案 B（插件写 .env + 重启）—— LightRAG HTTP 不支持请求级覆盖 | 源码证伪方案 A 后重选 |

## 卡片三层结构（查询算法的基础）

读完用户 vault 的真实 frontmatter 后确认的语义：

| 卡片 | 职责 | 关键 frontmatter |
|---|---|---|
| **MOC** | 知识点大纲，文件名前缀 `2.1.1_` 编码层级 | 无 frontmatter，靠前缀 |
| **Flash** | 二级结论/做题套路 | `subtype: know_what/know_how/know_why`、`mindtree: [[]]`（挂到哪些 MOC）、`errors: [[]]`（相关错题）、`topic`、`tags` |
| **Error** | 错题+错因 | `flash: [[]]`（反向：暴露哪些 Flash 套路盲点）、`mindtree`、`topic`、`tags` |

**subtype 三类（查询加权的基础）**：
- `know_what` (8 张) — 是什么（定义）
- `know_how` (27 张) — 怎么做（方法套路）
- `know_why` (17 张) — 为什么（易错原理）

**双向链**：
- Flash→Error（`errors:` 字段）：这个套路在哪些题栽过
- Error→Flash（`flash:` 字段）：这道错题暴露哪些套路盲点

## 执行原则

- **Ponytail 模式**：每阶段最小可用版本，不加未来抽象
- **每阶段完成后 git tag + 物理备份**（用户要求）
- **不修改 data.ts**（数据管道完全保留）
- **不修改现有布局算法**（starRingSectorLayout / fishboneLayout 等）
- **不修改现有交互**（hover 链路、Alt+聚焦、minimap）
- **不引入新依赖**（用 Obsidian 内置 requestUrl，SVG inline）

## 必须用户提供的前置

- **GLM API key**（去 open.bigmodel.cn 申请）—— 阶段 5 测试必需，其他阶段可用占位
- **插件源码的当前正确版本**——上次错误是应用到了旧版本，本次执行前要确认 src/ 是用户要的最新版

# 4 动作查询算法（档1 + 档2 结构优化）

> 这是替代 LightRAG 默认 5 模式（local/global/hybrid/naive/mix）的定制查询逻辑，
> 直接对应用户的三层卡片结构（MOC/Flash/Error）和 subtype（know_what/know_how/know_why）。
> 算法逻辑在 `reference/lightrag-compare.html` 里可视化验证过。

## 4 个学习动作

针对考研复习场景，不是通用 RAG：

| 动作 | 场景 | 目标卡片类型 |
|---|---|---|
| 📖 **学概念** | 查定义性知识 | MOC + `know_what` Flash，过滤错题和方法 |
| 🛠 **找方法** | 查做题套路 | `know_how` Flash，过滤定义和错题 |
| ⚠ **查错题** | 查错题+错因 | Error 卡 + 反查暴露的 `know_why` Flash 盲点 |
| 📚 **复习专题** | 系统性复习某主题 | MOC + 全 subtype Flash + Error，全亮 |

```typescript
const ACTION_TARGET = {
  concept: { moc: true,  flashSubtypes: ['know_what'],                       error: false },
  method:  { moc: false, flashSubtypes: ['know_how'],                        error: false },
  error:   { moc: false, flashSubtypes: ['know_why'],                        error: true  },
  review:  { moc: true,  flashSubtypes: ['know_what','know_how','know_why'], error: true  },
};
```

## 档1：导入时喂结构提示（让 LLM 感知三层语义）

`ingest.py` 在每篇笔记正文前拼结构 header：

**MOC 卡片**：
```
【MOC 知识点：数列极限定义，章节层级 2.1.1（第 3 层）】

<正文>
```

**Flash 卡片**：
```
【Flash 二级结论：arccot x 的值域｜类型：know_why（know_what=是什么 / know_how=怎么做 / know_why=为什么）｜主题：一元微分/性态分析｜挂在 MOC：拐点的判断, 单调性｜相关错题：arccot x 复合函数单调性判断】

<正文>
```

**Error 卡片**：
```
【Error 错题：1992 数二｜主题：极限/函数极限｜标签：泰勒展开, 等价无穷小｜暴露的 Flash 套路盲点：为什么极限趋于非零常数时常规公式会失效, 加减复合极限的整体代换】

<错因分析>
```

header 让 GLM 抽实体时知道"这是 MOC/Flash(know_how)/Error，挂在 X 下，暴露 Y 套路"。

## 档2：查询时沿双链结构扩展（核心算法）

查询流程：

```
1. 并发 POST /query（拿答案）+ POST /query/data（拿实体名集合）
2. 实体名 → 节点 basename 三级匹配（见 01-lightrag-api-contract.md）
3. 按 ACTION_TARGET 筛选命中的节点（类型 + subtype）
4. 沿 mindtree 双链扩展（下面 expandByStructure）
5. 命中节点用 view.ts 已有的 active/inactive 状态高亮
```

### expandByStructure（核心算法）

```javascript
function expandByStructure(g6Data, hitIds, mode) {
  const action = ACTION_TARGET[mode];
  const finalIds = new Set();
  const reason = new Map();  // nodeId → 命中原因（决定发光颜色）

  // 建父子索引（只用 tree 结构边，排除 aux 辅连线）
  const parentOf = new Map();
  const childrenOf = new Map();
  g6Data.edges.forEach(e => {
    if (e.relation === 'aux') return;  // ⚠ aux 边过滤，关键防回归点
    parentOf.set(e.target, e.source);
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source).push(e.target);
  });
  const nodeById = new Map();
  g6Data.nodes.forEach(n => nodeById.set(n.id, n));

  // Pass 1：按动作目标筛选语义命中的节点
  hitIds.forEach(id => {
    const node = nodeById.get(id);
    if (!node) return;
    if (node.type === 'moc' && action.moc) {
      finalIds.add(id); reason.set(id, 'moc-target');
    } else if (node.type === 'Flash' && action.flashSubtypes.includes(node.subtype)) {
      finalIds.add(id); reason.set(id, 'flash-target');
    } else if (node.type === 'Error' && action.error) {
      finalIds.add(id); reason.set(id, 'error-target');
    }
  });

  // Pass 2：沿 mindtree 双链扩展（每个动作策略不同）
  const climbMOC = (n) => {
    let cur = parentOf.get(n.id);
    while (cur !== undefined) {
      const p = nodeById.get(cur);
      if (p && p.type === 'moc' && (action.moc || mode === 'error')) {
        if (!finalIds.has(cur)) { finalIds.add(cur); reason.set(cur, 'moc-context'); }
      }
      cur = parentOf.get(cur);
    }
  };

  hitIds.forEach(id => {
    const node = nodeById.get(id);
    if (!node) return;

    if (node.type === 'Flash') {
      climbMOC(node);
      // 找方法：同 MOC 下的其他 know_how 兄弟
      if (mode === 'method') {
        const moc = parentOf.get(id);
        (childrenOf.get(moc) || []).forEach(sib => {
          const sn = nodeById.get(sib);
          if (sn && sn.type === 'Flash' && sn.subtype === 'know_how' && !finalIds.has(sib)) {
            finalIds.add(sib); reason.set(sib, 'flash-method-sibling');
          }
        });
      }
      // 查错题/复习：亮该 Flash 下挂的 Error（套路在哪栽过）
      if (action.error) {
        (childrenOf.get(id) || []).forEach(child => {
          if (!finalIds.has(child)) { finalIds.add(child); reason.set(child, 'error-from-flash'); }
        });
      }
    } else if (node.type === 'Error') {
      // 反查父 Flash（Error 的 flash: 字段反向映射：暴露的套路盲点）
      const parentFlash = parentOf.get(id);
      if (parentFlash !== undefined) {
        if (!finalIds.has(parentFlash)) { finalIds.add(parentFlash); reason.set(parentFlash, 'flash-cause'); }
        climbMOC(nodeById.get(parentFlash));
      }
      // 复习：同主题其他错题
      if (mode === 'review') {
        const moc = parentOf.get(parentFlash);
        (childrenOf.get(moc) || []).forEach(sib => {
          (childrenOf.get(sib) || []).forEach(err => {
            const en = nodeById.get(err);
            if (en && en.type === 'Error' && !finalIds.has(err)) {
              finalIds.add(err); reason.set(err, 'error-sibling');
            }
          });
        });
      }
    } else if (node.type === 'moc' && mode === 'review') {
      // 复习专题：MOC 下全套子树全亮
      (childrenOf.get(id) || []).forEach(child => {
        if (!finalIds.has(child)) { finalIds.add(child); reason.set(child, 'review-all'); }
        (childrenOf.get(child) || []).forEach(grand => {
          if (!finalIds.has(grand)) { finalIds.add(grand); reason.set(grand, 'review-all'); }
        });
      });
    }
  });

  return { finalIds, reason };
}
```

### reason → 发光颜色映射

| reason | 含义 | 颜色 |
|---|---|---|
| `semantic` | LightRAG 直接命中 | `#fbbf24` 琥珀 |
| `moc-target` / `flash-target` | 动作目标节点 | `#4fd1c5` 青 |
| `error-target` | 动作目标 Error | `#f472b6` 粉 |
| `moc-context` | 上下文 MOC（祖先）| `#7dd3fc` 浅蓝 |
| `flash-method-sibling` | 同套方法兄弟 | `#a78bfa` 紫 |
| `flash-cause` | Error 反查的 Flash 套路 | `#fbbf24` 琥珀 |
| `error-from-flash` | Flash 下挂的错题 | `#f472b6` 粉 |
| `error-sibling` | 同主题其他错题 | `#c084fc` 紫粉 |
| `review-all` | 复习全套 | `#94a3b8` 灰 |

## 4 动作的预期差异（验证清单）

以查"泰勒展开"为例：

| 动作 | 应亮节点 |
|---|---|
| 学概念 | 只亮 MOC「极限计算工具」+ `know_what` Flash |
| 找方法 | 只亮 `know_how` Flash（泰勒展开套路 + 同 MOC 的等价无穷小代换等） |
| 查错题 | 亮 1991/1992 数二 Error + 反查它们暴露的 know_why Flash（加减滥用等价无穷小） |
| 复习专题 | MOC + 全 Flash + 全 Error 一次性全亮 |

## 算法自检（防回归）

把 `expandByStructure` 抽成纯函数（不依赖 G6/Obsidian），写一个 `selfcheck.mjs`：
- 构造 mock 的 g6Data（含 tree 边 + aux 边，覆盖环检测）
- 对 4 个动作各跑一遍，断言 finalIds 符合预期
- 关键防回归点：**aux 边必须过滤**（否则会形成环导致无限递归）

详见已有的 `src/lightrag-algorithm.selfcheck.mjs`（若已存在，作为算法镜像副本参考）。

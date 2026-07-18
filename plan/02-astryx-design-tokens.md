# Astryx 设计规范（纯 CSS 复刻）

> 全部从 facebook/astryx 源码摘录。Astryx 是 React+StyleX 库，无法直接装进纯 TS+G6 插件，
> 但它的设计 token 用纯 CSS 完整复刻 —— 参考实现见 `reference/star-ring-preview.html`。
>
> 深色用 Gothic 主题，浅色用 Neutral 主题（两套都是 Astryx 原生）。

## 双主题 CSS 变量

```css
/* Dark: Gothic（dark-only 原值）*/
:root, [data-theme="dark"] {
  --ast-bg-body: #101314;
  --ast-bg-surface: #101314;
  --ast-bg-card: #1a1d20;
  --ast-bg-popover: #24292D;
  --ast-bg-muted: #24292D;
  --ast-accent: #E8F1F6;
  --ast-accent-muted: rgba(232, 241, 246, 0.125);
  --ast-neutral: rgba(232, 241, 246, 0.10);
  --ast-text-primary: #E8F1F6;
  --ast-text-secondary: #96A0AB;
  --ast-text-disabled: #495056;
  --ast-on-accent: #101314;
  --ast-border: rgba(232, 241, 246, 0.10);
  --ast-border-emphasized: #495056;
  --ast-overlay-hover: rgba(232, 241, 246, 0.05);
  --ast-overlay-pressed: rgba(232, 241, 246, 0.10);
  /* 分类色 chip（dusty pastel on dark）*/
  --ast-bg-teal: #a3c2b6;   --ast-text-teal: #174a40;
  --ast-bg-blue: #a3b5d6;   --ast-text-blue: #1f2c54;
  --ast-bg-purple: #b29bc4; --ast-text-purple: #481b58;
  --ast-bg-pink: #c89aab;   --ast-text-pink: #71223c;
  --sr-bg-start: #1a1f2e;  --sr-bg-end: #0d1117;
  --sr-edge: rgba(122, 168, 212, 0.55);
  --ast-shadow-high: 0 4px 6px rgba(0,0,0,0.25), 0 12px 24px rgba(0,0,0,0.30);
}

[data-theme="light"] {
  --ast-bg-body: #fafafa;
  --ast-bg-surface: #ffffff;
  --ast-bg-card: #ffffff;
  --ast-bg-popover: #ffffff;
  --ast-bg-muted: #f5f5f5;
  --ast-accent: #171717;
  --ast-accent-muted: rgba(23, 23, 23, 0.08);
  --ast-neutral: rgba(23, 23, 23, 0.05);
  --ast-text-primary: #1a1a1a;
  --ast-text-secondary: #737373;
  --ast-text-disabled: #d4d4d4;
  --ast-on-accent: #fafafa;
  --ast-border: rgba(23, 23, 23, 0.10);
  --ast-border-emphasized: #e5e5e5;
  --ast-overlay-hover: rgba(23, 23, 23, 0.05);
  --ast-overlay-pressed: rgba(23, 23, 23, 0.10);
  /* 分类色 chip（浅底深字）*/
  --ast-bg-teal: #ccfbf1;   --ast-text-teal: #115e59;
  --ast-bg-blue: #dbeafe;   --ast-text-blue: #1e40af;
  --ast-bg-purple: #ede9fe; --ast-text-purple: #5b21b6;
  --ast-bg-pink: #fce7f3;   --ast-text-pink: #9d174d;
  --sr-bg-start: #f5f7fa;  --sr-bg-end: #e4e9f2;
  --sr-edge: rgba(74, 107, 138, 0.45);
  --ast-shadow-high: 0 4px 6px rgba(0,0,0,0.07), 0 12px 24px rgba(0,0,0,0.10);
}
```

## 通用 token（两主题共用）

```css
:root {
  --ast-r-element: 8px;       /* input/button/item 圆角 */
  --ast-r-container: 12px;    /* card/dropdown 圆角 */
  --ast-r-full: 9999px;       /* chip pill */
  --ast-ease: cubic-bezier(0.24, 1, 0.4, 1);  /* Astryx 唯一缓动曲线 */
  --ast-dur-fast: 150ms;
  --ast-dur-med: 350ms;
  --ast-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif;
}
```

## 组件规范

### Input（focus 用 inset ring，不用 outline）
```css
.input-wrap {
  padding: 4px 8px;
  border: 1px solid var(--ast-border-emphasized);
  border-radius: var(--ast-r-element);
  background: var(--ast-bg-surface);
  transition: border-color var(--ast-dur-fast) var(--ast-ease),
              box-shadow var(--ast-dur-fast) var(--ast-ease);
}
.input-wrap:focus-within {
  border-color: var(--ast-accent);
  box-shadow: inset 0 0 0 2px var(--ast-accent-muted);
}
.input-wrap:hover:not(:focus-within) {
  box-shadow: inset 0 0 0 2px var(--ast-border);
}
```

### Button primary（Astryx 签名：active scale(0.98)）
```css
.btn {
  padding: 6px 14px;
  border: none; border-radius: var(--ast-r-element);
  background-color: var(--ast-accent);
  color: var(--ast-on-accent);
  font-size: 13px; font-weight: 500;
  transition: background-image var(--ast-dur-fast) var(--ast-ease),
              transform var(--ast-dur-fast) var(--ast-ease);
}
.btn:hover { background-image: linear-gradient(var(--ast-overlay-hover), var(--ast-overlay-hover)); }
.btn:active { transform: scale(0.98); background-image: linear-gradient(var(--ast-overlay-pressed), var(--ast-overlay-pressed)); }
```

### DropdownMenu + Item（自定义下拉，替代原生 select）
```css
.dropdown-menu {
  position: absolute; top: calc(100% + 4px); left: 0;
  min-width: 180px;
  padding: 4px;
  background: var(--ast-bg-popover);
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-r-container);
  box-shadow: var(--ast-shadow-high);
  opacity: 0; pointer-events: none;
  transform: translateY(-4px);
  transition: opacity var(--ast-dur-fast) var(--ast-ease),
              transform var(--ast-dur-fast) var(--ast-ease);
}
.dropdown.open .dropdown-menu { opacity: 1; pointer-events: auto; transform: translateY(0); }

.dropdown-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px;
  border-radius: var(--ast-r-element);
  cursor: pointer;
  transition: background-color 112ms var(--ast-ease);  /* fast-min 档 */
}
.dropdown-item:hover { background: var(--ast-overlay-hover); }
.dropdown-item.selected { background: var(--ast-accent-muted); }
```

### Badge chip（命中统计，分类色）
```css
.chip {
  display: inline-flex; align-items: center;
  height: 20px; padding: 0 8px;
  border-radius: var(--ast-r-full);
  font-size: 12px; font-weight: 500;
}
.chip-moc   { background: var(--ast-bg-teal);   color: var(--ast-text-teal); }
.chip-flash { background: var(--ast-bg-blue);   color: var(--ast-text-blue); }
.chip-error { background: var(--ast-bg-pink);   color: var(--ast-text-pink); }
```

### Popover 浮层（查询弹窗容器）
```css
.query-fab {
  position: absolute; top: 16px; left: 16px;
  background: var(--ast-bg-popover);
  border: 1px solid var(--ast-border);
  border-radius: var(--ast-r-container);
  box-shadow: var(--ast-shadow-high);
  padding: 12px;
  width: 400px;
}
```

## SVG icon 规范

```css
.icon-svg {
  width: 16px; height: 16px; flex-shrink: 0;
  stroke: currentColor; fill: none;
  stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
}
.icon-svg.sm { width: 14px; height: 14px; }
```

**零 emoji**。全部 inline SVG，`stroke: currentColor` 自动适配主题。完整图标路径见 `reference/star-ring-preview.html`：
- 搜索：`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>`
- 箭头：`<path d="M5 12h14M13 5l7 7-7 7"/>`
- chevron：`<path d="m6 9 6 6 6-6"/>`
- 勾选：`<path d="M20 6 9 17l-5-5"/>`
- 太阳：`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`
- 月亮：`<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`

## 动效

- **全局唯一缓动**：`cubic-bezier(0.24, 1, 0.4, 1)`，没有 ease-in/out 区分
- **fast 档 150ms**（按钮/输入框/hover），**medium 档 350ms**（浮层/主题切换）
- **item hover 用 112ms**（fast-min 档）
- **唯一 transform 动效**：Button `:active` → `scale(0.98)`（按下缩 2%）
- Dropdown/Popover 进出场：`opacity + translateY(-4px) → 0`

## 字体

- `system-ui` 栈（Gothic 原用 Fustat，但 system-ui 回退已够好，不引外部字体）
- base 14px，行高 1.4286
- weight：normal 400 / medium 500 / semibold 600 / bold 700
- 组件映射：input/button label = 14px；badge = 12px；item desc = 12px

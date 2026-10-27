/**
 * 图标：**内联 SVG ＋ 一个解析点**。
 *
 * 形状（2026-10-20 定）：
 *   · 图标槽的值（`props._icon`、绑定的 `icon`、菜单行的 `icon`）用 **`lucide:<name>`**；
 *   · 不是 `lucide:` 开头的值**照字面渲染**（emoji、字符、旧数据都还能用）；
 *   · 空值 ⇒ 调用方给的**角色默认**（页 = `file`，日记 = `calendar`，反链 = `corner-up-left`）。
 *
 * 为什么**存名字**而不是存 path：属性属于知识库，path 属于这一版渲染实现。
 * 存名字才能让别的实现按前缀找到同一套图标；升级图标集时未知名字会降级成占位，不静默消失。
 *
 * 为什么**放在 `view/` 而不是 `ui/`**：
 *   · `view/block-dom.ts` 的 gutter（折叠三角 / 待办框 / 拖拽把手）也要画图标；
 *   · 而 `arch-check [13]` 规定 `core ← view ← ui ← app`，**view 不能 import ui**；
 *   · 所以图标是 **view 层的公共原语**，ui 与 app 只能往上引用它。
 *
 * 为什么**不装包**：`app/package.json` 的生产依赖是 0，这个性质值得保住。这里只 vendor
 * 用到的 37 个图标的 path 数据（约 6KB 源码），不跟随上游版本漂移；换图标只是加一行。
 *
 * ⚠️ **正文里的 emoji 不归这里管**：那是用户写的文本，不是图标位。
 *
 * 图形数据：Lucide v1.59.0（ISC）。`ICON_PATHS` 是 `lucide-static` 的 `<svg>` 内联内容，
 * 视觉口径统一为 24 网格、2px 描边、圆头圆角；颜色一律 `currentColor`，尺寸只走 `--ui-icon-*`。
 */

/** 用到的图标。新增图标：把上游 `<svg>` 的内联内容粘进来，并在调用点用 `lucide:<name>` */
export const ICON_PATHS = {
  "chevron-left": "<path d=\"m15 18-6-6 6-6\" />",
  "chevron-right": "<path d=\"m9 18 6-6-6-6\" />",
  "chevron-down": "<path d=\"m6 9 6 6 6-6\" />",
  "maximize-2": "<polyline points=\"15 3 21 3 21 9\" /><polyline points=\"9 21 3 21 3 15\" /><line x1=\"21\" y1=\"3\" x2=\"14\" y2=\"10\" /><line x1=\"3\" y1=\"21\" x2=\"10\" y2=\"14\" />",
  "minimize-2": "<polyline points=\"4 14 10 14 10 20\" /><polyline points=\"20 10 14 10 14 4\" /><line x1=\"14\" y1=\"10\" x2=\"21\" y2=\"3\" /><line x1=\"3\" y1=\"21\" x2=\"10\" y2=\"14\" />",
  "x": "<path d=\"M18 6 6 18\" /><path d=\"m6 6 12 12\" />",
  "grip-vertical": "<circle cx=\"9\" cy=\"12\" r=\"1\" /><circle cx=\"9\" cy=\"5\" r=\"1\" /><circle cx=\"9\" cy=\"19\" r=\"1\" /><circle cx=\"15\" cy=\"12\" r=\"1\" /><circle cx=\"15\" cy=\"5\" r=\"1\" /><circle cx=\"15\" cy=\"19\" r=\"1\" />",
  "square": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" />",
  "square-check": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /><path d=\"m16 9-5.5 5.5L8 12\" />",
  "arrow-up-right": "<path d=\"M7 7h10v10\" /><path d=\"M7 17 17 7\" />",
  "corner-up-left": "<path d=\"M20 20v-7a4 4 0 0 0-4-4H4\" /><path d=\"M9 14 4 9l5-5\" />",
  "plus": "<path d=\"M5 12h14\" /><path d=\"M12 5v14\" />",
  "sliders-horizontal": "<path d=\"M10 5H3\" /><path d=\"M12 19H3\" /><path d=\"M14 3v4\" /><path d=\"M16 17v4\" /><path d=\"M21 12h-9\" /><path d=\"M21 19h-5\" /><path d=\"M21 5h-7\" /><path d=\"M8 10v4\" /><path d=\"M8 12H3\" />",
  "pilcrow": "<path d=\"M13 4v16\" /><path d=\"M17 4v16\" /><path d=\"M19 4H9.5a4.5 4.5 0 0 0 0 9H13\" />",
  "hash": "<line x1=\"4\" x2=\"20\" y1=\"9\" y2=\"9\" /><line x1=\"4\" x2=\"20\" y1=\"15\" y2=\"15\" /><line x1=\"10\" x2=\"8\" y1=\"3\" y2=\"21\" /><line x1=\"16\" x2=\"14\" y1=\"3\" y2=\"21\" />",
  "image": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\" /><circle cx=\"9\" cy=\"9\" r=\"2\" /><path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\" />",
  "image-off": "<line x1=\"2\" x2=\"22\" y1=\"2\" y2=\"22\" /><path d=\"M10.41 10.41a2 2 0 1 1-2.83-2.83\" /><line x1=\"13.5\" x2=\"6\" y1=\"13.5\" y2=\"21\" /><line x1=\"18\" x2=\"21\" y1=\"12\" y2=\"15\" /><path d=\"M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59\" /><path d=\"M21 15V5a2 2 0 0 0-2-2H9\" />",
  "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />",
  "trash-2": "<path d=\"M10 11v6\" /><path d=\"M14 11v6\" /><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\" /><path d=\"M3 6h18\" /><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\" />",
  "bold": "<path d=\"M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8\" />",
  "italic": "<line x1=\"19\" x2=\"10\" y1=\"4\" y2=\"4\" /><line x1=\"14\" x2=\"5\" y1=\"20\" y2=\"20\" /><line x1=\"15\" x2=\"9\" y1=\"4\" y2=\"20\" />",
  "highlighter": "<path d=\"m9 11-6 6v3h9l3-3\" /><path d=\"m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4\" />",
  "code": "<path d=\"m16 18 6-6-6-6\" /><path d=\"m8 6-6 6 6 6\" />",
  "eraser": "<path d=\"M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21\" /><path d=\"m5.082 11.09 8.828 8.828\" />",
  "quote": "<path d=\"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z\" /><path d=\"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z\" />",
  "file-text": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /><path d=\"M14 2v5a1 1 0 0 0 1 1h5\" /><path d=\"M10 9H8\" /><path d=\"M16 13H8\" /><path d=\"M16 17H8\" />",
  "list-tree": "<path d=\"M8 5h13\" /><path d=\"M13 12h8\" /><path d=\"M13 19h8\" /><path d=\"M3 10a2 2 0 0 0 2 2h3\" /><path d=\"M3 5v12a2 2 0 0 0 2 2h3\" />",
  "layout-dashboard": "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\" /><rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\" /><rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\" /><rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\" />",
  "monitor": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\" /><line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\" /><line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\" />",
  "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\" /><path d=\"M12 2v2\" /><path d=\"M12 20v2\" /><path d=\"m4.93 4.93 1.41 1.41\" /><path d=\"m17.66 17.66 1.41 1.41\" /><path d=\"M2 12h2\" /><path d=\"M20 12h2\" /><path d=\"m6.34 17.66-1.41 1.41\" /><path d=\"m19.07 4.93-1.41 1.41\" />",
  "moon": "<path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\" />",
  "book-open": "<path d=\"M12 5v16\" /><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\" />",
  "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /><path d=\"M12 9v4\" /><path d=\"M12 17h.01\" />",
  "square-dashed": "<path d=\"M5 3a2 2 0 0 0-2 2\" /><path d=\"M19 3a2 2 0 0 1 2 2\" /><path d=\"M21 19a2 2 0 0 1-2 2\" /><path d=\"M5 21a2 2 0 0 1-2-2\" /><path d=\"M9 3h1\" /><path d=\"M9 21h1\" /><path d=\"M14 3h1\" /><path d=\"M14 21h1\" /><path d=\"M3 9v1\" /><path d=\"M21 9v1\" /><path d=\"M3 14v1\" /><path d=\"M21 14v1\" />",
  "check": "<path d=\"M20 6 9 17l-5-5\" />",
  "file": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /><path d=\"M14 2v5a1 1 0 0 0 1 1h5\" />",
  "calendar": "<path d=\"M8 2v3\" /><path d=\"M16 2v3\" /><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" /><path d=\"M3 9h18\" />",
  "newspaper": "<path d=\"M15 18h-5\" /><path d=\"M18 14h-8\" /><path d=\"M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2\" /><rect width=\"8\" height=\"4\" x=\"10\" y=\"6\" rx=\"1\" />",
  "compass": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z\" />",
  "flask-conical": "<path d=\"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2\" /><path d=\"M6.453 15h11.094\" /><path d=\"M8.5 2h7\" />",
  "circle-help": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3\" /><path d=\"M12 17h.01\" />",
} as const

export type IconName = keyof typeof ICON_PATHS
/** 尺寸档：走 CSS token（`--ui-icon-sm|md|lg`），不在调用点写 px */
export type IconSize = 'sm' | 'md' | 'lg'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 画一个图标。
 *
 * ⚠️ `innerHTML` 的内容是**上面这张静态表**（vendor 的上游 path），不是用户输入；
 *    任何来自属性的值都只经过 `isIconRef` 的白名单查表，不会拼进标记。
 */
export function createIcon(name: IconName, size: IconSize = 'md'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('ico')
  svg.dataset.size = size
  svg.innerHTML = ICON_PATHS[name]
  return svg
}

/** 图标槽的值是不是一个图标引用（只有 `lucide:` 前缀进查表，其余一律当字面文本） */
export function isIconRef(v: string): boolean {
  return v.startsWith('lucide:')
}

/**
 * **图标槽的唯一解析点**：清空宿主 → 写 `data-icon`（给门禁/主题读）→ 放 SVG 或字面文本。
 *
 * 三种情况：
 *   · `lucide:<known>` → SVG；
 *   · `lucide:<unknown>` → 占位图标 ＋ `title`（**不静默消失**）；
 *   · 其它任何字符串（emoji／字符／旧数据）→ 原样文本；
 *   · 空值 → 调用方给的角色默认。
 *
 * `data-icon` 始终写**原始值**：样式与断言都看它，而不是看里面有没有 svg。
 */
export function renderIcon(
  host: HTMLElement,
  value: string | undefined,
  fallback: IconName,
  size: IconSize = 'md',
): void {
  host.replaceChildren()
  const raw = value?.trim() ?? ''
  host.dataset.icon = raw
  if (raw === '') {
    host.appendChild(createIcon(fallback, size))
    return
  }
  if (!isIconRef(raw)) {
    host.textContent = raw
    return
  }
  const name = raw.slice('lucide:'.length)
  if (name in ICON_PATHS) {
    host.appendChild(createIcon(name as IconName, size))
    return
  }
  host.title = raw
  host.appendChild(createIcon('circle-help', size))
}

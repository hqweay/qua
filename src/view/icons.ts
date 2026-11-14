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
 * 为什么**不装包**：生产依赖保持 0——`lucide-static` 只在 devDependencies（生成脚本
 * `scripts/gen-icon-catalog.mjs` 读它），path 数据以生成文件随源码提交，不跟随上游运行时漂移。
 *
 * ⚠️ **正文里的 emoji 不归这里管**：那是用户写的文本，不是图标位。
 *
 * 图形数据在 `icon-catalog.ts`（脚本生成的全量 catalog，换图标＝加一行引用，
 * 不再手粘 path）；`createIcon` 统一给属性：24 网格、2px 描边、圆头圆角；
 * 颜色一律 `currentColor`，尺寸只走 `--ui-icon-*`。
 */
import { ICON_PATHS } from './icon-catalog.ts'

export { ICON_PATHS }
export type IconName = keyof typeof ICON_PATHS
/** 尺寸档：走 CSS token（`--ui-icon-sm|md|lg`），不在调用点写 px */
export type IconSize = 'sm' | 'md' | 'lg'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 画一个图标。
 *
 * ⚠️ `innerHTML` 的内容是 **catalog 的静态表**（vendor 的上游 path），不是用户输入；
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
  host.dataset.tip = raw
  host.appendChild(createIcon('circle-help', size))
}

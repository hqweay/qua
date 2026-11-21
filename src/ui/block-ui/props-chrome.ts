/**
 * **属性区的行 chrome**（段头 ＋ 两种值行）：面板壳与抽出的段共用一份。
 *
 * 段抽出后（定义值配置／字段声明）不再长在面板类里，但这些形状是**属性区**的
 * 视觉语言，不是某一段自己的：段头回答「这是哪一段」，行头小图标回答「这是哪一行」；
 * 单行的轻动作贴着标签走（`labeledRow`），富值整宽落下（`stackedRow`）。
 * 每个宿主（检视卡／抽屉／将来的就地投影）挂段时都要同一套 chrome，
 * 所以独立成档：判据写一份，谁挂段谁就得到同一套形状。
 */
import { renderIcon } from '../../view/icons.ts'

/**
 * **段头**：图标 ＋ 名字 ＋ 可选计数。
 *
 * 段头是「分组」的唯一视觉锚点：一列表单里没有段头，读者只看到一串行；
 * 有了图标与计数，主段与次段在同一视野里各有身份（图标是形状，计数是规模）。
 */
export function sectionHead(icon: string, title: string, count?: number): HTMLElement {
  const head = document.createElement('div')
  head.className = 'props-section-head'
  const ico = document.createElement('span')
  ico.className = 'props-section-ico'
  ico.setAttribute('aria-hidden', 'true')
  renderIcon(ico, icon, 'list', 'md')
  const label = document.createElement('span')
  label.className = 'props-section-title'
  label.textContent = title
  head.append(ico, label)
  if (count !== undefined && count > 0) {
    const badge = document.createElement('span')
    badge.className = 'props-section-count'
    badge.textContent = String(count)
    head.appendChild(badge)
  }
  return head
}

/**
 * 身份/归属段的行 chrome：左标签 ＋ 轻值贴着标签（`prop-hug`）。
 * 这些行的值是轻动作（勾选/按钮/chips），铺满右半会把「一行一个字段」读成
 * 「标签在左、答案在很远的右边」；铺满只属于要填的值（字段行、系统信息）。
 * `icon` 给了就画行头小图标：给「这是哪个字段」一个可扫的形状——
 * 与段头图标同一语言小一档（段头回答「这是哪一段」，行头回答「这是哪一行」）。
 */
export function labeledRow(cls: string, title: string, value: HTMLElement, icon?: string): HTMLElement {
  const row = document.createElement('div')
  row.className = `prop-row prop-hug ${cls} ui-row`
  const label = document.createElement('label')
  label.className = 'prop-label'
  if (icon) {
    const ico = document.createElement('span')
    ico.className = 'prop-field-ico'
    ico.setAttribute('aria-hidden', 'true')
    renderIcon(ico, icon, 'list', 'sm')
    label.appendChild(ico)
  }
  const name = document.createElement('span')
  name.className = 'prop-name'
  name.textContent = title
  label.append(name)
  row.append(label, value)
  return row
}

/**
 * 富值行：标签占第一行（与摘除键同排），值整宽落第二行。
 *
 * 判据是**值自己的形状**：一串 chips、一列别名、一张图，都不是「标签右边的一格」，
 * 塞进半宽的值槽只会互相压。单行值（文本／日期／下拉）仍走上一条 `labeledRow`。
 */
export function stackedRow(
  cls: string,
  title: string,
  value: HTMLElement,
  icon?: string,
  action?: HTMLElement,
): HTMLElement {
  const row = labeledRow(cls, title, value, icon)
  row.dataset.stack = '1'
  if (action) {
    // 行头的动作位：与段头「动作住进段头」同一句判据，小一号——值行留给值
    action.classList.add('prop-row-action')
    row.appendChild(action)
  }
  return row
}

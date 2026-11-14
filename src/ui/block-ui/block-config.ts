/**
 * **块配置弹窗**（瞬态壳）：身份与归属的快改面。
 *
 * 本组件只做**装配**：头部（名字投影 ＋ 脸位）＋ 共享段（`config-sections.ts`
 * 的名字/露面/显示/标签/归属）按统一段序排开。判据与写路径都住在段里；
 * 「写完谁重画」由 ctx 的写操作带（装配层接线）。
 *
 * 与属性面板是**同一个配置体的两个壳**：弹窗＝瞬态、锚在行头，做身份与归属的快改；
 * 面板＝常驻、整高右滑，在此之上还有字段值/声明/选项/系统。字段不进弹窗：
 * 重表单与高频多表面编辑（gutter/表格/面板共存）不进瞬态浮层。
 *
 * ⚠️ 每次写操作后**重绘自己**（不关闭）：连续「加名字 → 设主名 → 摘露面」是同一轮动作；
 *    关闭只发生在用户点击浮层之外。
 */
import {
  aliasLeaf,
  displayNameOf,
  COLOR_PROP,
  ICON_PROP,
  primaryAliasOf,
  prop,
  aliasesOf,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'
import { identityColorCss } from '../../core/identity/faces.ts'
import { renderIconPicker } from '../overlay/icon-picker.ts'
import {
  displayContent,
  focusNamesInput,
  listsContent,
  namesContent,
  belongsContent,
  tagsContent,
  type ConfigSectionsCtx,
} from './config-sections.ts'

export interface BlockConfigDeps {
  /** 段的能力包（读写与开取都在里面，装配层接线） */
  ctx: ConfigSectionsCtx
  /** 关闭浮层（保留给「块已经不存在」等退出路径） */
  close: () => void
  /**
   * 打开时就把光标放进「添加别名」输入框。
   *
   * 用在「无名块想标记为标签」这条路上：走到这里的原因就是没名字，
   * 所以下一步必须是起名，而不是让用户自己再点一次。
   */
  autofocus?: boolean
}

/** 一个小节：标题 ＋ 内容（弹窗的小节 chrome；面板的同一段包行标签） */
function section(title: string, content: HTMLElement): HTMLElement {
  const box = document.createElement('div')
  box.className = 'alias-section'
  const head = document.createElement('div')
  head.className = 'alias-section-title'
  head.textContent = title
  box.append(head, content)
  return box
}

/**
 * 把块配置画进 `host`（`layers.openPopover` 给的浮层）。
 *
 * 写操作全部经 ctx（写完宿主重画），不关闭浮层。
 */
export function renderBlockConfig(host: HTMLElement, deps: BlockConfigDeps): void {
  const { ctx } = deps
  const b = ctx.block()
  host.replaceChildren()
  host.classList.add('block-config')
  if (!b) {
    deps.close()
    return
  }
  const redraw = (): void => renderBlockConfig(host, deps)

  /* ------------------------------------------------------------ 头部 */

  const title = document.createElement('h4')
  title.textContent = t('ui.blockConfig.title')
  host.appendChild(title)

  const head = document.createElement('div')
  head.className = 'alias-head'
  const leaf = document.createElement('span')
  leaf.className = 'alias-leaf'
  leaf.textContent = displayNameOf(b)
  head.appendChild(leaf)
  const primary = primaryAliasOf(b)
  if (primary !== '' && aliasLeaf(primary) !== primary) {
    const full = document.createElement('span')
    full.className = 'alias-full'
    full.textContent = t('ui.alias.fullName', { name: primary })
    head.appendChild(full)
  }
  // **配置头的脸位**：在这里配「图标＋颜色」（任意块——读路径对所有块一致，
  // 写入口跟着一致）。选择器**内嵌**（不另开一层 popover——这颗头自己就在 popover 里），
  // 选完就地更新；写走 `ctx.setFace`（命令面：撤销、落盘、重画都在那条路上）。
  // ⚠️ 开合状态挂在**宿主元素**上：redraw 是整棵重画，局部变量活不过一次渲染。
  const hasFaceEntry = ctx.layers !== undefined && ctx.setFace !== undefined
  if (hasFaceEntry) {
    const faceBtn = document.createElement('button')
    faceBtn.type = 'button'
    faceBtn.className = 'alias-face-btn'
    faceBtn.dataset.tip = t('ui.iconPicker.faceEntry')
    const faceIco = document.createElement('span')
    faceIco.className = 'alias-face-ico'
    renderIcon(faceIco, prop<string>(b, ICON_PROP), 'circle-help', 'sm')
    faceBtn.appendChild(faceIco)
    const faceColor = prop<string>(b, COLOR_PROP)
    if (faceColor !== undefined) {
      const dot = document.createElement('span')
      dot.className = 'alias-face-dot'
      dot.style.setProperty('--swatch', identityColorCss(faceColor))
      faceBtn.appendChild(dot)
    }
    head.appendChild(faceBtn)
    faceBtn.addEventListener('click', () => {
      host.dataset.faceOpen = host.dataset.faceOpen === '1' ? '0' : '1'
      redraw()
    })
  }
  host.appendChild(head)
  if (hasFaceEntry && host.dataset.faceOpen === '1') {
    const facePanel = document.createElement('div')
    facePanel.className = 'alias-face-panel'
    const cur = ctx.block()
    if (cur) {
      renderIconPicker(facePanel, {
        layers: ctx.layers!,
        anchor: null,
        current: prop<string>(cur, ICON_PROP) ?? '',
        color: prop<string>(cur, COLOR_PROP) ?? '',
        recentColors: ctx.recentColors,
        keepOpen: true,
        onPick: (value) => {
          host.dataset.faceOpen = '1'
          ctx.setFace?.({ icon: value })
          redraw()
        },
        onColor: (color) => {
          host.dataset.faceOpen = '1'
          ctx.setFace?.({ color })
          redraw()
        },
      })
    }
    host.appendChild(facePanel)
  }

  /* ------------------------------------------ 段（身份 → 归属，与面板同序） */

  host.appendChild(section(t('ui.alias.title'), namesContent(ctx, host)))
  host.appendChild(section(t('ui.alias.lists'), listsContent(ctx)))
  if (aliasesOf(b).length > 0) host.appendChild(section(t('ui.alias.display'), displayContent(ctx)))
  host.appendChild(section(t('ui.props.tagsTitle'), tagsContent(ctx)))
  host.appendChild(section(t('ui.belongs.title'), belongsContent(ctx)))

  // 重绘时若光标已经在浮层里（比如刚敲完回车），不要抢回去。
  // ⚠️ 首次打开时浮层还没挂进文档（`openPopover` 先 render 再 append）⇒ 此刻
  //    `focus()` 无效，必须等挂载完成；用微任务而不是 setTimeout，落点确定。
  if (deps.autofocus && !host.contains(document.activeElement)) {
    queueMicrotask(() => {
      if (host.isConnected) focusNamesInput(host)
    })
  }
}

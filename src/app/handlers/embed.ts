/**
 * **露面块（镜像／投影）的命令**：插入、移除、把行内引用展开成露面。
 *
 * 三条纪律：
 *   · 只经 `App.ed` 改结构（命令层不碰 DOM）；
 *   · 一次动作一笔事务（`insertEmbedAfter`／`expandAtomToEmbed` 内部已合并）；
 *   · 看法写在**露面块自己**身上（`_views`／`_activeView`），绝不改源。
 */
import { t } from '../../core/msg.ts'
import { refTokensIn } from '../../core/ref.ts'
import type { Handler } from '../../core/ports.ts'
import { curBlock, S } from './shared.ts'

export const EMBED_HANDLERS: Record<string, Handler> = {
  'core.embed/insert': (a, app) => {
    const at = S(a.blockId) || curBlock(app)
    if (!at) return false
    const targetId = S(a.targetId)
    if (!targetId) {
      app.showEmbedPicker(at)
      return true
    }
    const view = S(a.view, 'mirror') === 'table' ? 'table' : 'mirror'
    const id = app.insertEmbed(at, targetId, view)
    if (!id) return false
    app.toast(t('ui.embed.inserted'))
    return true
  },

  'core.embed/remove': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    if (!id) return false
    return app.removeEmbed(id)
  },

  /**
   * 行内引用 → 露面块：摘掉那一枚原子，在它所在块下面摊开。
   * `kind` 只认 `mirror`／`table`（别的看法还没有渲染器，命令面不该先假装有）。
   */
  'core.embed/from-atom': (a, app) => {
    const atomId = S(a.atomId)
    if (!atomId) return false
    const view = S(a.view, 'mirror') === 'table' ? 'table' : 'mirror'
    return app.expandAtomToEmbed(atomId, view) !== null
  },

  /**
   * **粘贴为…**：把剪贴板里的块 id 变成「这里的一次露面」。
   *
   * 不读剪贴板本身：文本与 id 由粘贴事件给（那边才知道这一下按在哪个落点），
   * 命令只负责「把 id 落成块」。这样桌面与浏览器的剪贴板差异不进命令层。
   */
  'core.embed/paste': (a, app) => {
    const at = S(a.blockId) || curBlock(app)
    if (!at) return false
    const view = S(a.view, 'mirror') === 'table' ? 'table' : 'mirror'
    const targetId = S(a.targetId)
    if (targetId) return app.insertEmbed(at, targetId, view) !== null
    void app
      .readText()
      .then((text) => {
        const id = refTokensIn(text)[0]?.id
        if (!id) {
          app.toast(t('ui.embed.noTarget'), 'warn')
          return
        }
        app.insertEmbed(at, id, view)
      })
      .catch(() => app.toast(t('err.clipboardFailed'), 'warn'))
    return true
  },

  'core.embed/paste-menu': (a, app) => {
    const at = S(a.blockId) || curBlock(app)
    if (!at) return false
    app.showMenu({ kind: 'menu', prefix: 'embedPaste/', anchor: null, title: t('ui.embed.pasteTitle') })
    return true
  },
}

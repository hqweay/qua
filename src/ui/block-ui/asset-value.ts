/**
 * **属性值里的资产露面**（`asset` kind 的读侧）。
 *
 * 正文里的图片走 `AssetRun` ＋ `view/editor/block-dom.ts`；属性值是另一种形状：
 * 一个字符串（内态 hash ／ 外态 http(s) 链接），或一串这样的字符串（多值）。
 * 两处要的是同一件事——「能不能拿到一个地址，拿不到就给一句实话」——
 * 所以这里只做投影，不碰库、不写值、不自建对象 URL（地址一律由 `assetRefView` 给）。
 *
 * ⚠️ **外链腐烂与内态 missing 是同一种显示态**：`<img>` 的 error 在现场现算，
 *    不落盘、不改值。值仍是那个地址，等它回来了自然又是真图。
 * ⚠️ **单值与多值同一条读法**（`assetRefsOf`）：值控件和块下投影都不许用
 *    `String(value)`——数组会被压成 `a,b`，下一次写入就把多值抹成单值。
 */
import { assetRefKindOf } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { assetClickActionOf, assetRefView, markAssetMissing } from '../../view/asset-views.ts'
import { openImageLightbox } from '../overlay/lightbox.ts'
import { renderIcon } from '../../view/icons.ts'

/** 两种尺寸：块下属性行贴着文字走（不改行高），面板与表格格子给一枚可缩略图 */
export type AssetThumbSize = 'line' | 'panel'

function failedChip(state: 'missing' | 'unavailable'): HTMLElement {
  const chip = document.createElement('span')
  chip.className = `prop-asset-chip prop-asset-chip--${state}`
  const icon = document.createElement('span')
  icon.className = 'prop-asset-chip-ico'
  renderIcon(icon, undefined, 'image-off', 'sm')
  const text = document.createElement('span')
  text.className = 'prop-asset-chip-text'
  text.textContent = t(state === 'missing' ? 'ui.props.assetMissing' : 'ui.props.assetUnavailable')
  chip.append(icon, text)
  return chip
}

/**
 * **文件 chip**：内态但索引说不是图片（pdf／音视频…）。画 `<img>` 只会 error，
 * 然后「图片不可用」——字节明明在库里，这句就是谎话。
 * 文本给 mime 的子类型（`image/png` → PNG），是数据不是文案，不占翻译表。
 */
function fileChip(mime: string): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'prop-asset-chip prop-asset-chip--file'
  const icon = document.createElement('span')
  icon.className = 'prop-asset-chip-ico'
  renderIcon(icon, undefined, 'file-text', 'sm')
  const text = document.createElement('span')
  text.className = 'prop-asset-chip-text'
  text.textContent = (mime.split('/')[1] ?? '').toUpperCase()
  chip.append(icon, text)
  return chip
}

function removeButton(onRemove: () => void): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'prop-asset-remove'
  btn.dataset.tip = t('ui.props.assetRemove')
  btn.textContent = '×'
  btn.addEventListener('click', (e) => {
    // 这枚缩略图可能落在块下属性行的按钮里：不抢「点整对开面板」那一下
    e.stopPropagation()
    onRemove()
  })
  return btn
}

export interface AssetThumbOptions {
  size?: AssetThumbSize
  /** 给了就画一枚摘除键；值怎么改由调用方决定（单值清空／多值去掉这一项） */
  onRemove?: () => void
}

/**
 * 一枚资产露面：真图 `<img>`，或缺失／不可用的文字 chip。
 *
 * `dataset.assetRef` 留着原值：hover 能看到是哪一个 hash／链接，冒烟也据此认这一枚。
 */
export function makeAssetThumb(ref: string, opts: AssetThumbOptions = {}): HTMLElement {
  const size = opts.size ?? 'panel'
  const wrap = document.createElement('span')
  wrap.className = `prop-asset-thumb prop-asset-thumb--${size}`
  wrap.dataset.assetRef = ref
  wrap.dataset.tip = ref
  const view = assetRefView(ref)
  if (view.state === 'ready' && view.url) {
    // 内态非图（文件）画不出图：给文件 chip，不画一个注定 error 的假 <img>
    const internal = assetRefKindOf(ref) === 'internal'
    if (internal && view.mime !== undefined && !view.mime.startsWith('image/')) {
      wrap.appendChild(fileChip(view.mime))
      if (opts.onRemove) wrap.appendChild(removeButton(opts.onRemove))
      return wrap
    }
    const img = document.createElement('img')
    img.className = 'prop-asset-img'
    img.src = view.url
    img.alt = t('ui.props.assetAlt')
    img.draggable = false
    img.addEventListener(
      'error',
      () => {
        // 内态才记「这份字节不在库里」；外态只是这一刻取不到，别把链接记成库里的缺失
        if (assetRefKindOf(ref) === 'internal') markAssetMissing(ref)
        wrap.replaceChildren(failedChip('missing'))
        if (opts.onRemove) wrap.appendChild(removeButton(opts.onRemove))
      },
      { once: true },
    )
    wrap.appendChild(img)
  } else {
    // `ready` 但没有地址（web 的 Blob URL 还没就绪）与「取不到」是同一种显示态
    wrap.appendChild(failedChip(view.state === 'ready' ? 'missing' : view.state))
  }
  if (opts.onRemove) wrap.appendChild(removeButton(opts.onRemove))
  return wrap
}

export interface AssetActivateDeps {
  /** lightbox 标题（块下行用栏名；正文原子用 run 上的文件名） */
  label: string
  /** 外态链接交给系统浏览器（`App.openExternal` 的注入点；被拒时的文案由那一层给） */
  openUrl: (url: string) => void
  /** 其余情形的详情落点（面板那一栏／原子详情浮层由调用方给） */
  onDetails: () => void
}

/**
 * **点一枚资产露面**的默认动作（判据在 `assetClickActionOf`，这里只执行）。
 *
 * 块下行、面板值控件、正文原子共用这一份——分两处写就会出现
 * 「正文里点图能放大、块下点图没反应」这种只在某处复现的差别。
 */
export function activateAssetRef(ref: string, deps: AssetActivateDeps): void {
  const action = assetClickActionOf(ref)
  if (action.t === 'external') deps.openUrl(action.url)
  else if (action.t === 'lightbox') openImageLightbox({ url: action.url, label: deps.label, subtitle: action.subtitle })
  else deps.onDetails()
}

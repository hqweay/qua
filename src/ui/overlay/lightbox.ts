/**
 * **lightbox**：全屏看一张行内图片。
 *
 * 为什么需要它：行内层的契约是「一个点、占 1 格」（行高缩略图），
 * 所以「看清楚这张图」必须另有一处 —— 不是把行内图拉大（那会让行高随图变，
 * 虚拟化的 `visibleRowHeight` 就得跟着喂图片尺寸，是另一档工作）。
 *
 * 三条实测口径：
 *   1. **点遮罩关、点图不关**：图本身是「我要看的东西」，点它不该消失；
 *   2. `Esc` 关：与所有浮层同一套退出键，用户不用学第二种；
 *   3. 关闭时把 `src` 清掉再摘节点 —— 大图常驻在 DOM 里会让合成层一直占着内存，
 *      而这张图可能已经不在视口里了。
 *
 * ⚠️ 一个实例一个遮罩（不是复用）：同一时刻只该有一个 lightbox 打开，
 *    重复打开时先把旧的摘掉（否则 Esc 会关掉最上面那层、下面那层留在屏幕上）。
 */
export interface LightboxOptions {
  url: string
  /** 标题：文件名快照（缺失时它就是唯一能认出这张图的东西） */
  label: string
  /** 副标题：尺寸／大小／hash 短码，一行说明 */
  subtitle?: string
}

import { dismissFloating } from './overlay-dismiss.ts'

let current: HTMLElement | null = null

function closeLightbox(): void {
  if (!current) return
  const el = current
  current = null
  document.removeEventListener('keydown', onKey, true)
  // 状态立即归零（lightboxOpen/Esc 判据不再看它）；遮罩淡出走完再摘节点，
  // 大图的 src 也在那时才清——淡出途中先把 src 摘掉，屏幕上会闪一帧空图。
  dismissFloating(el, () => {
    const img = el.querySelector('img')
    if (img) img.removeAttribute('src')
  })
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // 捕获阶段拦下：lightbox 是最上层，Esc 不该先去关别的浮层
  e.preventDefault()
  e.stopPropagation()
  closeLightbox()
}

/**
 * 打开一张图。
 *
 * 调用方负责**只在 `state === 'ready'` 且是图片时**调它：缺失/不可用不打开空 lightbox
 * （那会得到一个黑屏，用户以为图坏了）。
 */
export function openImageLightbox(o: LightboxOptions): void {
  closeLightbox()

  const overlay = document.createElement('div')
  overlay.className = 'lightbox'
  overlay.dataset.lightbox = '1'
  overlay.tabIndex = -1

  const figure = document.createElement('figure')
  figure.className = 'lightbox-figure'

  const img = document.createElement('img')
  img.className = 'lightbox-img'
  img.src = o.url
  img.alt = o.label
  img.draggable = false
  // 点图不关：这一支只是拦掉冒泡，真正的关闭在遮罩上
  img.addEventListener('click', (e) => e.stopPropagation())
  figure.appendChild(img)

  const caption = document.createElement('figcaption')
  caption.className = 'lightbox-caption'
  const title = document.createElement('span')
  title.className = 'lightbox-title ui-ellipsis'
  title.textContent = o.label
  caption.appendChild(title)
  if (o.subtitle) {
    const sub = document.createElement('span')
    sub.className = 'lightbox-sub'
    sub.textContent = o.subtitle
    caption.appendChild(sub)
  }
  figure.appendChild(caption)
  overlay.appendChild(figure)

  // 点遮罩关（点在 figure 里不算：那已经由 figure 内部各自拦掉了）
  overlay.addEventListener('click', () => closeLightbox())
  document.addEventListener('keydown', onKey, true)

  document.body.appendChild(overlay)
  current = overlay
  // 焦点交给遮罩：Esc 才能被它这一层先收到（也给读屏一个落点）
  overlay.focus()
}

/** 当前有没有 lightbox 开着（探针/断言用；也是「不要开第二个」的判据） */
export function lightboxOpen(): boolean {
  return current !== null
}

/** 关掉（换页/换库时由装配层统一收，避免遮罩留在屏幕上挡住新页面） */
export function closeImageLightbox(): void {
  closeLightbox()
}

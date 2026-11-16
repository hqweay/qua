/**
 * **资产入库与选文件**：字节入库的公共段（正文粘贴／选文件／属性值选文件共用）＋
 * 资产地址变化的重画订阅 ＋ 外链交给系统浏览器。
 *
 * 「哪种文件能进这个库」只该有一个答案——校验（嗅 MIME／上限／allowlist）在入库
 * **之前**：先入库再校验等于让不合格的字节占了地方，而 v1 没有 GC。
 * 失败一律走 toast，不静默：用户刚按了粘贴/选了文件，「什么都没发生」是最糟的反馈。
 */
import { checkExternalUrl, rejectText } from '../../core/relations/link.ts'
import { IMAGE_MIME_ALLOWLIST, MAX_IMAGE_BYTES, sniffImageMime, type AssetMeta } from '../../core/infra/assets.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'
import { flatten } from '../../core/index.ts'
import type { AssetStorePort } from '../../core/storage/asset-port.ts'
import { assetsAvailable, onAssetChange, primeAsset } from '../../view/asset-views.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import type { BlockStore } from '../../core/model/store.ts'

export interface AssetsDeps {
  /** 资产库端口（算 hash／去重／读尺寸）；web 与桌面各一份实现，装配层选型 */
  assetStore: AssetStorePort
  /** 活动编辑器（装配层单槽，运行期会换）：取光标落点与插 run 用 */
  getEd: () => BlockEditor
  /** 属性面板晚于本片装配：闭包现取（地址就绪时要单独排一次重画） */
  scheduleProperties: () => void
  /** 角标刷新（同上，晚于本片装配） */
  scheduleBadge: () => void
  /** 用户可见提示（App 门面的 toast） */
  toast: App['toast']
  /** 共享 store：地址变化时扫全库找引用者 */
  blocks: BlockStore
  /** 单行重画（装配层自有）：只重画引用了这个 hash 的块，不整页重排 */
  repaintBlock: (blockId: string) => void
}

export function setupAssets(deps: AssetsDeps) {
  const { assetStore, blocks } = deps

  async function putAssetBlob(blob: Blob): Promise<AssetMeta | null> {
    if (!assetsAvailable()) {
      deps.toast(t('ui.asset.storeUnavailable'), 'warn')
      return null
    }
    if (blob.size > MAX_IMAGE_BYTES) {
      deps.toast(t('ui.asset.tooLarge', { mb: String(Math.round(MAX_IMAGE_BYTES / (1024 * 1024))) }), 'warn')
      return null
    }
    try {
      // 嗅探要在 put 之前判：不让不合格的字节先进库（v1 没有 GC）
      const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
      if (!sniffImageMime(head)) {
        deps.toast(t('ui.asset.unsupported'), 'warn')
        return null
      }
      const meta = await assetStore.put(blob)
      // 入库成功 ⇒ 立刻登记：正文 run 与属性值这一格的首帧都能画出图
      primeAsset(meta)
      return meta
    } catch (e) {
      // 解码失败（createImageBitmap 读不出尺寸）与配额/权限失败都走这里
      console.warn('[assets] put failed:', e)
      deps.toast(t('ui.asset.putFailed'), 'warn')
      return null
    }
  }

  async function insertAssetBlob(
    blob: Blob,
    label: string,
    point?: { blockId: string; offset: number },
  ): Promise<boolean> {
    const where = point ?? deps.getEd().insert.caretPoint()
    if (!where) {
      deps.toast(t('ui.asset.needCaret'), 'warn')
      return false
    }
    const meta = await putAssetBlob(blob)
    if (!meta) return false
    // 尺寸不进 run：它是那份字节的属性，从索引里读（见 `AssetRun`）
    const runId = deps.getEd().insert.insertAssetAt(where.blockId, where.offset, meta.hash, { label })
    if (!runId) {
      // 块在入库期间被删 / 光标越界：字节已经落库（孤儿，无害），引用不落
      deps.toast(t('ui.asset.caretGone'), 'warn')
      return false
    }
    return true
  }

  /**
   * **选图片文件的唯一入口**：临时 `<input type=file>`，用完即摘。
   *
   * 为什么临时建而不是常驻一个：这个元素只在这一刻有意义，常驻会让 `index.html`
   * 多一个谁都不认识的空控件。两条去处（正文插入／属性值）只差拿到文件之后做什么，
   * accept 白名单不能分家。
   */
  function openImageFileInput(onFile: (file: File) => void): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = IMAGE_MIME_ALLOWLIST.join(',')
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      input.remove()
      if (file) onFile(file)
    })
    // 取消选择不派发 change：用 cancel 事件把临时节点收掉（没有也不泄漏，只是留一个游离节点）
    input.addEventListener('cancel', () => input.remove())
    input.click()
  }

  /** **属性值的选文件入口**：只入库，不碰正文光标；拿到 hash 交回调写 `props[propId]` */
  function pickAssetValue(onPick: (hash: string) => void): void {
    openImageFileInput((file) => {
      void putAssetBlob(file).then((meta) => {
        if (meta) onPick(meta.hash)
      })
    })
  }

  /** 正文的选文件入口：先捕获光标落点，入库期间光标会动，不能等到写完再取 */
  function pickImageViaFileInput(): void {
    const point = deps.getEd().insert.caretPoint()
    if (!point) {
      deps.toast(t('ui.asset.needCaret'), 'warn')
      return
    }
    openImageFileInput((file) => {
      void insertAssetBlob(file, file.name, point)
    })
  }

  /**
   * **把地址交给系统浏览器**。只调 `window.open`：壳在 `setWindowOpenHandler` 那头等着，
   * 只放行 http(s)；web 下就是一次普通的新标签。
   * ⚠️ 白名单一律走 `core/link.ts`，与主进程那一份取值相同——两处分叉的表现是
   *    「界面上看着能开、点下去毫无反应」，而它不报错。
   *
   * @returns 真的发出去了才 `true`（被拦下时已经给了文案，调用方不必再说一遍）
   */
  function openExternalUrl(raw: string): boolean {
    const chk = checkExternalUrl(raw)
    if (!chk.ok) {
      deps.toast(rejectText(chk), 'warn')
      return false
    }
    window.open(chk.url, '_blank', 'noopener,noreferrer')
    return true
  }

  /**
   * **某个资产地址变了（就绪 / 判定缺失）时，重画引用了它的那几行**。
   *
   * 桌面版地址是常量，这一段平时不会响；浏览器端字节从 IndexedDB 读出来才会有一次
   * 「地址就绪」，以及 `<img>` 报错时的「判定缺失」。只重画**引用了这个 hash 的块**：
   * 重排整页会打断正在输入的那一行。
   */
  onAssetChange((hash) => {
    const hit = new Set<string>()
    for (const b of flatten({ roots: blocks.blocks })) {
      /** 正文的一枚资产 run，或**属性值**（单值／多值）指向这个 hash */
      const inContent = b.content.some((r) => r.t === 'asset' && r.asset === hash)
      const inProps = Object.values(b.props ?? {}).some((v) =>
        typeof v === 'string' ? v === hash : Array.isArray(v) && v.includes(hash),
      )
      if (inContent || inProps) hit.add(b.id)
    }
    for (const id of hit) deps.repaintBlock(id)
    /**
     * 属性面板／抽屉／检视卡是「当前主体」的投影，不在块 DOM 里：地址就绪要单独排一次重画。
     * 漏了这一行的症状：刚选完本地文件，那一格停在「图片不可用」，直到用户下一次交互才变真图。
     */
    deps.scheduleProperties()
    // 重画换了节点（文件占位 → 真图）⇒ 角标里的 DOM 读数是**派生量**，也要跟着排一次刷新
    deps.scheduleBadge()
  })

  return { putAssetBlob, insertAssetBlob, pickAssetValue, pickImageViaFileInput, openExternalUrl }
}

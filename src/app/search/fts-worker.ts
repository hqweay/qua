/**
 * 分词 worker：把 jieba-wasm 与拼音的 CPU 活搬出渲染线程。
 *
 * 为什么一定要 worker：重建 100k 块的分词实测约 1.5s（报告口径）；放在主线程就是
 * 「打开库后输入卡住 1.5 秒」。搜索是经常发生的事，这条延迟会被读成「应用卡了」。
 *
 * WASM 用**内联字节**而不是 `fetch(assetUrl)`：桌面端页面是 `file://`，
 * Chromium 不允许 `fetch(file://…)`；内联成 data URL 再解码成 `ArrayBuffer` 交给
 * wasm-bindgen，是两条宿主（web／Electron）都能走通的唯一形状。
 * 代价是 worker chunk 多约 5MB（base64），换来「文件协议下也能初始化」。
 */
import { cut, initSync } from 'jieba-wasm/web'
import { pinyin } from 'pinyin-pro'
import wasmInline from '../../../node_modules/jieba-wasm/pkg/web/jieba_rs_wasm_bg.wasm?inline'
import { tokenizeText } from '../../core/search/tokenizer.ts'

interface TokenizeRequest {
  id: number
  items: { id: string; text: string }[]
}
interface TokenizeReply {
  id: number
  rows?: { id: string; seg: string; chars: string; pinyin: string }[]
  error?: string
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<TokenizeRequest>) => void) | null
  postMessage: (m: TokenizeReply) => void
}

let ready: Promise<void> | null = null

function bytesOf(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function ensureReady(): Promise<void> {
  if (!ready) {
    // 同步初始化：字节已经在手里，不需要 wasm-bindgen 的 fetch 分支
    initSync({ module: bytesOf(wasmInline) })
    ready = Promise.resolve()
  }
  return ready
}

scope.onmessage = (e) => {
  const req = e.data
  void (async () => {
    try {
      await ensureReady()
      const rows = req.items.map((x) => ({ id: x.id, ...tokenizeText(x.text, cut, pinyin as never) }))
      scope.postMessage({ id: req.id, rows })
    } catch (err) {
      scope.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) })
    }
  })()
}

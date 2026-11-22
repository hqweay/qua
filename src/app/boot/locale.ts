/**
 * 装配层的**第一处** import：在命令表求值之前把界面语言定好。
 *
 * 为什么必须在 import 阶段做完：命令表、绑定表在模块顶层就调 `t()` 取 title／label，
 * 它们只在页面加载时求值一次。等到 `main()` 里再 `setLocale`，已经取过的文案冻在旧档位，
 * 界面会一半中文一半英文。这里同步读完档位就直接写进字典，后面所有 import 看到的都是同一档。
 *
 * 为什么放在 app/boot 而不是 core：要读设备字节（`readRawSync` 适配器）与
 * `navigator.language`（DOM），两样 core 都不许碰。这里是装配层，正该做这种接线。
 */
import { DEVICE_KEY } from '../../core/storage/device.ts'
import { readRawSync } from '../../core/storage/local-storage.ts'
import { bootLocale, readStoredLocale } from '../../core/infra/locale.ts'
import type { Locale } from '../../core/infra/msg.ts'

/** 同步读设备字节里的档位；读不到就 null（⇒ 跟系统语言） */
function storedLocale(): Locale | null {
  const raw = readRawSync(DEVICE_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if ('data' in parsed) {
      const data: unknown = parsed.data
      return readStoredLocale(data)
    }
    return readStoredLocale(parsed)
  } catch {
    return null
  }
}

/** URL 上的 `?locale=en` / `?locale=zh` 是演示站与截图脚本的显式入口；不写偏好，只管这一页 */
function urlLocale(): Locale | null {
  const v = new URLSearchParams(window.location.search).get('locale')
  return v === 'zh' || v === 'en' ? v : null
}

export const LOCALE: Locale = bootLocale(urlLocale() ?? storedLocale(), navigator.language)

// Electron 主进程的原生菜单在 renderer 之前就建好了：把最终档位告诉它重建。
// web 宿主没有这条桥，判空即可——不是错误。
const kbBridge = (window as unknown as { kb?: { setLocale?: (l: Locale) => void } }).kb
kbBridge?.setLocale?.(LOCALE)

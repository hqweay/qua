/**
 * 界面语言——**设备态的一个档位**，不是内容、不进 KB。
 *
 * 为什么要独立成模块：文案字典（`msg.ts`）必须在**任何命令表求值之前**知道自己该用哪份。
 * 命令表在 import 时就调 `t()` 取 title／category／keywords ⇒ 晚一步设进去，
 * 文案就冻在默认语言里，切换语言要重开才生效。这个模块由装配层的**第一处 import**引入，
 * 在模块求值时同步定档。
 *
 * 档位来源两条：
 *   1. 设备偏好里显式选过的（`prefs.locale`）——用户决定优先；
 *   2. 没有选过 ⇒ 跟系统／浏览器语言（`navigator.language`），中文走 zh、其余走 en。
 *     宣传场景里英文访客打开演示站就直接是英文，不必先找设置入口。
 *
 */
import type { Locale } from './msg.ts'
import { getLocale, setLocale } from './msg.ts'

/** 从语言标签判断档位：只有 zh 系走中文，其余（含 en、未知）走英文 */
export function localeFromTag(tag: string | undefined): Locale {
  return tag && /^zh\b/i.test(tag) ? 'zh' : 'en'
}

/** 读取设备偏好里显式选过的档位；没有就 null（⇒ 走系统语言） */
export function readStoredLocale(raw: unknown): Locale | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!('prefs' in raw)) return null
  const prefs: unknown = raw.prefs
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs) || !('locale' in prefs)) return null
  const l: unknown = prefs.locale
  return l === 'zh' || l === 'en' ? l : null
}

/**
 * 定档并写进字典。装配层最先调用它；返回选中的档位供 `document.documentElement.lang` 用。
 * `systemTag` 由装配层传进来（core 零 DOM，这里不碰 `navigator`）。
 */
export function bootLocale(stored: Locale | null, systemTag: string | undefined): Locale {
  const chosen = stored ?? localeFromTag(systemTag)
  setLocale(chosen)
  return chosen
}

/** `Intl` 用的标签：中文长日期走 zh-CN，英文走 en-US */
export function intlLocale(): string {
  return getLocale() === 'zh' ? 'zh-CN' : 'en-US'
}

/** 排序用的标签；中文按拼音、英文按字母 */
export function collatorLocale(): string {
  return getLocale() === 'zh' ? 'zh-Hans-CN' : 'en'
}

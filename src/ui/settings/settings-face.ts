/**
 * **设置面**（工具面）：偏好与键位在中心的一次露面。
 *
 * 两条口径：
 *   · **设置面不拥有数据**：主题走既有命令、键位覆盖写在设备偏好里（`prefs.keys`），
 *     这里只画与收手势——写路径全部经装配层给的回调，组件自己不落盘、不碰绑定表；
 *   · **一行一件事**：快捷键行读成「命令名 …… 键位」，改键位＝点键位、按新的。
 *     捕获期间整份按键归这一行（Esc 取消），别的命令不能被半路触发。
 */
import {
  eventKeyId,
  keyLabel,
  keymapSettingsRows,
  keyOwnerOf,
  validateUserKey,
} from '../../core/infra/bindings.ts'
import { t, type MsgId } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'

/**
 * 面只消费的**两格偏好**（结构最小依赖：不 import 偏好层——组件不认识落盘形状，
 * 装配层给什么就是什么，主题三档与键位覆盖在这里就是全部）。
 */
interface SettingsPrefs {
  theme: 'system' | 'light' | 'dark'
  /** 界面语言（设备态）；null = 跟系统 */
  locale: 'zh' | 'en' | null
  /** 块下属性区的密度档 */
  propsDensity: 'summary' | 'list'
  keys: Record<string, string | null>
  /** 自动化投影的键位覆盖（库态）；按行的派生归属读写 */
  libraryKeys: Record<string, string | null>
}

export interface SettingsFaceDeps {
  /** 现在的偏好（**活引用**：显示用现读，装配层写完不通知——面自己在动作后重画） */
  prefs: () => SettingsPrefs
  /** 命令面（主题直选走既有命令） */
  invoke: (name: string, args: Record<string, unknown>) => void
  /** 打开快捷键区前重建动作表（自动化可能新建/改名/删掉）；装配层给 */
  refreshKeyActions?: () => void
  /** 写键位覆盖（装配层：进对应那份偏好、注入绑定层、落盘；整表替换）；scope 派生自行的归属 */
  patchKeys: (scope: 'device' | 'library', next: Record<string, string | null>) => void
  /** 校验不过给一句实话（保留键／裸键／占用冲突） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

const THEME_MODES: readonly { mode: 'system' | 'light' | 'dark'; label: MsgId }[] = [
  { mode: 'system', label: 'ui.theme.mode.system' },
  { mode: 'light', label: 'ui.theme.mode.light' },
  { mode: 'dark', label: 'ui.theme.mode.dark' },
]

/** 块下属性密度的两档（标签走字典：`ui.props.density.*`） */
const DENSITIES: readonly { density: 'summary' | 'list'; label: MsgId }[] = [
  { density: 'summary', label: 'ui.props.density.summary' },
  { density: 'list', label: 'ui.props.density.list' },
]

export class SettingsFace {
  readonly root: HTMLElement
  private readonly deps: SettingsFaceDeps
  /** 正在捕获新键的行（同一时刻至多一行）；Esc 或失焦取消 */
  private capturingId: string | null = null
  /** 捕获冲突时已提示过的占用者（再按一遍才确认）；换行或取消即作废 */
  private confirmConflict: string | null = null
  private readonly isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  constructor(deps: SettingsFaceDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'settings-face'
  }

  mount(host: HTMLElement): void {
    host.replaceChildren(this.root)
    this.render()
  }

  dispose(): void {
    this.capturingId = null
    this.confirmConflict = null
    this.root.replaceChildren()
  }

  render(): void {
    this.root.replaceChildren(this.sectionTheme(), this.sectionLanguage(), this.sectionPropsLine(), this.sectionKeys())
  }

  /* ---------------------------------------------------------- 外观 */

  private sectionTheme(): HTMLElement {
    const sec = document.createElement('section')
    sec.className = 'settings-sec'
    const title = document.createElement('h2')
    title.className = 'settings-sec-title'
    title.textContent = t('ui.settings.appearance')
    sec.append(title)
    const row = document.createElement('div')
    row.className = 'settings-theme'
    row.dataset.settings = 'theme'
    const current = this.deps.prefs().theme
    for (const m of THEME_MODES) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ui-btn settings-theme-opt'
      b.dataset.settingsTheme = m.mode
      b.textContent = t(m.label)
      if (current === m.mode) b.classList.add('settings-theme-opt--on')
      b.addEventListener('click', () => {
        this.deps.invoke('core.view/set-theme', { mode: m.mode })
        this.render()
      })
      row.append(b)
    }
    sec.append(row)
    return sec
  }

  /* ---------------------------------------------------------- 界面语言 */

  private sectionLanguage(): HTMLElement {
    const sec = document.createElement('section')
    sec.className = 'settings-sec'
    const title = document.createElement('h2')
    title.className = 'settings-sec-title'
    title.textContent = t('ui.settings.language')
    const hint = document.createElement('p')
    hint.className = 'settings-hint'
    hint.textContent = t('ui.settings.languageHint')
    const row = document.createElement('div')
    row.className = 'settings-theme'
    row.dataset.settings = 'language'
    const current = this.deps.prefs().locale
    const options: readonly { locale: 'zh' | 'en'; label: 'ui.locale.zh' | 'ui.locale.en' }[] = [
      { locale: 'zh', label: 'ui.locale.zh' },
      { locale: 'en', label: 'ui.locale.en' },
    ]
    for (const opt of options) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ui-btn settings-theme-opt'
      b.dataset.settingsLocale = opt.locale
      b.textContent = t(opt.label)
      if (current === opt.locale) b.classList.add('settings-theme-opt--on')
      b.addEventListener('click', () => {
        this.deps.invoke('core.view/set-locale', { locale: opt.locale })
      })
      row.append(b)
    }
    sec.append(title, hint, row)
    return sec
  }

  /* ---------------------------------------------------------- 块下属性 */

  /**
   * **块下属性区的密度**（设备态）：一行摘要 / 一栏一行。
   *
   * 为什么这个开关在这里、不在属性定义页：它决定的是「**这一屏**读多密」，
   * 作用于所有块；放到某条属性的定义上就变成「这条占整行、那条挤半行」的混排，
   * 而且用户要为每一条属性回答同一个排版问题。定义页管的是值与格式。
   */
  private sectionPropsLine(): HTMLElement {
    const sec = document.createElement('section')
    sec.className = 'settings-sec'
    const title = document.createElement('h2')
    title.className = 'settings-sec-title'
    title.textContent = t('ui.settings.propsLine')
    const hint = document.createElement('p')
    hint.className = 'settings-hint'
    hint.textContent = t('ui.settings.propsLineHint')
    const row = document.createElement('div')
    row.className = 'settings-theme'
    row.dataset.settings = 'props-line'
    const current = this.deps.prefs().propsDensity
    for (const opt of DENSITIES) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ui-btn settings-theme-opt'
      b.dataset.propsDensity = opt.density
      b.textContent = t(opt.label)
      if (current === opt.density) b.classList.add('settings-theme-opt--on')
      b.addEventListener('click', () => {
        this.deps.invoke('core.view/set-props-density', { density: opt.density })
        this.render()
      })
      row.append(b)
    }
    sec.append(title, hint, row)
    return sec
  }

  /* ---------------------------------------------------------- 快捷键 */

  private sectionKeys(): HTMLElement {
    // 自动化可能新建/改名/删掉：打开这一区时重建动作表，清单与解析都跟当前库一致
    this.deps.refreshKeyActions?.()
    const sec = document.createElement('section')
    sec.className = 'settings-sec'
    const title = document.createElement('h2')
    title.className = 'settings-sec-title'
    title.textContent = t('ui.settings.keys')
    const hint = document.createElement('p')
    hint.className = 'settings-hint'
    hint.textContent = t('ui.settings.keysHint')
    sec.append(title, hint)

    const list = document.createElement('div')
    list.className = 'settings-keys'
    list.dataset.settings = 'keys'
    for (const row of keymapSettingsRows()) list.append(this.keyRow(row))
    sec.append(list)
    return sec
  }

  private keyRow(row: ReturnType<typeof keymapSettingsRows>[number]): HTMLElement {
    const el = document.createElement('div')
    el.className = 'settings-key-row'
    el.dataset.settingsKey = row.id

    const name = document.createElement('span')
    name.className = 'settings-key-name ui-ellipsis'
    name.textContent = row.title
    el.append(name)

    // 归属是派生事实（引用了什么），不是开关：一行小字说明，用户改不了
    const scope = document.createElement('span')
    scope.className = 'settings-key-scope ui-ellipsis'
    scope.textContent = t(row.scope === 'library' ? 'ui.keys.scope.library' : 'ui.keys.scope.device')
    el.append(scope)

    if (row.override !== undefined) {
      const mark = document.createElement('span')
      mark.className = 'settings-key-mark'
      mark.textContent = t(row.override === null ? 'ui.settings.removed' : 'ui.settings.customized')
      el.append(mark)
    }

    const keys = document.createElement('span')
    keys.className = 'settings-key-keys'
    if (this.capturingId === row.id) {
      keys.append(this.captureChip(row.id))
    } else if (row.keys.length === 0) {
      const none = document.createElement('button')
      none.type = 'button'
      none.className = 'settings-key-chip settings-key-chip--empty'
      none.textContent = '—'
      none.dataset.tip = t('ui.settings.keysHint')
      none.addEventListener('click', () => {
        this.capturingId = row.id
        this.render()
      })
      keys.append(none)
    } else {
      for (const k of row.keys) keys.append(this.keyChip(row.id, k))
    }
    el.append(keys)

    if (row.override !== undefined) {
      const reset = document.createElement('button')
      reset.type = 'button'
      reset.className = 'settings-key-reset'
      reset.dataset.tip = t('ui.settings.keysReset')
      reset.setAttribute('aria-label', t('ui.settings.keysReset'))
      renderIcon(reset, 'lucide:rotate-ccw', 'rotate-ccw')
      reset.addEventListener('click', () => {
        const p = this.deps.prefs()
        const next = { ...(row.scope === 'library' ? p.libraryKeys : p.keys) }
        delete next[row.id]
        this.deps.patchKeys(row.scope, next)
        this.render()
      })
      el.append(reset)
    }
    return el
  }

  private keyChip(rowId: string, key: string): HTMLButtonElement {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'settings-key-chip'
    chip.textContent = keyLabel(key, this.isMac)
    chip.dataset.tip = t('ui.settings.keysHint')
    chip.addEventListener('click', () => {
      this.capturingId = rowId
      this.render()
    })
    return chip
  }

  /**
   * 捕获态的那颗：拿到焦点后**下一颗按键**就是新键位。
   *
   * ⚠️ 捕获期整份按键归这一行：`stopPropagation` 挡住全局派发（命令不会半路触发）；
   * Esc 只取消捕获、不写覆盖。校验不过给一句实话，捕获不退出（可以再按一次）。
   */
  private captureChip(rowId: string): HTMLButtonElement {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'settings-key-chip settings-key-chip--capture'
    chip.dataset.settingsCapture = '1'
    chip.textContent = t('ui.settings.capture')
    chip.addEventListener('keydown', (e) => {
      // 修饰键先于主键 keydown（⌘U 会先来一颗 key='Meta'）：忽略它，等真正的那颗
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        this.capturingId = null
        this.confirmConflict = null
        this.render()
        return
      }
      const v = validateUserKey(eventKeyId(e, this.isMac))
      if (!v.ok) {
        this.deps.toast?.(t(v.reason), 'warn')
        return
      }
      // 冲突不硬拦：第一次按下先说清会盖掉谁，再按一遍才算确认（同键多义是允许的）
      const owner = keyOwnerOf(v.key)
      if (owner !== null && owner !== rowId) {
        const target = keymapSettingsRows().find((r) => r.id === owner)
        const name = target?.title ?? owner
        if (this.confirmConflict !== owner) {
          this.confirmConflict = owner
          this.deps.toast?.(t('ui.keys.conflict', { key: keyLabel(v.key, this.isMac), name }), 'warn')
          return
        }
      }
      const scope = keymapSettingsRows().find((r) => r.id === rowId)?.scope ?? 'device'
      const p = this.deps.prefs()
      this.deps.patchKeys(scope, { ...(scope === 'library' ? p.libraryKeys : p.keys), [rowId]: v.key })
      this.confirmConflict = null
      this.capturingId = null
      this.render()
    })
    chip.addEventListener('blur', () => {
      if (this.capturingId !== rowId) return
      this.capturingId = null
      this.confirmConflict = null
      this.render()
    })
    // 渲染在游离树里 focus 不到：等进文档再要焦点（与搜索面同一时刻差）
    window.setTimeout(() => chip.focus())
    return chip
  }
}

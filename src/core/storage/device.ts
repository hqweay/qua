/**
 * **设备状态**的落盘：不进 KB、不参与同步。
 *
 * 归属判据一句话：**引用块 id 或指涉某个库布局的状态跟着库走；纯外观与设备能力留设备。**
 *
 *   · **跟库走**（dock 整格、折叠表、露面视图 `mountViews`、日记栏 `journalMounts`）：
 *     它们的值全是块 id 或「这个库的槽里摆了什么」——留在设备键上，第二个库一开就会
 *     把 A 库的 id 指到 B 库的行上。它们住**库的 `settings` 表**（`LIBRARY_STATE_KEY`，
 *     桌面宿主经库面读写；web 宿主是单库演示，没有第二个库，暂住设备键）。
 *   · **留设备**（主题、虚拟化、badge、段排列等）：这台机器怎么看，与哪个库无关。
 *
 * 设备键里被搬走的字段**不再被读**（读侧只认库侧那份）：不迁移、不清除，自然孤儿化。
 *
 * ⚠️ 与库共用同一个 `StoragePort` 契约（异步、批次、单写者）：
 *    适配器只认字节，不认识「这是库还是偏好」—— 所以这里**不碰 `localStorage`**，
 *    只把 JSON 交给端口（`arch-check [20]` 要求 `localStorage` 只出现在 `local-storage.ts`）。
 */
import type { FoldState } from '../model/model.ts'
import type { Change, CommitBatch, StoragePort } from './port.ts'
import { normalizePrefs, type Prefs } from './prefs.ts'

/**
 * 设备状态的落盘键。
 *
 * 与 `STORAGE_KEY` 一样是**固定值**：原型期不做旧数据迁移，换键＝用户的主题/槽宽/卡片清单静默消失。
 * 它和库分开，是为了「一份坏了不连累另一份」：库作废重 seed 时偏好还在。
 */
export const DEVICE_KEY = 'qua.device'

/**
 * 库的 `settings` 表里，**跟库走的那份视图状态**的键（一份 JSON）。
 * 这是库级 settings 的第一个消费者；键只在这个表里需要唯一，所以取短名。
 */
export const LIBRARY_STATE_KEY = 'view-state'

/** 库侧设置的最小面（桌面宿主 preload 暴露的 `qua.getSetting`／`setSetting`；web 宿主没有） */
export interface LibrarySettingsSource {
  getSetting(key: string): Promise<unknown>
  setSetting(key: string, value: string): Promise<unknown>
}

/** 库侧设置的端口（`createLibrarySettingsPort` 把宿主回复的形状折成这一份） */
export interface LibrarySettingsPort {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<{ ok: true } | { ok: false; error: unknown }>
}

/** 库侧那份 JSON 的形状：只装「跟库走」的四格 */
export interface LibraryState {
  dock: Prefs['dock']
  folded: FoldState
  mountViews: Prefs['mountViews']
  journalMounts: Prefs['journalMounts']
}

/**
 * 把宿主的库面（回复形状是宿主定的）折成端口。
 * 回复不是预期形状 ⇒ 当作「没有这份设置」，不是错误——状态不是内容，没有「打不开」分支。
 */
export function createLibrarySettingsPort(src: LibrarySettingsSource): LibrarySettingsPort {
  return {
    async get(key) {
      try {
        const r = (await src.getSetting(key)) as { status?: unknown; value?: unknown } | null
        return r && typeof r === 'object' && r.status === 'ok' && typeof r.value === 'string' ? r.value : null
      } catch {
        return null
      }
    },
    async set(key, value) {
      try {
        const r = (await src.setSetting(key, value)) as { ok?: unknown; error?: unknown } | null
        return r && typeof r === 'object' && r.ok === true ? { ok: true } : { ok: false, error: r?.error ?? r }
      } catch (e) {
        return { ok: false, error: e }
      }
    },
  }
}

/** 设备状态：这台设备怎么显示（偏好 ＋ 折叠态）。 */
export interface DeviceState {
  prefs: Prefs
  /** 折叠态（块 id → 收起）。只记收起的，见 `FoldState` */
  folded: FoldState
}

export type DeviceSaveResult = { ok: true } | { ok: false; error: unknown }

export interface DeviceStore {
  readonly kind: string
  /**
   * 读设备状态。**永远成功**：读不到／认不出／字节坏了都回落默认值
   * （偏好与折叠态都不是内容，没有「只读保护」的必要，也不该因为一格坏了就打不开 app）。
   */
  load: () => Promise<DeviceState>
  save: (state: DeviceState) => Promise<DeviceSaveResult>
  /** 等已在途的提交落盘（页面隐藏 / 关页前） */
  settle: () => Promise<void>
}

/**
 * `Change[]` 描述的是**库里的对象**（块／区间）。设备状态不在库里，
 * 所以这批改动诚实地报「库没有变化」——适配器本来也只看 `payload`。
 */
const NO_KB_CHANGE: Change[] = []

/** 兜底值：每次都给一份新的（`DEFAULT_PREFS` 里的 `dock` 是共享对象，直接返回会被调用方改坏） */
const defaultDevice = (): DeviceState => ({ prefs: normalizePrefs(undefined), folded: {} })

/**
 * 折叠表的归一：**只留 `true`**，其余一律丢掉。
 *
 * 与**库**的形状校验不同：那边判的是「这份字节还能不能打开」，一个坏键就判整库 corrupt；
 * 而设备状态没有「打不开」这种分支（偏好与折叠态都不该让人打不开 app）。
 * ⇒ 这里逐条丢弃：一个坏键不该连累整张表，缺省就是「全展开」。
 */
function normalizeFoldState(raw: unknown): FoldState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: FoldState = {}
  for (const [id, v] of Object.entries(raw)) {
    // `false` 与「不在表里」是同一件事的两种写法，留着就会出现「表里有它、但它是展开的」第三态
    if (v === true && id !== '') out[id] = true
  }
  return out
}

export function createDeviceStore(port: StoragePort, library?: LibrarySettingsPort): DeviceStore {
  return {
    kind: port.kind,

    async load(): Promise<DeviceState> {
      const [r, libRaw] = await Promise.all([
        port.load(),
        library ? library.get(LIBRARY_STATE_KEY) : Promise.resolve(null),
      ])
      // 空 / 别的后端留下 / 存储不可用：都是「没有可用的设备状态」，不是错误
      if (r.status !== 'ok') {
        const fallback = defaultDevice()
        if (!library) return fallback
        // 库侧仍在：那四格照库侧来，设备格回默认
        return mergeLibraryState(fallback.prefs, null)
      }
      let value: unknown
      try {
        value = JSON.parse(r.raw)
      } catch {
        return library ? mergeLibraryState(defaultDevice().prefs, null) : defaultDevice()
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return library ? mergeLibraryState(defaultDevice().prefs, null) : defaultDevice()
      }
      const { prefs, folded } = value as { prefs?: unknown; folded?: unknown }
      // 形状兜底归 `normalizePrefs` / `normalizeFoldState`（缺字段补默认、坏键丢掉）；这里只挡住「整格不是对象」
      const prefsRaw = prefs && typeof prefs === 'object' ? (prefs as Partial<Prefs>) : undefined
      if (!library) {
        return {
          prefs: normalizePrefs(prefsRaw),
          folded: normalizeFoldState(folded),
        }
      }
      // 有库面 ⇒ 那四格**只认库侧**（缺省为空/默认；设备键里被搬走的字段是孤儿，不捡）
      let lib: Partial<LibraryState> | null = null
      if (libRaw) {
        try {
          const parsed: unknown = JSON.parse(libRaw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lib = parsed as Partial<LibraryState>
        } catch {
          lib = null
        }
      }
      return mergeLibraryState(prefsRaw, lib)
    },

    async save(state: DeviceState): Promise<DeviceSaveResult> {
      const batch: CommitBatch = {
        // 设备偏好不是库内容：没有 op，如实报空（适配器只看 payload）
        ops: [],
        changes: NO_KB_CHANGE,
        payload: JSON.stringify({ prefs: state.prefs, folded: state.folded } satisfies DeviceState),
        savedAt: Date.now(),
      }
      const r = await port.commit(batch)
      if (library) {
        // 跟库走的四格写库侧：这份 JSON 是库 settings 的第一个消费者
        const libState: LibraryState = {
          dock: state.prefs.dock,
          folded: state.folded,
          mountViews: state.prefs.mountViews,
          journalMounts: state.prefs.journalMounts,
        }
        const lr = await library.set(LIBRARY_STATE_KEY, JSON.stringify(libState))
        if (!lr.ok) return { ok: false, error: lr.error }
      }
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },

    settle: () => port.settle(),
  }
}

/**
 * 有库面时的装载：那四格（dock／折叠／露面视图／日记栏）**只**从库侧那份 JSON 来，
 * 缺省为空/默认（不捡设备键里的孤儿——那是别的库留下的，捡了就是把 A 库的 id 指到 B 库）。
 * 设备格（主题等）照旧从设备字节来；形状兜底仍归 `normalizePrefs`／`normalizeFoldState`。
 */
function mergeLibraryState(prefsRaw: Partial<Prefs> | undefined, lib: Partial<LibraryState> | null): DeviceState {
  return {
    prefs: normalizePrefs({
      ...(prefsRaw ?? {}),
      dock: lib?.dock as Prefs['dock'] | undefined,
      mountViews: lib?.mountViews as Prefs['mountViews'] | undefined,
      journalMounts: lib?.journalMounts as Prefs['journalMounts'] | undefined,
    }),
    folded: normalizeFoldState(lib?.folded),
  }
}

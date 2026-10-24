/**
 * **设备状态**的落盘：不进 KB、不参与同步、换一台机器就该是另一份。
 *
 * 为什么独立成键（`qua.device`）而不是折在库里：
 *   · 库里存的是**内容**（块森林／锚点／回收站），它的版本号一变就要整库作废；
 *     把偏好塞在里面，等于「调一下主题宽度」和「改一次落盘形状」共用同一条生死线；
 *   · 偏好是**这台设备怎么显示**，换库（演示状态切换）不该把它带走，
 *     换机器／清站点数据时它的丢失也不该被当成内容丢失。
 *
 * 折叠态（`folded`）与偏好同性质：它是「这一行此刻收没收起」，不是内容。
 * 它此前住在库里（`workspace.folded`），代价是**折一下就会触发一次整库提交**，
 * 而换库时旧库的块 id 又会把新库的行折起来（id 对不上，纯垃圾）。
 * ⇒ 和偏好一样留在设备这侧，换库时整格清空（`main.ts` 的换库路径）。
 *
 * ⚠️ 与库共用同一个 `StoragePort` 契约（异步、批次、单写者）：
 *    适配器只认字节，不认识「这是库还是偏好」—— 所以这里**不碰 `localStorage`**，
 *    只把 JSON 交给端口（`arch-check [20]` 要求 `localStorage` 只出现在 `local-storage.ts`）。
 */
import type { FoldState } from '../model.ts'
import type { Change, CommitBatch, StoragePort } from './port.ts'
import { normalizePrefs, type Prefs } from './prefs.ts'

/**
 * 设备状态的落盘键。
 *
 * 与 `STORAGE_KEY` 一样是**固定值**：原型期不做旧数据迁移，换键＝用户的主题/槽宽/钉住静默消失。
 * 它和库分开，是为了「一份坏了不连累另一份」：库作废重 seed 时偏好还在。
 */
export const DEVICE_KEY = 'qua.device'

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
 * `Change[]` 描述的是**库里的对象**（块／锚点／原子）。设备状态不在库里，
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

export function createDeviceStore(port: StoragePort): DeviceStore {
  return {
    kind: port.kind,

    async load(): Promise<DeviceState> {
      const r = await port.load()
      // 空 / 别的后端留下 / 存储不可用：都是「没有可用的设备状态」，不是错误
      if (r.status !== 'ok') return defaultDevice()
      let value: unknown
      try {
        value = JSON.parse(r.raw)
      } catch {
        return defaultDevice()
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultDevice()
      const { prefs, folded } = value as { prefs?: unknown; folded?: unknown }
      // 形状兜底归 `normalizePrefs` / `normalizeFoldState`（缺字段补默认、坏键丢掉）；这里只挡住「整格不是对象」
      return {
        prefs: normalizePrefs(prefs && typeof prefs === 'object' ? (prefs as Partial<Prefs>) : undefined),
        folded: normalizeFoldState(folded),
      }
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
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },

    settle: () => port.settle(),
  }
}

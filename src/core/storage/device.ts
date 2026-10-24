/**
 * **设备状态**的落盘：不进 KB、不参与同步、换一台机器就该是另一份。
 *
 * 为什么独立成键（`qua.device`）而不是折在库里：
 *   · 库里存的是**内容**（块森林／锚点／回收站），它的版本号一变就要整库作废；
 *     把偏好塞在里面，等于「调一下主题宽度」和「改一次落盘形状」共用同一条生死线；
 *   · 偏好是**这台设备怎么显示**，换库（演示状态切换）不该把它带走，
 *     换机器／清站点数据时它的丢失也不该被当成内容丢失。
 *
 * ⚠️ 与库共用同一个 `StoragePort` 契约（异步、批次、单写者）：
 *    适配器只认字节，不认识「这是库还是偏好」—— 所以这里**不碰 `localStorage`**，
 *    只把 JSON 交给端口（`arch-check [20]` 要求 `localStorage` 只出现在 `local-storage.ts`）。
 */
import type { Change, CommitBatch, StoragePort } from './port.ts'
import { normalizePrefs, type Prefs } from './prefs.ts'

/**
 * 设备偏好的落盘键。
 *
 * 与 `STORAGE_KEY` 一样是**固定值**：原型期不做旧数据迁移，换键＝用户的主题/槽宽/钉住静默消失。
 * 它和库分开，是为了「一份坏了不连累另一份」：库作废重 seed 时偏好还在。
 */
export const DEVICE_KEY = 'qua.device'

/** 设备状态（会随实现长大；现在只有偏好一格） */
export interface DeviceState {
  prefs: Prefs
}

export type DeviceSaveResult = { ok: true } | { ok: false; error: unknown }

export interface DeviceStore {
  readonly kind: string
  /**
   * 读设备状态。**永远成功**：读不到／认不出／字节坏了都回落默认偏好
   * （偏好不是内容，没有「只读保护」的必要，也不该因为一格坏了就打不开 app）。
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
const defaultDevice = (): DeviceState => ({ prefs: normalizePrefs(undefined) })

export function createDeviceStore(port: StoragePort): DeviceStore {
  return {
    kind: port.kind,

    async load(): Promise<DeviceState> {
      const r = await port.load()
      // 空 / 别的后端留下 / 存储不可用：都是「没有可用的偏好」，不是错误
      if (r.status !== 'ok') return defaultDevice()
      let value: unknown
      try {
        value = JSON.parse(r.raw)
      } catch {
        return defaultDevice()
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultDevice()
      const prefs = (value as { prefs?: unknown }).prefs
      // 形状兜底归 `normalizePrefs`（缺字段补默认、坏值丢掉）；这里只挡住「整格不是对象」
      return { prefs: normalizePrefs(prefs && typeof prefs === 'object' ? (prefs as Partial<Prefs>) : undefined) }
    },

    async save(state: DeviceState): Promise<DeviceSaveResult> {
      const batch: CommitBatch = {
        changes: NO_KB_CHANGE,
        payload: JSON.stringify({ prefs: state.prefs } satisfies DeviceState),
        savedAt: Date.now(),
      }
      const r = await port.commit(batch)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },

    settle: () => port.settle(),
  }
}

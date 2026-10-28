/**
 * `app.json` 注册表 —— 全局库列表 ＋ 设备身份。**住库外**（默认 `<用户文档目录>/Qua/app.json`）。
 *
 * ## 为什么是 JSON 而不是 `app.db`
 *
 * 小、可读、可手修。以后要全局快捷键/插件配置再升级成 `app.db`，**不碰库**。
 * 代价（已登记）：两个全局格式之间将来要迁移一次。
 *
 * ## 三条纪律
 *
 * ① **原子写**：临时文件 ＋ `rename`。直接 `writeFileSync` 会在崩在中间时留下半截 JSON，
 *    而那等于「用户的库列表没了」——注册表是**外部库绝对路径的唯一记录**。
 * ② **坏文件不许静默丢库**：坏 ⇒ 备份成 `app.json.broken-<时间>`，再**扫 `repos/*` 重建默认库**
 *    （外部库救不回来，但默认库能全救回来），并把这件事如实报给调用方。
 * ③ **`device_id` 只在缺失时生成**，生成后立刻写回（否则下次启动又生成一个，历史断成两条设备线）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MANIFEST_FILE,
  parseManifest,
  parseRegistry,
  serializeRegistry,
  type AppRegistry,
  type LibraryEntry,
} from '../../src/core/library.ts'

export interface RegistryIo {
  /** 注册表文件路径（`<dataRoot>/app.json`） */
  file: string
  /** 默认库的父目录（`<dataRoot>/repos`） */
  reposDir: string
}

export interface LoadedRegistry {
  registry: AppRegistry
  /** 这次生成过 `device_id`（已经写回，调用方不必再管） */
  generatedDeviceId: boolean
  /** 坏文件备份到哪（`null` ＝ 没坏） */
  backup?: string
  /** 从 `repos/` 扫回来的库数（只在重建时非零） */
  recovered?: number
  /** 被摘掉的坏条目数（如实报，不静默） */
  dropped: number
}

/**
 * 原子写：同目录临时文件 ＋ `rename`。
 *
 * 为什么临时文件必须在**同一目录**：跨目录 `rename` 在部分文件系统上退化成「复制＋删」，
 * 那就丢掉了原子性；而临时文件在别的卷上时连 `rename` 都会 EXDEV。
 */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (e) {
    // rename 失败时清掉临时文件，别在用户目录里留垃圾
    try {
      writeFileSync(tmp, '')
      renameSync(tmp, `${tmp}.failed`)
    } catch {
      /* 清不掉就算了，报原始错误更重要 */
    }
    throw e
  }
}

/** 扫 `repos/<id>/library.json` 重建默认库列表（坏注册表时的救援路径） */
function recoverFromRepos(reposDir: string): LibraryEntry[] {
  if (!existsSync(reposDir)) return []
  const out: LibraryEntry[] = []
  for (const name of readdirSync(reposDir)) {
    const manifestPath = join(reposDir, name, MANIFEST_FILE)
    if (!existsSync(manifestPath)) continue
    let raw: string | null = null
    try {
      raw = readFileSync(manifestPath, 'utf8')
    } catch {
      continue
    }
    const m = parseManifest(raw)
    if (m.status !== 'ok') continue
    // 目录名与 manifest 的 id 不一致的条目**不猜**：宁可少一条，也不要绑错库
    if (m.manifest.id !== name) continue
    out.push({ id: m.manifest.id, name: m.manifest.id })
  }
  return out
}

/**
 * 读注册表（**永远返回一份可用的注册表**）。
 *
 * 为什么不用 `LoadResult` 那种分型：注册表坏了应用仍然必须能启动（欢迎页），
 * 而「坏了」这件事通过 `backup` 字段如实报出来，由 UI 决定怎么说。
 */
export function loadRegistry(io: RegistryIo): LoadedRegistry {
  const raw = existsSync(io.file) ? safeRead(io.file) : null
  const parsed = parseRegistry(raw)

  if (parsed.status === 'ok') {
    if (parsed.generatedDeviceId) saveRegistry(io, parsed.registry)
    return { registry: parsed.registry, generatedDeviceId: parsed.generatedDeviceId, dropped: parsed.dropped }
  }

  if (parsed.status === 'empty') {
    // 从没写过：起一份空的（device_id 现在生成并写回）
    const registry: AppRegistry = { version: 1, deviceId: '', libraries: [] }
    const fresh = parseRegistry(JSON.stringify(registry))
    if (fresh.status !== 'ok') throw new Error('registry: fresh parse failed')
    saveRegistry(io, fresh.registry)
    return { registry: fresh.registry, generatedDeviceId: true, dropped: 0 }
  }

  // 坏注册表：**先备份，再从 repos 重建**。绝不静默起一个空列表就完事。
  const backup = `${io.file}.broken-${Date.now()}`
  try {
    copyFileSync(io.file, backup)
  } catch (e) {
    console.warn('[library] registry backup failed', e)
  }
  const libraries = recoverFromRepos(io.reposDir)
  const seed = parseRegistry(JSON.stringify({ version: 1, libraries }))
  if (seed.status !== 'ok') throw new Error('registry: recovery parse failed')
  saveRegistry(io, seed.registry)
  return { registry: seed.registry, generatedDeviceId: true, backup, recovered: libraries.length, dropped: 0 }
}

function safeRead(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 原子写注册表 */
export function saveRegistry(io: RegistryIo, registry: AppRegistry): void {
  writeFileAtomic(io.file, serializeRegistry(registry))
}

/* ------------------------------------------------------------ 增删条目（纯内存，调用方决定何时 save） */

/** 加一条或更新同 id 的条目（同 id 只留一条：一个 id 只能对应一个会话） */
export function upsertLibrary(registry: AppRegistry, entry: LibraryEntry): AppRegistry {
  const libraries = registry.libraries.filter((l) => l.id !== entry.id)
  libraries.push(entry)
  return { ...registry, libraries }
}

/** 从列表移除（**不删目录**）：只摘 `app.json` 的条目 */
export function removeLibrary(registry: AppRegistry, id: string): AppRegistry {
  return {
    ...registry,
    libraries: registry.libraries.filter((l) => l.id !== id),
    lastOpenedId: registry.lastOpenedId === id ? undefined : registry.lastOpenedId,
  }
}

/** 标记「这次打开的是它」 */
export function markOpened(registry: AppRegistry, id: string, at: number = Date.now()): AppRegistry {
  return {
    ...registry,
    lastOpenedId: id,
    libraries: registry.libraries.map((l) => (l.id === id ? { ...l, lastOpenedAt: at } : l)),
  }
}

/** 按 id 找条目 */
export function findLibrary(registry: AppRegistry, id: string): LibraryEntry | undefined {
  return registry.libraries.find((l) => l.id === id)
}

/** 默认库的目录（`repos/<id>`）；外部库用条目自己的 `path` */
export function libraryDir(io: RegistryIo, entry: LibraryEntry): string {
  return entry.path ?? join(io.reposDir, entry.id)
}

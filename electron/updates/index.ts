/**
 * 更新提示（**通知式**）：问 GitHub 有没有比当前更新的发布；有就把菜单项换成
 * 「有新版 X…」，手动检查时弹一次框，把用户送到发布页由他自己下载安装。
 *
 * ## 为什么不是「后台下载 → 点一下重启就换好」
 *
 * 那条路在 macOS 上由 Squirrel.Mac 完成，而它判断「这个新包是不是我发的」**只靠代码签名**；
 * 当前发布形态是未签名（`mac.identity: null`、不公证）⇒ 更新装不进去。Windows 上未签名
 * 虽然装得进去，但「静默换版本」会和「数据格式还在动」叠在一起（库 schema 还会加版本），
 * beta 阶段宁可让用户亲手做一次「我知道我升级了」的动作。
 *
 * 签名这件事一旦定下来，换掉的只是「怎么装」——「有没有新版」这一份判据（`./pick.ts`）
 * 原样继续用，不留返工。
 *
 * ## 只碰壳
 *
 * 网络、缓存、弹窗、菜单都在这里，渲染进程一行不知道：不需要 IPC、不需要新 UI 面，
 * 也就不会牵动任何界面冒烟。菜单是构建时快照 ⇒ 状态一变由调用方重建菜单。
 */
import { BrowserWindow, app, dialog, net, shell, type MessageBoxOptions } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../../src/core/infra/msg'
import { pickLatest, type UpdateCheck } from './pick.ts'

/**
 * 发布源：本仓公开的 Releases。
 *
 * 不带 token：未认证的限流是 60 次/小时（按来源 IP），而检查节奏是 5 小时一次（外加手动）
 * ——用不到凭据，也就不在用户机器上放一个 token。未发布的版本未认证看不见，正好让「发布动作在
 * 人手上」这条口径不需要额外机制。
 */
const FEED_URL = 'https://api.github.com/repos/hqweay/qua/releases?per_page=20'

/** 后台检查的节奏 */
const INTERVAL_MS = 5 * 60 * 60 * 1000

/** 缓存新鲜期＝检查节奏：重启应用不额外发请求（否则一天点十次就烧完限流） */
const CACHE_TTL_MS = INTERVAL_MS

/** 启动后等一拍再问：别和首屏抢网络 */
const START_DELAY_MS = Number(process.env.QUA_UPDATE_DELAY_MS ?? 30_000)

/**
 * 自检注入点（只有 `checks/electron-smoke.mjs` 用）：一个 releases 载荷文件，替代网络。
 * 有了它，「检查 → 判定 → 菜单文案」这条链能整条验，且不依赖外网。
 */
const FEED_FIXTURE = process.env.QUA_UPDATE_FEED ?? ''

const CACHE_FILE = 'update-check.json'
/** 网络请求的上限：查更新不许把界面拖住 */
const FETCH_TIMEOUT_MS = 10_000

interface Cache {
  checkedAt: number
  releases: unknown
}

export interface Updater {
  /** 启动后台检查：等一拍 + 之后每 `INTERVAL_MS` 一次 */
  start(): void
  /** 用户从菜单点的检查：无视缓存，一定给出结论 */
  checkNow(): void
  /** 菜单项文案（有新版时带版本号） */
  menuLabel(): string
  /** 检查中置灰：点了没反应比变灰更糟 */
  menuEnabled(): boolean
}

export function createUpdater(opts: { userData: string; onChanged: () => void }): Updater {
  const cacheDir = join(opts.userData, 'cache')
  const cachePath = join(cacheDir, CACHE_FILE)

  let found: { version: string } | null = null
  let busy = false
  let timer: ReturnType<typeof setInterval> | null = null

  function readCache(): unknown | null {
    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<Cache>
      if (typeof raw.checkedAt !== 'number' || Date.now() - raw.checkedAt > CACHE_TTL_MS) return null
      return Array.isArray(raw.releases) ? raw.releases : null
    } catch {
      // 没有缓存 / 读坏了 / 旧格式：都按「没有缓存」处理，不是错误
      return null
    }
  }

  function writeCache(releases: unknown): void {
    try {
      mkdirSync(cacheDir, { recursive: true })
      const cache: Cache = { checkedAt: Date.now(), releases }
      writeFileSync(cachePath, JSON.stringify(cache))
    } catch (e) {
      // 缓存写不进去只影响「下次少发一个请求」，不影响这次结论
      console.warn('[updates] cache write failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function load(): Promise<unknown> {
    if (FEED_FIXTURE) {
      /**
       * 自检注入：读一份本地载荷替代网络。**刻意让出一次宏任务**——
       * 网络本来就是异步的；注入若比真实路径快成同步，自检看到的时序在真机上不存在
       * （状态和首帧一起落地，于是「状态变了要重建菜单」这条断言变成恒绿）。
       */
      await new Promise((resolve) => setTimeout(resolve, 50))
      return JSON.parse(readFileSync(FEED_FIXTURE, 'utf8'))
    }
    const res = await net.fetch(FEED_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `qua/${app.getVersion()}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`release feed responded ${res.status}`)
    return (await res.json()) as unknown
  }

  async function run(manual: boolean): Promise<void> {
    if (busy) return
    busy = true
    opts.onChanged()
    try {
      // 手动检查绕过缓存：用户按了就要问一次现在的事实
      const cached = manual ? null : readCache()
      let releases: unknown
      if (cached) {
        releases = cached
      } else {
        try {
          releases = await load()
        } catch (e) {
          console.warn('[updates] release feed failed', e instanceof Error ? e.message : String(e))
          // 后台检查失败是**静默**的（连不上不是新闻）；只有用户主动问才说出来
          if (manual) await sayUnavailable()
          return
        }
        writeCache(releases)
      }

      const result = pickLatest(releases, app.getVersion())
      // 状态只在这里落地；菜单的重建统一归 `finally`（一处宣布，两处状态不再各喊一次）
      found = result.kind === 'available' ? { version: result.next } : null
      if (manual) await report(result)
    } finally {
      busy = false
      opts.onChanged()
    }
  }

  async function ask(options: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  }

  async function sayUnavailable(): Promise<void> {
    await ask({
      type: 'warning',
      title: t('app.name'),
      message: t('update.failed'),
      detail: t('update.failedDetail'),
      buttons: [t('update.ok')],
    })
  }

  async function report(result: UpdateCheck): Promise<void> {
    if (result.kind === 'available') {
      const r = await ask({
        type: 'info',
        title: t('app.name'),
        message: t('update.availableTitle', { next: result.next }),
        detail: t('update.availableDetail', {
          current: result.current,
          next: result.next,
          notes: result.notes || t('update.noNotes'),
        }),
        buttons: [t('update.openRelease'), t('update.later')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (r.response === 0) {
        await shell.openExternal(result.url).catch((e: unknown) => {
          console.warn('[updates] open release page failed', e instanceof Error ? e.message : String(e))
        })
      }
      return
    }
    if (result.kind === 'up-to-date') {
      await ask({
        type: 'info',
        title: t('app.name'),
        message: t('update.upToDate'),
        detail: t('update.upToDateDetail', { current: result.current }),
        buttons: [t('update.ok')],
      })
      return
    }
    await sayUnavailable()
  }

  return {
    start(): void {
      if (timer) return
      setTimeout(() => void run(false), START_DELAY_MS)
      timer = setInterval(() => void run(false), INTERVAL_MS)
    },
    checkNow(): void {
      void run(true)
    },
    menuLabel(): string {
      return found ? t('menu.item.updateAvailable', { version: found.version }) : t('menu.item.checkUpdate')
    },
    menuEnabled(): boolean {
      return !busy
    },
  }
}

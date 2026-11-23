/**
 * 更新（**通知 ＋ 应用内下载**）：问 GitHub 有没有比当前更新的发布；有就把菜单项换成
 * 「有新版 X…」，点开弹一次框，把对应平台的安装包下载到「下载」目录，再问一句
 * 「现在退出并打开安装包吗」。
 *
 * ## 为什么不是「后台下载 → 点一下重启就换好」
 *
 * 那条路在 macOS 上由 Squirrel.Mac 完成，而它判断「这个新包是不是我发的」**只靠代码签名**；
 * 当前发布形态是未签名（`mac.identity: null`、不公证）⇒ 更新装不进去。Windows 上未签名
 * 虽然装得进去，但「静默换版本」会和「数据格式还在动」叠在一起（库 schema 还会加版本），
 * beta 阶段宁可让用户亲手做一次「我知道我升级了」的动作。
 *
 * 所以这一版省掉的是「去发布页找文件、下载、再打开」——安装包由应用自己下、自己打开，
 * 最后一步（拖进「应用程序」／走安装器）仍由用户完成。签名定下来以后，换掉的只是
 * 「下载 → 打开」这一段；「有没有新版」与「哪个安装包」这两份判据（`./pick.ts`）原样继续用。
 *
 * ## 只碰壳
 *
 * 网络、缓存、下载、弹窗、菜单都在这里，渲染进程一行不知道：不需要 IPC、不需要新 UI 面，
 * 也就不会牵动任何界面冒烟。菜单是构建时快照 ⇒ 状态一变由调用方重建菜单。
 */
import { BrowserWindow, app, dialog, net, shell, type MessageBoxOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { t } from '../../src/core/infra/msg'
import { downloadUpdate } from './download.ts'
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

/**
 * 自检注入点：下载目录。默认是用户的「下载」文件夹——自检不许往那里写东西。
 */
const DOWNLOAD_DIR = process.env.QUA_UPDATE_DOWNLOAD_DIR || ''

const CACHE_FILE = 'update-check.json'
/** 网络请求的上限：查更新不许把界面拖住 */
const FETCH_TIMEOUT_MS = 10_000

interface Cache {
  checkedAt: number
  releases: unknown
}

/** 一次可安装的更新（`pickLatest` 的 available 分支） */
type Available = Extract<UpdateCheck, { kind: 'available' }>

export interface Updater {
  /** 启动后台检查：等一拍 + 之后每 `INTERVAL_MS` 一次 */
  start(): void
  /** 用户从菜单点的：没查过就查，有新版就弹框，已下载就问装不装 */
  checkNow(): void
  /** 菜单项文案（有新版／下载中／已下载时带状态） */
  menuLabel(): string
  /** 检查或下载中置灰：点了没反应比变灰更糟 */
  menuEnabled(): boolean
}

export function createUpdater(opts: { userData: string; onChanged: () => void }): Updater {
  const cacheDir = join(opts.userData, 'cache')
  const cachePath = join(cacheDir, CACHE_FILE)
  const downloadDir = DOWNLOAD_DIR || app.getPath('downloads')
  // 运行时平台/架构：挑安装包只看事实，不看编译期假设
  const target = { platform: process.platform, arch: process.arch }

  let latest: Available | null = null
  let downloaded: { version: string; path: string } | null = null
  /** 下载进度百分数；`null` ＝没在下载 */
  let percent: number | null = null
  let busy = false
  /** 「装不装」那个框已经开着：菜单在模态框开着时仍可能被点，别叠第二张 */
  let prompting = false
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

  /**
   * 上次已经下过同一个版本（用户点过「稍后」/ 重启过应用）：文件字节数对得上就认领，
   * 不再重下一遍 150MB。对不上就当没下过，等用户点了再重下。
   */
  function reuseDownload(result: Available): void {
    if (!result.asset) {
      downloaded = null
      return
    }
    const path = join(downloadDir, basename(result.asset.name))
    try {
      downloaded = existsSync(path) && statSync(path).size === result.asset.size ? { version: result.next, path } : null
    } catch {
      downloaded = null
    }
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

      const result = pickLatest(releases, app.getVersion(), target)
      // 状态只在这里落地；菜单的重建统一归 `finally`（一处宣布，两处状态不再各喊一次）
      if (result.kind === 'available') {
        // 换了新版本 ⇒ 之前下好的那份就不算数了（菜单不该把旧包的「已下载」挂在新版本上）
        if (!latest || latest.next !== result.next) reuseDownload(result)
        latest = result
      } else {
        latest = null
        downloaded = null
      }
      // 走到这里才轮到「用户主动问」：已经下好的直接问装不装，别让他再点一次下载
      if (manual) {
        if (downloaded) await promptInstall()
        else await report(result)
      }
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

  async function openRelease(url: string): Promise<void> {
    await shell.openExternal(url).catch((e: unknown) => {
      console.warn('[updates] open release page failed', e instanceof Error ? e.message : String(e))
    })
  }

  async function report(result: UpdateCheck): Promise<void> {
    if (result.kind === 'available') {
      // 挑不到本平台的安装包（比如资产命名变了）⇒ 不推一个走不通的下载，退回发布页
      const canDownload = result.asset !== null
      const buttons = canDownload
        ? [t('update.download'), t('update.openRelease'), t('update.later')]
        : [t('update.openRelease'), t('update.later')]
      const detail = t('update.availableDetail', {
        current: result.current,
        next: result.next,
        notes: result.notes || t('update.noNotes'),
      })
      const r = await ask({
        type: 'info',
        title: t('app.name'),
        message: t('update.availableTitle', { next: result.next }),
        detail: canDownload ? `${detail}\n\n${t('update.downloadHint')}` : detail,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
      })
      const openIndex = canDownload ? 1 : 0
      if (canDownload && r.response === 0) {
        await beginDownload(result)
        return
      }
      if (r.response === openIndex) await openRelease(result.url)
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

  async function beginDownload(result: Available): Promise<void> {
    // 注意：这里**不能**看 `busy`——`report` 是在「检查」那一笔还没收尾时调用它的，
    // 那一刻 busy 必然为真。重入由菜单置灰＋原生模态框挡住，不靠这个标志。
    if (!result.asset) return
    busy = true
    percent = 0
    opts.onChanged()

    let path: string
    try {
      path = await downloadUpdate(result.asset, {
        dir: downloadDir,
        userAgent: `qua/${app.getVersion()}`,
        onProgress: (p) => {
          const next = p.total > 0 ? Math.min(100, Math.floor((p.received / p.total) * 100)) : 0
          if (next === percent) return
          percent = next
          opts.onChanged()
        },
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('[updates] download failed', reason)
      busy = false
      percent = null
      opts.onChanged()
      const r = await ask({
        type: 'warning',
        title: t('app.name'),
        message: t('update.downloadFailed'),
        detail: t('update.downloadFailedDetail', { reason }),
        buttons: [t('update.openRelease'), t('update.ok')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (r.response === 0) await openRelease(result.url)
      return
    }

    busy = false
    percent = null
    downloaded = { version: result.next, path }
    opts.onChanged()
    await promptInstall()
  }

  /** 安装包已下载：问一句再退出，避免用户正在写东西时被直接关掉 */
  async function promptInstall(): Promise<void> {
    const d = downloaded
    if (!d || prompting) return
    prompting = true
    try {
      const r = await ask({
        type: 'info',
        title: t('app.name'),
        message: t('update.downloadedTitle'),
        detail: t('update.downloadedDetail', { path: d.path }),
        buttons: [t('update.quitAndOpen'), t('update.later')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (r.response !== 0) return
      // 先打开安装包再退出：打开失败就留在应用里把原因说清楚，不制造「应用没了、包也没开」的死局
      const err = await shell.openPath(d.path)
      if (err) {
        // 文件被用户挪走/删掉：把「已下载」状态作废，下次点菜单会重新下载，而不是永远卡在这个死路
        if (!existsSync(d.path)) {
          downloaded = null
          opts.onChanged()
        }
        await ask({
          type: 'warning',
          title: t('app.name'),
          message: t('update.openFailed'),
          detail: t('update.openFailedDetail', { path: d.path, reason: err }),
          buttons: [t('update.ok')],
        })
        return
      }
      app.quit()
    } finally {
      prompting = false
    }
  }

  return {
    start(): void {
      if (timer) return
      setTimeout(() => void run(false), START_DELAY_MS)
      timer = setInterval(() => void run(false), INTERVAL_MS)
    },
    checkNow(): void {
      if (busy) return
      if (downloaded) {
        void promptInstall()
        return
      }
      if (latest) {
        void report(latest)
        return
      }
      void run(true)
    },
    menuLabel(): string {
      if (percent !== null) return t('menu.item.updateDownloading', { percent: String(percent) })
      if (downloaded) return t('menu.item.updateReady', { version: downloaded.version })
      if (latest) return t('menu.item.updateAvailable', { version: latest.next })
      return t('menu.item.checkUpdate')
    },
    menuEnabled(): boolean {
      return !busy
    },
  }
}

/**
 * **Doc 分段装载的共用件**：启动与导航用同一套窗口，不各写一份。
 *
 * 为什么要有窗口：`doc` 是「整棵子树一次读完」——100k 块的页在 1M 库上读 530ms、
 * 投影 390ms，用户看到「点开一页停一秒」。切成先序前缀的窗口后，首窗（2000 块）
 * 落地就能画，余下窗口一窗一窗读；每个 `await` 天然让出主线程。
 *
 * 三条口径：
 *   · **首窗即全部**：`next === null` 的 Doc 与整棵读逐字相同（一次读、一次投影、不重画）；
 *   · **降级不是另一种语义**：实现没有这条读面、或某个 root 没有派生路径 ⇒ 调用方
 *     整批退回 `doc` 整棵读；
 *   · **余下的窗口逐窗投影**：装载走增量路径（按 `left` 挂接、索引只进新子树），
 *     每窗 `loadDoc` 是 O(本窗)，逐窗装不会越装越慢；换来的是主线程不被一次整篇的
 *     大投影占住（每窗几毫秒，中间隔着 `await` 让出），装载中途也读得到已装的部分
 *     （⌘K、点引用都不必等整篇装完）。
 */
import type { LibraryClient } from '../../core/storage/library-client.ts'
import type { LibraryDocRows, LibraryDocWindow } from '../../core/storage/library-reads.ts'
import type { RawLibraryRows } from '../../core/storage/db-rows.ts'
import type { Workset } from '../../core/storage/workset.ts'

/**
 * **一窗多少块**。1M 的合成语料上每窗读取 ≈3ms、投影 ≈4ms；2000 块已经远小于
 * 一屏可交互的阈值，再小只是多几次 IPC 往返。
 */
export const DOC_WINDOW = 2000

/** Doc 行（子树＋祖先链）拍平成装载行；`rows.blocks` 仍只含子树（祖先只补名字） */
export function withAncestors(doc: LibraryDocRows): RawLibraryRows {
  return {
    blocks: [...doc.rows.blocks, ...doc.ancestors],
    props: doc.rows.props,
    aliases: doc.rows.aliases,
    lists: doc.rows.lists,
    meta: {},
  }
}

/**
 * 取一批 root 的**首窗**；`null` ＝ 这条读面不可用或有一个 root 拿不到窗口
 * （没有派生路径）——调用方退回整棵 `doc`，不做半批装载。
 */
export async function readFirstWindows(
  client: LibraryClient,
  ids: readonly string[],
): Promise<LibraryDocWindow[] | null> {
  const read = client.docWindow?.bind(client)
  if (!read) return null
  const first = await Promise.all(ids.map((id) => read(id, null, DOC_WINDOW)))
  if (first.some((r) => r.status !== 'ok')) return null
  const out: LibraryDocWindow[] = []
  for (const r of first) if (r.status === 'ok') out.push(r.value)
  return out
}

/** 首窗里「还没读完」的那些：`{ root, 游标 }`，交给 `finishDocWindows` 续装 */
export function pendingOf(windows: readonly LibraryDocWindow[]): { id: string; after: string }[] {
  const out: { id: string; after: string }[] = []
  for (const w of windows) {
    const id = w.rootIds[0]
    if (id && w.next !== null) out.push({ id, after: w.next })
  }
  return out
}

/**
 * 把余下的窗口**逐窗投影**：读回一窗就 `loadDoc` 一窗，不攒批——攒批会把整篇
 * 压成一次大投影（主线程一帧长停顿；装载中途也查不到已装的部分）。窗口是
 * DFS 前缀，块的父亲总在同一窗或更早的窗里，逐窗挂接与攒批同解（等式测试钉住）。
 * 返回「有没有长过」（调用方据此在装完后重画一次）。
 *
 * 中途失败就停在那一条上：已装的部分是对的（先序前缀），只是不全——与整棵读失败
 * 相比不多不少，都是「这次没装完」。下一次打开会重新走窗口。
 */
export async function finishDocWindows(
  client: LibraryClient,
  workset: Workset,
  pending: readonly { id: string; after: string }[],
): Promise<boolean> {
  const read = client.docWindow?.bind(client)
  if (!read || pending.length === 0) return false
  let grew = false
  for (const job of pending) {
    let after: string | null = job.after
    let loaded = false
    while (after !== null) {
      const r = await read(job.id, after, DOC_WINDOW)
      if (r.status !== 'ok') {
        console.warn('[workset] doc window failed:', r.status === 'error' ? r.error : r.status)
        break
      }
      workset.loadDoc(withAncestors(r.value), [job.id])
      loaded = true
      after = r.value.next
    }
    if (!loaded) continue
    workset.pin([job.id])
    grew = true
  }
  return grew
}

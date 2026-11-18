/**
 * **首帧读面探针（仅开发构建）**：用工作集读面取一次 `doc` ＋ `catalog`，打印真机读数。
 *
 * 为什么要有它：Node 合成语料的读数能证明「这段逻辑多贵」，但不能证明「打包后的 app 首帧
 * 真的可以不读全库」。这一条在真机上跑，且把**主进程自己记的行数**（`libraryInfo.reads`）
 * 一起打出来：`full` 是旧路径的全库装载次数，`doc`／`catalog` 是工作集读面。
 * 切换渲染路径之后，验收就是 `full=0` 且 `fullRows` 不再增长。
 *
 * 为什么产品构建不包含它：它只是观测，不是功能；`DEV_SURFACE` 的判据是「这份构建给谁用」。
 * 调用点用动态 import，生产构建里整段被裁掉。
 *
 * ⚠️ 它**不改模型、不落盘、不参与渲染**：取回来的行直接丢掉，只留读数。
 * 真正的首帧切换要等工作集 store（那一步才允许把读回来的块交给 UI）。
 */
import { createLibraryClient } from '../../core/storage/library-client.ts'
import type { LibraryBridge } from '../../core/storage/ipc-adapter.ts'

interface ReadsInfo {
  reads?: { full?: number; fullRows?: number; doc?: number; docRows?: number; catalog?: number; catalogRows?: number }
}

function countDocRows(doc: { rows: { blocks: unknown[]; props: unknown[]; aliases: unknown[]; lists: unknown[] } }): number {
  return doc.rows.blocks.length + doc.rows.props.length + doc.rows.aliases.length + doc.rows.lists.length
}

export function probeBootLibraryReads(bridge: LibraryBridge, roots: readonly string[]): void {
  const doc = bridge.doc
  const catalog = bridge.catalog
  if (!doc || !catalog) return

  // 用 bridge 作接收者调：薄桥可能依赖 this（preload 里是箭头函数，但不能假设所有实现都是）
  const client = createLibraryClient({
    doc: (ids) => doc.call(bridge, ids),
    catalog: () => catalog.call(bridge),
  })

  void (async () => {
    const t0 = performance.now()
    const d = await client.doc(roots)
    const t1 = performance.now()
    const c = await client.catalog()
    const t2 = performance.now()
    const info = (await bridge.libraryInfo().catch(() => null)) as ReadsInfo | null
    const reads = info?.reads
    if (d.status !== 'ok') {
      console.warn(`[perf] boot doc read failed: ${d.status === 'error' ? d.error : d.status}`)
      return
    }
    if (c.status !== 'ok') {
      console.warn(`[perf] boot catalog read failed: ${c.status === 'error' ? c.error : c.status}`)
      return
    }
    const cat = c.value
    const catalogRows = cat.journals.length + cat.tags.length + cat.propDefs.length + cat.trash.length
    console.info(
      `[perf] boot working set: doc roots=${roots.length} rows=${countDocRows(d.value)} ${(t1 - t0).toFixed(1)}ms · ` +
        `catalog rows=${catalogRows} ${(t2 - t1).toFixed(1)}ms · ` +
        `session full=${reads?.full ?? '?'} fullRows=${reads?.fullRows ?? '?'} ` +
        `doc=${reads?.doc ?? '?'}/${reads?.docRows ?? '?'} catalog=${reads?.catalog ?? '?'}/${reads?.catalogRows ?? '?'}`,
    )
  })().catch((e) => console.warn('[perf] boot read probe failed', e))
}

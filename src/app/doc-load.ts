/**
 * 「补读完再继续」的**唯一收尾判据**。
 *
 * 打开入口的写法都是「`needsDoc(id)` ⇒ `loadDocThen([id], 回调里再调用自己)`」。
 * 装载没把目标补全（读失败、库被换掉、派生索引没铺到）时，如果再无条件递归，
 * 就会在同一个目标上无限重试：屏幕毫无反应、也没有异常——异步循环不冒泡。
 * 症状与「点击没接上」一模一样，排查时会先怀疑事件表。
 *
 * ⇒ 递归前过这一句：仍然 `needsDoc` ＝ 这次补读没成功，停在这里并留一条 warn
 *   （下一次显式动作还会再试，不会把「没读到」写成「没有」）。
 */
import type { KbClient } from '../core/kb/types.ts'

export function whenDocLoaded(
  kb: Pick<KbClient, 'needsDoc'>,
  id: string,
  then: () => void,
): () => void {
  return () => {
    if (kb.needsDoc(id)) {
      console.warn('[doc] load incomplete; skip this navigation:', id)
      return
    }
    then()
  }
}

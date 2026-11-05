/**
 * 搜索面的**形态 → 摆哪些件**。零依赖叶子：单测可以直接 import 它（不经 UI/编辑器）。
 *
 * 为什么单独一个文件而不是留在 `search-face.ts`：那份组件会拉进 `EditableBlock`／编辑器，
 * 而 Node 的 strip-only 类型剥离不支持参数属性（`constructor(private x)`），
 * 于是「纯判据」被组件一起拖得不可单测。判据本身没有依赖，就该住在叶子上。
 *
 * ⚠️ 这是读 `compact` 的**唯一**地方；组件里不许再出现 `if (compact)`。
 */

/** 两种形态摆哪些件。 */
export interface SearchFaceChrome {
  /** 「晋升为查询块」——tab 专属；紧凑形态不摆（那一步要建内容，属于面板/常驻面） */
  promote: boolean
  /**
   * 右列预览。**紧凑形态也必须留着**：藏了它就等于「点了行没反应」
   * （全部结果行只剩只读片段，没有任何编辑出口）。
   */
  preview: boolean
}

/**
 * `compact` → 摆件。
 *
 * `preview` 恒为真，写出来是给断言与读者一个明确口径，而不是省略字段。
 */
export function faceChrome(compact: boolean): SearchFaceChrome {
  return { promote: !compact, preview: true }
}

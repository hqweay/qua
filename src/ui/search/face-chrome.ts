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
   * 右列预览。两种形态都留着：藏了它就等于「点了行没反应」
   * （全部结果行只剩只读片段，没有任何编辑出口）。
   */
  preview: boolean
  /** 「展开为面板」——紧凑形态专属：浮层是一次性快入口，要常驻就把词带进 tab */
  expand: boolean
  /**
   * 输入框裸 ↵ 的落点：`true` ＝打开选中的那条，`false` ＝把焦点交给右列预览。
   *
   * ⚠️ 只回答**输入框**的 ↵。预览里的 ↵ 永远归编辑器（拆块／合并），不经过这里——
   * 两件事共用一条判据会让「开始编辑」和「离开这一屏」互相顶掉。
   * 只有**不可编辑的紧凑面**才需要 `true`；可编辑之后浮层也走 `false`。
   */
  bareEnterOpens: boolean
  /** 右列是不是只读。两种形态都可编辑；留着这个开关是给「只给看」的宿主用 */
  previewReadOnly: boolean
  /**
   * 命中高亮的命名空间。两面可同屏（tab 搜索面 + ⌘K 浮层），共用一条 key 会让
   * 任一面收起时把另一面的高亮一起删掉。
   * 这里给的是**基名**；真正落到 `CSS.highlights` 的那条 key 由
   * `./highlight-key.ts` 分配（同屏多个同类宿主也不重名）。
   */
  highlightKey: string
}

/**
 * `compact` → 摆件。
 *
 * `preview` 恒为真，写出来是给断言与读者一个明确口径，而不是省略字段。
 */
export function faceChrome(compact: boolean): SearchFaceChrome {
  return compact
    ? {
        promote: false,
        preview: true,
        expand: true,
        bareEnterOpens: false,
        previewReadOnly: false,
        highlightKey: 'search-match-overlay',
      }
    : {
        promote: true,
        preview: true,
        expand: false,
        bareEnterOpens: false,
        previewReadOnly: false,
        highlightKey: 'search-match',
      }
}

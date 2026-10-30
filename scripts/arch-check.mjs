#!/usr/bin/env node
/**
 * `scripts/arch-check.mjs` —— 架构断言（§5 的 17 条里**现在就能静态查**的那些）。
 *
 * 纪律（这条脚本自己也要守）：
 *   1. **只报它真查到的东西**：每条都打印「检查方式／白名单／命中数」，命中数就是证据；
 *   2. **查不了的不假装在跑**：DbClient／SQL／op-log／派生索引这类要内核的，单独打 `等内核` 段，
 *      写清为什么，而不是用一条永远绿的正则冒充；
 *   3. **硬门禁只有三条口径**：命中数 ≤ 白名单允许数才绿。带 `欠账` 标记的是**如实记账但不拦门**的
 *      （写在 `docs/ARCH-断言.md` 里，不允许悄悄消失）。
 *
 * 用法：`node scripts/arch-check.mjs`（`pnpm arch:check`）；`pnpm gate` 里也跑它。
 * 扫描用的是 TypeScript 自带 parser（devDependency），不是手搓正则 —— 注释/模板串/`import type`
 * 的边界靠正则分不干净，上一版原型就在 `escapeHtml` 的 `/["]/` 正则上翻过车。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const rel = (p) => relative(ROOT, p).split(sep).join('/')

/* ═══════════════════════════════════════════════════════╗
   ║ 断言账本                                                ║
   ╚═══════════════════════════════════════════════════════ */

const results = []
let hardRed = 0

/** level: hard（不过就红）/ debt（如实记账，不拦门）/ kernel（等内核）/ convention（只能靠约定） */
function add(o) {
  const expect = o.expect ?? 0
  const ok = o.hits <= expect
  const rec = { level: 'hard', expect, ...o, ok }
  if (rec.level === 'hard' && !ok) hardRed++
  results.push(rec)
  return rec
}

/* ═══════════════════════════════════════════════════════╗
   ║ 文件 / 解析工具                                          ║
   ╚═══════════════════════════════════════════════════════ */

function walk(dir, exts) {
  const out = []
  if (!existsSync(dir)) return out
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) rec(p)
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
    }
  }
  rec(dir)
  return out.sort()
}

const sfCache = new Map()
function tsFile(file) {
  if (!sfCache.has(file)) {
    const src = readFileSync(file, 'utf8')
    sfCache.set(file, {
      src,
      sf: ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS),
    })
  }
  return sfCache.get(file)
}

const isStrLike = (n) =>
  ts.isStringLiteral(n) ||
  ts.isNoSubstitutionTemplateLiteral(n) ||
  n.kind === ts.SyntaxKind.TemplateHead ||
  n.kind === ts.SyntaxKind.TemplateMiddle ||
  n.kind === ts.SyntaxKind.TemplateTail

/**
 * 这个字符串是不是**判别键的值**（`t: 'image'` 那种）。
 *
 * 判据是「父节点是属性赋值、键名是 `t`」——只看字面量会把
 * `img.type = 'image/png'`、`t('…image…')` 之类一起算进来。
 */
function isDiscriminantValue(n) {
  const p = n.parent
  return (
    p &&
    ts.isPropertyAssignment(p) &&
    p.name &&
    ts.isIdentifier(p.name) &&
    p.name.text === 't'
  )
}

/** 全部字符串/模板片段（注释不进 AST ⇒ 天然豁免） */
function literalsOf(sf) {
  const out = []
  const visit = (node) => {
    if (isStrLike(node)) {
      const pos = node.getStart(sf)
      out.push({
        node,
        text: node.text ?? '',
        line: sf.getLineAndCharacterOfPosition(pos).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** `console.*(...)` 实参里的字面量位置 —— 开发者日志不是用户文案 */
function consoleArgPositions(sf) {
  const set = new Set()
  const isConsole = (n) =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.expression.getText(sf) === 'console'
  const visit = (node) => {
    if (isConsole(node)) {
      for (const a of node.arguments) {
        const rec = (n) => {
          if (isStrLike(n)) set.add(n.getStart(sf))
          ts.forEachChild(n, rec)
        }
        rec(a)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return set
}

/** import / export … from '…'（含 `import type`） */
function importsOf(sf) {
  const out = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const m = node.moduleSpecifier
      if (m && ts.isStringLiteral(m)) {
        out.push({
          spec: m.text,
          typeOnly: Boolean(node.importClause?.isTypeOnly) || Boolean(node.isTypeOnly),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** 去注释：CSS / HTML 用（TS 走 AST，不需要） */
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
// 颜色字面量：hex 必须**恰好** 3/4/6/8 位且后面不是词字符（否则 `#badge` 这类 id 选择器会误伤）
const COLOR_LIT = /(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])|\brgba?\s*\(|\bhsla?\s*\(|\boklch\s*\(|\bcolor-mix\s*\()/
const LENGTH_LIT = /(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em|pt|vh|vw)\b/

const srcFiles = walk(join(ROOT, 'src'), ['.ts'])
const electronFiles = walk(join(ROOT, 'electron'), ['.ts'])
const codeFiles = [...srcFiles, ...electronFiles]
const cssFiles = walk(join(ROOT, 'src'), ['.css'])
const INDEX_HTML = join(ROOT, 'index.html')

/* ═══════════════════════════════════════════════════════╗
   ║ 11 · 禁裸中文字面量               ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 假数据按**目录前缀**豁免：种子内容拆到 `fixtures/` 下的多个文件之后，逐文件登记会
  // 在下一次拆分时静默失效（新文件立刻变成裸中文命中）。`bootstrap.ts` 是首屏那几行内容，
  // 不属于夹具目录，所以单列。
  const WL_FILES = new Set(['src/core/msg.ts', 'src/core/bootstrap.ts'])
  const WL_PREFIXES = ['src/core/fixtures/']
  const hits = []
  let whitelisted = 0
  for (const f of codeFiles) {
    const r = rel(f)
    const { sf } = tsFile(f)
    const consolePos = consoleArgPositions(sf)
    for (const lit of literalsOf(sf)) {
      if (!CJK.test(lit.text)) continue
      if (WL_FILES.has(r) || WL_PREFIXES.some((p) => r.startsWith(p))) continue
      if (consolePos.has(lit.node.getStart(sf))) {
        whitelisted++
        continue
      }
      hits.push(`${r}:${lit.line}  ${JSON.stringify(lit.text).slice(0, 80)}`)
    }
  }
  // CSS（去注释后）+ index.html（去注释后）
  for (const f of cssFiles) {
    const r = rel(f)
    const body = stripCssComments(readFileSync(f, 'utf8'))
    body.split('\n').forEach((line, i) => {
      if (CJK.test(line)) hits.push(`${r}:${i + 1}  ${line.trim().slice(0, 80)}`)
    })
  }
  if (existsSync(INDEX_HTML)) {
    const body = stripHtmlComments(readFileSync(INDEX_HTML, 'utf8'))
    body.split('\n').forEach((line, i) => {
      if (CJK.test(line)) hits.push(`index.html:${i + 1}  ${line.trim().slice(0, 80)}`)
    })
  }
  add({
    id: 11,
    title: '不得有裸中文字符串字面量（文案一律走 msg.ts）',
    method: 'TypeScript AST 遍历 StringLiteral / 模板片段（注释不进 AST）；CSS 与 index.html 去注释后逐行扫',
    scope: 'src/**/*.ts · src/**/*.css · electron/**/*.ts · index.html',
    whitelist: `注释 · src/core/msg.ts（字典本身）· src/core/fixtures/** ＋ src/core/bootstrap.ts（假数据与首屏内容）· console.* 日志实参（本仓命中 ${whitelisted} 处，开发者日志不是用户文案）· checks/** + scripts/**（测试与脚本，不在扫描范围）`,
    hits: hits.length,
    detail: hits,
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 13 · 层级依赖方向                 ║
   ╚═══════════════════════════════════════════════════════ */

// 层**按目录推导**，不再维护「文件 → 层」的手工映射：新增文件自动落入所在层，
// 忘记登记也不会静默失效（上一版是显式表，拆目录后新文件只会进 note，门禁形同虚设）。
const LAYER_BY_DIR = [
  ['src/core/', 'core'],
  ['src/view/', 'view'],
  ['src/ui/', 'ui'],
  ['src/app/', 'app'],
  ['electron/', 'host'],
]
/** `app` 是 renderer 装配入口（index.html 的脚本），四层里没有它，单列。 */
function layerOf(r) {
  if (r === 'src/main.ts') return 'app'
  for (const [prefix, layer] of LAYER_BY_DIR) if (r.startsWith(prefix)) return layer
  return undefined
}
const ORDER = ['core', 'view', 'ui', 'app', 'host']

{
  const hits = []
  const typeOnlyEdges = []
  const reactInView = []
  const unknown = []
  for (const f of codeFiles) {
    const r = rel(f)
    const from = layerOf(r)
    if (!from) {
      unknown.push(r)
      continue
    }
    const { sf } = tsFile(f)
    for (const imp of importsOf(sf)) {
      if (!imp.spec.startsWith('.')) {
        if (from === 'view' && /^react(-dom)?$/.test(imp.spec)) reactInView.push(`${r}:${imp.line} → ${imp.spec}`)
        continue
      }
      // 相对路径 → 目标文件（只关心 .ts；`.css` 之类的资源导入不是层级边）
      if (!/\.ts$/.test(imp.spec) && !/\.tsx$/.test(imp.spec) && imp.spec.includes('.')) continue
      const target = rel(new URL(imp.spec.endsWith('.ts') ? imp.spec : `${imp.spec}.ts`, `file://${f}`).pathname)
      const to = layerOf(target)
      if (!to) {
        unknown.push(`${r}:${imp.line} → ${target}`)
        continue
      }
      if (ORDER.indexOf(to) > ORDER.indexOf(from)) {
        const edge = `${r}:${imp.line} → ${target}（${from} → ${to}）`
        if (imp.typeOnly) typeOnlyEdges.push(edge)
        else hits.push(edge)
      }
    }
  }
  add({
    id: 13,
    title: '层级依赖方向 core ← view ← ui ← app ← host（单向）；view 不得 import React',
    method: 'AST 遍历 import/export-from：目标层序高于来源层序＝违规；`react` 只允许出现在 ui/app 层',
    scope: codeFiles.map(rel).join(' · '),
    whitelist: `类型导入（\`import type\`，运行时被擦除；本仓 ${typeOnlyEdges.length} 条：${typeOnlyEdges.join('；') || '无'}）· 非相对路径按外部依赖处理（只查 react）`,
    hits: hits.length + reactInView.length,
    detail: [...hits, ...reactInView],
    note: unknown.length ? `目录未覆盖（顶层只允许 main.ts）：${unknown.join(' / ')}` : '',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 14 · 原生模块白名单（只允许 better-sqlite3）             ║
   ╚═══════════════════════════════════════════════════════ */

{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const prod = Object.keys(pkg.dependencies ?? {})
  const WHITELIST = new Set(['better-sqlite3'])
  const isNative = (name) => {
    const dir = join(ROOT, 'node_modules', name)
    if (!existsSync(dir)) return false
    if (existsSync(join(dir, 'binding.gyp'))) return true
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).gypfile) return true
    } catch {
      /* ignore */
    }
    try {
      return readdirSync(dir).some((n) => n.endsWith('.node'))
    } catch {
      return false
    }
  }
  const nativeDeps = prod.filter(isNative)
  const bad = nativeDeps.filter((d) => !WHITELIST.has(d))
  // 源码里 import 到的裸模块（运行时依赖面的第二道闸）
  const bareImports = new Set()
  for (const f of codeFiles) {
    const { sf } = tsFile(f)
    for (const imp of importsOf(sf)) {
      if (!imp.spec.startsWith('.') && !imp.spec.startsWith('node:')) bareImports.add(imp.spec)
    }
  }
  const nativeImports = [...bareImports].filter((m) => m !== 'electron' && isNative(m))
  const badImports = nativeImports.filter((m) => !WHITELIST.has(m))
  add({
    id: 14,
    title: '原生模块白名单：只允许 better-sqlite3',
    method: '①package.json 的 dependencies 逐个探 binding.gyp / gypfile / *.node；②源码 import 的裸模块同上（electron 是壳本体，豁免）',
    scope: 'package.json dependencies · src/**/*.ts · electron/**/*.ts 的裸 import',
    whitelist: 'better-sqlite3（白名单）· electron（壳本体，不是数据层原生模块）· devDependencies（esbuild/electron 等工具链，不在约束内）',
    hits: bad.length + badImports.length,
    detail: [...bad, ...badImports],
    note: `生产依赖 ${prod.length} 个（其中原生 ${nativeDeps.filter((d) => WHITELIST.has(d)).length} 个）· 源码裸 import：${[...bareImports].join(', ') || '无'}（本轮期望 0 命中：better-sqlite3 还没接）`,
    expect: 0,
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 15 · 命令 decl 不得含 context / host / key（声明是纯语义，落点归绑定表）  ║
   ╚═══════════════════════════════════════════════════════ */

/** 从 AST 里取 `COMMANDS` 数组的字面量对象 */
function commandDecls() {
  const { sf } = tsFile(join(ROOT, 'src/core/commands/decls.ts'))
  let arr = null
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'COMMANDS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      arr = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!arr) return { sf, decls: [] }
  const decls = arr.elements.filter(ts.isObjectLiteralExpression).map((o) => {
    const props = new Map()
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        props.set(p.name.text, p.initializer)
      }
    }
    return { obj: o, props, line: sf.getLineAndCharacterOfPosition(o.getStart(sf)).line + 1 }
  })
  return { sf, decls }
}

{
  const { sf, decls } = commandDecls()
  const FORBIDDEN = ['context', 'host', 'key']
  const hits = []
  const notViaT = []
  for (const d of decls) {
    for (const k of FORBIDDEN) {
      if (d.props.has(k)) hits.push(`src/core/commands/decls.ts:${d.line} 命令 decl 含禁止字段 \`${k}\``)
    }
    const title = d.props.get('title')
    const viaT = title && ts.isCallExpression(title) && title.expression.getText(sf) === 't'
    if (!viaT) {
      notViaT.push(`src/core/commands/decls.ts:${d.line} title=${title ? title.getText(sf).slice(0, 40) : '(缺)'}`)
    }
  }
  add({
    id: 15,
    title: '命令 decl 不得含 `context` / `host` / `key`，且 `title` 必须走 `t()`',
    method: 'AST 定位 `COMMANDS` 数组，逐条 ObjectLiteral 查字段名；title 必须是 `t(...)` 调用（文案收敛点）',
    scope: `src/core/commands/decls.ts（${decls.length} 条命令）`,
    whitelist: '无（这三个字段在命令面上不该存在；`keywords:` 里的 key 不会误伤——按属性名精确匹配）',
    hits: hits.length + notViaT.length,
    detail: [...hits, ...notViaT],
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 19 · 组件不得直接引用基础色 --c-*（第 18 条）  ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 来由：主题机制（§4.1）要求「第三方主题只填 --ui-*」。
  // 一旦某个组件直连 --c-*，主题改语义槽就改不动它 —— **主题机制当场失效**。
  // 这比门禁 4（禁字面量）更关键：门禁 4 防「写死颜色」，这条防「绕过语义层」。
  const hits = []
  const cssFiles = walk(join(ROOT, 'src'), ['.css'])
  for (const f of cssFiles) {
    const r = rel(f)
    const src = readFileSync(f, 'utf8')
    const end = src.indexOf('/* @token:end */')
    // token 段内是**定义处**，允许出现（`--ui-surface: var(--c-n-0)`）
    const body = end >= 0 ? src.slice(end) : src
    body.split('\n').forEach((line, i) => {
      if (!/var\(--c-[a-z0-9-]+\)/.test(line)) return
      const lineNo = end >= 0 ? src.slice(0, end).split('\n').length + i : i + 1
      hits.push(`${r}:${lineNo}  ${line.trim().slice(0, 70)}`)
    })
  }
  add({
    id: 19,
    title: '组件不得直接引用基础色 `--c-*`（只能走语义槽 `--ui-*`）',
    method: '扫 src/**/*.css 的 **token 段之外**，找 `var(--c-*)`；token 段内是定义处，豁免',
    scope: `src/**/*.css 的非 token 段（${cssFiles.length} 个文件）`,
    whitelist: 'token 段（`/* @token:begin */`…`/* @token:end */`）—— 那是 `--ui-*` 指向 `--c-*` 的唯一合法处',
    hits: hits.length,
    detail: hits,
    note: '本条与 `[18]`（命令 handler 不得碰 DOM）是两件事，别看混：`[18]` 是「命令不许碰 DOM」，本条是「组件只能引语义 token」',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 28 · 层叠层级只能走 --ui-z-*                             ║
   ╚═══════════════════════════════════════════════════════ */

{
  /**
   * 来由：`z-index` 此前是 11 个裸数字（1 / 4 / 55 / 56 / 60 / 65 / 70 / 72 / 80 / 85 / 90）。
   * 谁比谁高只能靠「我记得那个数字更大」；加一层新浮层时唯一可用的办法是猜一个更大的数字，
   * 而猜错的形态是**静默被盖住**——不报错、不红、只有人眼能发现。
   *
   * ⇒ 层级改成**语义排序**（`--ui-z-menu` / `--ui-z-popover` / …），这条断言禁裸数字回潮。
   * 与 `[19]` 同一条纪律：token 段是唯一定义处，段外只许引用。
   */
  const hits = []
  for (const f of cssFiles) {
    const r = rel(f)
    const src = readFileSync(f, 'utf8')
    const end = src.indexOf('/* @token:end */')
    const head = end >= 0 ? src.slice(0, end) : ''
    const body = end >= 0 ? src.slice(end) : src
    body.split('\n').forEach((line, i) => {
      /**
       * 只查**声明值**：`z-index: 70;` 这种裸数字。
       *
       * ⚠️ 必须先剥掉注释再判：注释里写「旧写法是 `z-index: 70;`」是**说明**，不是声明。
       *    实测：不剥注释时，一条解释这条断言本身的注释会让它自己变红（假阳性）——
       *    而假阳性的代价比漏报更贵：它教会人「这条断言会误报，忽略它」。
       */
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/, '')
      if (!/z-index\s*:\s*[0-9]/.test(code)) return
      const lineNo = end >= 0 ? head.split('\n').length + i : i + 1
      hits.push(`${r}:${lineNo}  ${line.trim().slice(0, 70)}`)
    })
  }
  add({
    id: 28,
    title: '层叠层级只能走 `--ui-z-*`（不许再出现裸 `z-index: <数字>`）',
    method: '扫 src/**/*.css 的非 token 段，找 `z-index:` 后面直接跟数字的行',
    scope: `src/**/*.css 的非 token 段（${cssFiles.length} 个文件）`,
    whitelist: 'token 段（`/* @token:begin */`…`/* @token:end */`，`--ui-z-*` 的唯一定义处）',
    hits: hits.length,
    detail: hits,
    note: '判据是**语义排序**不是数值排序：读 `--ui-z-popover` 的人知道它是「浮层」，不需要知道它比谁大',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 29 · 原语的几何不许在组件里再写一份                    ║
   ╚═══════════════════════════════════════════════════════ */

{
  /**
   * 来由：`primitives.css` 立起四条原语（`.ui-field` / `.ui-btn` / `.ui-row` /
   * `.ui-ellipsis`）之前，同一套完整几何在 3–4 处逐字重复：
   *   · 输入框（padding + border + radius + 背景）4 套；
   *   · 按钮（逐字相同的 4 条声明）3 处；
   *   · 「一行：标签 ＋ 控件」4 套（于是行距各自漂移）；
   *   · 「单行省略」5 条声明 4 处（漏 `min-width: 0` 就撑破容器）。
   *
   * ⇒ 这条断言的判据落在**声明的去处**，不是语法形状：只要某个非原语规则里
   *   又出现了「原语那份几何的整组」，就是有人把原语抄回去了一份。
   *
   * ⚠️ 为什么用「整组声明逐字相同」而不是关键词：关键词会把「碰巧用了同一个 token」
   *    也判成重复（`--ui-gap-2` 到处都在用）。整组相同才是「同一套形状」。
   */
  const PRIMITIVES = 'src/styles/primitives.css'
  const GEOMETRY_SETS = [
    {
      name: '输入字段',
      decls: [
        'padding: var(--ui-gap-2) var(--ui-gap-3)',
        'border: var(--ui-sep) solid var(--ui-border)',
        'border-radius: var(--ui-radius-sm)',
        'background: var(--ui-surface)',
      ],
    },
    {
      name: '小按钮',
      decls: [
        'padding: var(--ui-gap-2) var(--ui-gap-3)',
        'border: var(--ui-sep) solid var(--ui-border)',
        'border-radius: var(--ui-radius-sm)',
        'color: var(--ui-text-secondary)',
      ],
    },
    {
      name: '单行省略',
      decls: ['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap'],
    },
  ]
  const hits = []
  for (const f of cssFiles) {
    const r = rel(f)
    if (r === PRIMITIVES) continue // 原语自己的定义处，豁免
    const src = readFileSync(f, 'utf8')
    // 粗解析成规则块：`选择器 { 声明 }`（本仓 CSS 没有嵌套，够用）
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m
    while ((m = re.exec(src))) {
      const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ')
      if (!sel || sel.startsWith('@')) continue
      const decls = m[2]
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean)
      for (const set of GEOMETRY_SETS) {
        const all = set.decls.every((d) => decls.includes(d))
        if (!all) continue
        const lineNo = src.slice(0, m.index).split('\n').length
        hits.push(`${r}:${lineNo}  ${sel}  ← 这套几何属于「${set.name}」原语`)
      }
    }
  }
  add({
    id: 29,
    title: '原语的几何不许在组件里再写一份（改形状只改 `styles/primitives.css`）',
    method: '扫 src/**/*.css（除 primitives.css 自己），找**整组逐字相同**的几何声明',
    scope: `src/**/*.css（${cssFiles.length} 个文件，原语自身豁免）`,
    whitelist: `${PRIMITIVES} —— 原语的唯一定义处`,
    hits: hits.length,
    detail: hits,
    note: '判据落在**声明的去处**：整组相同才算「同一套形状」；只共用一个 token 不算（那到处都在用）',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 30 · 被引用的 CSS 变量必须有定义                        ║
   ╚═══════════════════════════════════════════════════════ */

{
  /**
   * 来由：`var(--ui-bg-hover)` 被三处引用却从未定义过——回收站行与空天格的
   * hover 反馈、资产「不可用」态的颜色**静默失效**：声明回退成初始值，
   * 不报错、不红、类型与单测都拦不住，只有把那行悬停上去的人眼能发现。
   *
   * 判据：`var(--x)` 的每一处引用，都能对应到一个定义——
   *   · CSS 里的 `--x:`（token 段或组件自己的局部变量都算）；
   *   · TS 字符串里的 `--x`（`setProperty('--x', …)` 那类运行时定义）。
   * 两边都对不上 ⇒ 这条引用是悬空的。
   *
   * ⚠️ 必须先剥注释再判（与 `[28]` 同一条教训）：说明文字里提到变量名是**讲解**，
   *    不是声明也不是引用；不剥的话，解释这条断言的注释会让它自己变红。
   */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const defined = new Set()
  for (const f of cssFiles) {
    const src = stripComments(readFileSync(f, 'utf8'))
    for (const m of src.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) defined.add(m[1])
  }
  for (const f of srcFiles) {
    const src = stripComments(tsFile(f).src)
    // `setProperty('--x', …)` / 内联 `style="--x: …"` / cssText —— 引号或冒号两种写法都收
    for (const m of src.matchAll(/['"`]--[a-zA-Z][\w-]*['"`]/g)) defined.add(m[0].slice(1, -1))
    for (const m of src.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) defined.add(m[1])
  }

  const hits = []
  for (const f of cssFiles) {
    const src = stripComments(readFileSync(f, 'utf8'))
    for (const m of src.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)/g)) {
      if (!defined.has(m[1])) hits.push(`${rel(f)}  引用了未定义的 ${m[1]}`)
    }
  }
  for (const f of srcFiles) {
    const src = stripComments(tsFile(f).src)
    for (const m of src.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)/g)) {
      if (!defined.has(m[1])) hits.push(`${rel(f)}  引用了未定义的 ${m[1]}`)
    }
  }

  add({
    id: 30,
    title: '被引用的 `var(--…)` 必须有定义（悬空引用＝声明静默失效）',
    method: '①CSS 与 TS 里收集定义（`--x:` 与引号包裹的 `--x`）；②收集 `var(--x` 引用；③引用 ∩ ¬定义 ＝命中',
    scope: `src/**/*.css ＋ src/**/*.ts（共 ${cssFiles.length + srcFiles.length} 个文件）`,
    whitelist: '定义可以是 CSS 局部变量或 TS 的运行时 `setProperty`；两处都没有才算悬空',
    hits: hits.length,
    detail: [...new Set(hits)],
    note: '教训：`var(--x, fallback)` 里的 fallback 未定义时整个声明失效——回退不是保险，是同一颗雷',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 额外（里能静态查的）                          ║
   ║   4  同名命令不可二次注册                                ║
   ║   2  主进程不得 import 数据层                            ║
   ╚═══════════════════════════════════════════════════════ */

{
  const { sf, decls } = commandDecls()
  const seen = new Map()
  const dups = []
  for (const d of decls) {
    const n = d.props.get('name')
    if (!n || !ts.isStringLiteral(n)) continue
    if (seen.has(n.text)) dups.push(`${n.text}（${seen.get(n.text)} 与 ${d.line} 行重复）`)
    else seen.set(n.text, d.line)
  }
  add({
    id: '4+',
    title: '同名命令不可二次注册（含跨 host）',
    method: 'AST 收集 `COMMANDS[].name` 字面量，查重',
    scope: `src/core/commands/decls.ts（${decls.length} 条命令 / ${seen.size} 个唯一名）`,
    whitelist: '无',
    hits: dups.length,
    detail: dups,
  })
}

{
  /**
   * 主进程准入 —— **白名单**，不是黑名单。
   *
   * 为什么改成白名单（原先是一条禁 `workspace|seed|core|commands` 的正则）：
   * 那条正则实测**放行** `core/query.ts`、`core/kb/types.ts`、`view/editor.ts`、`app/handlers.ts`
   * —— 也就是说「块语义搬进主进程」这件事，门禁不会红。而 `[13]` 对 `electron/` 零约束
   * （它被映射成 `host`，是层序最后一层 ⇒ 什么都不算越界）。两条加起来等于**主进程没有任何边界**。
   *
   * 判据不是「哪些 import 危险」（黑名单永远列不全），而是**主进程该做什么**：
   * 窗口／会话／DB／fs／路径／菜单。块语义、查询、渲染一律不许。
   * ⇒ 白名单只放三样：`node:*`（fs/sqlite/path）、`electron`（壳本体）、
   *   以及两个**零依赖叶子**：`src/core/msg.ts`（纯文案字典）与 `src/core/library.ts`
   *   （库身份/版本判据，两个进程共读同一份口径，故必须零依赖）。
   */
  const ALLOWED = [
    /^node:/,
    /^electron$/,
    // 主进程**自己目录内**的相对 import（`./assets.ts`／`./library/session.ts`）不是跨层边。
    // ⚠️ 必须排除 `..`：`../../src/core/walk.ts` 也能被「允许任意相对路径」的正则放过，
    //    那样这条断言就形同虚设（实测踩到过）。
    /^\.\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+(\.ts)?$/,
    /^(\.\.\/)+src\/core\/msg(\.ts)?$/,
    /^(\.\.\/)+src\/core\/library(\.ts)?$/,
    /**
     * `src/core/assets.ts` 是第三个零依赖叶子：只有「字节 → 类型／后缀／地址」的纯函数
     * （嗅探、`extOf`、`sha256Hex`、`assetUrl`），没有块语义、没有 DOM、没有存储。
     * 主进程需要它是因为**同一条协议的两端必须用同一份判据**：
     * 后缀由入库那侧算、地址由协议那侧认，各写一份就是「两份答案」。
     */
    /^(\.\.\/)+src\/core\/assets(\.ts)?$/,
  ]
  const hits = []
  for (const f of electronFiles) {
    const r = rel(f)
    const { sf } = tsFile(f)
    for (const imp of importsOf(sf)) {
      if (ALLOWED.some((re) => re.test(imp.spec))) continue
      /**
       * **类型导入可以进 `src/core/`**：`verbatimModuleSyntax: true` 保证它写成 `import type`，
       * 运行时被擦除（esbuild 也照样剥掉）⇒ 它拖不进任何运行时代码。
       * 主进程要的正是「共享形状但不共享实现」：端口的类型来自 core，实现留在主进程。
       */
      if (imp.typeOnly && /^(\.\.\/)+src\/core\//.test(imp.spec)) continue
      hits.push(`${r}:${imp.line} → ${imp.spec}（主进程只许 node:* / electron / core/msg / core/library，以及 core 的**类型**）`)
    }
  }
  add({
    id: '2+',
    title: '主进程准入白名单：只许 node:* / electron / core/msg / core/library / core/assets（块语义、查询、渲染一律不许）',
    method:
      'AST 遍历 electron/**/*.ts 的 import/export-from，**白名单**逐条比：`node:*`／`electron`／`src/core/msg`／`src/core/library`／`src/core/assets`；其余一律命中',
    scope: `electron/**/*.ts（${electronFiles.length} 个文件：${electronFiles.map(rel).join(' · ')}）`,
    whitelist:
      '`node:*`（fs／sqlite／path）· `electron`（壳本体）· `./x.ts`（主进程自己目录内）· `src/core/msg`（纯文案字典）· `src/core/library`（库身份与版本判据，零依赖、两进程共读）· `src/core/assets`（字节→类型/后缀/地址的纯函数，同一份判据给协议两端）',
    hits: hits.length,
    detail: hits,
    note: '为什么是白名单：黑名单版本实测放行 core/query、core/kb/types、view/editor、app/handlers —— 「块语义搬进主进程」时门禁不会红，而那时块语义已经有两个实现',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 额外 · 不可逆项：localStorage 键名（硬纪律）              ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 换键 ＝ 用户已存的库静默消失。把值钉死在这里：真要换，必须先改这条断言并写迁移。
  // 2026-10-20：`STORAGE_KEY` 随 StoragePort 拆分留在导出面 `src/core/workspace.ts`，断言路径不变。
  // 2026-10-20 公开整理：旧键是内部阶段的值，公开版定为 `qua.workspace`（原型不做旧数据迁移，旧库显式作废重 seed）。
  const FROZEN = 'qua.workspace'
  const ws = readFileSync(join(ROOT, 'src/core/workspace.ts'), 'utf8')
  const m = /export const STORAGE_KEY = '([^']+)'/.exec(ws)
  const got = m ? m[1] : '(没找到 STORAGE_KEY)'
  add({
    id: 'key',
    title: '不可逆项：localStorage 键名固定为 `qua.workspace`（换键＝静默丢数据）',
    method: '正则取 `src/core/workspace.ts` 的 `STORAGE_KEY` 字面量，与钉死的值逐字比较',
    scope: 'src/core/workspace.ts',
    whitelist: '无 —— 要换键必须先改这条断言并写迁移（不许悄悄改）',
    hits: got === FROZEN ? 0 : 1,
    detail: got === FROZEN ? [] : [`STORAGE_KEY = ${got} ≠ ${FROZEN}`],
  })
}


/* ═══════════════════════════════════════════════════════╗
   ║ 12 · 颜色 / 间距字面量（门禁 4 + §4 三层）     ║
   ╚═══════════════════════════════════════════════════════ */

{
  // ① TS/组件代码：颜色 + 长度都不许有
  const TS_WL_FILES = new Set(['src/core/msg.ts', 'src/core/bootstrap.ts'])
  const TS_WL_PREFIXES = ['src/core/fixtures/']
  // 内联 SVG 数据 URI 的取色：data URI 里的 SVG 看不见页面 CSS 变量（不是"懒得抽"）
  const SVG_URI_WL = /hsl\(|rgba\(/
  const hits = []
  const wl = []
  for (const f of codeFiles) {
    const r = rel(f)
    if (TS_WL_FILES.has(r) || TS_WL_PREFIXES.some((p) => r.startsWith(p))) continue
    const { sf, src } = tsFile(f)
    const lines = src.split('\n')
    for (const lit of literalsOf(sf)) {
      if (!COLOR_LIT.test(lit.text) && !LENGTH_LIT.test(lit.text)) continue
      const inThumb = r === 'src/view/block-dom.ts' && SVG_URI_WL.test(lit.text)
      // 主进程不是渲染层：没有 CSS、也 import 不到 token ⇒ 窗口底色只能由 shell 给
      const inShellBg = r === 'electron/main.ts' && /backgroundColor\s*:/.test(lines[lit.line - 1] ?? '')
      const row = `${r}:${lit.line}  ${JSON.stringify(lit.text.slice(0, 60))}`
      if (inThumb || inShellBg) wl.push(row)
      else hits.push(row)
    }
  }
  // ② 样式分片：**只有 `styles/tokens.css` 持有 token 段**，其它分片整份按「非 token 段」扫。
  //    标记段必须放在**唯一定义处**，否则「段内豁免」会被复制到多个文件、门禁 4 就失效了。
  const TOKEN_CSS = 'src/styles/tokens.css'
  const cssHits = []
  const cssDebt = []
  let tokenLines = 0
  for (const f of cssFiles) {
    const r = rel(f)
    const src = readFileSync(f, 'utf8')
    const begin = src.indexOf('/* @token:begin */')
    const end = src.indexOf('/* @token:end */')
    let bodies
    if (r === TOKEN_CSS) {
      if (begin < 0 || end < 0) {
        cssHits.push(`${r} 缺少 /* @token:begin */ ~ /* @token:end */ 标记段`)
        continue
      }
      tokenLines = src.slice(begin, end).split('\n').length
      // 段前 / 段后分开扫；base 是该段第一行在原文件里的行号（1-based）
      bodies = [
        [src.slice(0, begin), 0],
        [src.slice(end), src.slice(0, end).split('\n').length - 1],
      ]
    } else {
      bodies = [[src, 0]]
    }
    for (const [body, base] of bodies) {
      stripCssComments(body)
        .split('\n')
        .forEach((line, i) => {
          if (!line.trim()) return
          if (COLOR_LIT.test(line)) cssHits.push(`${r}:${base + i + 1}  ${line.trim().slice(0, 70)}`)
          if (LENGTH_LIT.test(line)) cssDebt.push(`${r}:${base + i + 1}`)
        })
    }
  }
  add({
    id: 12,
    title: '禁颜色 / 间距字面量（TS 组件代码里一个都不许有；styles/tokens.css 的 token 段是唯一允许处）',
    method: `①AST 扫 TS 字符串与模板片段里的 #hex／rgb()/hsl() 与 px/rem/em/pt/vh/vw；②styles/tokens.css 按 /* @token:begin */…/* @token:end */ 切段，其它分片整份扫，段外只查颜色字面量（门禁 4 的口径）`,
    scope: `src/**/*.ts · electron/**/*.ts（${codeFiles.length} 个文件）· src/**/*.css 的非 token 段（token 段 ${tokenLines} 行，仅 styles/tokens.css）`,
    whitelist: `src/core/msg.ts · src/core/fixtures/** ＋ src/core/bootstrap.ts（假数据口袋里没有样式）· view/editor.ts 的 \`thumbUri\` 内联 SVG 数据 URI 取色（${wl.filter((x) => x.startsWith('src/view/editor.ts')).length} 处：data URI 里的 SVG 读不到页面 CSS 变量，颜色又是按内容 hash **算**出来的，不是设计 token）· electron/main.ts 的 \`BrowserWindow.backgroundColor\`（${wl.filter((x) => x.startsWith('electron/')).length} 处：主进程没有 CSS，首帧前的窗口底色只能由 shell 给）`,
    hits: hits.length + cssHits.length,
    detail: [...hits, ...cssHits],
    note: wl.length ? `白名单明细：${wl.join('｜')}` : '',
  })
  add({
    id: '12b',
    title: '（欠账·不拦门）样式分片非 token 段的**长度**字面量',
    method: '同一套长度正则扫 token 段之外；只统计行数、不判红',
    scope: `src/styles/**/*.css 的非 token 段（${cssFiles.length} 个文件）`,
    whitelist: 'token 段（* @token:begin */…/* @token:end */，仅 styles/tokens.css）',
    level: 'debt',
    hits: cssDebt.length,
    detail: [],
    note: `已知欠账 ${cssDebt.length} 行（多为 1px 描边、100vh、calc 里的 6px/8px 缩进几何）。清零＝重写整份 CSS 并逐个复核视觉，**不在本轮**（本轮口径：TS/组件里的字面量必须清零；CSS 里只硬卡颜色）。见 docs/ARCH-断言.md §12b`,
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 16 · 换肤不得改 DOM 形状（66 / 门禁 5）                  ║
   ╚═══════════════════════════════════════════════════════ */

{
  const smoke = join(ROOT, 'checks/smoke.mjs')
  const src = existsSync(smoke) ? readFileSync(smoke, 'utf8') : ''
  // 2026-10-20：**三皮肤已删**，「换肤不改 DOM 形状」这条失去对象。
  // 保留的不变量改为「**换主题不改 DOM 形状**」——同一套 token 的两次取值，
  // DOM 形状必须逐行一致（这条才是 66 的契约，与皮肤无关）。
  const need = [
    ['主题切换序列', /setTheme\('light'\)[\s\S]*setTheme\('dark'\)/],
    ['data-depth 序列一致性断言', /a\.domShape === light\.domShape && light\.domShape === dark\.domShape/],
    ['皮肤已删的否定断言（body 无 data-skin）', /hasSkin/],
  ]
  const missing = need.filter(([, re]) => !re.test(src)).map(([n]) => n)
  add({
    id: 16,
    title: '换外观不改 DOM 形状（`data-depth` 序列一致）；皮肤已删',
    method: '静态确认 checks/smoke.mjs 里那条断言还在（含亮/暗切换与 domShape 比较，以及「body 无 data-skin」的否定式断言）；**真跑**由同一条 `pnpm gate` 里的 `pnpm check`（T11，真 Chrome）执行',
    scope: 'checks/smoke.mjs（T11）',
    whitelist: '无',
    hits: missing.length,
    detail: missing.map((m) => `smoke.mjs 少了：${m}`),
    note: '静态这半只防「断言被删掉」；DOM 形状本身只有真浏览器说了算 ⇒ 所以在同一条 gate 里跑 checks/smoke.mjs',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 17 · 组件不得直改 KB 状态（59  / 60 B）           ║
   ╚═══════════════════════════════════════════════════════ */

{
  const COMPONENTS = codeFiles.map(rel).filter((r) => r.startsWith('src/ui/') || r.startsWith('src/view/'))
  const hits = []
  // 用 AST 找**标识符**而不是行内正则：面板里 `'localStorage'` 只是一个标签字符串，
  // 行内扫会把标签当成访问（[17] 扩到整个 ui/ 时真踩到）。
  for (const r of COMPONENTS) {
    const f = join(ROOT, r)
    if (!existsSync(f)) continue
    const { sf } = tsFile(f)
    for (const imp of importsOf(sf)) {
      if (/workspace\.ts$|seed\.ts$/.test(imp.spec)) hits.push(`${r}:${imp.line} 组件 import 了持久化/假数据层：${imp.spec}`)
    }
    const visit = (n) => {
      if (ts.isIdentifier(n)) {
        const name = n.text
        if (name === 'localStorage' || name === 'saveWorkspace' || name === 'clearWorkspace' || name === 'loadWorkspace' || name === 'createWorkspaceStore' || name === 'createLocalStorageAdapter') {
          // 属性名（`x.localStorage`）不算；字符串标签天然不在这里
          const isPropName = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n
          const isDeclName = (ts.isFunctionDeclaration(n.parent) || ts.isVariableDeclaration(n.parent)) && n.parent.name === n
          if (!isPropName && !isDeclName) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
            hits.push(`${r}:${line} 组件直接碰 ${name}`)
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  add({
    id: 17,
    title: '组件不得直改 KB 状态（只经命令）',
    method: '静态查 `src/ui/**`、`src/view/**` 是否 import 持久化层，AST 查 localStorage / saveWorkspace / clearWorkspace / loadWorkspace / createWorkspaceStore / createLocalStorageAdapter 标识符（字符串标签与属性名不算）',
    scope: `src/ui/** · src/view/**（${COMPONENTS.length} 个组件文件）`,
    whitelist: 'src/main.ts（renderer **装配层**，不是组件：它是唯一允许持有 workspace/seed 的地方）· view 层改内存里的 `doc/marks/atoms`（本 demo 它就是模型持有者，见 note）',
    hits: hits.length,
    detail: hits,
    note: '**只能查到这里**：「经命令 vs 直改」在 demo 里分不开——view 层就是内存文档的持有者，命令最终也落到它的 tx() 上。kernel 到位后这条要升级成「写路径只有 DbClient 事务」，见 等内核 段',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 20 · StoragePort：持久化收口       ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 71.5 第 1 条：「localStorage 只允许出现在**一个适配器文件**里」。
  // 上一版就是散在 `core/workspace.ts` 里，于是上层顺手把「同步全量 save」当成了契约。
  const ADAPTER = 'src/core/storage/local-storage.ts'
  const hits = []
  for (const f of srcFiles) {
    const r = rel(f)
    if (r === ADAPTER) continue
    const { sf } = tsFile(f)
    const visit = (n) => {
      if (ts.isIdentifier(n) && n.text === 'localStorage') {
        const isPropName = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n
        const isDeclName = (ts.isFunctionDeclaration(n.parent) || ts.isVariableDeclaration(n.parent)) && n.parent.name === n
        if (!isPropName && !isDeclName) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
          hits.push(`${r}:${line} 适配器之外直接碰 localStorage`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  // 上层不得再 import 已删掉的同步 API（迁移期真踩过：`clearWorkspace` 被 commands 用着）
  const GONE = ['loadWorkspace', 'saveWorkspace', 'clearWorkspace']
  for (const f of srcFiles) {
    const r = rel(f)
    const { sf } = tsFile(f)
    for (const imp of importsOf(sf)) {
      if (!/workspace\.ts$/.test(imp.spec)) continue
      const decl = sf.statements.find(
        (s) => ts.isImportDeclaration(s) && s.moduleSpecifier.text === imp.spec,
      )
      const named = decl?.importClause?.namedBindings
      if (!named || !ts.isNamedImports(named)) continue
      for (const el of named.elements) {
        const name = el.propertyName?.text ?? el.name.text
        if (GONE.includes(name)) hits.push(`${r}:${imp.line} 还在 import 已删除的同步 API：${name}`)
      }
    }
  }
  add({
    id: 20,
    title: '持久化收口：`localStorage` 只出现在一个适配器文件里；上层不再 import 同步 save/load',
    method: `AST 扫 src/**/*.ts（除适配器）里的 localStorage 标识符；再查所有 \`import … from '*workspace.ts'\` 里的具名导入是否含 loadWorkspace／saveWorkspace／clearWorkspace`,
    scope: `src/**/*.ts（${srcFiles.length} 个文件；适配器 ${ADAPTER} 豁免）`,
    whitelist: `${ADAPTER}（唯一实现）· src/main.ts（装配层持有 StoragePort 实例，但不直接碰 localStorage）`,
    hits: hits.length,
    detail: hits,
    note: '这条只保证「换实现时改一处」。**异步 + 批次**这条契约由 `tests/storage.test.ts` 真跑（串行、失败如实返回、往返）——静态查不出「上层有没有偷偷依赖同步返回」',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 21 · 列表判定只能走 hasList（禁读 `.role` / `.roles`）    ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 来由：露面从单值 `role` 改成可兼位的集合（现在叫 `props._lists`）之后，
  // 任何残留的 `b.role === 'x'` 都**不会报错**——字段不存在，比较恒为 false，
  // 表现是「页不再是页」「日记不再是日记」，而且类型检查也抓不到（属性访问在 any 上合法）。
  // ⇒ 把「读单个 role 字段」这件事本身禁掉：判定只有 `hasList` 一个入口。
  //
  // 载体换到属性袋（`props._lists`）之后，同一条理由对 `.roles` 也成立，而且更凶：
  // 裸读拿到的是 `undefined`，`(b.roles?.length ?? 0) === 0` 这种写法会静默恒真
  // ⇒ **所有块都成了「无露面」**，页/标签/日记的每一条身份判据同时翻转，一个红灯都没有。
  // ⇒ `.roles` 只许出现在模型实现里（唯一实现），别处一律走 `hasList`／`listsOf`／`identityTags`。
  const ROLES_IMPL = 'src/core/model.ts'
  // 查询条件的实现与序列化：这两处读的 `.role` 是条件原子的键，不是块的列表判定
  const QUERY_LANG = new Set(['src/core/query.ts', 'src/core/query-view.ts'])
  const hits = []
  for (const f of srcFiles) {
    const r = rel(f)
    const { sf } = tsFile(f)
    const push = (n, what) => {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
      hits.push(`${r}:${line}  ${what}  ${n.getText(sf).slice(0, 60)}`)
    }
    const visit = (n) => {
      // ① `x.role`
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'role') {
        // DOM 的 `el.dataset.role` 是对外 CSS 契约（`[data-role~='journal']`），不是块角色判定
        const isDataset = ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'dataset'
        // 查询语言自己的 `role` 键（条件原子 `{ role: 'journal' }`）也不是块角色判定：
        // 它读的是 QueryNode 联合类型的条件形状，与 `props._lists` 无关
        const isQueryLang = QUERY_LANG.has(r)
        if (!isDataset && !isQueryLang) push(n, '读了单值 `.role`')
      }
      // ①b `x.roles`（唯一允许的读点在模型实现里）
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'roles' && r !== ROLES_IMPL) {
        push(n, '读了裸 `.roles`（走 hasList／listsOf／identityTags）')
      }
      // ② `x['role']`
      if (
        ts.isElementAccessExpression(n) &&
        n.argumentExpression &&
        ts.isStringLiteral(n.argumentExpression) &&
        n.argumentExpression.text === 'role'
      ) {
        push(n, '读了单值 `["role"]`')
      }
      // ③ `const { role } = b`
      if (ts.isBindingElement(n) && !n.propertyName && ts.isIdentifier(n.name) && n.name.text === 'role') {
        push(n, '解构出单值 `role`')
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  add({
    id: 21,
    title: '列表判定只走 `hasList`（禁读单值 `.role` 与裸 `.roles`）',
    method: `AST 扫 src/**/*.ts 的 \`x.role\`／\`x.roles\` 属性访问、\`x["role"]\` 元素访问、\`const { role } = …\` 解构；\`el.dataset.role\` 豁免（DOM 属性，不是块的列表判定）`,
    scope: `src/**/*.ts（${srcFiles.length} 个文件）`,
    whitelist: `\`el.dataset.role\`（写入 DOM 供 CSS 选择，承的是身份**外观**契约）· \`${ROLES_IMPL}\`（列表集合的唯一实现处）· 查询条件原子的键（\`{ role: 'journal' }\`，读的是 QueryNode 形状不是块）：src/core/query.ts ＋ src/core/query-view.ts · 列表**写入**请走 \`addList\`／\`removeList\``,
    hits: hits.length,
    detail: hits,
    note: '为什么必须机检：列表住进属性袋之后，裸读 `.roles` 恒 `undefined`，表现是「所有块都成了无露面」——页、标签、日记的身份判据同时翻转，类型检查也看不出来',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 22 · 块树遍历只有一个入口（禁自写递归）                   ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 来由：全仓十几条读路径都要「把块走一遍」—— 找一个块、列全部块、算路径、算层级、
  // 算可见行、找子树、建索引、按角色筛块……各自写一遍递归时，
  // 「哪些块算活着、按什么顺序走」就有了十几份答案。任何一处改变走法（回收站、软删、
  // 可见性、顺序）都要同时改十几处，漏一处就是**静默的**「有的地方找得到、有的地方找不到」。
  // 实测过一次：日记流只看顶层、索引走整片森林 ⇒ 同一天两个答案。
  // ⇒ 递归只许出现在 `core/walk.ts` 的 `walkForest` 里，其余读路径由它派生。
  const ONLY = 'src/core/walk.ts'
  const hits = []
  for (const f of srcFiles) {
    const r = rel(f)
    if (r === ONLY) continue
    const { sf } = tsFile(f)
    /** **造树**不是**走树**：`children: f(x.children)` / `b.children = f(x.children)` 是在造新节点 */
    const isConstruction = (call) => {
      const p = call.parent
      if (!p) return false
      if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'children') return true
      return (
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        /\.children$/.test(p.left.getText(sf))
      )
    }
    /** 一个函数是不是「自己递归走 children」 */
    const checkFn = (name, body) => {
      let recursesOverChildren = false
      let callsSelf = false
      let iteratesChildren = false
      const visit = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
          callsSelf = true
          // `walk(b.children)` —— 直接把 children 递归下去（造树的那支不算）
          if (!isConstruction(n) && n.arguments.some((a) => /\.children\b/.test(a.getText(sf)))) {
            recursesOverChildren = true
          }
        }
        // `for (const c of b.children) walk(c)` —— children 出现在循环上
        if (ts.isForOfStatement(n) && /\.children\b/.test(n.expression.getText(sf))) iteratesChildren = true
        ts.forEachChild(n, visit)
      }
      visit(body)
      if (!recursesOverChildren && !(iteratesChildren && callsSelf)) return
      const line = sf.getLineAndCharacterOfPosition(body.getStart(sf)).line + 1
      hits.push(`${r}:${line}  \`${name}\` 自己递归走 \`children\``)
    }
    const top = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) checkFn(n.name.text, n.body)
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        checkFn(n.name.text, n.initializer.body)
      }
      ts.forEachChild(n, top)
    }
    top(sf)
  }
  add({
    id: 22,
    title: '块树遍历只有一个入口（禁自写递归）',
    method:
      'AST 扫 src/**/*.ts 的函数（声明与 `const f = () => …`），命中条件是「自己递归走 children」：' +
      '① 自调用 `f(… .children …)`，或 ② `for (const x of ….children)` 且同函数里调用了自己',
    scope: `src/**/*.ts（${srcFiles.length} 个文件）`,
    whitelist: '`src/core/walk.ts`（唯一入口 `walkForest`）· DOM 遍历（走 `childNodes`，不是块树）· `cloneSubtree` 的 `cp`（那是**造树**不是**走树**，且用的是 `.map` 不是循环）',
    hits: hits.length,
    detail: hits,
    note: '为什么必须机检：多写一处递归**不会报错**，只会让「哪些块算活着」多一份答案；分歧那天没人知道，直到某处功能静默失效（日记流与索引对同一天给出两个答案就是这么来的）',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 23 · 块存储只有一个持有层（app/ui 不拿整库）             ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 块森林的持有者是 view/ 的编辑器与装配层（main.ts）。app/（命令）与 ui/（组件）
  // 只经注入的依赖面 / 读门面取数据——一旦它们直接 import 块存储，「换实现只改一个
  // 构造参数」就变成「重写每个调用方」。
  const FORBIDDEN = /core\/(store|kb\/memory|kb\/index)\.ts$/
  const hits = []
  for (const f of codeFiles) {
    const r = rel(f)
    if (!(r.startsWith('src/app/') || r.startsWith('src/ui/'))) continue
    // 装配层的分片（wiring）与 main.ts 同一角色：store 实例只在这里创建并注入
    if (r.startsWith('src/app/wiring/')) continue
    const { sf } = tsFile(f)
    for (const imp of importsOf(sf)) {
      if (FORBIDDEN.test(imp.spec)) hits.push(`${r}:${imp.line} import 了块存储：${imp.spec}`)
    }
  }
  add({
    id: 23,
    title: 'app／ui 不得 import 块存储（BlockStore／MemoryKb）——数据只经注入的依赖面与读门面',
    method: `静态扫 src/app/**、src/ui/** 的 import，禁 core/store.ts、core/kb/memory.ts、core/kb/index.ts`,
    scope: `src/app/** · src/ui/**`,
    whitelist: 'src/view/**（编辑器就是 store 的持有者）· src/main.ts ＋ src/app/wiring/**（renderer 装配层：store 实例只在这里创建并注入）· core 内部自用',
    hits: hits.length,
    detail: hits,
    note: '依赖接口里的整库口子由 [24] 看',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 24 · 依赖接口不注入整片森林（调用方写不出「遍历全库」）  ║
   ╚═══════════════════════════════════════════════════════ */

{
  // import 断言（[23]）拦不住「装配层把森林当能力注入」：app/ui 拿到 `blocks: () => Block[]`
  // 之后照样能扫全库、能直写树，P5 换懒加载实现时每个这样的调用方都得重写。
  // 读面只许经 `KbClient` 的窄方法（按 id／按名／按清单取数）；
  // 全库派生（成环检查、日记流天数这类）由装配层算好再注入答案。
  const INJECTED_FOREST = /blocks\??\s*:\s*(?:\(\)\s*=>|Readonly<\(\) =>)/
  const hits = []
  for (const f of codeFiles) {
    const r = rel(f)
    if (!(r.startsWith('src/app/') || r.startsWith('src/ui/'))) continue
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (INJECTED_FOREST.test(line)) hits.push(`${r}:${i + 1} 依赖接口注入了整片森林：${line.trim()}`)
    })
  }
  add({
    id: 24,
    title: 'app／ui 的依赖接口不得注入「整片森林」——读走 KbClient 窄方法，全库派生由装配层算好注入',
    method: '静态扫 src/app/**、src/ui/** 的 `blocks: () =>` 形态（把森林当能力注入的口子）',
    scope: `src/app/** · src/ui/**`,
    whitelist: 'src/main.ts（装配层是森林的持有者，它**收窄后**再注入）· src/view/**（编辑器持 store）',
    hits: hits.length,
    detail: hits,
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 25 · 行内内容只有 run 序列一套（禁旧形状复活）           ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 来由：正文曾经是「一个字符串 ＋ 库级扁平锚点数组」，靠**占位符字符**让原子在字符串里
  // 占一格，再靠逐端粘性映射让锚点跟着文本走。那套形状的每个零件都自洽，所以它坏起来
  // 是**静默**的：删字顺手吃掉原子、插入点恰好落在端点时多吞一个字。
  // 换成 run 序列之后，那些零件全部没有存在的理由（原子是流节点、格式是 run 属性）。
  // ⇒ 一旦有人把它们写回来（哪怕是「先留着以防万一」），两套形状就会同时成立，
  //    而分歧只会在某次编辑之后显形。这条断言的作用是让「写回来」当场变红。
  const BANNED = [
    'ATOM_PLACEHOLDER',
    'writeBlockText',
    'setAnnotations',
    'normalizeMarks',
    'mapAtoms',
    'mapMarks',
    'syncAnchors',
    'ImageRun',
    'thumbUri',
  ]
  const hits = []
  for (const f of srcFiles) {
    const r = rel(f)
    const { sf } = tsFile(f)
    const visit = (n) => {
      // 标识符与属性名都算：`mapAtoms(...)` 与 `x.mapAtoms` 是同一次复活
      if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
        const name = ts.isIdentifier(n) ? n.text : n.name.text
        if (BANNED.includes(name)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
          hits.push(`${r}:${line} 旧行内形状的零件复活：\`${name}\``)
        }
      }
      // `t: 'image'` 是**另一种**复活方式：不需要标识符，写个字面量就成立了，
      // 而它会让形状校验把整份库判成 corrupt（比静默错更糟：打不开）。
      if (ts.isStringLiteral(n) && n.text === 'image' && isDiscriminantValue(n)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
        hits.push(`${r}:${line} 旧 run 种类复活：\`t: 'image'\`（资产用 \`t: 'asset'\`）`)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  add({
    id: 25,
    title: '行内内容只有 run 序列一套（禁旧形状的零件复活）',
    method:
      'AST 扫 src/**/*.ts 的标识符与属性名，命中即复活：' +
      BANNED.map((n) => `\`${n}\``).join('／') +
      '；另扫「`t:` 的值是 `\'image\'`」这种形状复活（注释不进 AST ⇒ 讲「为什么不用它」不算命中）',
    scope: `src/**/*.ts（${srcFiles.length} 个文件）`,
    whitelist: '无——这些名字对应的机制已被 run 序列与资产对象取代，没有正当用途',
    hits: hits.length,
    detail: hits,
    note: '为什么必须机检：旧形状自带一套自洽的解释（原子在字符串里占一格、锚点靠粘性映射跟随、图片带一份内联 state），写回来时类型与单测都不会喊，只有真编辑几轮之后才会显形',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 26 · 资产库：indexedDB 与对象 URL 各自只有一个产地        ║
   ╚═══════════════════════════════════════════════════════ */

{
  /**
   * 两条不可逆/易漏的口径：
   *
   * ① **`indexedDB` 只许出现在一个适配器文件里**。与 `localStorage` 同一条理由：
   *    散出去之后「换存储只改一处」就变成重写每个调用方；而且 IDB 的库名是**不可逆契约**
   *    （换名＝已有资产静默消失），必须只有一处能碰它。
   * ② **`URL.createObjectURL` 只许出现在一个文件里**。每次渲染都建一个 URL 会一直泄漏
   *    （浏览器不回收，直到文档卸载），而泄漏不报错、只是越来越占内存。
   *    收口到**实现内部**之后，「按 hash 缓存 + 统一 revoke」才是这个文件能自己保证的事
   *    —— 视图层不再有机会漏。
   *
   * 为什么是 hard：两条都不是风格问题——一条是数据静默消失，一条是慢性泄漏。
   */
  const IDB_ADAPTER = 'src/core/storage/asset-idb.ts'
  /**
   * 对象 URL 的产地是**适配器自己**（2026-10-29 改）。
   *
   * 上一版它在 `view/asset-views.ts`：那是「渲染层拿到的只有字节，于是只好自己建 URL」
   * 的形状。现在端口给的是**地址**（`urlOf`），地址的生命周期归实现 ——
   * 浏览器端那个实现就是 `blob:` 的创建者，也就是唯一有资格回收它的人。
   * 视图层连 `URL` 这个标识符都不该再碰。
   */
  const URL_HOME = 'src/core/storage/asset-idb.ts'
  const idbHits = []
  const urlHits = []
  for (const f of srcFiles) {
    const r = rel(f)
    const { sf } = tsFile(f)
    const visit = (n) => {
      if (ts.isIdentifier(n) && n.text === 'indexedDB' && r !== IDB_ADAPTER) {
        const isPropName = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n
        if (!isPropName) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
          idbHits.push(`${r}:${line} 适配器之外直接碰 indexedDB`)
        }
      }
      if (
        ts.isPropertyAccessExpression(n) &&
        n.name.text === 'createObjectURL' &&
        r !== URL_HOME
      ) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
        urlHits.push(`${r}:${line} 对象 URL 在唯一产地之外创建（会漏 revoke）`)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  add({
    id: 26,
    title: '资产库：`indexedDB` 只在一个适配器里；`URL.createObjectURL` 只在唯一产地',
    method: 'AST 扫 src/**/*.ts 的 `indexedDB` 标识符与 `.createObjectURL` 属性访问',
    scope: `src/**/*.ts（${srcFiles.length} 个文件；适配器 ${IDB_ADAPTER}、URL 产地 ${URL_HOME} 豁免）`,
    whitelist: `${IDB_ADAPTER}（唯一实现）· ${URL_HOME}（唯一创建与回收处）`,
    hits: idbHits.length + urlHits.length,
    detail: [...idbHits, ...urlHits],
    note: '库名 `qua.assets` 是新的不可逆契约（换名＝资产静默消失），与 `qua.workspace` 同级；由本条的另一半（只允许一个产地）保证它不会散出去',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 额外 · 主题双轨静态面                       ║
   ╚═══════════════════════════════════════════════════════ */

{
  // ⚠️ 主题逻辑已从 main.ts 抽到 `src/theme.ts`：断言按**整个 src** 找，不绑死在某个文件上
  const srcText = codeFiles.map((f) => readFileSync(f, 'utf8')).join('\n')
  const html = existsSync(INDEX_HTML) ? readFileSync(INDEX_HTML, 'utf8') : ''
  const checks = [
    ['src 里有 prefers-color-scheme', /prefers-color-scheme/.test(srcText)],
    ['src 里有 matchMedia 监听', /matchMedia\([^)]*prefers-color-scheme/.test(srcText)],
    ['index.html 有首屏 color-scheme 兜底', /color-scheme/.test(html)],
    ['不做 JS 切类（没有按主题 toggle class）', !/classList\.(add|remove|toggle)\(\s*['"](dark|light|theme)/.test(srcText)],
  ]
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n)
  add({
    id: '3+',
    title: '主题三档＝CSS 自定义属性 ＋ color-scheme 双轨（prefers-color-scheme ＋ data-theme），不做 JS 切类，首屏有兜底',
    method: '静态查 src/main.ts 是否有 prefers-color-scheme 的 matchMedia 监听、index.html 是否有 color-scheme 首屏兜底、JS 是否按主题切 class',
    scope: 'src/main.ts · index.html · src/styles.css（light-dark() 取值）',
    whitelist: '无',
    hits: bad.length,
    detail: bad.map((n) => `缺：${n}`),
    note: '「跟随系统真的变色」是渲染行为，静态查不了 ⇒ 由 checks/smoke.mjs T11 用 Playwright emulateMedia(colorScheme) 真跑',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 18 · 命令 handler 不得碰 DOM（59 「命令不知道 UI」）  ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 来由：底座轮报的「`core.page/rename` 的 handler 里 `document.getElementById('page-title')`」
  // ——命令面是机器接口（HTTP／MCP／CLI 都会走到它），碰 DOM 会让这些传输在非渲染环境里直接炸。
  // 判据：`COMMANDS` 的 handler 只许经 `app.*` 改状态；DOM 焦点/选区归装配层（`src/main.ts`）。
  //
  // 2026-10-23：handlers 拆到 `src/app/handlers/*.ts` 后，旧的「只扫 handlers.ts」会数到 0
  // 却仍然报过 —— 断言空转比红更危险。现在扫合并面 + 各域文件（排除 shared.ts 的小工具）。
  const files = [
    join(ROOT, 'src/app/handlers.ts'),
    ...walk(join(ROOT, 'src/app/handlers'), ['.ts']).filter((p) => !p.endsWith('/shared.ts')),
  ]
  const hits = []
  const has = new Map()
  for (const file of files) {
    const { sf } = tsFile(file)
    const path = rel(file)
    for (const b of sf.statements) {
      // 形如 `'core.x/y': (a, app) => {...}` 的对象字面量属性
      if (!ts.isVariableStatement(b)) continue
      for (const d of b.declarationList.declarations) {
        if (!d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue
        for (const p of d.initializer.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.name)) continue
          const name = p.name.text
          if (!name.includes('/')) continue // 只挑 `core.*/*` 形状的 handler（跳过 tooltip 之类的杂项）
          has.set(name, true)
          const walkNode = (n) => {
            if (ts.isIdentifier(n) && (n.text === 'document' || n.text === 'window')) {
              const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
              hits.push(`${path}:${line} \`${name}\` 的 handler 用了 \`${n.text}\``)
              return
            }
            ts.forEachChild(n, walkNode)
          }
          walkNode(p.initializer)
        }
      }
    }
  }
  add({
    id: 18,
    title: '命令 handler 不得碰 DOM（`document` / `window`）',
    method:
      'AST 定位 `src/app/handlers.ts` ＋ `src/app/handlers/*.ts`（排除 `shared.ts`）里形如 `\'core.*/x\': (args, app) => …` 的属性，遍历其函数体查 `document` / `window` 标识符（注释与字符串不计）',
    scope: `src/app/handlers.ts ＋ src/app/handlers/*.ts（${has.size} 个 handler）`,
    whitelist: '无 —— 焦点/选区/滚动一律走 `App` 门面（例：`app.focusTitle()`）',
    hits: hits.length,
    detail: hits,
    note: '只查这两个全局：`navigator`/`localStorage` 在原型里偶尔有正当用途，先不拦；内核到位后升级成「handler 只能调 app.*」',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 额外 · 块形状：四个内容槽                               ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 父子关系只能有一份。`parent`／`left` 一旦进了 `Block`，就与 `children` 并列成第二份真相：
  // 移动／复制／撤销／软删每处都要维护，漏一处就静默分叉；取路径改走派生索引 `Index.parentOf`。
  // 白名单 ＝ 四个内容槽 ＋ 两个必填时间戳（创建／改动时刻，不可能缺席）＋ 按需物化的 `annos`。
  // 加任何新字段都要先改这里 —— 那正是本条存在的意义：让「顺手加个字段」变成一次显式动作。
  const MODEL = join(ROOT, 'src/core/model.ts')
  const ALLOWED = new Set(['id', 'content', 'children', 'created', 'modified', 'annos', 'props'])
  const hits = []
  let seen = 0
  if (!existsSync(MODEL)) hits.push('src/core/model.ts 不存在（本条断言的锚点丢了）')
  else {
    const { sf } = tsFile(MODEL)
    for (const st of sf.statements) {
      if (!ts.isInterfaceDeclaration(st) || st.name.text !== 'Block') continue
      for (const m of st.members) {
        if (m.name === undefined) continue
        const name = m.name.getText(sf)
        seen++
        if (!ALLOWED.has(name)) {
          const line = sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1
          hits.push(`src/core/model.ts:${line} \`Block.${name}\` 不在白名单 —— 父/序/正文只能是派生的第二份答案`)
        }
      }
    }
  }
  add({
    id: 27,
    title: '块只有四个内容槽：`Block` 不得长出 `parent` / `left` / `text` 这类第二份真相',
    method:
      'AST 定位 `src/core/model.ts` 的 `interface Block`，逐个成员名对白名单（`id`/`content`/`children`/`created`/`modified`/`annos`/`props`）',
    scope: `src/core/model.ts（${seen} 个成员）`,
    whitelist: 'id / content / children / created / modified / annos / props —— 加字段＝改这条白名单的一次显式动作',
    hits: hits.length,
    detail: hits,
    note: '父子关系只有 `children` 一份，取路径走派生索引 `Index.parentOf`；插件读路径走读门面（`kb.pathOf`），不靠块上的指针',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 32 · 拥有者模型：被删掉的旧形状不得复活                    ║
   ╚═══════════════════════════════════════════════════════ */

{
  /**
   * **一次破坏性重构之后，旧形状最容易以三种方式回来**，而这三种都不报错：
   *   ① 有人「顺手加个缓存」把冻结结果又写回块上（`_queryResult`）——
   *      于是「刷新」开始进撤销栈，而同一个查询在不同设备上结果能不一样；
   *   ② 有人为了「日记也挂一栏」再造一个隐藏配置块（`journalMountsId`）——
   *      那个块不可寻址、不进回收站，删了没有入口、备份里却多一块；
   *   ③ 有人拿数组下标当 tab 的键（`user:<index>`）——摘掉第一栏之后，
   *      激活项与冻结缓存全体漂到别一栏上。
   *
   * 判据走 AST（注释不算命中）：`_queryResult` / `journalMountsId` 是**字符串与标识符**，
   * 而讲「为什么不用它」的注释必须留得住（被推翻的想法要留痕）。
   */
  const hits = []
  const scan = (files) => {
    for (const f of files) {
      const r = rel(f)
      const { sf } = tsFile(f)
      const visit = (n) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) {
          if (n.text === '_queryResult' || n.text.startsWith('user:')) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
            hits.push(`${r}:${line} 旧形状 \`${n.text.slice(0, 24)}\``)
          }
        }
        if (ts.isIdentifier(n) && (n.text === 'QUERY_RESULT_PROP' || n.text === 'journalMountsId')) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
          hits.push(`${r}:${line} 旧符号 \`${n.text}\``)
        }
        // `spec.todo`：顶层 todo 与 `where:{todo}` 是同一件事的第二份表示
        if (ts.isPropertyAccessExpression(n) && n.name.text === 'todo' && ts.isIdentifier(n.expression) && n.expression.text === 'spec') {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
          hits.push(`${r}:${line} \`spec.todo\`（三态只由 where:{todo} 表达）`)
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
  }
  scan([...srcFiles, ...walk(join(ROOT, 'tests'), ['.ts']), ...walk(join(ROOT, 'checks'), ['.mjs'])])
  add({
    id: 32,
    title: '拥有者模型：`_queryResult` / `journalMountsId` / `user:<index>` / `spec.todo` 都不得复活',
    method:
      'AST 扫 src/**/*.ts ＋ tests/**/*.ts ＋ checks/**/*.mjs 的字符串字面量（`_queryResult`／`user:` 前缀）、标识符（`QUERY_RESULT_PROP`／`journalMountsId`）、属性访问（`spec.todo`）',
    scope: `src ＋ tests ＋ checks（${srcFiles.length} 个源文件 ＋ 测试与冒烟）`,
    whitelist: '无 —— 结果按表面实例冻结、日记的栏住设备状态、tab 的键是稳定 id',
    hits: hits.length,
    detail: hits,
    note: '注释不在 AST 里 ⇒ 讲「为什么删掉它」的记录不会被这条拦住',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 33 · 视图配置的写路径唯一                                  ║
   ╚═══════════════════════════════════════════════════════ */

{
  /**
   * 「配置住哪」必须只有一个答案。
   *
   * 允许碰 `_views`／`_activeView`／`_mounts` 的只有三处：
   *   · `core/view-owner.ts`（拥有者/绑定的纯函数）；
   *   · `core/mount.ts`（栏的编解码）；
   *   · `app/wiring/owners.ts`（唯一实现：一笔事务或一次设备保存）。
   * 其余地方（命令、UI、装配）都经 `ViewOwnerStore`。
   *
   * 为什么是 hard：第二处写路径不会「明显坏掉」——它会在读到 `_mounts` 是
   * 日记宿主（设备状态）时静默写一个不存在的块，或者把 `_views` 写到 target 以外的块上。
   */
  const ALLOW = new Set(['src/core/view-owner.ts', 'src/core/mount.ts', 'src/app/wiring/owners.ts', 'src/core/model.ts', 'src/core/view.ts'])
  const PROPS = new Set(['_views', '_activeView', '_mounts'])
  const hits = []
  for (const f of srcFiles) {
    const r = rel(f)
    if (ALLOW.has(r)) continue
    const { sf } = tsFile(f)
    const visit = (n) => {
      // `x.props._views` 形状：属性访问链里出现被保护的键
      if (ts.isPropertyAccessExpression(n) && PROPS.has(n.name.text)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
        hits.push(`${r}:${line} 直接碰 \`${n.name.text}\` —— 走 ViewOwnerStore`)
      }
      // `props['_mounts']` 形状
      if (ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteral(n.argumentExpression) && PROPS.has(n.argumentExpression.text)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
        hits.push(`${r}:${line} 直接碰 \`${n.argumentExpression.text}\` —— 走 ViewOwnerStore`)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  add({
    id: 33,
    title: '视图配置的写路径唯一（`_views` / `_activeView` / `_mounts` 只经 ViewOwnerStore）',
    method: 'AST 扫 src/**/*.ts 的属性访问与元素访问，命中被保护的三个键就记账（白名单按文件）',
    scope: `src/**/*.ts（${srcFiles.length} 个文件）`,
    whitelist: [...ALLOW].join(' · '),
    hits: hits.length,
    detail: hits,
    note: '「配置住哪」有两个答案时不会报错：改一处、另一处不动，用户看到的是「点了没生效」',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 34 · 源 × kind 的兼容表只有一份                            ║
   ╚═══════════════════════════════════════════════════════ */

{
  /**
   * 哪些 kind 能落在哪种源上，只在 `core/view.ts` 的 `STORED_KINDS_BY_SOURCE` 里有一份。
   *
   * 渲染器各写一份分支的下场是「命令能写、读回来被丢掉」——也就是**点了没生效**，
   * 而它看起来只是「这个视图不支持」。判据：`STORED_KINDS_BY_SOURCE` 这个声明只许出现一次。
   */
  const hits = []
  let decls = 0
  for (const f of srcFiles) {
    const r = rel(f)
    const { sf } = tsFile(f)
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'STORED_KINDS_BY_SOURCE') {
        decls++
        if (r !== 'src/core/view.ts') {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
          hits.push(`${r}:${line} 第二份兼容表`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  if (decls === 0) hits.push('src/core/view.ts 里找不到 `STORED_KINDS_BY_SOURCE`（本条断言的锚点丢了）')
  add({
    id: 34,
    title: '源 × kind 的兼容表只有一份（`STORED_KINDS_BY_SOURCE`）',
    method: 'AST 数 `STORED_KINDS_BY_SOURCE` 的变量声明，且只许在 `src/core/view.ts`',
    scope: `src/**/*.ts（${srcFiles.length} 个文件；找到 ${decls} 处声明）`,
    whitelist: 'src/core/view.ts（唯一一份）',
    hits: hits.length,
    detail: hits,
    note: 'UI 的「能切哪几种」读同一张表：分两处写会得到「菜单里有、切过去空屏」',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 35 · 页的「字段声明」入口不存在                            ║
   ╚═══════════════════════════════════════════════════════ */

{
  /**
   * 页曾经能声明 `_fieldDefs`，但那一格**没有任何消费方**（子块不会因此获得那些字段）。
   * v29 起：页不画那一段，`declareField(page)` 返回 false。
   *
   * 判据（两条，都是「这一格还能不能写」的直接体现）：
   *   · `ui/properties.ts` 不再用页版本的标题（`ui.props.pageFieldsTitle`）；
   *   · `core/props.ts` 的 `declareField` 里不再出现 `'page'` 这个列表值。
   */
  const hits = []
  for (const [file, needle] of [
    ['src/ui/properties.ts', 'ui.props.pageFieldsTitle'],
    ['src/core/props.ts', 'page'],
  ]) {
    const f = join(ROOT, file)
    if (!existsSync(f)) {
      hits.push(`${file} 不存在（本条断言的锚点丢了）`)
      continue
    }
    const { sf, src } = tsFile(f)
    const at = src.indexOf(needle)
    if (at < 0) continue
    if (file.endsWith('props.ts')) {
      // 只关心 `declareField` 函数体：别处（注释/其它函数）提 page 是正当的
      const fn = src.indexOf('export function declareField')
      const end = src.indexOf('\n}', fn)
      if (fn >= 0 && at > fn && at < end) {
        const line = sf.getLineAndCharacterOfPosition(at).line + 1
        hits.push(`${file}:${line} \`declareField\` 里还有页分支`)
      }
      continue
    }
    const line = sf.getLineAndCharacterOfPosition(at).line + 1
    hits.push(`${file}:${line} 还在渲染页的字段声明段`)
  }
  add({
    id: 35,
    title: '页的「字段声明」入口不存在（能写没人读的值不许留着）',
    method: '文本查 `ui/properties.ts` 的页版标题、`core/props.ts` 的 `declareField` 里是否还有 page 分支',
    scope: 'src/ui/properties.ts · src/core/props.ts',
    whitelist: '无 —— 页的子块不会继承声明，所以那一格不该可写',
    hits: hits.length,
    detail: hits,
    note: '继承是另一个设计（要先定「页的子块」与「标签的成员」谁说了算）；在那之前这一格不可写',
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 等内核（不假装在跑）                                     ║
   ╚═══════════════════════════════════════════════════════ */

const KERNEL_TODO = [
  ['1', '不得绕过 `DbClient`；不得写 SQL', '**等内核，不在本轮**：仓里根本没有 DbClient／驱动／SQL，静态扫 SQL 关键词只能扫到 `core.editor/insert-block` 这类英文命令名 ⇒ 是假阳性工厂，不写。内核落地后这条改成「新增 import 只允许 db/client.ts」＋ SQL 关键词扫描。'],
  ['7', '三寄存器存在、无单一 `hlc` 列', '**等内核，不在本轮**：寄存器是 SQLite 表结构（migration）里的事实，现在没有库、没有 migration。'],
  ['8', '写事务必产 op-log 批', '**等内核，不在本轮**：op-log 是内核事务的一部分；renderer 的 localStorage 写入没有这个语义。'],
  ['10', '派生索引可全量重建且与增量结果逐字节一致', '**等内核，不在本轮**：派生索引（FTS 等）还没建；这条本质是集成测试，不是静态检查。'],
  ['6', 'ID 同型（32-hex UUIDv7）', '**等内核，不在本轮**：这是运行时/单测口径（uuidv7Hex 的形状），静态只能证明函数在，证明不了每个落库 id 同型。'],
  ['9', '未 `expose` 的命令不出现在 HTTP／MCP／CLI 面', '**等内核，不在本轮**：HTTP/MCP/CLI 三个面都还没起，没有可断言的对象。'],
]

/* ═══════════════════════════════════════════════════════╗
   ║ 输出                                                     ║
   ╚═══════════════════════════════════════════════════════ */

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

console.log(`\n${C.bold('架构断言')} ${C.dim(`（scripts/arch-check.mjs ・ 根 ${rel(ROOT) || '.'} ・ node ${process.version}）`)}\n`)

for (const r of results) {
  const tag =
    r.level === 'kernel'
      ? C.cyan('等内核')
      : r.level === 'debt'
        ? C.yellow('欠账')
        : r.level === 'convention'
          ? C.cyan('约定')
          : r.ok
            ? C.green('过')
            : C.red('红')
  console.log(`${tag}  ${C.bold(`[${r.id}]`)} ${r.title}`)
  console.log(`      检查方式：${r.method}`)
  console.log(`      扫描范围：${r.scope}`)
  console.log(`      白名单：${r.whitelist}`)
  const hitTail = !r.ok && r.level === 'hard' ? '  ← 红' : r.level === 'debt' ? '（不拦门，只记账）' : ''
  console.log(`      命中数：${r.hits}${r.expect ? `（允许 ≤ ${r.expect}）` : ''}${hitTail}`)
  if (r.note) console.log(`      ${C.dim(`注：${r.note}`)}`)
  for (const d of r.detail.slice(0, 20)) console.log(`      ${C.red('·')} ${d}`)
  if (r.detail.length > 20) console.log(`      ${C.dim(`… 还有 ${r.detail.length - 20} 条`)}`)
  console.log('')
}

console.log(C.cyan(`${C.bold('等内核（本轮明确不查）')}`))
for (const [id, title, why] of KERNEL_TODO) {
  console.log(`  ${C.cyan(`[${id}]`)} ${title}`)
  console.log(`      ${why}`)
}
console.log('')

const hard = results.filter((r) => r.level === 'hard')
const hardOk = hard.filter((r) => r.ok).length
const debt = results.filter((r) => r.level === 'debt')
console.log(
  `${hardOk === hard.length ? C.green('✔') : C.red('✘')} 硬断言 ${hardOk}/${hard.length} 过` +
    `　· ${C.yellow(`欠账 ${debt.length} 条（不拦门）`)}　· ${C.cyan(`等内核 ${KERNEL_TODO.length} 条`)}`,
)
if (hardRed) {
  console.log(C.red(`\n${hardRed} 条硬断言红了 —— 先把命中列出来源再改代码。\n`))
  process.exit(1)
}
console.log('')

/* 顺带当作一次「文件真的存在」的体检：这三个是 msg / 主题 / token 段的落点 */
for (const p of ['src/core/msg.ts', 'src/styles.css', 'index.html']) {
  if (!existsSync(join(ROOT, p))) {
    console.log(C.red(`缺少 ${p}`))
    process.exit(1)
  }
}
void statSync

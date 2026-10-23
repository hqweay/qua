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
   ║ 15 · 命令 decl 不得含 context / host / key（59 ）      ║
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
  const hits = []
  for (const f of electronFiles) {
    const r = rel(f)
    const { sf } = tsFile(f)
    for (const imp of importsOf(sf)) {
      if (/workspace|seed|core\.ts$|commands\.ts$/.test(imp.spec)) {
        hits.push(`${r}:${imp.line} → ${imp.spec}（主进程不得 import 数据层／业务）`)
      }
    }
  }
  add({
    id: '2+',
    title: '主进程不得 import 数据层',
    method: 'AST 遍历 electron/**/*.ts 的 import/export-from，禁 workspace / seed / core / commands；只放行 src/core/msg.ts（纯字典）',
    scope: 'electron/main.ts · electron/preload.ts',
    whitelist: '`../src/core/msg`（纯文案字典，零依赖，不是数据层）· `electron` · `node:*`',
    hits: hits.length,
    detail: hits,
  })
}

/* ═══════════════════════════════════════════════════════╗
   ║ 额外 · 不可逆项：localStorage 键名（硬纪律）              ║
   ╚═══════════════════════════════════════════════════════ */

{
  // 换键 ＝ 用户已存的库静默消失。把值钉死在这里：真要换，必须先改这条断言并写迁移。
  // 2026-10-20：`STORAGE_KEY` 随 StoragePort 拆分留在导出面 `src/core/workspace.ts`，断言路径不变。
  // 2026-10-20 公开整理：旧键是内部阶段的值，公开版定为 `qua.workspace`（旧数据不迁移，见 AGENTS §1.7）。
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
        if (!isDataset) push(n, '读了单值 `.role`')
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
    whitelist: `\`el.dataset.role\`（写入 DOM 供 CSS 选择，承的是身份**外观**契约）· \`${ROLES_IMPL}\`（列表集合的唯一实现处）· 列表**写入**请走 \`addList\`／\`removeList\``,
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

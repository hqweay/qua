# 参与开发

> 这份是**流程**纪律。动手前必须知道的**工程**纪律在 [`AGENTS.md`](AGENTS.md)——先读那份。

---

## 0 三句话

1. **`pnpm gate` 全绿才算做完。** 不是「跑过」，是**在当前 HEAD 上**跑过。
2. **一个 PR 只做一件事。** 混着重构与功能，review 会走形。
3. **改了规则就要改断言。** 本仓的规则大多是可执行断言，不是文档——文档会过期，断言不会。

---

## 1 环境

```bash
# Node 必须 26.x（.node-version 钉住）；旧版会让 rollup 原生模块 dlopen 失败
node -v

pnpm i
pnpm dev        # 起来之后光标已在第一块，先敲几个字确认输入面正常
```

首次 `pnpm i` 会下载 Electron 二进制（数百 MB）。仓库里的 `.npmrc` 默认指向国内镜像
（npmmirror），在中国大陆会快很多。**海外网络请改成本地源**：

```bash
# 临时（不改仓库文件）
pnpm i --config.electron_mirror=https://github.com/electron/electron/releases/download/
# 或直接删掉 .npmrc 里那两行（不要提交这个改动）
```

只改界面、不启 Electron 的话用 `pnpm dev:web`，不需要下载那份二进制。

---

## 2 分支

| 分支 | 用途 |
|---|---|
| `main` | 永远可跑、门禁全绿。**不要直接往 `main` 推不可跑的东西。** |
| `feat/<短横线主题>` | 一个功能 |
| `fix/<短横线主题>` | 一个缺陷 |
| `refactor/<短横线主题>` | 纯结构调整（**不许夹带行为变化**） |
| `docs/<短横线主题>` | 只动文档 |

命名说**做了什么**，不说**在哪改**：`feat/query-view` ✅／`feat/ui-ts` ❌

提交前从 `main` 拉一次、把分支 rebase 上去，保证历史是一条直线。

---

## 3 提交

[Conventional Commits](https://www.conventionalcommits.org/)，中文正文，**一行说清做了什么**：

```
feat(editor): Enter 按落点分三支（块中同级拆 / 块尾子块 / 空块反缩进）
fix(storage): 读盘结果分型——过新/损坏的库进入只读态，不再被 seed 覆盖
refactor(layers): 按层拆分 src，图标槽改内联 SVG
docs(model): 补「判据 ②」的反例
```

- **scope** 用目录名：`core` `view` `ui` `app` `electron` `checks` `docs`。
- **标题里不要写「修复了一些问题」**——那等于没写。
- 一个提交做不完一件事是可以的，但**每个提交都要能单独构建**。

**提交信息也是公开历史的一部分**，和代码注释、文档同一条边界——只写「为什么」，
不写「改了什么」、不挂读者打不开的内部引用、不写原型阶段里的话。

**隐私**：提交里会带你的邮箱，且**永久留在公开历史里**。不想暴露真实邮箱就用 GitHub 的 noreply 地址：

```bash
git config user.email "12345678+hqweay@users.noreply.github.com"   # 换成你自己的 ID
```

> push 之前改还来得及；push 之后再改就要重写历史了。

---

## 4 PR

标题同提交格式。描述里只写三样：

```markdown
## 做了什么
（一两句）

## 怎么验的
（贴 `pnpm gate` 的结论行，例如：arch 14/14 · check 40/40 · dock 8/8 · electron 10/10 · test:core 72/72）

## 已知没做 / 风险
（没有就写「无」）
```

**review 时按这个顺序看**：

1. **分层**有没有被绕开（`pnpm arch:check` 会拦，但先自己看一眼）；
2. **用户可见文案**有没有裸中文（要 `t('id')`）；
3. 新行为有没有**断言**——只加功能不加测试的 PR 一般会被要求补；
4. 有没有**顺手改**了无关文件（会让 rebase 时的冲突难以归因）。

---

## 5 门禁

```bash
pnpm gate
```

它是下面这一串，**任何一环非 0 退出就是没做完**：

```
typecheck → test:core → build → build:electron → arch:check → check → check:dock → check:electron
```

| 环节 | 查什么 | 挂了先看 |
|---|---|---|
| `typecheck` | renderer ＋ 主进程两套 tsconfig | 类型错误原文 |
| `test:core` | `tests/*.test.ts`（`node --test`，零依赖，纯 core） | 测试名就是断言口径 |
| `arch:check` | 架构断言（秒级） | 命中列表里有文件与行号 |
| `check` | **真 Chrome** 真按键真鼠标 | `.cache/` 里的截图与日志 |
| `check:dock` | 真量尺寸的布局断言 | 断言的量值与实际值 |
| `check:electron` | 真 Electron 里的同一批账 | `.cache/etest/electron-smoke.log` |

> **不要跳过 `electron` 那步。** 浏览器里过的，在 Electron 里可能不过（IME、系统按键、窗口尺寸都见过差异）。

### 偶发失败怎么办

冒烟里有几条依赖时序（IME 组合、窗口焦点）。**判据：看到挂了先原样重跑一次**；
第二次还挂才当回归去查。把「重跑就好了」写进结论里，不要静默重跑。

---

## 6 加一个功能的标准动作

1. **先问模型**：这东西是**新实体**，还是「块 ＋ 角色／属性」？——[`docs/模型-一切皆块.md`](docs/模型-一切皆块.md) §1 的三条判据。
2. **再问归属**：它属于数据层（`core`）、渲染（`view`）、组件（`ui`）、命令（`app`）还是装配（`main.ts`）？
   **放错层会被断言拦下来，这是好事。**
3. **加命令就加声明**：命令表在 `src/core/commands/decls.ts`，`title` 必须走 `t()`；
   键位是**数据**，加在 `src/core/bindings.ts`——**不要写 `if (e.key === …)` 硬分支**。
4. **加文案就加字典项**：`src/core/msg.ts`，键名用 `区域.组件.用途`。
5. **写断言**：纯逻辑进 `tests/`；要真浏览器的进 `checks/smoke.mjs`。
   **断言写在测试名里**——失败时那句话就是你需要的全部上下文。

---

## 7 不要做的事

| 别做 | 为什么 |
|---|---|
| 直接改 `main` | 无法 rebase 的历史会让别人的 PR 全部冲突 |
| 在 `core` 里 `import` 任何 DOM 类型 | `core` 必须能脱离浏览器跑（单测就是这么跑的） |
| 在命令 handler 里写 `document.xxx` | 命令不知道 UI 长什么样；要焦点/滚动走 `App` 门面 |
| 在组件里写 `var(--c-*)` 或 `#fff` | 主题只填 `--ui-*`，直连基础色会让主题改不动它 |
| 改 `STORAGE_KEY` | 等于把所有用户的数据静默丢掉；真要改必须配迁移 |
| 为了「先跑起来」写死路径 | 会在别人的机器上变成一次排查 |

---

## 8 提交信息之外的两条约定

- **被推翻的方案要留痕**：在 `docs/` 的对应段落里写「当时想怎么做、被什么推翻」，
  而不是把那段代码删掉就当没发生过。理由见 [`docs/模型-一切皆块.md`](docs/模型-一切皆块.md) §5。
- **标明证据强度**：结论区分「实测过」「看源码得出」「还没验证」。宁可写「未验证」，不要含糊。

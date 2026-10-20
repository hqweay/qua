# `kb/` —— 知识库本体（v1：还没有落盘）

## 现状：数据在 localStorage 里，**不在这里**

v1 的持久化仍然是 `localStorage`（`src/core/workspace.ts`，键 `qua.workspace`）。
它落在 Chromium 的 profile 目录里，也就是：

```
<userData>/Local Storage/leveldb/
```

（`<userData>` = `~/Library/Application Support/net.leay.qua/`）
—— 所以数据**确实**跟着 app 走、确实天然持久，只是**没有出现在 `kb/` 下面**。

## 将来：这个目录放什么

```
kb/
  main.sqlite          ← 库本体（将来接内核后的事务落点）
  main.sqlite-wal
  main.sqlite-shm
  assets/<hash>        ← 图片/附件的原文件（库里只存 hash 与尺寸）
```

## 换实现时**写入通道的形状不变**

现在的写入是一句 `localStorage.setItem(键, JSON.stringify(workpace))`；
将来换成内核事务 `ctx.tx.run(...)`——**调用点的形状（一次提交一整份 workspace）不变**，
变的是背后的实现。见 `src/core/workspace.ts` 顶部的注释与 app 根 `README.md` 的 `TODO: 换 DbClient`。

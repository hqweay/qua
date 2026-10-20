# 应用数据目录（`userData`）

这个目录里放**运行时才产生的、不属于源码的东西**。它**不在** app 包内、卸载 app 不会删掉它。

绝对路径（macOS）：`~/Library/Application Support/net.leay.qua/`

> ⚠️ 目录名用的是 **appId `net.leay.qua`（全英文）**，不是中文显示名「相」。
> Electron 默认拿 `productName` 当数据目录名，中文会变成
> `~/Library/Application Support/相/` —— 中文路径在脚本、日志、备份工具里到处是坑，
> 所以主进程在 `whenReady` 之前**显式** `app.setPath('userData', <appData>/net.leay.qua)`。

## 六个子目录

| 目录 | 用途 | v1 现状 |
|---|---|---|
| `kb/` | 知识库本体（将来 SQLite 库文件、WAL、附件） | **占位**：现在数据还在 localStorage（见 `kb/README.md`） |
| `logs/` | 应用日志、崩溃转储（`logs/crashes/`） | 已接：`app.setPath('logs')` 指到这里 |
| `cache/` | 可随时删除的缓存（索引、缩略图） | 预留空目录，尚无写入者 |
| `plugins/` | 插件宿主落盘的位置（每个插件一个子目录） | 预留空目录，尚无写入者 |
| `backups/` | 库的自动备份轮转 | 预留空目录，尚无写入者 |
| `tmp/` | 临时文件（导入中间产物等） | 预留空目录，尚无写入者 |

**除 `logs/` 外，v1 里只有 `kb/` 有明确语义**；其余四个是**先把形状占住**，
免得将来接内核/插件时又要在用户的机器上"搬家"。

本文件与 `kb/README.md` **只在文件不存在时才写入**，你自己改过的内容不会被覆盖。

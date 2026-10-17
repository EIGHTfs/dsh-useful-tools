# dsh-useful-tools · DSH 有用小工具箱

小工具集合插件。首个工具：**文件观测标记**——解决官方原生 write/edit 的
「cannot modify "…": file has not been read」门禁误伤（内容明明已经用 grep/脚本等
方式看过，原生写仍要求先用 read 工具读一遍）。

## 用法一览（撤销是参数，不是另一个工具）

一个工具双向用法：不带 undo = 增加；undo:true = 撤销；all:true 作用于标记台账。

## 开发者能力（本插件自带）

- `sync_plugin` 工具 / `/sync-plugin` 指令：把本插件工作区代码同步到 profile 的 local-plugins（缺省 dryRun，`--write` 真写；软链布局下免重启热重载）——由原 dsh-git-push 的 sync-plugin.mjs 收编而来
- `assets/dsh-plugin-minihost.mjs` + `dsh-plugin-minihost-child.mjs`：通用插件 minihost（模拟装配 / dev 直通），散落各处的副本归拢于此；用到 minihost 的插件建议改为引用本插件能力

## 功能

| 工具 | 作用 |
|---|---|
| `mark_read` | 把文件标记为已读（按宿主同一 recipe 补发 `fs/observed`）⇒ 之后原生 write/edit 可直接改 |
| `unmark_read` | 反向撤回：让原生写对该文件恢复「必须先读」门禁 |
| 自动标记钩子 | 对配置集合里的工具（默认 `grep`）执行后自动补发观测，无需手动 mark |

## 用法

```
mark_read  paths: "/volume1/xx/a.js,/volume1/xx/b.js"   # 逗号分隔一次多个
mark_read undo:true file_path: "/volume1/xx/a.js"      # 撤销单个文件
mark_read undo:true all:true                           # 全部还原成宿主原生状态
```

## 配置（设置 → 插件 → DSH 有用小工具）

- `observeHook`：自动标记钩子总开关（默认开）
- `observeTools`：读命令集合（逗号分隔，默认 `grep`）——**填什么、什么就生效**，改动即时生效无需重启

## 语义与边界（实测结论）

- 观测**有效到文件版本再变为止**：版本不变一直放行；文件被任何一方改动后，
  原生写改为报 `file changed since it was read — re-read the file, then retry`，重新标记即可。
- 官方 read 带 offset/limit 只看几行同样算读过 ⇒ 把 grep 纳入与宿主自身尺度一致，不算放权。
- `bash` 里 `cat`/`sed` 等无法可靠判定读了哪些文件，**不建议**加入命令集合。
- 单次调用最多标记 40 个文件（防全仓 grep 观测风暴）。

## 安装

DSH 0.2.1-alpha.2+。装好后需重启 DSH 生效（工具与钩子在启动时装配）。

另有斜杠命令 `/mark-read [--undo] [--all] <路径…>`（结果只给界面，不进模型历史）。

## 目录结构（按功能域划分 · 命名规范）

三个功能互相独立，各自一个目录，统一命名规范：

| 功能域 | 目录 | 工具（toolcall） | 指令（斜杠命令） | 核心文件 |
|---|---|---|---|---|
| 文件已读标记 | `lib/mark-read/` | `mark_read` | `/mark-read` | `observe.js`（补发+台账）· `hook.js`（自动标记钩子） |
| 插件同步 | `lib/plugin-sync/` | `sync_plugin` | `/sync-plugin` | `tools.js` · `sync-plugin.mjs`（CLI 同款）· `install.mjs` · `fsx.js` |
| mini 宿主 | `lib/minihost/` | `minihost_start/call/stop/list` | `/minihost` | `tools.js` · `host.mjs`（主）· `host-child.mjs`（每请求子进程） |

命名规范：**目录 = 功能域 kebab-case；工具 = 域名_动词；指令 = 域名-动词；文件按角色命名**（tools/host/hook/observe）。
入口 `lib/index.js` 只做装配（逐域 register*），不含业务逻辑。

数据/运行时产物统一落 `.minihost/`（pid 台账与日志，git 忽略）。

## 预览页（统一管理 · 主题插件除外）

```
通用件（本插件）  lib/preview/：DSH 根与 DSH_HOME 自探测 · React UMD 缓存 · 单文件 HTML 壳
                  · 静态服务 + /api 反代 · 进程台账（.preview/instances.json）
插件自持          assets/preview.spec.mjs（垫片 harness / 假数据 / 首屏注入 post / 输出路径）
                 └ 默认字段：{ title, css, harness, body, post, client, output }
主题插件          允许完全自持预览（皮肤注入与真实渲染强耦合，不走本工具）
```

```bash
# 工具
preview_gen   { plugin: "<插件根>", spec?, out? }      # 生成单文件 preview.html（内联 React UMD）
preview_serve { file: "<preview.html>", port?, backend? }  # 起服务；给 backend 则 /api/* 反代真实后端
preview_stop  { port | file } · preview_list {}
# 指令
/preview gen <插件根> · /preview serve <html> [端口] [backend] · /preview stop <端口> · /preview list
```

实测（2026-10-17）：夹具插件 gen 产出 1.14MB 单文件 → serve 200 → 页面含预期标记 → stop 清台账 ✓。

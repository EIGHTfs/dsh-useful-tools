# dsh-useful-tools · DSH 有用小工具箱

小工具集合插件。首个工具：**文件观测标记**——解决官方原生 write/edit 的
「cannot modify "…": file has not been read」门禁误伤（内容明明已经用 grep/脚本等
方式看过，原生写仍要求先用 read 工具读一遍）。

## 用法一览（撤销是参数，不是另一个工具）

一个工具双向用法：不带 undo = 增加；undo:true = 撤销；all:true 作用于标记台账。

## 开发者能力（本插件自带）

- `sync_plugin` 工具：把本插件工作区代码同步到 profile 的 local-plugins（缺省 dryRun，`--write` 真写；软链布局下免重启热重载）——由原 dsh-git-push 的 sync-plugin.mjs 收编而来
- `assets/dsh-plugin-minihost.mjs` + `dsh-plugin-minihost-child.mjs`：通用插件 minihost（模拟装配 / dev 直通），散落各处的副本归拢于此；用到 minihost 的插件建议改为引用本插件能力

## 功能

| 工具 | 作用 |
|---|---|
| `mark_read` | 把文件标记为已读（按宿主同一 recipe 补发 `fs/observed`）⇒ 之后原生 write/edit 可直接改 |
| `mark_read（undo:true）` | 反向撤回：让原生写对该文件恢复「必须先读」门禁 |
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

本插件只注册工具，不提供斜杠指令（宿主 `commands.register` 要求 `input` 必须带非空 `hint`，
同名指令的收益低于维护成本；要恢复时按该契约补 `input.hint` 即可）。

## 目录结构（目录即工具名 · 一个文件夹一个工具）

```
lib/
├── index.js                 装配入口：扫描 lib/shared/* 动态注册（工具名取文件夹名）
├── shared/                  工具适配层 —— 新增工具只需新建一个文件夹，不必改装配
│   ├── mark_read/index.js    → 工具 mark_read
│   ├── sync_plugin/index.js  → 工具 sync_plugin
│   ├── minihost/index.js     → 工具 minihost   （action=start|call|stop|list）
│   └── preview/index.js      → 工具 preview    （action=gen|serve|stop|list）
└── core/                    共享实现（不含注册逻辑）
    ├── mark-read/           观测补发 + 台账 + 自动标记钩子
    ├── plugin-sync/         同步实现（CLI 同款）+ profile 探测 + 原子拷贝
    ├── minihost/            主进程 host.mjs + 每请求子进程 host-child.mjs
    └── preview/             DSH 根/UMD 自探测 + 单文件 HTML 壳 + 静态服务（含 /api 反代）
```

**三条约定**：

1. **目录即工具名**：`lib/shared/<名字>/index.js` 导出的工具就叫 `<名字>`，装配层不写死任何工具；
2. **一个文件夹只对应一个工具**：同一功能域的多种动作收进 `action` 参数（如 `minihost` 的 start/call/stop/list），不拆成多个工具；
3. **功能全部参数化**：路径集合、开关、动作、目标 profile 等一律走参数，代码里不留"某个插件专属"的分支。

新增工具：新建 `lib/shared/<名字>/index.js` 导出 `{ description, parameters, run }` 即可自动生效。

## 预览页（统一管理 · 主题插件除外）

```
通用件（本插件）  lib/preview/：DSH 根与 DSH_HOME 自探测 · React UMD 缓存 · 单文件 HTML 壳
                  · 静态服务 + /api 反代 · 进程台账（.preview/instances.json）
插件自持          assets/preview.spec.mjs（垫片 harness / 假数据 / 首屏注入 post / 输出路径）
                 └ 默认字段：{ title, css, harness, body, post, client, output }
主题插件          允许完全自持预览（皮肤注入与真实渲染强耦合，不走本工具）
```

```bash
# 工具（一个 preview 工具，动作走 action 参数）
preview { action: "gen",   plugin: "<插件根>", spec?, out? }        # 生成单文件 preview.html（内联 React UMD）
preview { action: "serve", file: "<preview.html>", port?, backend? } # 起服务；给 backend 则 /api/* 反代真实后端
preview { action: "stop",  port | file }
preview { action: "list" }
```

实测（2026-10-17）：夹具插件 gen 产出 1.14MB 单文件 → serve 200 → 页面含预期标记 → stop 清台账 ✓。

## 版本记录

| 版本 | 变更 |
| --- | --- |
| 0.1.2 | 移除斜杠指令：宿主 `commands.register` 要求 `input` 必须带非空 `hint`，原实现传 `input: { type: 'string' }` 使四条指令全部注册失败；该功能收益低于维护成本，直接移除，只保留工具。README 里的工具名同步为实际注册名（`mark_read` / `sync_plugin` / `minihost` / `preview`）。 |
| 0.1.1 | 修复装配入口 `apply` 返回普通对象的问题：cordis 把 apply 返回值当 effect 收集，普通对象会抛 `TypeError: Invalid effect`，整条插件 fiber 随即卸载，四个工具全部不注册。改为只写日志、不返回值。 |
| 0.1.0 | 首个版本：`mark_read` / `sync_plugin` / `minihost` / `preview` 四工具 + 自动标记钩子。 |

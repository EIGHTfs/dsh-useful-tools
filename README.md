# dsh-useful-tools · DSH 有用小工具箱

小工具集合插件。**mark_read** 配置「读命令集合」——哪些命令（cat/grep/head/sed/awk…）读过的文件算已读，
解决官方原生 write/edit 的「cannot modify "…": file has not been read」门禁误伤
（内容明明已经用 grep/脚本等方式看过，原生写仍要求先用 read 工具读一遍）。

## 功能

| 工具 | 参数 | 简介 |
|---|---|---|
| `mark_read` | `commands` `undo` | 配置**读命令集合** + **自动标记钩子**（两者是同一功能）。`commands` 写命令串 / 传文件路径 / 不传用预置清单（`lib/core/mark-read/read-commands.json`）；`undo:true` 撤销。**两种读法都算**：① 宿主工具（如 `grep` 工具）；② `bash` 里跑的命令（`cat a.txt`、`grep x b.txt`）。跨平台别名归一：`Get-Content`/`gc`/`type`/`more` → cat，`Select-String`/`sls`/`findstr` → grep。集合里的命令执行后，钩子（`tools/post-execute`）自动把它读过的**所有文件**补发观测，不用指定文件；配置落盘 `<DSH_HOME>/useful-tools/config.json`、每次现读 ⇒ 配置一次永久有效 |
| `sync_plugin` | `write` `profile` `source` `dshHome` `pluginName` `register` | 把插件工作区代码同步到 profile 的 local-plugins。缺省 dryRun，`write:true` 真写；`register:true` 写 profile 的 dependencies + bundles 并注册；`dshHome` 缺省当前实例，指向测试环境即可装进去 |
| `minihost` | `action` `plugin` `port` `path` `method` `body` `services` | **后端模拟**：本地 mini 宿主，把插件服务端代码跑起来。`action=start`（启动）/ `stop`（停止）/ `status`（状态）/ `call`（请求）；`services` 可注入宿主服务（插件依赖 storageDomain/sessions 等真实服务时用） |
| `preview` | `action` `plugin` `spec` `out` `file` `port` `backend` | **前端模拟**：插件预览页。`action=gen`（生成，无 spec 时自动挂载插槽组件）/ `serve`（启动，`backend` 可反代真实后端或 minihost）/ `stop` / `status` |
| `verify_plugin` | `plugin` `source` `profile` `log` | 验证任意 DSH 插件是否装载成功、工具是否注册（只静态分析，不执行插件代码）。`plugin` 传插件名或根目录，缺省巡检所有已装插件 |
| `test_env` | `action` `kind` `version` `root` `force` `plugin` `pluginName` `dir` `dshBin` | 测试环境（隔离实例）：`action=create`（创建）/ `start`（启动）/ `stop`（停止）/ `status`（状态）。独立 DSH_HOME + 自动端口，随便崩不碰主实例 |

## 用法

```
mark_read commands: "cat,grep,head"        # 加入读命令集合（持久生效）
mark_read                                   # 不传 commands = 用预置清单（20 个常见读文件命令）
mark_read commands: "/tmp/cmds.txt"         # 从文件读命令集合（每行/逗号一个）
mark_read commands: "grep" undo: true       # 撤销 grep（从集合移除）

verify_plugin plugin: "dsh-git-push"        # 验单个插件（也可传插件根目录）
verify_plugin                               # 巡检所有已装插件
```

`mark_read` 的语义是**配置「哪些命令算读」**，不是逐个标记文件：集合里的命令执行后，
它读过的**所有文件**自动补发观测（`tools/post-execute` 钩子），不需要指定文件——要指定文件直接 `read` 就行。
集合落盘到 `<DSH_HOME>/useful-tools/config.json`，钩子每次现读，所以**配置一次、永久有效**（改完即时生效、重启仍在）。

`verify_plugin` 给三项证据，专治「装完插件发现工具没出现」：

1. **装配结构**（静态读源码）：入口是否存在、是否导出 `apply`、是否有 tools 注册调用、
   `apply` 顶层是否 `return {`（cordis 会判 `Invalid effect` 并卸载整条 fiber，工具全部失效）、
   `cordis.patch.yml` 是否有顶层 `- insert:`。入口用 `export *` 转出的会跟进去看。
2. **部署一致性**：源码根 vs profile 的 local-plugins/node_modules 副本逐文件比内容，
   不一致说明宿主跑的不是你改的代码。
3. **宿主日志**：扫 `did not activate` / `TypeError` 等行；日志早于源码最后修改时间的
   判为修复前的历史记录，降级为提示。

只读文件、不 import 被验证插件——插件模块顶层和 `apply` 都可能带副作用，验证不该把它跑起来。
代价是「注册是否真的成功」仍需宿主内实测（工具是否真的出现在工具清单里），输出里的 `staticOnly`/`notes` 会标注这一点。

## 前后端模拟链路

`minihost` 是**后端模拟**，`preview` 是**前端模拟**，两者通过 `serve` 的 `backend` 参数串成一条链，
全程不碰真实后端：

```
minihost { action: "start", plugin: "<插件根>", port: 31177 }          # ① 起后端（插件服务端代码）
preview  { action: "gen",   plugin: "<插件根>" }                        # ② 生成前端预览页（无 spec 时自动挂载插槽组件）
preview  { action: "serve", file: "<插件根>/assets/preview.html", backend: "http://127.0.0.1:31177" }
                                                                        # ③ 起前端，/api/* 打到 ①
minihost { action: "status" } · preview { action: "status" }            # 查状态
minihost { action: "stop", port: 31177 } · preview { action: "stop", port: 31188 }
```

### minihost 的两个细节

- **路由匹配只看路径**：`/api/xxx?fromIndex=true` 按 `/api/xxx` 匹配，query 留给 handler 自己解析
  （旧实现拿含 query 的完整 URL 比对，任何带参数的接口都会 404）。
- **宿主服务注入**：插件接线依赖真实服务（`storageDomain` / `sessions` / `workspaceRegistry` 等）时，
  传 `services` 指向一个模块——该模块默认导出一个「服务对象」或「返回服务对象的函数」，注入项覆盖同名默认服务：

```
minihost { action: "start", plugin: "<插件根>", port: 31177, services: "<插件根>/test/api/helpers/fake-services.mjs" }
```

`backend` 也可以指向真实 DSH 后端（如 `http://127.0.0.1:30800`），此时是「前端模拟 + 真实后端」。

## 测试环境（隔离实例）

起一个与主实例完全隔离的 DSH：独立 `DSH_HOME`、独立端口（3083-3182），里面随便装插件、随便改、随便崩。

```
test_env { action: "status" }                                    # 看两个环境（test/clean）是否存在/运行
test_env { action: "create", plugin: "<插件根>" }                # 创建 <工作区>/<版本>@Save-test 并把插件装进去
test_env { action: "start",  plugin: "<插件根>" }                # 创建（若无）并启动，返回端口
test_env { action: "stop" }                                      # 停止（按端口记录找进程 TERM）
```

`plugin` 可选：给了就把该插件复制进 `profiles/web/node_modules` 并注册到 bundle 列表；不给就是纯裸环境。
环境根优先级：参数 `root` > 环境变量 `DSH_TEST_ENV_ROOT` > 插件配置 `<DSH_HOME>/useful-tools/config.json` 的 `testEnvRoot` > 推算（`DSH_WORKSPACE` / `DSH_HOME` 上一级「工作区」）。**不写死路径**，部署方按配置决定位置。

配合 `sync_plugin` 可以把插件同步 + 注册进这个隔离环境（`dshHome` 指向环境目录即可，缺省是当前实例）：

```
sync_plugin { write: true, register: true, dshHome: "<环境目录>" }
```

## 配置（`<DSH_HOME>/useful-tools/config.json`）

```json
{
  "observeHook": true,
  "observeTools": ["cat", "grep", "head", "sed", "awk"],
  "testEnvRoot": "<可选，test_env 的环境根>"
}
```

- `observeHook`：自动标记钩子总开关（默认开）
- `observeTools`：读命令集合——**填什么、什么就生效**；钩子每次现读，改动即时生效无需重启
- 也可以直接用 `mark_read` 工具改这个集合（`commands` 加入 / `undo` 撤销）
- 预置清单：`lib/core/mark-read/read-commands.json`（20 个常见读文件命令）

## 语义与边界（实测结论）

- 观测**有效到文件版本再变为止**：版本不变一直放行；文件被任何一方改动后，
  原生写改为报 `file changed since it was read — re-read the file, then retry`，重新标记即可。
- 官方 read 带 offset/limit 只看几行同样算读过 ⇒ 把 grep 纳入与宿主自身尺度一致，不算放权。
- **bash 里跑的命令也算读**（0.1.13 起）：钩子解析命令串（`cat a.txt`、`grep x b.txt`），
  命令名在集合里就标记其文件参数；跨平台别名归一（`Get-Content`/`gc`/`type` → cat，`Select-String`/`sls`/`findstr` → grep）。
  已知边界：`xargs`、`$(...)`、`for` 循环里的文件参数提取不到（启发式解析）。
- 单次钩子调用最多标记 40 个文件（防全仓 grep 观测风暴）。

## 安装

DSH 0.2.1-alpha.2+。装好后需重启 DSH 生效（工具与钩子在启动时装配）。

本插件只注册工具，不提供斜杠指令（原因与恢复条件见契约 C-204）。

## 文档

| 文件 | 内容 |
| --- | --- |
| `README.md` | 门面：简介、工具表、用法、配置、安装、目录结构、版本记录 |
| `docs/CONTRACT.md` | 契约：命名 / 装配 / 部署 / 依赖 / 验证 / 测试 / 版本的硬约束，实现与验收的唯一依据 |
| `docs/NOT-DONE.md` | 未实现能力与原因（预览页截图 / 自包含快照 / shell 启动器），含未来若做的形态 |

## 目录结构（目录即工具名 · 一个文件夹一个工具）

```
lib/
├── index.js                 装配入口：扫描 lib/shared/* 动态注册（工具名取文件夹名）
├── shared/                  工具适配层 —— 新增工具只需新建一个文件夹，不必改装配
│   ├── mark_read/index.js    → 工具 mark_read
│   ├── sync_plugin/index.js  → 工具 sync_plugin
│   ├── minihost/index.js     → 工具 minihost   （action=start|call|stop|list|status）
│   ├── preview/index.js      → 工具 preview    （action=gen|serve|stop|list|status）
│   ├── verify_plugin/index.js → 工具 verify_plugin（验证任意插件的装载与工具注册，只静态分析）
│   └── test_env/index.js     → 工具 test_env（测试环境：create/start/stop/status）
└── core/                    共享实现（不含注册逻辑）
    ├── mark-read/           观测补发 + 台账 + 自动标记钩子
    ├── plugin-sync/         同步实现（CLI 同款）+ profile 探测 + 原子拷贝 + 注册
    ├── minihost/            主进程 host.mjs + 每请求子进程 host-child.mjs
    ├── preview/             DSH 根/UMD 自探测 + 单文件 HTML 壳 + 静态服务（含 /api 反代）
    ├── verify-plugin/       静态分析（入口/apply/注册调用）+ 部署一致性 + 宿主日志
    └── test-env/            隔离实例：环境骨架 / 启停 / 端口探测 / 状态
```

**设计契约**：命名、装配、部署、依赖、验证、测试、版本等硬约束见 [docs/CONTRACT.md](docs/CONTRACT.md)
（实现与验收的唯一依据）。新增工具只需新建 `lib/shared/<名字>/index.js` 并导出 `{ description, parameters, run }`。

## 预览页（统一管理 · 主题插件除外）

```
通用件（本插件）  lib/core/preview/：DSH 根与 DSH_HOME 自探测 · React UMD 缓存 · 单文件 HTML 壳
                  · 静态服务 + /api 反代 · 进程台账（.preview/instances.json）· 通用自动挂载垫片
插件自持          assets/preview.spec.mjs（可选增强：自定义垫片 harness / 假数据 / 首屏注入 post / 输出路径）
                 └ 默认字段：{ title, css, harness, body, post, client, output }
主题插件          允许完全自持预览（皮肤注入与真实渲染强耦合，不走本工具）
```

```bash
# 工具（一个 preview 工具，动作走 action 参数）
preview { action: "gen",   plugin: "<插件根>", spec?, out? }        # 生成单文件 preview.html（无 spec 时自动挂载插槽组件）
preview { action: "serve", file: "<preview.html>", port?, backend? } # 起服务；给 backend 则 /api/* 反代真实后端
preview { action: "stop",  port | file }
preview { action: "status" }                                        # 存活实例（等价 list）
```

实测（2026-10-17）：dsh-session-conductor 无 spec → gen 1.28MB → serve 200 → `#root` 渲染出真实界面（5 个插槽、0 错误）；
dsh-skill-scoreboard 修复 TDZ 后同样渲染成功。

## 版本记录

| 版本 | 变更 |
| --- | --- |
| 0.1.13 | `mark_read` 支持 `bash` 里跑的命令：钩子解析命令串（`cat a.txt`、`grep x b.txt`），命令名在集合里就标记其文件参数——`cat` 不再必须写成宿主工具。命令名做**跨平台别名归一**：`Get-Content`/`gc`/`type`/`more`→cat，`Select-String`/`sls`/`findstr`→grep，去 `.exe`/`.cmd`/`.bat`/`.ps1` 后缀。实测：`bash cat c.txt` 后直接 edit 成功。 |
| 0.1.12 | `mark_read` 重做：语义从「按文件标记」改为「**读命令集合**」——两个参数 `commands`（命令串，或传文件路径从文件读，不传用预置清单 `read-commands.json`）+ `undo`（撤销）；集合里的命令读过的**所有文件**自动生效。配置落盘 `<DSH_HOME>/useful-tools/config.json`，钩子每次现读 ⇒ 命令配置一次、永久有效（改完即时生效、重启仍在）。移除 `paths` / `file_path` / `all`（要指定文件直接 `read`）。 |
| 0.1.11 | `preview` 自动挂载修复 TDZ：`__ModuleLoader__.load` 只登记 entry，`factory` 统一延迟到 `setTimeout(0)`（client.js 整体执行完之后）再调用。实测 dsh-skill-scoreboard：修复前无插槽可渲染，修复后 `#root` 渲染出真实界面。 |
| 0.1.10 | `minihost` 两处修复/增强：① 路由匹配只看 pathname（`/api/x?y=1` 不再 404）；② 新增 `services` 参数注入宿主服务。实测：`/templates?x=1` 由 404→200；注入 storageDomain 后 `/templates` 由 500→200 真实数据。 |
| 0.1.9 | 测试环境根改为**配置驱动**：参数 `root` > `DSH_TEST_ENV_ROOT` > 插件配置 `<DSH_HOME>/useful-tools/config.json` 的 `testEnvRoot` > 推算。环境目录为 `<根>/<版本>@Save-test`，部署方按配置决定位置，不写死代码路径。 |
| 0.1.8 | 新增 `test_env` 工具：测试环境（隔离实例）create/start/stop/status，独立 DSH_HOME + 自动端口（3083-3182），路径全由参数/环境决定。`sync_plugin` 增加 `dshHome`（缺省当前实例）、`pluginName`、`register`（写 profile 的 dependencies + bundles，并对齐 node_modules 副本），可把插件直接装进隔离实例。实测：同步 34 文件 + 注册成功，实例启动 `ready:true`、无 failed to import。 |
| 0.1.7 | `preview gen` 无 spec 时改为**通用自动挂载**：mock `window.__ModuleLoader__` / `require` / `ctx`（slots / locale / effect），调插件 `apply(ctx)`，把 `slots.register(def, component)` 捕获到的组件 `createRoot().render()` 到 `#root`。实测 dsh-session-conductor（无 spec）：`#root` 1 个子节点 / 1378 字符 / 捕获 5 个插槽 / 0 错误 / 中文文案正常。spec 从此是可选的增强（自定义 mock 与首屏注入），不再是必填。 |
| 0.1.6 | `preview gen` 支持无 spec 兜底：插件没有 `assets/preview.spec.mjs` 时按默认垫片生成页面，返回带 `note`；显式传入不存在的 spec 路径仍报错，不静默降级。 |
| 0.1.5 | 启停状态统一走工具参数：`preview` 与 `minihost` 新增 `status`（等价 `list`，语义直白，旧名保留）。新增 [docs/NOT-DONE.md](docs/NOT-DONE.md) 记录三项未实现能力（预览页截图、自包含快照、shell 启动器）的评估结论与不做原因。 |
| 0.1.4 | 契约独立成文：[docs/CONTRACT.md](docs/CONTRACT.md)（编号 C-101~C-703，含命名/装配/部署/依赖/验证/测试/版本）。README 只保留门面与文档索引，契约细节改为引用，不再两处重复。`docs/` 纳入同步清单。 |
| 0.1.3 | 新增 `verify_plugin`：验证任意 DSH 插件的装载与工具注册（装配结构静态分析 + 部署一致性 + 宿主日志；只读文件、不执行被验证插件的代码），支持传插件名或根目录，缺省巡检所有已装插件。 |
| 0.1.2 | 移除斜杠指令：宿主 `commands.register` 要求 `input` 必须带非空 `hint`，原实现传 `input: { type: 'string' }` 使四条指令全部注册失败；该功能收益低于维护成本，直接移除，只保留工具。README 里的工具名同步为实际注册名（`mark_read` / `sync_plugin` / `minihost` / `preview`）。 |
| 0.1.1 | 修复装配入口 `apply` 返回普通对象的问题：cordis 把 apply 返回值当 effect 收集，普通对象会抛 `TypeError: Invalid effect`，整条插件 fiber 随即卸载，四个工具全部不注册。改为只写日志、不返回值。 |
| 0.1.0 | 首个版本：`mark_read` / `sync_plugin` / `minihost` / `preview` 四工具 + 自动标记钩子。 |

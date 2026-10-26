# dsh-useful-tools · DSH 有用小工具箱

小工具集合插件。**mark_read** 让指定命令（cat/grep/head/sed/awk…）读过的文件自动算已读，
解决官方原生 write/edit 的「cannot modify "…": file has not been read」门禁误伤
（内容明明已经用 grep/脚本等方式看过，原生写仍要求先用 read 工具读一遍）。

## 功能

| 工具 | 参数 | 简介 |
|---|---|---|
| `mark_read` | `commands` `undo` | 配置**读命令集合** + **自动标记钩子**（两者是同一功能）。`commands` 写命令串 / 传文件路径 / 不传用预置清单（`lib/core/mark-read/read-commands.json`）；`undo:true` 撤销。**两种读法都算**：① 宿主工具（如 `grep` 工具）；② `bash` 里跑的命令（`cat a.txt`、`grep x b.txt`）。跨平台别名归一：`Get-Content`/`gc`/`type`/`more` → cat，`Select-String`/`sls`/`findstr` → grep。集合里的命令执行后，钩子（`tools/post-execute`）自动把它读过的**所有文件**补发观测，不用指定文件；配置落盘 `<DSH_HOME>/useful-tools/config.json`、每次现读 ⇒ 配置一次永久有效 |
| `mark_edit` | `paths` `undo` `settleMs` | **编辑后标记**（`mark_read` 的另一半，同样**落盘持久、可撤销**）：把「我刚改过这些文件」按**当前磁盘版本**补发给宿主（官方同一条 `fs/observed` 通道 + `fs.stat()` 现取 version），之后 `write`/`edit` 不必重读全文。**清单落盘**（`config.json` 的 `editPaths`，跨重启有效）；**不传 `paths` = 用清单续期**（对应 `mark_read` 不传 `commands` 用预置清单）。标记过的路径在每次被 `write`/`edit` 改动后**自动续期**（延迟 150ms 等时间戳写稳再补发一次），因此连续编辑也无需重读。`settleMs` 可选延迟毫秒（等 CIFS 时间戳写稳，上限 2000）；`undo:true` 撤销（从清单移除 + 补发对不上的版本，重新要求先读）。**不读文件内容**——只在自己确实经手写入时用 |
| `quick_command` | `action` `name` `command` `cwd` `description` `timeoutMs` | **快捷命令**：执行/管理 `<DSH_HOME>/useful-tools/quick-commands.json` 里定义的命令。`action=run`（缺省，按 `name` 执行；同时传 `command` 会**先持久化再执行**，等效 add 后执行）/ `add` / `edit` / `delete` / `list`（列出所有名字+命令）。`cwd` 指定执行目录（缺省空 = 宿主进程 cwd）。**无内置预置**：定义完全来自该文件，首次是空表；重启 DSH 这类命令由使用方自己 `add` |
| `sync_plugin` | `write` `profile` `source` `dshHome` `pluginName` `register` | 把插件工作区代码同步到 profile 的 local-plugins。缺省 dryRun，`write:true` 真写；`register:true` 写 profile 的 dependencies + bundles 并注册；`dshHome` 缺省当前实例，指向测试环境即可装进去。**写盘后自动**：权限/属主对齐（目录 755 / 文件 644，属主对齐 profile）+ 读权限自检 + 依赖体检（`file:` 路径失效会明确报出） |
| `patch_cifs_write` | `action` `dryRun` `file` `packageRoot` `probeDir` | **给官方写/编辑工具打 CIFS 补丁**：CIFS/SMB 不实现 POSIX chmod，官方写入实现 `writeFileAtomic()` 在「chmod 临时目录」这步就抛 `EPERM`，导致 `write`/`edit` 在挂载盘上一次都写不进去（目录其实是可写的，极易误判成权限问题）。本工具把三处 chmod 包成「尽力而为」：只吞 EPERM/ENOTSUP/EOPNOTSUPP，其它错误照常抛，**rename 与原子性完全不动**。`action=check`（缺省，只读检测：定位文件 / 是否已打 / chmod 是否真不可用）/ `apply`（备份 → 替换 → `node --check` 校验；`dryRun` **缺省 true**，要真改传 `false`）/ `revert`（还原备份）。打完**必须重启 DSH** 才生效；DSH 升级会覆盖补丁，升级后重跑 `apply` |
| `minihost` | `action` `plugin` `port` `path` `method` `body` `services` `env` `force` | **后端模拟**：本地 mini 宿主，把插件服务端代码跑起来。`action=start`（启动）/ `stop`（停止）/ `status`（状态）/ `call`（请求）；`services` 可注入宿主服务（插件依赖 storageDomain/sessions 等真实服务时用）。**默认隔离 `DSH_HOME`**（写到 `.minihost/home-<port>`，不碰真实会话/附件库），需要贴近真实环境时用 `env: { DSH_HOME: "<真实 .dsh>" }` 覆盖。内置 `webServer`/`tools`/`storageDomain`/`sessions` 宽容桩；`force:true` 在已有实例时按新参数重启；404 会带原因提示 |
| `preview` | `action` `plugin` `spec` `out` `file` `port` `backend` `host` `lan` | **前端模拟**：插件预览页。`action=gen`（生成，**`preview.spec.mjs` 可选**——不写走通用自动挂载，标题默认取插件目录名；产物在插件内且未忽略时会提示入库风险）/ `serve`（启动，**`backend` 可省略**——自动沿用最近一次 minihost 实例并返回 `backendSource`；也可显式指真实 DSH 后端；`host=0.0.0.0` 或 `lan:true` 供局域网）/ `stop` / `status`。页面顶部内置错误面板（运行期错误直接可见） |
| `verify_plugin` | `plugin` `source` `profile` `log` `ui` | 验证任意 DSH 插件是否装载成功（**只静态分析，不执行插件代码**）：入口/apply/注册调用/effect 形态 + **inject 服务名校验**（拼错给近似建议）+ **激活诊断**（dependencies / bundles / loader 行 / `did not activate` 归类）+ **依赖解析** + **客户端入口与 UI 骨架**（`controls=0` 直接判失败）+ **HMR 覆盖判定** + **DSH 插件规则（9 条，与 dsh-git-push 审计同步维护）** + 部署一致性 + 宿主日志。`plugin` 传插件名或根目录，缺省巡检所有已装插件 |
| `test_env` | `action` `kind` `version` `root` `force` `plugin` `pluginName` `dir` `dshBin` | 测试环境（隔离实例）：`action=create`（创建）/ `start`（启动）/ `stop`（停止）/ `status`（状态）。独立 DSH_HOME + 自动端口，随便崩不碰主实例。`dshBin` 可传 shell wrapper（自动解析到真实 `bin.js`）；启动超时会直接带回日志里的关键错误行 |
| `useful_tools` | `action` `tool` | **本插件工具清单**（动态扫描 `lib/shared`，不维护硬编码列表）：`action=help`（缺省，输出每个工具的名字/说明/参数/示例调用）/ `list`（紧凑清单）；`tool` 可选，只看某一个工具 |
| `ui_check` | `plugin` `file` `out` `write` `limit` | **UI 静态骨架检查**：解析插件 `lib/client.js` 的 React 元素调用，产出「代码里声明了哪些控件」的 HTML 骨架页 + JSON 清单（插槽注册 / 层级 / className / 内联样式 / 来源行号）。`write:false` 只解析不写盘；缺省输出 `<plugin>/assets/ui-skeleton.html` + 同名 `.json`。**静态解析，不代表运行时渲染结果** |

## 用法

```
mark_read commands: "cat,grep,head"        # 加入读命令集合（持久生效）
mark_read                                   # 不传 commands = 用预置清单（20 个常见读文件命令）
mark_read commands: "<命令清单文件路径>"      # 从文件读命令集合（每行/逗号一个）
mark_read commands: "grep" undo: true       # 撤销 grep（从集合移除）

verify_plugin plugin: "dsh-git-push"        # 验单个插件（也可传插件根目录）
verify_plugin                               # 巡检所有已装插件

quick_command restart                       # 执行预置 restart（重启 DSH，当前连接会断）
quick_command list                          # 列出所有快捷名 + 命令
quick_command add name: "logs" command: "tail -n 50 <日志路径>"          # 新增定义（落盘）
quick_command run  name: "logs" command: "tail -n 20 <日志路径>"         # 先持久化（新增或更新）再执行
quick_command edit name: "logs" command: "..."                          # 修改已定义命令
quick_command delete name: "logs"                                       # 删除定义
quick_command run  name: "logs" cwd: "/var/log"                         # 指定执行目录（只对本次生效）

useful_tools                                  # 列出本插件所有工具（名字/说明/参数/示例）
useful_tools action: "list"                   # 紧凑清单
useful_tools tool: "quick_command"            # 只看一个工具
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
preview  { action: "serve", file: "<插件根>/assets/preview.html", backend: "http://<本机IP>:31177" }
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

`backend` 也可以指向真实 DSH 后端（如 `http://<本机IP>:30800`），此时是「前端模拟 + 真实后端」。

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

## 快捷命令（quick_command）

定义存 `<DSH_HOME>/useful-tools/quick-commands.json`，形如：

```json
{
  "restart": {
    "command": "nohup sh -c 'sleep 2; \"/path/to/start.sh\" restart' >/dev/null 2>&1 &",
    "description": "重启 DSH 主实例"
  },
  "logs": { "command": "tail -n 50 /path/to/dsh.log", "description": "看最近日志" }
}
```

- **无内置预置**：文件不存在时是空表（`list` 返回 `count:0` 并提示用 `add`），定义完全由使用方创建。
  例如本机重启 DSH：
  `add name:"restart" command:"nohup sh -c 'sleep 2; /var/packages/DeepSeekHarness-NAS/target/start.sh restart' >/dev/null 2>&1 &"`
  （后台化以免重启杀掉进程后拿不到结果；该形态仅 Linux/macOS，Windows 换对应重启命令）。
- `run` 只执行 JSON 里已定义的命令；**同时传 `command` 时先写入 JSON（新增或更新）再执行**，不是临时执行。
- `cwd` 指定执行目录：缺省空 = 沿用**宿主进程的 cwd**（不一定是当前工作区）；
  传了会校验「存在且是目录」，并解析成绝对路径。`add`/`edit`/`run` 带 `command` 时随定义落盘，
  `run` 单独传 `cwd` 只对本次执行生效、不改已有定义。
- 执行走 `bash -c`（Windows `cmd /c`），默认超时 60 秒，stdout/stderr 各截断 20000 字符。

## 编辑前为什么会被要求重读（`mark_read` / `mark_edit`）

宿主的 `write` / `edit` 有一道门禁：**改之前必须读过**。台账在 `fs-observation-policy` 里，
按 `actor.agent.session` 记账，每项记录 `targetKey → { kind, version }`；写入时用 CAS 比对
`version`，对不上就报 `file changed since it was read`，要求先读。

而 `version` 的构成是 `dev:ino:size:mtimeNs:ctimeNs`。这里有个实测出来的坑：

> CIFS/SMB 上 **mtime/ctime 会「晚到」**——文件写完之后时间戳还会再变一次（实测 3ms 内：
> `mtime …223135 → …226020`，`ctime …224135 → …226020`，内容未变）。
> 官方 `write`/`edit` 成功后是在 `rename` 之后**立刻** probe 拿版本、再补发观测的，
> 于是它记下的是**稳定前**的值；等到下一次写改时磁盘上已是稳定值 ⇒ CAS 对不上 ⇒ 报 stale。

所以这**不只是**「bash 改过」的问题，同样是**连续编辑**的问题（实测：CIFS 上
`write → edit ✓ → edit ✗`；同一流程在本地盘 `/tmp` 上连编 3 次全过）。重读之所以管用，
是因为 `read` 在时间戳稳定之后才 probe。

本插件用官方同一条通道（`fs/observed` + `fs.stat()` 现取 version）把这个缺口补上：

| 工具 | 补的是什么 | 用法 |
| --- | --- | --- |
| `mark_read` | **读**过的文件（自动） | 配好读命令集合（缺省 `grep`、`cat`），集合里的命令执行后，它读过的文件自动补发观测 |
| `mark_edit` | **写**过的文件（显式，落盘可撤销） | `mark_edit { paths: "a.js,b.js" }`：按当前磁盘版本补发观测并写入持久清单；之后每次被 `write`/`edit` 改动，钩子会**延迟 150ms 自动续期**（取稳定值），所以连续编辑也不用重读；`undo:true` 撤销、恢复「先读再改」 |

实测（CIFS 工作区）：bash 改写文件后 `cat` 一次（`cat` 在集合里）即可编辑；但只标记/只 `cat`
**一次只够一次编辑**——第二次编辑又会 stale，这正是「自动续期」存在的理由。

边界：`mark_edit` **不读文件内容**，它声明的是「我已经知道这份文件现在是什么」。
内容不是自己写的文件，仍应老实 `read`——否则等于自己拆掉门禁。续期钩子只作用于
**你自己标记过的路径**，没标记的文件完全不受影响。

## UI 静态骨架（ui_check）

解析插件的 `lib/client.js`，把「代码里声明了哪些控件」变成可看、可 diff 的产物：

```
ui_check plugin: "<插件根>"                       # 产出 assets/ui-skeleton.html + .json
ui_check plugin: "<插件根>" write: false           # 只解析不写盘
ui_check plugin: "<插件根>" file: "lib/ui.js" out: "/tmp/ui.html"
```

产物两份：

- `ui-skeleton.html`：插槽注册表 + 结构树 + 静态还原预览 + 控件清单，浏览器打开即看
- `ui-skeleton.json`：同一份数据的机器可读版本，控件带 `visible: null`——留给将来的渲染探针填 true/false

**它回答什么、不回答什么**（这个边界决定它不能被误用）：

| 问题 | 能否回答 |
| --- | --- |
| 代码里声明了哪些控件、层级、className、文本 | ✅ 能，带来源行号 |
| 哪个插槽注册了、渲染的是哪个组件 | ✅ 能（组件在文件内定义时还会展开该组件的 UI） |
| 条件分支 / 逻辑与里的元素 | ✅ 能（收进 `conditional` 子树，不漏报） |
| 运行时到底渲染出来没有（TDZ、条件为 false、hooks 报错、map 空数组） | ❌ 不能 |
| 真实外观（主题 CSS 变量、宿主布局约束） | ❌ 不能，只能用内联样式近似 |

所以它是**静态骨架，不是渲染检查**：判断「实际渲染出来没有」仍然需要在真实宿主里看。
将来补渲染探针时，两者共用同一份清单格式（`visible` 字段），可直接 diff 出「声明了但没渲染」的控件。

## 静默失败诊断（verify_plugin 的六段）

插件开发里最难查的不是报错，是**不报错**。verify_plugin 把这类问题逐段列出来：

| 症状 | 检查段 | 判定依据 |
| --- | --- | --- |
| 装了但不激活、apply 没执行 | `activation` | profile 的 dependencies / `dsh.profile.bundles` / 离线组合出的 loader 行，缺哪项报哪项 |
| 服务拿不到、路由 404 | `inject` | 声明的服务名与当前 DSH 安装里实际存在的比对（`super(ctx,'x')` / `inject([...])` / `.get('x')`），拼错给近似建议 |
| import 失败、依赖找不到 | `deps` | 在目标 profile 的 `node_modules` 与 Node 解析里逐个试；`file:` 路径失效单独报 |
| UI 空白、控件没出来 | `client` + `ui` | 有 `dsh.client` 就必须有 `lib/client.js` 且调用 `__ModuleLoader__.load`；UI 骨架 `controls=0` 或插槽 0 节点直接判失败 |
| 改了代码没生效 | `hmr` | 读 profile 的 hmr 配置，判断插件路径是否在 watch 范围 |
| 同步后宿主读不到 | `sync_plugin` 的 `permissions` / `readable` | 写盘后对齐 755/644 与属主，再逐个 `access(R_OK)` |

边界：激活诊断是**离线组合**（profile 的 patch + 各 bundle 的 patch），不启动宿主；运行期真实装配仍以宿主日志为准。

## DSH 插件规则（与 dsh-git-push 审计同步维护）

同一套规则有**两份独立实现**，判定口径相同：

| 位置 | 形态 | 用途 |
| --- | --- | --- |
| `dsh-git-push` 的 `lib/audit-rules/audit-rules-dsh.yml` | 审计规则（提交时拦截） | 逐行扫描改动 |
| 本插件 `lib/core/verify-plugin/dsh-rules.mjs` | 工具检查（`verify_plugin`） | 整仓扫描，并与激活/依赖/UI 检查合并出结论 |

**维护约定**：两个插件**不互相 import**，各自实现；规则增删改必须两边同步，语义保持一致。

| 规则 | 严重度 | 判定 |
| --- | --- | --- |
| `dsh/import-bare-cordis` | error | `import … from 'cordis'` / `require('cordis')` |
| `dsh/import-bare-schemastery` | error | 裸名 `schemastery` |
| `dsh/tool-render-empty-body` | error | `render(…) {}` 或 `return null/undefined` |
| `dsh/client-node-builtin-require` | error | client 半部 require Node 内置模块 |
| `dsh/schema-secret-field-role` | warning | token/secret/apiKey 字段缺 `.role('secret')` |
| `dsh/patch-insert-unique-id` | warning | insert 行 id 与按 id 覆盖行重复 |
| `dsh/client-module-loader-id` | warning | client 入口未走 `__ModuleLoader__` |
| `dsh/ctx-undeclared-property-read` | **blocker** | 读 `ctx.sessionId` 等未注入属性（注释行豁免） |
| `dsh/host-api-guessed-fallback-chain` | error | `addRoute \|\| route` 这类猜测 API 兜底链 |

## CIFS/SMB 挂载下 `write` / `edit` 报 EPERM（`patch_cifs_write`）

**症状**：工作区放在 CIFS 挂载上时，`write` / `edit` 一次都写不进去，报

```
EPERM: operation not permitted, chmod '.../.xxx.tmpdir'
```

而目录明明可写（`ls -ld` 是 `drwxrwxrwx`、`touch` 也成功）——极易误判成权限问题。

**根因**：官方写入实现 `writeFileAtomic()` 的流程是
`mkdir 临时目录 → chmod 0700 → open 临时文件 → chmod 0600 → write → fsync → (可选) chmod 目标 mode → rename 原子替换`。
CIFS/SMB **不实现 POSIX chmod**，第二步就抛 `EPERM`，文件其实还没写进去。

**处置**：`patch_cifs_write` 把三处 chmod 包成「尽力而为」（只吞 EPERM/ENOTSUP/EOPNOTSUPP，
EACCES/ENOENT/EIO 等照常抛），`rename` 与原子性完全不动——只是「权限收紧」这一步降级。

| 步骤 | 调用 | 说明 |
| --- | --- | --- |
| ① 体检 | `patch_cifs_write { action: "check" }` | 只读：定位 `dsh-fs-local/lib/index.js`、是否已打补丁、chmod 是否真的不可用 |
| ② 预演 | `patch_cifs_write { action: "apply" }` | `dryRun` 缺省 `true`，只报计划不落盘 |
| ③ 打补丁 | `patch_cifs_write { action: "apply", dryRun: false }` | 备份 → 替换 → `node --check` 校验 |
| ④ 生效 | 重启 DSH | 官方模块已在宿主 ESM 缓存里，不重启不生效 |
| ⑤ 回滚 | `patch_cifs_write { action: "revert", dryRun: false }` | 从最新备份还原 |

DSH 升级会覆盖这套补丁，**升级后重跑一次 `apply` 即可**（幂等；已打过会直接报告）。

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
| 0.1.29 | `mark_edit` 补齐「永久有效」语义：清单落盘（`config.json` 的 `editPaths`）、不传 `paths` 用清单续期、`undo` 撤销；新增**自动续期钩子**——标记过的路径每次被 `write`/`edit` 改动后，延迟 `settleMs`（缺省 150ms）重新取版本并补发，解决「标记一次只够一次编辑」；文档更正根因：版本串含 `mtimeNs`/`ctimeNs`，CIFS 时间戳晚到导致连续编辑也判 stale（与 `patch_cifs_write` 无关）。 |
| 0.1.28 | 新增 `mark_edit` 工具（`mark_read` 的另一半）：把「我刚改过这些文件」按当前磁盘版本经官方 `fs/observed` 通道补发观测，`write`/`edit` 不必重读全文；`undo` 用哨兵版本恢复「先读再改」门禁。补的是官方补不到的缺口——bash `sed -i` / heredoc 重定向 / `tee`、别的工具或会话写入导致的 `file changed since it was read`。 |
| 0.1.27 | 修 `verify_plugin` 的 DSH 规则自指误报：匹配前先把**注释与字符串内容**遮蔽成等长空格（行号不变），只对「真实代码」匹配，规则 `message` 文案里写出违规写法（如「用 addRoute \|\| route 兜底」）不再触发自己；需要字符串内容的模块名类规则改为「遮蔽视图确认 import/require 结构 → 回原文核对模块名」；并跳过规则定义文件本身。补齐 `patch_cifs_write` 的文档（工具表 + 「CIFS 挂载下报 EPERM」章节；工具本身随 0.1.26 提交，README 当时漏记）。 |
| 0.1.26 | 按 dsh-session-migrate 的实战反馈改 5 处：`preview gen` 说明写明 `preview.spec.mjs` 可选、产物在插件内且未忽略时提示入库风险、页面顶部内置错误面板（运行期错误可见）；`preview serve` 的 `backend` 可省略（自动沿用最近一次 minihost 实例并返回 `backendSource`）；`minihost start` 新增 `env` 参数且**默认隔离 `DSH_HOME`**（写到 `.minihost/home-<port>`，依赖解析用 `--deps` 补回真实 profile）。多挂载点 `mounts[]` 记入 NOT-DONE 待办。 |
| 0.1.25 | 把 dsh-git-push 的 9 条 DSH 插件规则移植到 `verify_plugin`（独立实现，两个插件不互相 import）：裸名 cordis/schemastery、render 空实现、client 引 Node 内置、凭据字段缺 `role('secret')`、patch insert id 冲突、client 未走 `__ModuleLoader__`、ctx 未注入属性（blocker）、猜宿主 API 兜底链。另修激活诊断的 profile 选择：显式指定 > web > 第一个（原先取 `profiles[0]` 会误判到历史 profile）。 |
| 0.1.24 | 按 sub2api 插件开发的实战问题清单增强「静默失败」诊断：`verify_plugin` 新增 inject 服务名校验（拼错给近似建议）、激活诊断（dependencies / bundles / loader 行 / `did not activate` 归类）、依赖解析、客户端入口与 UI 骨架串联、HMR 覆盖判定；`sync_plugin` 写盘后自动对齐权限/属主并做读权限自检 + 依赖体检；`minihost` 内置 storageDomain/sessions 宽容桩、`force` 重启、404 原因提示；`test_env` 支持 shell wrapper 形式的 `dshBin` 并带出超时日志关键行；`ui_check` 增加一行摘要；`useful_tools` help 增加「症状 → 工具」索引。 |
| 0.1.23 | 新增 `ui_check` 工具：静态解析插件 `lib/client.js`，产出 HTML 骨架页 + JSON 控件清单（插槽注册、层级、className、内联样式、来源行号；组件在文件内定义时展开）。支持 `createElement` / `h` / `jsx` / `(0, ns.fn)(…)` 四种写法，排除 `document.createElement`，条件与逻辑表达式里的元素一并收集；清单 `visible: null` 为将来的渲染探针预留。 |
| 0.1.22 | CI 回到固定 `ubuntu-latest` × Node 20/22/24：CI 是门禁，环境固定才稳定；跨平台能力（`cmd /c` 分支、测试不依赖 shell 内置命令）保留在代码里，但 Windows 不挂进每次提交的门禁（其 spawn cwd 与 cmd 引号语义尚未验证，需真实环境单独验证）。 |
| 0.1.21 | `quick_command` 去掉内置预置：定义完全来自 `<DSH_HOME>/useful-tools/quick-commands.json`，首次是空表（`list` 返回 `count:0` 并提示用 add），`restart` 这类本机命令由使用方自己 add。测试入口改为跨平台 runner `node test/run-tests.mjs`（自扫 `*.test.mjs`，不依赖 Node 20 不支持的 glob 与 Windows 不展开的通配符）。 |
| 0.1.20 | `quick_command` 支持 `cwd` 执行目录：缺省空 = 宿主进程 cwd，传了先校验「存在且是目录」并解析成绝对路径；`add`/`edit`/`run` 带 `command` 时随定义落盘，`run` 单独传只对本次生效。跨平台加固：单测不再依赖 shell 内置命令（用 node 打印 cwd）、测试文件统一改名 `*.test.mjs` 用 Node 自身展开 glob，CI 矩阵增加 `windows-latest`。 |
| 0.1.19 | 新增 `useful_tools` 工具：动态扫描 `lib/shared` 输出本插件全部工具（名字/说明/参数/示例调用），`action=help`（缺省）/ `list`，`tool` 可只看单个。另修 `quick_command` 预置命令在探测不到 `start.sh` 时把占位符替换成空串的问题（改为保留 `{startScript}`，执行时报错暴露）。 |
| 0.1.18 | 新增 `quick_command` 工具：快捷命令定义存 `<DSH_HOME>/useful-tools/quick-commands.json`，`action=run`（缺省，按 name 执行；带 command 时先持久化再执行）/ `add` / `edit` / `delete` / `list`（列出所有名字+命令）；预置 `restart` = `start.sh restart`（后台延迟 2 秒，会断开当前连接）。执行走 `bash -c`、默认超时 60 秒、输出截断 20000 字符。 |
| 0.1.17 | 新增单测 CI：`.github/workflows/test.yml`，push 到 master 与所有 PR 触发，Node 20/22/24 矩阵跑 `node --test test/*.mjs`（测试零依赖，无需 npm install）。 |
| 0.1.16 | 修 `sync_plugin` 源目录 bug：缺省 `source` 少上溯两层（停在 `lib/core`），`packageFilesOf` 读不到 `package.json`，每次同步都是「0 文件空操作」却返回 `ok:true`——已改为上溯三层（`tools.js` 用 `fileURLToPath`，`sync-plugin.mjs` 的 `SOURCE_ROOT` 同步修正），实测同步写入 5 文件、副本 README/package.json 一致。另：README 示例地址改 `<本机IP>` 占位（不再写本机回环）；CONTRACT C-402 改为「允许探测候选、环境变量/参数优先且不得作为唯一来源」，C-601 测试数改 5 份，补记 0.1.9/0.1.10/0.1.13 契约更新；sync-plugin 顶部注释与 files 白名单对齐。 |
| 0.1.15 | 修 minihost 启动 TDZ 回归：`host.mjs` 的 `TIMEOUT_MS` 引用了后面才定义的 `DEFAULT_TIMEOUT_MS`（`Cannot access before initialization`），已把常量定义前移；实测 `minihost start` 正常、请求 200。另在 preview/minihost 工具描述里注明「参数定义在实例加载期注册，更新插件后需重载实例」。 |
| 0.1.14 | `preview serve` 支持局域网访问：新增 `host`（缺省仅监听本机回环，可传 0.0.0.0）与 `lan:true`（等价 0.0.0.0）；监听 0.0.0.0 时返回 `lanUrl`（本机第一个非回环 IPv4，如 `http://10.10.31.218:31200/`），原 `url` 保留本机回环地址。实测：`ss` 显示 `0.0.0.0:31200 LISTEN`，局域网与回环均 200。 |
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

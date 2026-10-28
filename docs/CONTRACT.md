# 工具契约（CONTRACT）

本文件是 dsh-useful-tools 的**实现与验收唯一依据**：每条都是可测断言，
实现必须照做；改动契约要显式改本文件并升版本，不允许「代码改了文档没改」。

编号规则：`C-<分组><序号>`。违反后果按「读者感知」写，不写空话。

---

## 1. 工具装配

### C-101 目录即工具名
`lib/shared/<名字>/index.js` 一个目录 = 一个工具，注册名就是 `<名字>`（不带前缀、不做驼峰转换）。
- 依据：`lib/index.js` 的 `listToolDirs()` 扫 `lib/shared/*/index.js`，`name` 取目录名。
- 验证：`ls lib/shared/` 与工具清单逐项对照；当前应为 `mark_read` / `sync_plugin` / `minihost` / `preview` / `verify_plugin` / `test_env`。
- 违反后果：调用方按文档名字调不到工具（历史上 `tool_` / `ut_` 前缀就是这么对不上的）。

### C-102 一个文件夹一个工具，多动作走 `action`
同一功能域的多种动作收进 `action` 参数，不拆成多个工具。
启动 / 停止 / 状态这类生命周期动作同样走 `action`：`status` 与 `list` 同义
（状态查询用 `status` 更直白，旧名保留兼容，不新增工具）。
- 依据：`minihost`（start/call/stop/list/status）、`preview`（gen/serve/stop/list/status）的实现。
- 验证：新增工具时检查 `parameters` 里是否有 `action`；工具总数不应随动作数增长。
- 违反后果：工具清单膨胀，模型选择成本上升。

### C-103 工具模块只导出三件套
`lib/shared/<名字>/index.js` 导出 `{ description, parameters, run }`：
`description` 是字符串，`parameters` 是参数 schema，`run(args, env)` 返回可 JSON 序列化的对象。
- 依据：`lib/index.js` 装配时按这三项构造工具定义。
- 验证：`node -e "import('./lib/shared/x/index.js').then(m=>console.log(Object.keys(m)))"` 应含这三项。
- 违反后果：装配层跳过该工具（日志 warn「未导出 run，跳过」）。

### C-104 装配层零业务逻辑
`lib/index.js` 只做扫描 + 注册，不含任何工具的业务实现；新增工具不需要改它。
- 依据：`lib/index.js` 全文只有目录扫描、注册、钩子挂载、装配摘要日志。
- 验证：新增一个工具后 `git diff lib/index.js` 应为空。
- 违反后果：每加一个工具就改装配层，改动面随工具数线性增长。

### C-105 前后端模拟分工
`preview` 负责**前端模拟**（页面渲染自检），`minihost` 负责**后端模拟**（插件服务端 handler）；
两者通过 `preview serve` 的 `backend` 串起来：前端页面的 `/api/*` 打到 minihost，即完成不碰真实后端的联调。
- 依据：`lib/core/preview/server.js` 的 backend 反代；`lib/core/minihost/host.mjs` 的插件 handler 加载。
- 验证：`minihost start` 后把 `preview serve` 的 `backend` 指向该端口，页面 `/api/*` 应返回 minihost 的响应；
  **省略 `backend` 时**自动沿用台账里最近一次存活的 minihost 实例，并在结果里给出 `backendSource`（如 `minihost:31178`）。
- 违反后果：两个工具各自能跑但串不起来，模拟链路断在前端或后端；自动沿用若不给来源，会静默连错实例。

### C-106 预览页无 spec 兜底（通用自动挂载）
`preview gen` 在插件没有 `assets/preview.spec.mjs` 时用**通用自动挂载垫片**生成页面：
mock `window.__ModuleLoader__` / `require` / `ctx`（slots / locale / effect），调用插件的 `apply(ctx)`，
把 `slots.register(def, component)` 捕获到的组件用 `createRoot().render()` 挂到 `#root`；返回带 `note` 与 `autoMount:true`。
- **显式**传入不存在的 spec 路径仍然报错——调用方指错了文件，不静默降级。
- 自动挂载是**尽力而为**：组件依赖宿主 hooks/context 时渲染失败，页面显示错误与已捕获插槽清单，**不白屏**。
- 依据：`lib/core/preview/gen.js` + `lib/core/preview/auto-harness.js`。
- 验证：对无 spec 的 dsh-session-conductor 跑 `gen` → 页面 `#root` 有 1 个子节点 / 1378 字符 / 捕获 5 个插槽 / 0 错误。
- 违反后果：没 spec 的插件只能看到空壳；或渲染失败白屏、无从判断原因。

### C-107 测试环境是隔离实例，路径全由配置决定
`test_env` 管理的实例：独立 `DSH_HOME`（默认 `<工作区>/<DSH版本>@Save-test`）、独立端口（3083-3182 首个空闲），
与主实例完全隔离。**环境根不写死**，优先级：参数 `root` > 环境变量 `DSH_TEST_ENV_ROOT` > 插件配置
`<DSH_HOME>/useful-tools/config.json` 的 `testEnvRoot` > 推算（`DSH_WORKSPACE` / `DSH_HOME` 上一级「工作区」）。
`sync_plugin` 的 `dshHome` 同样缺省为当前实例（`process.env.DSH_HOME`），传环境目录即可把插件装进隔离实例。
- 依据：`lib/core/test-env/index.js` 的 `envRoot` / `readPluginConfig` / `detectDshVersion` / `startEnv`；`lib/core/plugin-sync/tools.js` 的 `registerPlugin`。
- 验证：配置 `testEnvRoot` 后 `test_env { action: "status" }` 的 `root` 应等于该配置；`test_env { action: "start" }` 返回 `ready:true` 与端口；`sync_plugin { write:true, register:true, dshHome:"<环境目录>" }` 后该环境 profile 的 `dependencies` 与 `dsh.profile.bundles` 均含插件名。
- 违反后果：测试实例与主实例共用 home/端口，测试崩了会污染生产；或路径写死导致换机不可用。

### C-108 minihost 路由匹配与服务注入
`minihost` 的路由匹配只比较 **pathname**（`/api/x?y=1` 按 `/api/x` 匹配），query 原样留给 handler；
插件依赖真实宿主服务（`storageDomain` / `sessions` 等）时，用 `services` 参数指向一个模块
（默认导出服务对象，或返回服务对象的函数），注入项覆盖同名默认服务，核心服务（`webServer` / `tools`）仍由 minihost 提供。
- 依据：`lib/core/minihost/host-child.mjs` 的 pathname 匹配与 `DSH_MINIHOST_SERVICES` 注入；`host.mjs` 的 `--services`。
- 环境隔离：`minihost start` 默认把子进程的 `DSH_HOME` 指到 `.minihost/home-<port>`（不写真实会话/附件库），
  并用 `--deps <真实 profile>/node_modules` 补回依赖解析；需要贴近真实环境时用 `env: { DSH_HOME: "<真实 .dsh>" }` 覆盖。
- 验证：`/api/x?y=1` 与 `/api/x` 返回同一状态码；注入 storageDomain 后 `/templates` 由 500 变 200；
  默认启动后 `home` 指向 `.minihost/home-<port>`，且插件路由仍能注册（依赖解析正常）。
- 违反后果：带参数的接口全部 404；依赖宿主服务的插件在 minihost 里只能跑出 500；不隔离 home 会让自测写脏真实数据。

### C-109 mark_read 是「读命令集合」配置，不是文件标记
`mark_read` 只有两个参数：`commands`（读命令集合，可直接写、可传文件路径从文件读、不传用预置清单
`lib/core/mark-read/read-commands.json`）与 `undo`（撤销）。集合里的命令读过的**所有文件**
由 `tools/post-execute` 钩子自动补发观测——**不提供文件路径参数**（要指定文件直接 `read`）。
**两种读法都算**：① 宿主工具本身（如 `grep` 工具，exec.name 即命令名）；② `bash` 里跑的命令
（`cat a.txt` / `grep x b.txt`，钩子解析命令串提取文件参数）。命令名经跨平台别名归一
（`Get-Content`/`gc`/`type`/`more`→cat，`Select-String`/`sls`/`findstr`→grep，去 `.exe` 后缀）。
配置落盘 `<DSH_HOME>/useful-tools/config.json`，钩子每次现读 ⇒ 命令配置一次、永久有效。
- 依据：`lib/shared/mark_read/index.js`、`lib/core/mark-read/{config.js,hook.js}`、`read-commands.json`。
- 验证：不传 `commands` 时按预置清单写入；`undo` 能从集合移除；`bash cat a.txt` 后可直接 edit 该文件；`Get-Content` 等同理。
- 违反后果：做成按文件标记会偏离需求（用户明确要求「所有文件都生效」），且与「直接 read」重复；不解析 bash 命令串则 `cat` 永远不算读。

---

### C-110 quick_command 是配置驱动的快捷命令
定义存 `<DSH_HOME>/useful-tools/quick-commands.json`（结构 `{名字: {command, description, cwd}}`，兼容值为纯字符串）。
**无内置预置**：文件不存在时是空表（`list` 返回 `count:0` 并提示用 add），定义完全由使用方创建。
`action=run`（缺省）按 `name` 执行已定义命令；**同时传 `command` 时先 upsert 写入 JSON 再执行**（等效 add 后执行），
不提供「只传 command、不落盘」的临时执行。`add` / `edit` / `delete` 管理定义，`list` 列出所有名字+命令。
`cwd`：缺省空 = 沿用宿主进程 cwd；传了必须**存在且是目录**，并解析成绝对路径。
`add`/`edit`/`run` 带 `command` 时随定义落盘；`run` 单独传 `cwd` 只影响本次执行，不改已有定义。
跨平台：Linux/macOS 走 `bash -c`，Windows 走 `cmd /c`；命令形态由使用方自定（插件不预置任何平台相关命令）。
- 依据：`lib/shared/quick_command/index.js`、`lib/core/quick-command/{store,exec}.js`。
- 验证：`test/quick-command.test.mjs` 覆盖 空表 list / add / edit / delete / run / 超时 / 非法名 / cwd（含不存在的目录被拒）；
  首次 `list` 的 `count` 必须为 0，`add` 后文件里只应有用户定义（不得出现任何内置预置）。
- 违反后果：内置预置会把「本机专属命令」塞给所有部署方；不落盘则重启后快捷命令消失；
  不校验 cwd 会把「路径写错」拖到执行时才暴露。

---

### C-111 useful_tools 是动态清单
`useful_tools` 的 `action=help`（缺省）动态扫描 `lib/shared/*/index.js`，import 每个模块的 `description` / `parameters`，
输出「名字 + 说明 + 参数 + 示例调用」；`action=list` 给紧凑清单；`tool` 过滤单个工具。
**禁止维护硬编码工具清单**：新增工具只需新建目录，本文件与 help 输出都应自动跟随。
- 依据：`lib/shared/useful_tools/index.js` 的 `loadTools()`（与 `lib/index.js` 的目录扫描同源）。
- 验证：`test/useful-tools.test.mjs` 断言清单含 mark_read / quick_command / sync_plugin，且不写死工具总数。
- 违反后果：新增工具后 help 看不到它（README 与实现对不上就是这么来的）。

---

### C-112 ui_check 是静态骨架，不是渲染检查
解析 `lib/client.js` 的 React 元素调用（`createElement` / `h` / `jsx` / `(0, ns.fn)(…)`），产出 HTML 骨架页与 JSON 控件清单。
必须遵守四条：
① **不执行代码**（与 C-501 同口径：只读文件、不进浏览器）；
② 明确区分「静态未知」与「已渲染」：清单里 `visible` 恒为 `null`，留给将来的渲染探针填 true/false；
③ 排除 DOM API（`document.createElement` 不是 React 节点），且注释里的示例代码不得污染解析结果；
④ 组件只在文件内定义时才展开；跨文件或工厂函数返回的组件标注「未展开」，不得假装展开成功（`resolved:true` 就必须真有节点）。
- 依据：`lib/core/ui-check/parse.js`（扫描/配平/插槽/组件定位）、`lib/core/ui-check/emit.js`（清单与 HTML）、`lib/shared/ui_check/index.js`。
- 验证：`test/ui-check.test.mjs` 覆盖三种调用写法、DOM 排除、注释污染、条件分支收集、组件解构参数、压缩告警、HTML 转义；
  真实文件实测：dsh-session-conductor 267 个控件 / 5 个插槽全展开，dsh-skill-scoreboard 76 个控件。
- 违反后果：把它当渲染检查会制造新的误判（静态说有、运行时没有），比不做更糟。

---

### C-113 静默失败诊断只做离线组合，不启动宿主
`verify_plugin` 的 inject 校验、激活诊断、依赖体检都是**离线**的：只读 profile 的 `package.json` /
`cordis.patch.yml` 与各 bundle 的 patch，组合出 loader 行清单；不启动宿主、不 import 被验证插件。
运行期真实装配以宿主日志（`did not activate` 归类）为准，输出里不得把离线推断写成「运行期实测」。

`sync_plugin` 写盘后的权限/属主对齐与读权限自检属于**副作用收尾**：只改权限位与属主，不改文件内容；
CIFS 等挂载上 chmod/chown 失败只记录、不中断同步，也不假装成功。
- 依据：`lib/core/verify-plugin/{inject,activation,deps}.mjs`、`lib/core/plugin-sync/permissions.mjs`。
- 验证：`test/verify-enhance.test.mjs` 覆盖 inject 近似建议、激活三项缺失、依赖 `file:` 失效、权限对齐、`dshBin` wrapper 解析。
- 违反后果：把「离线推断」说成「运行期实测」会误导排查方向；权限静默失败会再次变成「装了不激活」。

---

### C-114 DSH 插件规则两边同源维护，但实现不耦合
同一套 DSH 插件规则存在两处，判定语义必须一致：
- `dsh-git-push` 的 `lib/audit-rules/audit-rules-dsh.yml`（提交审计，逐行扫描改动）
- 本插件 `lib/core/verify-plugin/dsh-rules.mjs`（`verify_plugin`，整仓扫描）

约束：
① 两个插件**不得互相 import**（各自独立实现，避免耦合与加载顺序问题）；
② 规则 id / 严重度 / 判定语义必须一致，增删改要两边同步；
③ 本插件的命中并入 `verify_plugin` 结论：blocker/error → problems，warning → warnings；
④ 与 `checkClient` 重叠的规则（client 未走 `__ModuleLoader__`）只报一次；
⑤ **匹配只针对真实代码**：匹配前把注释与字符串内容遮蔽成等长空格（行号不变），
  所以规则的 `message`/说明里写出违规写法（否则说不清规则是什么）不会触发规则自身；
  模块名类规则（`from 'cordis'`、`require('fs')`）走「遮蔽视图确认 import/require 结构 → 回原文核对模块名」；
⑥ 跳过规则定义文件本身（`dsh-rules.mjs`）。
- 依据：`lib/core/verify-plugin/dsh-rules.mjs` 的 `DSH_RULES`、`maskCode`、`stringArgHits`。
- 验证：`test/dsh-rules.test.mjs` 断言 9 条规则 id 与 git-push 一致、每条有正例与关键负例，
  并含自指回归（说明文案/注释里的违规写法不产生 finding）与反向验证（真实代码仍报错）。
- 违反后果：两份实现漂移会让「审计放行、工具报错」或反之，开发者不知道该信哪个；
  匹配不遮蔽文案则规则会被自己的说明触发，产生「插件没这个毛病却报错」的假阳性。

---

### C-115 `patch_cifs_write` 只降级权限收紧，不动原子性
CIFS/SMB 不实现 POSIX chmod，官方 `writeFileAtomic()` 在「chmod 临时目录」这步抛 `EPERM`，
使 `write` / `edit` 在挂载盘上完全不可用（目录其实可写）。本工具给 `@deepseek-ai/dsh-fs-local`
打补丁，把三处 chmod 包成「尽力而为」。三条硬约束：
① **只吞「不支持 chmod」这一类错误**（EPERM / ENOTSUP / EOPNOTSUPP）；EACCES / ENOENT / EIO 等
   真实故障照常抛出，不得一律 catch 吞掉；
② **rename 与原子性完全不动**——不为了兼容 CIFS 改成「直接覆盖写」（那会让所有平台一起变脆）；
③ 补丁目标是套件安装目录，**DSH 升级会覆盖**：工具必须幂等、带备份与 `revert`，
   并明确报告「打完需重启 DSH 才生效」（官方模块已在宿主 ESM 缓存里）。
- 依据：`lib/shared/patch_cifs_write/index.js`（`chmodBestEffort`、备份与 `node --check` 校验）。
- 验证：`action=check` 能报出「是否已打 / chmod 是否真不可用」；`apply` 的 `dryRun` 缺省 true；
  `revert` 能从最新备份还原；已打过时重复 `apply` 直接报告而不重复改。
- 违反后果：把错误一律吞掉会掩盖真实故障；放弃原子性会连带影响所有平台。

---

### C-116 `mark_edit` 全局续期：只补发观测，不改宿主、不读内容
宿主的 `write` / `edit` 门禁由 `fs-observation-policy` 管：按 `actor.agent.session` 记账，
每项 `targetKey → { kind, version }`，写入走 CAS。而 `version` 是
`dev:ino:size:mtimeNs:ctimeNs`，其中时间戳在 CIFS/SMB 上会**晚到**——实测写完后 3ms 内
`mtime/ctime` 还会再变一次（内容未变）。官方在 `rename` 后**立刻** probe 取版本并补发观测，
于是记下的是稳定前的值 ⇒ 下一次写改 CAS 对不上 ⇒ 报 `file changed since it was read`。
所以「连续编辑」每次都要求重读，与官方「写后会自动补发」并不矛盾，是补发的值不稳。

`mark_edit` 做的就是把这步补稳，六条约束：
① **只走官方通道**：`ctx.emit('fs/observed', target, { kind:'present', version }, exec)`，
   `version` 由 `fs.stat()` 现取；不修改宿主、不碰私有接口、不动 `fs-observation-policy`；
② **actor 必须是本次调用的 `exec`**——台账按 owner 隔离，拿错 actor 等于替别人记账；
③ **不读文件内容**：它声明的是「这份现在是什么」，因此只在自己确实经手写入时用；
   内容不是自己写的文件仍应 `read`（否则等于自己拆掉门禁）；
④ `undo` 用**哨兵 version**（与真实版本必然不等）让 CAS 判 stale ⇒ 重新要求先读，即恢复门禁；
⑤ **全局生效、缺省开启**：所有经 `write` / `edit` 改过的文件写完后都按稳定版本再补发一次，
   **不指定文件、不维护路径清单**（与 mark_read「配置一次、全局生效」同口径）；
   延迟 `editSettleMs`（缺省 1100ms，上限 2000）并在 +500/+1300ms 各再复核一次（实测漂移点 ~1000ms，早于它的复核拿到的是稳定前的值），开关与延迟**每次现读配置** ⇒ 改配置即时生效；
   `paths` 只用于补标「没走 write/edit 的改动」（bash `sed -i` / heredoc / `tee`、别的会话写入）；
⑥ **只处理「有明确目标文件」的写形态**：宿主 `write`/`edit` 取参数路径；bash 取命令串里的写目标
   （`> >> tee sed -i cp mv touch truncate dd of=`）；`python -c` / `node -e` 这类无法可靠解析，不猜；
⑦ 与 `mark_read` 的分工：读侧由 `mark_read` 解析（含 `cmd < 文件` 与**输出命中行**），写侧由本钩子兜住；
   两边都只走官方 `fs/observed`，互不依赖。
- 依据：`lib/core/mark-edit/hook.js`（全局续期钩子）、`lib/core/mark-edit/store.js`
  （`editHook` / `editSettleMs` 配置，保留其它键）、`lib/core/mark-edit/index.js`（`runMarkEdit`），
  补发 recipe 复用 `lib/core/mark-read/observe.js` 的 `observeFileForHost`。
- 验证：`test/mark-edit.test.mjs` 12 例（缺省全局开启、任意 write/edit 都续期且无需标记、
  read 不触发、关开关后不再续期、关闭时不注册、配置落盘与保留其它键、`paths` 补标与 `undo` 哨兵、上限截断）；
  真实链路（CIFS）：`write → edit ✓ → edit ✗` 复现稳定前版本问题，补发稳定值后即可连续编辑。
- 违反后果：绕过官方通道改宿主会在升级后失效；不读内容却标「已读」会诱发盲改；
  把「全局」做成「按路径清单」则用户每次都要指定文件，等于没解决连续编辑的问题。

---

### C-117 `github_mirror` 只改 git 层的 insteadOf，不碰 npm 源与宿主代码
DSH 从 GitHub 安装插件走 `pnpm add <git spec>` → git clone（`plugin-manager` 把 `github:` 与仓库 URL
判为 `kind: 'git'`），**不经过 npm 源**——界面「安装源」只管 npm 包。pnpm 的父环境经
`scrubbedParentEnv()` 清洗（剔除敏感键与 `DSH_*`），环境变量注入不可靠；HOME 保留 ⇒ `~/.gitconfig` 是稳定落点。
本工具因此只写一类 git 配置：`url.<代理>https://<host>/.insteadOf https://<host>/`，之后原地址 clone 无感走代理。

七条约束：
① **只碰这一种键**：`clear` 只删指向 `github.com` 等受管站点的规则，不动 user/proxy 等其它配置；
   并按后缀兼容匹配早期误写的裸主机形式，否则清不掉历史残留；
② **insteadOf 两端都必须带协议**：git 按字符串前缀匹配目标 URL，写成裸主机 `github.com/`
   匹配不到 `https://github.com/...` ⇒ 重写静默失效、表现为直连超时（会被误判成代理不可用）；
③ **`mirror` 可省**：省略时按候选清单顺序探测，取第一个可用的；仅当清单为空或全部停用才必须显式传
   （工具不内置任何"默认代理"，清单是数据文件，可增删可停用）；
④ **探测不通的地址不入库**：显式传入但探测失败的只在返回值 `rejected` 里告知（`persisted: false`），
   不污染候选表；清单内地址失败才累加 `failures`，满 `MAX_FAILURES` 自动停用、`probe` 成功可恢复；
⑤ `apply` **先探测再写**，失败按清单顺序自动轮换（`rotate: false` 只测显式那一个）；
   全不可用则不写并报错，同时给出直连探测结果；
⑥ `dryRun` 缺省 **true**：只报计划，**探测结果也不落盘**（避免每次预演都污染失败计数）；
⑦ 不改 DSH 源码、不改 npm 源、无需重启（git 每次现读配置）。
- 依据：`lib/core/github-mirror/{index,store,git}.js`、`lib/core/github-mirror/candidates.json`。
- 验证：`test/github-mirror.test.mjs` 16 例（归一化、并入与更新、失败计数与停用恢复、原子落盘、
  `planProbeOrder` 纯函数四态、insteadOf 带协议与幂等读写删、清单为空才必填、不可达不入库、
  dryRun 不落盘、clear 只清受管规则含历史残留、status 视图、入库清单不被测试写脏）；
  真机实测：裸主机形式下 `git ls-remote https://github.com/git/git` 超时（退出码 124）
  → 改为带协议后同一命令返回 HEAD（退出码 0）→ `clear` 后规则清零。
- 违反后果：② 错则功能整体静默失效；③④ 错则候选表被不可用地址填满；
  ⑥ 错则一次预演就把候选误标为失败。

---

### C-118 `sync_plugin` 的 `hmr` 参数：幂等启用热重载，只补不破坏
「改代码要不要重启」取决于两处：① profile 的 `cordis.patch.yml` 有无 `- id: hmr` 且 `root` 含 `local-plugins`；
② 插件真源在 `local-plugins`（hmr 默认把 `node_modules` 整棵剪枝）。本参数管 ①，②由 `judgeHmr` 判定并回报。

四条约束：
① **base 必须用版本无关表达式** `!!js 'ctx.get("profileContext").dir'`；
   写死版本目录会在升级后指向不存在的目录，hmr 在 init 阶段 `realpathSync(baseDir)` 抛错 →
   监视器根本没建起来，且崩掉的 hmr 连配置变更都不再监视（改配置不自愈，必须重启一次）；
   发现写死的版本目录只**警告并给替换方案**，不静默改动语义无关的其它键；
② **整块重建，不逐行替换**：`root: []` 这类行内写法用逐行正则会留下**重复键与错缩进**（实测写坏过 patch 文件），
   因此按「root = 原有项 ∪ local-plugins（保序）、其它键原样保留」重建整块；
③ **`changed` 仅表示已落盘**：dryRun 只填 `plan`，不得谎报已改（否则调用方以为生效）；
   重复执行必须逐字节幂等；
④ `hmr: true` 且未传 `write` 时只报计划；`hmr` 缺省完全不碰配置文件。
- 依据：`lib/core/plugin-sync/hmr-config.mjs`（`readHmrConfig` / `ensureHmrConfig` / `rebuildHmrBlock`），
  `install.mjs` 的 `readHmrConfig` 转调它、`judgeHmr` 负责布局判定。
- 验证：`test/sync-plugin-install.test.mjs` 中 ensureHmrConfig 六例——含五种入口形态写盘后的**结构断言**
  （root/base 键唯一、列表项更深缩进、其它键不丢）、二次执行逐字节不变、
  `!!js` 表达式 base 下 `judgeHmr` 按当前 profile 判定（不能拿表达式当路径）。
- 违反后果：① 错则升级后热重载整体静默失效；② 错则写坏 profile 配置（破坏性）；
  ③ 错则 dryRun 看起来像已生效。

### C-601 新增工具必须带单测
`test/<工具名>.test.mjs`，用 `node:test` + `node:assert/strict`，零依赖。
- 依据：`test/` 现有 11 份测试（统一 `*.test.mjs`），`package.json` 的 `test` 脚本为 `node test/run-tests.mjs`。
- 入口：`test/run-tests.mjs` 自己扫描 `*.test.mjs` 再把文件列表传给 `node --test`——不依赖 glob
  （Node 20 不支持 `--test` 的 glob，Windows 的 shell 也不展开通配符）。
- CI：`.github/workflows/test.yml` **固定 `ubuntu-latest`** × Node 20/22/24 跑同一命令（零依赖，无需 npm install）。
  CI 是门禁，环境固定才稳定；跨平台能力由代码保留，但不把 Windows 挂进每次提交的门禁
  （Windows 上 spawn 的 cwd 传递与 cmd 引号/重定向语义尚未验证，需真实环境单独验证）。
- 验证：`npm test` 全绿。
- 跨平台：测试里不得依赖 shell 内置命令（`pwd`/`sleep`/`ls` 只有某类 shell 有），一律用 `node -e` 代替。
- 违反后果：装配类 bug 只能靠宿主日志发现（本次 `Invalid effect` 藏了很久）。

### C-602 测试不写死路径、不自留垃圾
测试用相对路径 + `mkdtempSync` 临时目录，结束 `rmSync` 清理。
- 依据：`test/verify-plugin.test.mjs` 的 `makePlugin` 辅助。
- 验证：跑完测试后 `/tmp` 无残留 `verify-plugin-*` 目录。
- 违反后果：每跑一次留一堆夹具目录。

---

## 7. 版本与文档

### C-701 版本两处同步
`package.json` 的 `version` 与 `docs/VERSIONS.md` 版本记录表的**首行**必须一致。
版本记录不放 README：README 是精简使用手册（见 readme-spec），发布历史属文档，移入 docs。
- 依据：`package.json` / `docs/VERSIONS.md`。
- 验证：`grep '"version"' package.json` 与 VERSIONS 表首行版本号对照。
- 违反后果：装的版本和文档写的版本对不上。

### C-702 README 只做门面，契约引用本文件
README 保留：简介、工具表、用法、配置、安装、目录结构、版本记录、文档索引。
**契约正文（命名规则、装配规则、部署规则、验证规则）不在 README 重复**，一律引用本文件。
- 依据：本文件与 README 的分工。
- 验证：README 出现契约细节即为漂移，应移到本文件。
- 违反后果：同一事实两处表达，必然漂移（`tool_` 前缀与目录名不符就是这么来的）。

### C-703 文档不写对话残留
文档、注释只写「做了什么 / 为什么这么做」，不写对话来源、许可表述、商量转述。
- 依据：仓库审计规则 `documentation/comment-suspicious-detection`。
- 验证：提交前审计无该规则 blocker。
- 违反后果：审计拦截提交。

---

## 修改记录

| 版本 | 变更 |
| --- | --- |
| 0.1.33 | C-117 改 7 条：`mirror` 改为**可省**（省略则按候选清单顺序取第一个可用的，仅清单空/全停用才必填）、不可达地址不入库只报 `rejected`、明确 **insteadOf 两端都必须带协议**（裸主机形式会静默失效）。新增 C-118：`sync_plugin` 的 `hmr` 参数幂等启用热重载（base 用版本无关表达式、整块重建不逐行替换、`changed` 仅表示已落盘）。 |
| 0.1.32 | 新增 C-117：`github_mirror` 只改 git 层 insteadOf（mirror 必显式传、候选外置、失败计数轮换、dryRun 缺省 true）。 |
| 0.1.31 | C-116 ⑥⑦ 改写：写形态含 bash 写命令；读侧补「重定向输入 + 输出命中行」口径（`mark_read`）。 |
| 0.1.30 | C-116 改为「全局续期」：缺省开启、对**所有** write/edit 生效（不指定文件、不维护清单）；`paths` 仅用于补标非 write/edit 的改动；开关与延迟每次现读配置。 |
| 0.1.29 | C-116 补 ⑤：清单落盘 + 自动续期（只对 `editPaths` 内路径、延迟 settle 取稳定版本）；补根因说明（version 含 mtimeNs/ctimeNs，CIFS 时间戳晚到）。 |
| 0.1.28 | 新增 C-116：`mark_edit` 只补发观测（官方 `fs/observed` 通道、actor 用本次 exec、不读内容、undo 用哨兵版本恢复门禁）。 |
| 0.1.27 | 新增 C-115：`patch_cifs_write` 只降级权限收紧、不动原子性（只吞 EPERM/ENOTSUP/EOPNOTSUPP）；C-114 补 ⑤⑥：规则匹配只针对真实代码（遮蔽注释与字符串内容）。 |
| 0.1.26 | C-105 补「backend 可省略、自动沿用最近 minihost 实例并给 backendSource」；C-108 补默认隔离 `DSH_HOME` 与 `--deps` 补依赖解析。 |
| 0.1.25 | 新增 C-114：DSH 插件规则在 dsh-git-push（审计）与本插件（verify_plugin）两边同源维护、实现不耦合；9 条规则并入 verify_plugin 结论。 |
| 0.1.24 | 新增 C-113：静默失败诊断只做离线组合（不启动宿主），`sync_plugin` 的权限收尾只改权限位、失败只记录；inject 校验 / 激活诊断 / 依赖体检 / HMR 判定并入 verify_plugin。 |
| 0.1.23 | 新增 C-112：`ui_check` 是静态骨架（不执行代码、`visible` 恒 null、排除 DOM API、`resolved:true` 必须真有节点）。 |
| 0.1.22 | C-601 CI 矩阵固定 `ubuntu-latest`（去掉 `windows-latest`）：CI 是门禁，环境固定才稳定；跨平台能力由代码保留，Windows 未验证不进门禁。 |
| 0.1.21 | C-110 明确「无内置预置」（定义只来自 quick-commands.json，首次为空表）；C-601 单测入口改为 `test/run-tests.mjs`（自扫文件，不依赖 glob）。 |
| 0.1.20 | C-110 补 `cwd` 语义（缺省宿主 cwd、必须存在且是目录）与跨平台要求（`bash -c` / `cmd /c`，预置 restart 仅 Linux/macOS）；C-601 单测入口改为 Node 自身展开的 glob、CI 增加 `windows-latest`、明确测试不得依赖 shell 内置命令。 |
| 0.1.16 | C-402 允许探测候选（环境变量/参数优先、不得作为唯一来源）；C-601 测试数改 5 份；补记 0.1.9 / 0.1.10 / 0.1.13 三次契约内容更新。 |
| 0.1.13 | C-109 补「bash 命令串也算读」与跨平台别名归一。 |
| 0.1.10 | C-108 补路由只看 pathname 与 `services` 宿主服务注入。 |
| 0.1.9 | C-107 补测试环境根配置驱动（参数 > 环境变量 > 插件配置 > 推算）。 |
| 0.1.4 | 首版：把散落在 README 与代码注释里的设计约定收拢成编号契约，README 改为引用。 |

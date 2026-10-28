# 版本记录

版本与 `package.json` 的 `version` 一致（契约 C-701）。

| 版本 | 变更 |
| --- | --- |
| 0.1.33 | 修「改了代码但工具没换新」的根因：工具注册与两个 post-execute 钩子都把 disposer 交回 cordis（`inject` 回调是子 fiber，不返回 disposer 则热重载后旧注册永不释放、同名重注册被拒，工具一直指向旧闭包）。`github_mirror` 的 `mirror` 改为**可省**：省略时按候选清单顺序探测、取第一个可用的，仅当清单为空或全部停用才必填；探测不通的地址不写入候选清单，只在返回的 `rejected` 里告知。`sync_plugin` 新增 `hmr` 参数：幂等启用 profile 的模块热重载（补 `- id: hmr`、`base` 用版本无关表达式、`root` 含 `local-plugins`），并回报该插件是否已可免重启。修 `insteadOf` 值必须带协议（裸主机会让重写静默失效）。README 版本记录移至本文件。 |
| 0.1.32 | 新增 `github_mirror`：在 git 层写 `insteadOf` 重写，让 DSH 通过 pnpm/git 安装 GitHub 插件时无痕走代理（「安装源」只管 npm 包，覆盖不到这条链路）。mirror 显式传入才并入候选、探测失败累加计数并满 3 次停用、`apply` 先探测后写并自动轮换、`dryRun` 缺省 true、`clear` 只删受管站点的规则。候选清单外置 `lib/core/github-mirror/candidates.json`。 |
| 0.1.31 | 补齐读/写两条链路：`mark_read` 修 bash 解析——支持 `cmd < 文件` 重定向输入，并按**输出命中行**反推读过哪些文件（`grep -rn pat 目录` 以前只把目录当文件、静默跳过，现在目录里的文件也算已读）；`mark_edit` 兼管 **bash 写命令**（`> >> tee sed -i cp mv touch dd of=`）的目标文件，写入后同样多检查点补发稳定版本。返回里带 `stats` / `refreshEmits` 自证计数。 |
| 0.1.30 | `mark_edit` 改为**全局生效**（与 `mark_read` 对称）：缺省开启，所有经 `write`/`edit` 改过的文件写完后延迟 `settleMs` 按稳定版本再补发一次观测，连续编辑不再需要重读——不再需要指定路径、不再维护清单；`paths` 只保留给「没走 write/edit 的改动」补标，`undo` 撤销补标，`enabled`/`settleMs` 改配置。 |
| 0.1.29 | `mark_edit` 补齐「永久有效」语义：清单落盘（`config.json` 的 `editPaths`）、不传 `paths` 用清单续期、`undo` 撤销；新增**自动续期钩子**——标记过的路径每次被 `write`/`edit` 改动后，延迟 `settleMs` 重新取版本并补发，解决「标记一次只够一次编辑」；文档更正根因：版本串含 `mtimeNs`/`ctimeNs`，CIFS 时间戳晚到导致连续编辑也判 stale（与 `patch_cifs_write` 无关）。 |
| 0.1.28 | 新增 `mark_edit` 工具（`mark_read` 的另一半）：把「我刚改过这些文件」按当前磁盘版本经官方 `fs/observed` 通道补发观测，`write`/`edit` 不必重读全文；`undo` 用哨兵版本恢复「先读再改」门禁。补的是官方补不到的缺口——bash `sed -i` / heredoc 重定向 / `tee`、别的工具或会话写入导致的 `file changed since it was read`。 |
| 0.1.27 | 修 `verify_plugin` 的 DSH 规则自指误报：匹配前先把**注释与字符串内容**遮蔽成等长空格（行号不变），只对「真实代码」匹配，规则 `message` 文案里写出违规写法不再触发自己；需要字符串内容的模块名类规则改为「遮蔽视图确认 import/require 结构 → 回原文核对模块名」；并跳过规则定义文件本身。补齐 `patch_cifs_write` 的文档（工具本身随 0.1.26 提交，文档当时漏记）。 |
| 0.1.26 | 按实战反馈改 5 处：`preview gen` 说明写明 `preview.spec.mjs` 可选、产物在插件内且未忽略时提示入库风险、页面顶部内置错误面板（运行期错误可见）；`preview serve` 的 `backend` 可省略（自动沿用最近一次 minihost 实例并返回 `backendSource`）；`minihost start` 新增 `env` 参数且**默认隔离 `DSH_HOME`**（写到 `.minihost/home-<port>`，依赖解析用 `--deps` 补回真实 profile）。多挂载点 `mounts[]` 记入 NOT-DONE 待办。 |
| 0.1.25 | 把 9 条 DSH 插件规则移植到 `verify_plugin`（独立实现，与提交审计不互相 import）：裸名 cordis/schemastery、render 空实现、client 引 Node 内置、凭据字段缺 `role('secret')`、patch insert id 冲突、client 未走 `__ModuleLoader__`、ctx 未注入属性（blocker）、猜宿主 API 兜底链。另修激活诊断的 profile 选择：显式指定 > web > 第一个（原先取 `profiles[0]` 会误判到历史 profile）。 |
| 0.1.24 | 按实战问题清单增强「静默失败」诊断：`verify_plugin` 新增 inject 服务名校验（拼错给近似建议）、激活诊断（dependencies / bundles / loader 行 / `did not activate` 归类）、依赖解析、客户端入口与 UI 骨架串联、HMR 覆盖判定；`sync_plugin` 写盘后自动对齐权限/属主并做读权限自检 + 依赖体检；`minihost` 内置 storageDomain/sessions 宽容桩、`force` 重启、404 原因提示；`test_env` 支持 shell wrapper 形式的 `dshBin` 并带出超时日志关键行；`ui_check` 增加一行摘要；`useful_tools` help 增加「症状 → 工具」索引。 |
| 0.1.23 | 新增 `ui_check` 工具：静态解析插件 `lib/client.js`，产出 HTML 骨架页 + JSON 控件清单（插槽注册、层级、className、内联样式、来源行号；组件在文件内定义时展开）。支持 `createElement` / `h` / `jsx` / `(0, ns.fn)(…)` 四种写法，排除 `document.createElement`，条件与逻辑表达式里的元素一并收集；清单 `visible: null` 为将来的渲染探针预留。 |
| 0.1.22 | CI 回到固定 `ubuntu-latest` × Node 20/22/24：CI 是门禁，环境固定才稳定；跨平台能力（`cmd /c` 分支、测试不依赖 shell 内置命令）保留在代码里，但 Windows 不挂进每次提交的门禁（其 spawn cwd 与 cmd 引号语义尚未验证，需真实环境单独验证）。 |
| 0.1.21 | `quick_command` 去掉内置预置：定义完全来自 `<DSH_HOME>/useful-tools/quick-commands.json`，首次是空表（`list` 返回 `count:0` 并提示用 add），`restart` 这类本机命令由使用方自己 add。测试入口改为跨平台 runner `node test/run-tests.mjs`（自扫 `*.test.mjs`，不依赖 Node 20 不支持的 glob 与 Windows 不展开的通配符）。 |
| 0.1.20 | `quick_command` 支持 `cwd` 执行目录：缺省空 = 宿主进程 cwd，传了先校验「存在且是目录」并解析成绝对路径；`add`/`edit`/`run` 带 `command` 时随定义落盘，`run` 单独传只对本次生效。跨平台加固：单测不再依赖 shell 内置命令（用 node 打印 cwd）、测试文件统一改名 `*.test.mjs` 用 Node 自身展开 glob。 |
| 0.1.19 | 新增 `useful_tools` 工具：动态扫描 `lib/shared` 输出本插件全部工具（名字/说明/参数/示例调用），`action=help`（缺省）/ `list`，`tool` 可只看单个。另修 `quick_command` 预置命令在探测不到启动脚本时把占位符替换成空串的问题（改为保留 `{startScript}`，执行时报错暴露）。 |
| 0.1.18 | 新增 `quick_command` 工具：快捷命令定义存 `<DSH_HOME>/useful-tools/quick-commands.json`，`action=run`（缺省，按 name 执行；带 command 时先持久化再执行）/ `add` / `edit` / `delete` / `list`。执行走 `bash -c`、默认超时 60 秒、输出截断 20000 字符。 |
| 0.1.17 | 新增单测 CI：`.github/workflows/test.yml`，push 到 master 与所有 PR 触发，Node 20/22/24 矩阵跑测试（测试零依赖，无需 npm install）。 |
| 0.1.16 | 修 `sync_plugin` 源目录 bug：缺省 `source` 少上溯两层（停在 `lib/core`），`packageFilesOf` 读不到 `package.json`，每次同步都是「0 文件空操作」却返回 `ok:true`——已改为上溯三层，实测同步写入 5 文件、副本一致。另：README 示例地址改 `<本机IP>` 占位（不再写本机回环）；C-402 改为「允许探测候选、环境变量/参数优先且不得作为唯一来源」。 |
| 0.1.15 | 修 minihost 启动 TDZ 回归：`host.mjs` 的 `TIMEOUT_MS` 引用了后面才定义的 `DEFAULT_TIMEOUT_MS`（`Cannot access before initialization`），已把常量定义前移；实测 `minihost start` 正常、请求 200。另在 preview/minihost 工具描述里注明「参数定义在实例加载期注册，更新插件后需重载实例」。 |
| 0.1.14 | `preview serve` 支持局域网访问：新增 `host`（缺省仅监听本机回环，可传 0.0.0.0）与 `lan:true`（等价 0.0.0.0）；监听 0.0.0.0 时返回 `lanUrl`，原 `url` 保留本机回环地址。 |
| 0.1.13 | `mark_read` 支持 `bash` 里跑的命令：钩子解析命令串（`cat a.txt`、`grep x b.txt`），命令名在集合里就标记其文件参数——`cat` 不再必须写成宿主工具。命令名做**跨平台别名归一**：`Get-Content`/`gc`/`type`/`more`→cat，`Select-String`/`sls`/`findstr`→grep，去 `.exe`/`.cmd`/`.bat`/`.ps1` 后缀。 |
| 0.1.12 | `mark_read` 重做：语义从「按文件标记」改为「**读命令集合**」——两个参数 `commands`（命令串，或传文件路径从文件读，不传用预置清单 `read-commands.json`）+ `undo`（撤销）；集合里的命令读过的**所有文件**自动生效。配置落盘 `<DSH_HOME>/useful-tools/config.json`，钩子每次现读 ⇒ 命令配置一次、永久有效。移除 `paths` / `file_path` / `all`（要指定文件直接 `read`）。 |
| 0.1.11 | `preview` 自动挂载修复 TDZ：`__ModuleLoader__.load` 只登记 entry，`factory` 统一延迟到 `setTimeout(0)`（client.js 整体执行完之后）再调用。实测无插槽可渲染的插件修复后渲染出真实界面。 |
| 0.1.10 | `minihost` 两处修复/增强：① 路由匹配只看 pathname（`/api/x?y=1` 不再 404）；② 新增 `services` 参数注入宿主服务。 |
| 0.1.9 | 测试环境根改为**配置驱动**：参数 `root` > `DSH_TEST_ENV_ROOT` > 插件配置的 `testEnvRoot` > 推算。环境目录为 `<根>/<版本>@Save-test`，部署方按配置决定位置，不写死代码路径。 |
| 0.1.8 | 新增 `test_env` 工具：测试环境（隔离实例）create/start/stop/status，独立 DSH_HOME + 自动端口，路径全由参数/环境决定。`sync_plugin` 增加 `dshHome`（缺省当前实例）、`pluginName`、`register`（写 profile 的 dependencies + bundles，并对齐 node_modules 副本），可把插件直接装进隔离实例。 |
| 0.1.7 | `preview gen` 无 spec 时改为**通用自动挂载**：mock `window.__ModuleLoader__` / `require` / `ctx`（slots / locale / effect），调插件 `apply(ctx)`，把 `slots.register(def, component)` 捕获到的组件渲染到 `#root`。spec 从此是可选的增强，不再是必填。 |
| 0.1.6 | `preview gen` 支持无 spec 兜底：插件没有 `assets/preview.spec.mjs` 时按默认垫片生成页面，返回带 `note`；显式传入不存在的 spec 路径仍报错，不静默降级。 |
| 0.1.5 | 启停状态统一走工具参数：`preview` 与 `minihost` 新增 `status`（等价 `list`，语义直白，旧名保留）。新增 [NOT-DONE.md](NOT-DONE.md) 记录三项未实现能力（预览页截图、自包含快照、shell 启动器）的评估结论与不做原因。 |
| 0.1.4 | 契约独立成文：[CONTRACT.md](CONTRACT.md)（编号 C-101~C-703，含命名/装配/部署/依赖/验证/测试/版本）。README 只保留门面与文档索引，契约细节改为引用，不再两处重复。`docs/` 纳入同步清单。 |
| 0.1.3 | 新增 `verify_plugin`：验证任意 DSH 插件的装载与工具注册（装配结构静态分析 + 部署一致性 + 宿主日志；只读文件、不执行被验证插件的代码），支持传插件名或根目录，缺省巡检所有已装插件。 |
| 0.1.2 | 移除斜杠指令：宿主 `commands.register` 要求 `input` 必须带非空 `hint`，原实现传 `input: { type: 'string' }` 使四条指令全部注册失败；该功能收益低于维护成本，直接移除，只保留工具。README 里的工具名同步为实际注册名。 |
| 0.1.1 | 修复装配入口 `apply` 返回普通对象的问题：cordis 把 apply 返回值当 effect 收集，普通对象会抛 `TypeError: Invalid effect`，整条插件 fiber 随即卸载，四个工具全部不注册。改为只写日志、不返回值。 |
| 0.1.0 | 首个版本：`mark_read` / `sync_plugin` / `minihost` / `preview` 四工具 + 自动标记钩子。 |

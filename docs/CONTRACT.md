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
- 验证：`minihost start` 后把 `preview serve` 的 `backend` 指向该端口，页面 `/api/*` 应返回 minihost 的响应。
- 违反后果：两个工具各自能跑但串不起来，模拟链路断在前端或后端。

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
与主实例完全隔离。环境根/版本/端口一律探测或参数传入，**不写死任何机器路径**；
`sync_plugin` 的 `dshHome` 同样缺省为当前实例（`process.env.DSH_HOME`），传环境目录即可把插件装进隔离实例。
- 依据：`lib/core/test-env/index.js` 的 `envRoot` / `detectDshVersion` / `startEnv`；`lib/core/plugin-sync/tools.js` 的 `registerPlugin`。
- 验证：`test_env { action: "start" }` 返回 `ready:true` 与端口；`sync_plugin { write:true, register:true, dshHome:"<环境目录>" }` 后该环境 profile 的 `dependencies` 与 `dsh.profile.bundles` 均含插件名。
- 违反后果：测试实例与主实例共用 home/端口，测试崩了会污染生产；或路径写死导致换机不可用。

---

## 2. 装配入口（cordis）

### C-201 入口必须导出 `apply`
`package.json` 的 `main`（或 `exports["."]`）指向的模块必须导出 `apply(ctx, config)`。
入口只做再导出（`export * from ...`）时，`apply` 必须在跟进的文件里能找到。
- 依据：`lib/index.js` 的 `export async function apply`；宿主按 `apply` 装载。
- 验证：`verify_plugin` 的 `hasApply`；或 `grep -n "function apply" lib/index.js`。
- 违反后果：宿主不把它当插件，工具一个都不会注册。

### C-202 `apply` 的返回值必须是合法 effect
合法形态只有：`undefined` / `null` / dispose 函数 / thenable / iterator。
**禁止返回普通对象**（例如 `return { name, tools }`）。
- 依据：cordis 4.0.5 `_execute → safeCollect`：普通对象抛 `TypeError: Invalid effect`，
  整条 fiber 随即 `_unload()`，已注册的工具全部失效（0.1.1 修的就是这个）。
- 验证：`verify_plugin` 的 `analysis.applyReturn.risky` 必须为 `false`；单测 `test/verify-plugin.test.mjs` 覆盖该判定。
- 违反后果：插件看起来装了、工具一个都没有，日志里只有一行 `Invalid effect`。

### C-203 注册必须走 `ctx.inject`
工具注册写成 `ctx.inject(['tools'], (c) => c.get('tools').register(...))`；
不要在 apply 里直接 `ctx.get('tools')`（未 inject 读取会抛）。
- 依据：`lib/index.js` 的注册块；`dsh-git-push` 也踩过「直接读服务抛 without inject」。
- 验证：`verify_plugin` 的 `registersTools` 为 `true`；`grep -n "inject(\['tools'\]" lib/index.js`。
- 违反后果：注册代码抛错被 catch 吞掉，工具静默缺失。

### C-204 本插件不提供斜杠指令
宿主 `commands.register` 要求 `input` 必须带非空 `hint` 字符串；本插件已移除指令注册，只提供工具。
若要恢复，必须按该契约补 `input: { hint: '...' }`，并补对应测试。
- 依据：`dsh-commands` 的 `normalizeDefinition`；0.1.2 的移除记录。
- 验证：`grep -rn "commands" lib/` 应无注册调用。
- 违反后果：指令注册抛 `input hint must be a string`，被 catch 吞掉，界面看不到指令。

---

## 3. 部署与同步

### C-301 工作区源码是唯一真源
`工作区/dsh-useful-tools` 是源码；profile 的 `local-plugins/<包名>` 是部署副本，
`node_modules/<包名>` 是指向它的软链。
- 依据：`lib/core/plugin-sync/sync-plugin.mjs` 的 `detectTargets` 与 profile 布局。
- 验证：`verify_plugin` 的 `deploy.targets[].inSync` 为 `true`。
- 违反后果：改了源码没同步，宿主跑的还是旧代码，排查时被假象带偏。

### C-302 改完必须同步并逐文件一致
改完源码后执行 `sync_plugin { write: true }`，同步后源码与部署副本逐文件内容一致。
- 依据：`syncPlugin` 逐文件比内容，内容相同不写（幂等）。
- 验证：`verify_plugin` 返回 `deploy.targets[].missing/different` 均为空。
- 违反后果：部署副本落后，`hmr` 重载到的仍是旧代码。

### C-303 文档随插件同步
`docs/` 必须写进 `package.json` 的 `files` 字段——同步清单的唯一权威就是它
（`SYNC_ENTRIES` 只是未声明 `files` 时的兜底白名单）。否则部署副本的 README 引用会指向不存在的文件。
- 依据：`lib/core/plugin-sync/sync-plugin.mjs` 的 `packageFilesOf`（`files` 优先，未声明才用白名单）。
- 验证：`sync_plugin` 的 dryRun 输出里应出现 `docs/CONTRACT.md`；`ls <部署副本>/docs`。
- 违反后果：部署副本文档残缺，引用断链。

---

## 4. 依赖与路径

### C-401 零依赖
只使用 Node 内置模块，`package.json` 不新增 `dependencies`；不为跑通写本地依赖清单。
- 依据：`package.json` 无 dependencies；全部 `import` 均为 `node:` 前缀或相对路径。
- 验证：`grep -rn "from '[^n.]" lib/ | grep -v "from '\./"` 应为空。
- 违反后果：插件要装依赖才能起，部署与迁移成本陡增。

### C-402 不写死路径
`DSH_HOME`、profile、日志、部署目标一律运行时探测；代码里不出现机器专属绝对路径。
- 依据：`defaultPluginRoot()`、`inspectProfiles`、`detectTargets`、`logCandidates` 均为探测。
- 验证：`grep -rn "/volume1\|/var/packages" lib/` 应为空。
- 违反后果：换机/换版本目录即失效。

### C-403 单文件不超过 400 行
超过就按职责拆分（例如 `verify-plugin/static.mjs` 与 `check.mjs`）。
- 依据：仓库提交要求；当前最大文件 < 300 行。
- 验证：`wc -l lib/**/*.js lib/**/*.mjs | sort -n | tail -3`。
- 违反后果：单文件难维护，改动互相牵连。

---

## 5. 验证（verify_plugin）

### C-501 只静态分析，不执行被验证插件
`verify_plugin` 只读文件，**不得 import、不得执行**目标插件代码。
- 依据：`lib/core/verify-plugin/static.mjs` 与 `check.mjs` 只做 `readFileSync` / 目录遍历。
- 验证：跑巡检后宿主日志不应出现被验证插件的启动输出（例如 session-conductor 的分组服务日志）。
- 违反后果：验证动作本身产生副作用（起服务、写台账、改配置）。

### C-502 硬伤与启发式分开
`problems` 只放确定性硬伤（入口缺失、无 apply、apply 返回对象字面量、声明的 patch 缺 `insert`）；
`warnings` 放启发式（没找到 tools 注册调用、patch id 与包名不同、入口靠 `export *` 转出）。
- 依据：`analyzePlugin` 的 `problems` / `warnings` 分类。
- 验证：单测覆盖「不注册工具的插件不算失败」。
- 违反后果：把合法插件判成坏插件，工具失去可信度。

### C-503 入口 `export *` 必须跟进
入口只做再导出时，静态分析要沿 `export * from './x'` 跟进（最多 3 层），否则会误判「没有 apply」。
- 依据：`collectSourceFiles`；`dsh-git-push` 实测为 index → app/index 两层。
- 验证：对 `dsh-git-push` 跑 `verify_plugin` 应为 `ok: true` 且 `filesAnalyzed.length >= 2`。
- 违反后果：主流写法（入口再导出）全部误报。

### C-504 历史日志降级为提示
日志文件最后写入时间早于源码最后修改时间时，命中的报错判为「修复前的历史记录」，进 `warnings` 而非 `problems`。
- 依据：`verifyOne` 里 `srcMtime` 与日志 `mtime` 的比较。
- 验证：单插件自验时旧报错不阻塞 `ok: true`。
- 违反后果：修好的问题一直显示失败，用户对工具失去信任。

---

## 6. 测试

### C-601 新增工具必须带单测
`test/<工具名>.test.mjs`，用 `node:test` + `node:assert/strict`，零依赖。
- 依据：`test/` 现有 4 份测试，`package.json` 的 `test` 脚本为 `node --test test/*.mjs`。
- 验证：`npm test`（或 `node --test test/*.mjs`）全绿。
- 违反后果：装配类 bug 只能靠宿主日志发现（本次 `Invalid effect` 藏了很久）。

### C-602 测试不写死路径、不自留垃圾
测试用相对路径 + `mkdtempSync` 临时目录，结束 `rmSync` 清理。
- 依据：`test/verify-plugin.test.mjs` 的 `makePlugin` 辅助。
- 验证：跑完测试后 `/tmp` 无残留 `verify-plugin-*` 目录。
- 违反后果：每跑一次留一堆夹具目录。

---

## 7. 版本与文档

### C-701 版本三处同步
`package.json` 的 `version` 与 `README.md` 的版本记录表必须一致（本插件无独立 VERSION 常量）。
- 依据：`package.json` / `README.md` 版本记录。
- 验证：`grep '"version"' package.json` 与 README 表格首行对照。
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
| 0.1.4 | 首版：把散落在 README 与代码注释里的设计约定收拢成编号契约，README 改为引用。 |

# dsh-useful-tools

DSH 插件开发与日常使用的小工具集：读/写观测、插件体检、前后端模拟、环境修复。

## 功能

| 功能 | 做什么 | 入口 |
| --- | --- | --- |
| 读命令集合 | 集合内命令读过的文件自动算已读 | `mark_read` |
| 写后自动续期 | 写改后自动补发观测，连续编辑免重读 | `mark_edit` |
| 快捷命令 | 定义并执行常用命令，定义持久保存 | `quick_command` |
| 插件同步 | 同步代码到 profile 并对齐权限 | `sync_plugin` |
| 上游更新 | 按 GitHub API 差异只覆盖装机目录的变动文件 | `sync_plugin` |
| 插件体检 | 静态检查装载链路，逐段列出静默失败 | `verify_plugin` |
| 前端模拟 | 生成并托管插件预览页 | `preview` |
| 后端模拟 | 本地跑插件服务端代码 | `minihost` |
| 隔离实例 | 起独立 DSH，随便装随便崩 | `test_env` |
| UI 骨架 | 静态解析 client.js，产出控件清单 | `ui_check` |
| GitHub 代理 | 装 GitHub 插件时走代理 | `github_mirror` |
| GitHub 下载 | 下载 GitHub 资源时自动选可用通道 | `github_download` |
| CIFS 写入修复 | 修挂载盘上写文件报权限错误 | `patch_cifs_write` |
| 工具清单 | 列出全部工具与排障索引 | `useful_tools` |

## 环境要求

| 宿主版本 | 运行时 | 平台 |
| --- | --- | --- |
| DSH 0.2.x | Node 20 / 22 / 24 | Linux、macOS、Windows |

## 用法

### 读 / 写门禁

```jsonc
mark_read  { commands: "cat,grep,head,sed,tail,awk" }    // commands 必填；不给则用预置清单
mark_read  { commands: "sed", undo: true }                // undo 可空；true = 从集合移除
mark_edit  {}                                             // 无参：查当前状态与自证计数
mark_edit  { enabled: false }                             // enabled 可空；false = 关闭自动续期
mark_edit  { paths: "a.js,b.js" }                         // paths 可空；补标没走 write/edit 的改动
mark_edit  { settleMs: 1200 }                             // settleMs 可空；缺省 1100，上限 2000
```

`mark_read` 的 `commands` 可传命令串、清单文件路径，或省略用预置清单。
`mark_edit` 的 `paths` 支持逗号/分号/换行分隔或 `@清单文件`；省略则不补标，只做状态查询。

### 插件开发

```jsonc
sync_plugin   { write: true, register: true }              // write 必填才真写；register 可空
sync_plugin   { write: true, hmr: true }                    // hmr 可空；true=启用热重载（缺省 dryRun 只报计划）
sync_plugin   { target: "<目录>" }                          // target 可空；给了就同步到该目录（缺省 local-plugins 旧行为）
sync_plugin   { fromGithub: "<owner/repo>", target: "<装机目录>" }  // 上游更新；不给 write 只报差异
verify_plugin { plugin: "<插件根>" }                        // plugin 可空；省略则巡检所有已装插件
minihost      { action: "start", plugin: "<插件根>" }        // action 可空，缺省 start
preview       { action: "gen", plugin: "<插件根>" }          // spec 可空，省略则自动挂载
preview       { action: "serve", file: "<预览页>" }          // backend 可空，省略则接最近一次 minihost
test_env      { action: "start", plugin: "<插件根>" }        // plugin 可空，省略则起裸环境
ui_check      { plugin: "<插件根>" }                         // write 可空，缺省 true
```

`minihost` 的 `services` 可空，用于注入宿主服务（`webServer` / `tools` / `storageDomain` / `sessions` / `llm` 已内置宽容桩，
`llm` 垫片会把 `registerAdapter` 的 providerIds 打进启动日志）；`env` 可空，用于覆盖子进程环境变量。
`test_env` 的 `kind` 可空（test / clean），`root` 可空（环境根位置）。
`sync_plugin` 的 `target` 可空——给了就同步到该目录（校验存在且是目录），省略则沿用「DSH_HOME → local-plugins/<插件名>」旧行为。
带 `target` 时比对源与目标各自 `package.json` 的 `name`，两边都有且不一致会拒绝（防止拿 A 插件源码覆盖 B 插件的运行时代码），确认无误再传 `allowMismatch: true`。
`fromGithub` 给了就切换为上游更新模式，按 GitHub API 的 blob sha 与本地目录比对，只覆盖变动文件（不 clone、不落 .git、不动多余文件）；
`ref` 可空（缺省远端默认分支）；返回的 `files` 只列变动文件，全量口径看 `totalCount` / `unchangedCount`；
真写前自动把被覆盖的旧文件备份到 `<DSH_HOME>/useful-tools/upstream-backup/`，更新记录写 `upstream-records/`。

### 环境修复与杂项

```jsonc
github_mirror     { action: "apply" }                                   // mirror 可省：按候选清单取第一个可用的
github_mirror     { action: "apply", mirror: "https://<代理>/" }         // 显式指定代理（dryRun 缺省 true）
github_mirror     { action: "apply", dryRun: false }                    // 探测通过后真写入
github_mirror     { action: "clear", dryRun: false }                    // 恢复直连
github_mirror     { action: "probe" }                                   // 只探测，不写配置
github_download   { url: "<GitHub 下载地址>" }                            // url 必填；channel 可空，缺省 auto
github_download   { url: "<地址>", dryRun: true }                        // dryRun 可空；true=只探通道不下载
github_download   { url: "<地址>", sha256: "<期望哈希>" }                  // sha256 可空；给了就校验
github_download   { url: "<地址>", channel: "direct" }                   // channel 可空；direct/mirror 只走单一路径
patch_cifs_write  { action: "check" }                                   // action 可空，缺省 check
patch_cifs_write  { action: "apply", dryRun: false }                     // dryRun 缺省 true
quick_command     { name: "logs", command: "tail -n 50 app.log" }        // name 必填
quick_command     { action: "list" }                                    // action 可空，缺省 run
useful_tools      { action: "help" }                                     // action 可空；tool 可空
```

`github_mirror` 的 `mirror` 可省——省略时按候选清单顺序自动取第一个可用的；仅当清单为空或全部停用才必须传。
`hosts` 可空（缺省 `github.com`）；`rotate` 可空（缺省 true，探测失败换下一个候选）。
探测不通的地址不会被写进候选清单，只在返回的 `rejected` 里告知。
`github_download` 的 `channel` 可空（`auto` 缺省：先探直连，不通再按候选清单轮换镜像；`direct` / `mirror` 只走单一路径）；
`savePath` 可空（缺省 `<cwd>/<URL 文件名>`），`cwd`、`mirror`、`timeoutMs` 可空；
`dryRun: true` 返回直连与各镜像的探测结果及推荐通道。
它只管「通过本工具下载」这条路径——用 bash 手敲 `curl` 不会被改写。
`patch_cifs_write` 的 `apply` / `revert` 需显式传 `dryRun: false` 才落盘。
`quick_command` 的 `cwd` 可空，省略则沿用宿主进程工作目录。

## 配置

`<DSH_HOME>/useful-tools/config.json`：

| 键 | 含义 |
| --- | --- |
| `observeHook` | 读命令集合钩子总开关，默认开 |
| `observeTools` | 读命令集合，填什么生效什么 |
| `editHook` | 写后自动续期开关，默认开 |
| `editSettleMs` | 写后复核延迟毫秒，缺省 1100 |
| `testEnvRoot` | 隔离实例的环境根 |

## 文档索引

- [机制说明](docs/机制说明.md)
- [契约](docs/CONTRACT.md)
- [版本记录](docs/VERSIONS.md)
- [未做事项](docs/NOT-DONE.md)
- [使用摩擦清单](docs/使用摩擦清单.md)

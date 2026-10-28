# dsh-useful-tools

DSH 插件开发与日常使用的小工具集：读/写观测、插件体检、前后端模拟、环境修复。

## 功能

| 功能 | 做什么 | 入口 |
| --- | --- | --- |
| 读命令集合 | 集合内命令读过的文件自动算已读 | `mark_read` |
| 写后自动续期 | 写改后自动补发观测，连续编辑免重读 | `mark_edit` |
| 快捷命令 | 定义并执行常用命令，定义持久保存 | `quick_command` |
| 插件同步 | 同步代码到 profile 并对齐权限 | `sync_plugin` |
| 插件体检 | 静态检查装载链路，逐段列出静默失败 | `verify_plugin` |
| 前端模拟 | 生成并托管插件预览页 | `preview` |
| 后端模拟 | 本地跑插件服务端代码 | `minihost` |
| 隔离实例 | 起独立 DSH，随便装随便崩 | `test_env` |
| UI 骨架 | 静态解析 client.js，产出控件清单 | `ui_check` |
| GitHub 代理 | 装 GitHub 插件时走代理 | `github_mirror` |
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
verify_plugin { plugin: "<插件根>" }                        // plugin 可空；省略则巡检所有已装插件
minihost      { action: "start", plugin: "<插件根>" }        // action 可空，缺省 start
preview       { action: "gen", plugin: "<插件根>" }          // spec 可空，省略则自动挂载
preview       { action: "serve", file: "<预览页>" }          // backend 可空，省略则接最近一次 minihost
test_env      { action: "start", plugin: "<插件根>" }        // plugin 可空，省略则起裸环境
ui_check      { plugin: "<插件根>" }                         // write 可空，缺省 true
```

`minihost` 的 `services` 可空，用于注入宿主服务；`env` 可空，用于覆盖子进程环境变量。
`test_env` 的 `kind` 可空（test / clean），`root` 可空（环境根位置）。

### 环境修复与杂项

```jsonc
github_mirror     { action: "apply", mirror: "https://<代理>/" }        // mirror 必填；dryRun 缺省 true
github_mirror     { action: "apply", mirror: "https://<代理>/", dryRun: false }
github_mirror     { action: "clear", dryRun: false }                    // 恢复直连
github_mirror     { action: "probe" }                                   // 只探测，不写配置
patch_cifs_write  { action: "check" }                                   // action 可空，缺省 check
patch_cifs_write  { action: "apply", dryRun: false }                     // dryRun 缺省 true
quick_command     { name: "logs", command: "tail -n 50 app.log" }        // name 必填
quick_command     { action: "list" }                                    // action 可空，缺省 run
useful_tools      { action: "help" }                                     // action 可空；tool 可空
```

`github_mirror` 的 `mirror` 必填，省略会直接报错；`hosts` 可空（缺省 `github.com`），
`rotate` 可空（缺省 true，探测失败自动换候选）。
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
- [未做事项](docs/NOT-DONE.md)

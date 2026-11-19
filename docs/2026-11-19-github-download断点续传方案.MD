# github_download 断点续传方案（2026-11-19）

> 状态：**已确认，实施中**。决策：① 默认开启，但只在确认支持 Range 的通道生效；② 只改 useful-tools，不动 dsh-git-push 的 clone 下载器。

## 门禁表

| 项 | 内容 |
|---|---|
| 任务 | 给 `github_download` 增加断点续传：中断后从已下字节继续 |
| 验收标准 | 中断一个 ~10MB raw 文件后重跑，第二次请求带 `Range: bytes=<have>-`、服务端回 206，最终字节数与 sha256 均正确 |
| 不做什么 | 不改镜像通道行为、不做多线程分段下载、不动 `dsh-git-push` 的 clone 下载器 |

## 一、现状（代码事实）

`lib/core/github-download/index.js` 的 `downloadOnce()`：

- `createWriteStream(savePath)` **覆盖写**，无 Range / 偏移 / append 概念
- 边写边算 sha256（`Transform` 里 `hasher.update`）
- 失败三条路径都 `rmSync(savePath)` 删掉半截文件
- 有 `expectedSha256` 校验（**只在调用方给了才校验**）

所以续传不是加个参数，是改写入模型。

## 二、为什么以前没做（那条注释的真实含义）

`index.js:120` 写着「不能用 Range 探测——实测 ghfast.top 不透传 Range，带 Range 请求会返回整个文件」。

2026-11-19 实测澄清：**那是镜像的问题，不是 raw 的问题**。

| 通道 | GET | Range |
|---|---|---|
| 镜像（ghfast.top 等） | 200 | ❌ 忽略 Range，返回整包 |
| `raw.githubusercontent.com` 直连 185.199.108.133 | 200 | ✅ 206 + `content-range: bytes 0-99/43029` |
| 同域 185.199.110.133 / 111.133 | 200 | ⚠️ Range 请求超时（GET 正常） |

⇒ 结论：**raw 直连可以续传**，但要**按「Range 是否返回 206」判据选路**，不能只测 GET。

## 三、设计

### 3.1 通道能力判定（`channels.js`）

`supportsResume(channel, url)`：

- `direct` + 目标域名是 `raw.githubusercontent.com` / `objects.githubusercontent.com` → 可续传
- `mirror` → 不可续传（实测不透传）
- 其它 → 不可续传（保守）

**默认只在可续传通道上启用**（已确认决策①），其余通道行为与现在完全一致。

### 3.2 状态文件

- 数据分片：`<savePath>.part`
- 指纹：`<savePath>.part.meta.json`，内容 `{ etag, totalBytes, savedBytes, url, updatedAt }`

为什么要指纹：远端文件可能已经变了（发布新版本覆盖同名资产），续传会把两个版本拼起来——**这是续传最容易出坏文件的地方**。指纹不一致 ⇒ 清 `.part` 重下。

### 3.3 下载主路径（`downloadOnce`）

```
有 .part 且指纹匹配 且 savedBytes < totalBytes
  → 请求带 Range: bytes=<savedBytes>-
     ├ 206 且 Content-Range 的 start == savedBytes → append 写，进度 = savedBytes + 本次
     ├ 200（服务端忽略 Range）        → 清 .part，回退整下
     └ 416（Range 越界，说明 .part 已完整）→ 直接进入完成校验
否则 → 走现有整下逻辑（行为不变）
```

### 3.4 完成校验（三个都要）

1. 字节数 == `Content-Range` 的 total（有则比）
2. 若调用方给了 `expectedSha256` → **重读整个文件**算 sha 比对（hasher 无法从中间续算，这是已知代价）
3. 通过后 `rename(.part → savePath)`，删 meta

### 3.5 失败语义（与现在相反，需在文档写清）

| 情形 | 现在 | 改为 |
|---|---|---|
| 传输中断 | 删文件 | **保留 `.part`**（下次续传） |
| sha256 不匹配 | 删文件 | 删 `.part` 与 meta（坏分片不能续） |
| 指纹不匹配 | —— | 删 `.part` 重下 |

### 3.6 并发保护

同一 `savePath` 同时两个任务写 `.part` 会交叉损坏：

- 进程内 `Map<savePath, token>` 互斥
- 落 `.part.lock`（含 pid + 时间戳）防跨进程
- 拿不到锁 → 返回可读错误「该文件已有下载任务在进行」

## 四、影响范围

| 文件 | 改动 |
|---|---|
| `lib/core/github-download/index.js` | `downloadOnce` 增 Range 分支；`executeDownload` 接入指纹与 rename |
| `lib/core/github-download/channels.js` | 新增 `supportsResume` |
| `lib/core/github-download/resume-state.js`（新） | `.part`/meta 读写、指纹比对、锁 |
| `lib/core/github-download/job.js` | 进度改为「已有 + 本次」 |
| `lib/shared/github_download/index.js` | 工具参数 `resume`（默认 true，但受通道能力约束）+ 回执 `resumedFrom` / `totalBytes` |
| `test/github-download-resume.test.mjs`（新） | 见验证方案 |

## 五、执行看板

| 步 | 内容 | 提交信息 |
|---|---|---|
| 1 | `supportsResume` + 单测 | `feat(download): 通道续传能力判定` |
| 2 | `resume-state.js`（meta 读写/指纹/锁）+ 单测 | `feat(download): 续传状态与指纹` |
| 3 | `downloadOnce` Range 分支 | `feat(download): Range 续传主路径` |
| 4 | `executeDownload` 编排接入 | `feat(download): 编排接入续传` |
| 5 | 工具参数与回执字段 + README | `docs(download): 续传参数说明` |

## 六、验证方案

单测（本地 http server，不碰真实网络）：

1. 206 续传成功（`.part` 10 字节 + 服务端 206 → 最终内容正确）
2. 200 时安全回退（服务端忽略 Range → 清 `.part` 重下，文件不翻倍）
3. 指纹变化（etag 变了 → 清 `.part`）
4. `.part` 已完整 → 不再请求，直接校验
5. 无 `.part` → 行为与改动前一致（回归）
6. 并发同路径 → 第二个被拒
7. `resume: false` → 完全走旧路径

集成：真实下 ~10MB raw 文件，中途 `kill`，重跑断言 `resumedFrom > 0` 且 sha256 与 `curl` 算的一致。

## 七、后续优化清单

- 多线程分段下载（Range 多段并发）
- 镜像通道续传（需镜像支持 Range）
- release 资产 302 跳到 `objects.githubusercontent.com` 后重定向链上的 Range 语义重新校验

## 八、决策记录

| 日期 | 决策 |
|---|---|
| 2026-11-19 | 默认开启，但只在确认支持 Range 的通道生效；只改 useful-tools |

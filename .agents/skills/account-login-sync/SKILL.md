---
name: account-login-sync
description: 同步 galaxy-spider 的微博账号登录态：完成网页端与移动端登录、校验真实会话并更新 GitHub Gist。用于“同步账号登录态”“刷新微博 Cookie”“更新 storageState”或线上登录失效后的恢复；仅排查日志、同步业务数据或其他网站登录不适用。
metadata:
  icon: '🔄'
  title: 微博账号登录态同步
---

# 微博账号登录态同步

将本地经过接口验证的微博登录态同步到 galaxy-spider 的既有 GitHub Gist，并回读确认。复用仓库现有脚本；运行不依赖 oo，不需要数据库。

## 定位与准备

1. 以包含本 skill 的 galaxy-spider 仓库为工作目录：从本 skill 目录 `.agents/skills/account-login-sync` 向上三级定位仓库根目录，使用 `git rev-parse --show-toplevel` 确认。用户明确指定其他 checkout 时，以其指定为准。读取适用的 AGENTS.md，不依赖个人机器的绝对路径或全局 skill 安装。
2. 核对 `package.json` 中 `storage:refresh`、`storage:fetch` 及对应脚本、`src/utils/storageState.ts`。以下步骤以这些入口仍存在且行为一致为前提；入口发生变化时按实际实现调整，不照搬旧命令。
3. 在仓库中检查 Node.js、pnpm、已安装的依赖、Playwright Chromium 与可用的图形界面。缺少依赖时复用锁文件安装；缺少 Chromium 时运行 `pnpm exec playwright install chromium`。Linux/WSL 检查 DISPLAY/WAYLAND_DISPLAY 是否配置；以浏览器实际能打开为准。
4. 从现有进程环境或项目 `.env` 获取 `GIST_ID`、`GIST_TOKEN`（也支持 `GITHUB_TOKEN`），以及可选的 `GIST_STORAGE_STATE_FILENAME`，默认文件名为 `weibo.storage.json`。只报告变量是否具备，不输出值。沿用线上已配置的 Gist，不创建新 Gist、不猜测目标；目标有歧义时再澄清。

已有凭据即继续。确实缺少时，让用户在本机环境或 `.env` 中配置后继续，不要求将 Token、Cookie、密码粘贴到聊天中。若缺少图形界面且没有可用的已授权浏览器，报告需要用户在有界面的机器上完成登录，不反复启动失败的浏览器。

## 刷新并同步

用户要求同步/刷新登录态时，登录、导出及更新既有 Gist 均在该任务范围内；仅要求检查或试运行时，只做相应检查。创建或阅读本 skill 本身不授权执行同步。

在仓库目录运行以下命令，**分配 TTY 并保留进程会话**：

```bash
umask 077
mkdir -p .cache
STORAGE_STATE_PATH=.cache/weibo-login-sync.storage.json pnpm storage:refresh
```

先用 `git check-ignore .cache/weibo-login-sync.storage.json` 确认输出被忽略；若不被忽略则使用仓库外的私有临时目录，并将同一绝对路径传给上述命令和后续校验。保留已有的同名登录态时使用新的私有文件名。不要覆盖工作区中已跟踪或用户正在使用的登录态文件，不读取文件原文来展示结果。

该脚本会启动新的、有界面的浏览器上下文，流程是：

1. 打开 `https://weibo.com/`，等待网页端登录。
2. 第一次确认后打开 `https://m.weibo.cn/`，等待移动端登录。
3. 第二次确认后验证移动端 `/api/config` 的 `data.login === true`，以及网页端 `/ajax/statuses/mymblog` 的 `ok === 1` 且 `data.list` 为数组。
4. 两项接口校验通过后保存 storageState，并通过 `updateStorageStateToGist` 更新目标 Gist 中指定的文件。

扫码、密码、短信验证码交给用户完成。在每个“按回车继续”的提示处，告诉用户当前等待哪一端登录；用户表示完成后，通过保留的会话发送回车。若工具能可靠确认已登录，也可继续。不要在未完成登录时提前发送两个回车。等待用户期间保留进程，不把等待说成成功或重复启动登录窗口。

**不要以无 TTY 模式运行交互登录。** 当前脚本在非 TTY 下每端仅等待默认 180 秒，然后自动继续校验，不能替代用户完成登录的信号。

## 回读验证

脚本退出码为 0 且确认保存、上传成功后，在同一仓库、同一组 Gist 配置下下载至另一个私有文件：

```bash
umask 077
STORAGE_STATE_PATH=.cache/weibo-login-sync.roundtrip.storage.json pnpm storage:fetch
cmp -s .cache/weibo-login-sync.storage.json .cache/weibo-login-sync.roundtrip.storage.json
```

若前一步改用了其他路径，相应替换两处路径。若回读文件已存在，使用新的私有文件名。必要时将两个文件权限收紧到 0600。`cmp` 只检查退出码，不输出差异；差异可能包含完整 Cookie。内容不一致时停止，检查目标、并发更新及文件名，不自动覆盖远端重试。

区分三个结论：

- **登录有效**：刚才网页端和移动端真实接口校验均通过。
- **同步完成**：Gist 更新成功且回读文件与本地导出一致。
- **线上恢复**：必须有后续真实线上执行成功的证据，不能由前两项推断。

`storage:fetch` 只校验 Cookie 结构、域名及声明的过期时间；下载成功不等于微博服务器仍认可会话。

只在用户要求重跑/验证线上任务时触发 GitHub Actions。届时核对 workflow 实际定义：Producer 会采集并写数据库，Consumer 会上传媒体并写数据库，均超出单纯同步登录态的步骤。若已获授权，则先验证 Producer，再按任务范围处理 Consumer，不额外重复索要授权。

## 失败处理

- **登录失败或接口返回登录页**：不宣布同步完成。检查失败的是网页端还是移动端，在用户重新登录后验证；不要把 `SUB` 尚未到期当成有效会话证据。
- **HTTP 403/418/429/432**：停止持续重试。记录状态码和接口类型，不输出 Cookie 或带凭据的完整 URL。若同一登录态本地成功而 Actions 失败，说明运行环境可能被风控，需要进一步对比，不能断言只有 Cookie 过期。
- **Gist 更新失败**：本地文件可能已经保存。保留私有文件，报告“本地已保存、远端未同步”，只排查目标或权限；不要无谓要求重新扫码，也不要创建新的 Gist 绕过问题。
- **回读失败**：如实报告已上传但未完成回读确认，不声称同步已经验证。
- **日志泄密风险**：仓库脚本在 Gist 更新失败时可能打印响应正文；转述前过滤 Token、Cookie、storageState 原文及含凭据的 URL。不提交、上传到公开位置或发送这些文件。
- **线上仍有其他报错**：50 MB 视频上限、Prisma 更新异常、帖子数据格式异常均需单独诊断；不能承诺刷新登录态会修复这些问题。

## 交付

简短说明两端登录是否校验、Gist 是否更新且回读一致，以及是否实际验证线上恢复。仅给出需要保留的私有文件路径和剩余阻塞，不展示登录态内容。不要因完成同步而自动提交代码、发布 skill 或修改线上 Secrets。

---
title: Windows 内存增长
description: 为什么 bun 进程在 Windows 上会增长到数 GB 内存，opencodex 目前对此做了什么，以及在上游 Bun 修复发布前你可以怎么做。
---

一些 Windows 用户会看到，opencodex 背后的 `bun` 进程在长时间流式会话期间增长到数 GB 的 RSS（已作为问题 [#314](https://github.com/lidge-jun/opencodex/issues/314) 报告）。本页会如实解释实际发生了什么，以及你可以采取什么措施。

## 根因：上游 Bun 运行时问题

opencodex 打包了 Bun 运行时（当前为 **1.4.0**）。历史上的内存增长与已知上游 Bun 问题有关，而不是代理中的 JavaScript 级泄漏：

| Bun issue | 状态（检查于 2026-07-23） |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` 接收背压未与 JS 消费关联 | 已由 [PR #29831](https://github.com/oven-sh/bun/pull/29831) 修复，并在 Bun 1.4.0 发布前合并；仍需持续观察真实工作负载 |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — 当客户端中止一个 async-pull 流时发生崩溃 | 修复 [PR #32120](https://github.com/oven-sh/bun/pull/32120) 已包含在 Bun 1.4.0 中，因此 Windows 的 `auto` 门控会允许 bounded relay。原始崩溃**并非 Windows 特有** |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` socket 句柄泄漏 | 在上游仍然**开放** |

旧版 Bun 1.3.14 必须使用保守流路径以避开 #32111。当前捆绑的 Bun 1.4.0 会在 Windows 上自动启用 bounded single-reader relay。

## opencodex 目前做了什么

Bun 1.4.0 会启用更安全的 Windows 流路径，同时继续保留有界缓解和可见性；这并不代表所有内存增长场景都已修复：

- **内存监视器** — 代理每分钟采样一次自身内存，并在观测到的内存超过 4 GiB 时记录限频告警。观测到的内存取 RSS、`external` 和 `arrayBuffers` 三者中的最大值（不是它们的总和），因为 Windows 的工作集/RSS 计数可能低报已提交的外部保留。
- **`ocx doctor`** — `"Memory / runtime"` 部分会显示*服务*进程的 Bun 版本、RSS、external/ArrayBuffers 计数、JS 堆上下文以及流模式决策。单看 `heapUsed` / `jscHeap` 不能作为泄漏判据；应把观测到的内存与 `responseState` 以及多次采样一起比较。
- **`GET /api/system/memory`** — 通过已认证的管理 API 提供同样的数据，便于仪表板或脚本使用。除了 RSS/heap/external 计数之外，它还会报告一个标量的 `responseState` 块（条目数、序列化总字节数/最大字节数、最老条目的年龄），对应代理内存中的 `previous_response_id` 续接存储。这能进一步归因增长：在观测到的内存上升时，如果 `responseState.totalBytes` 也在上升，说明是对话保留在增长（较长的 `store:false` 链在每轮中重新扩张）；而在观测到的内存上升时，如果 `responseState` 保持平稳，则更像不是这个存储造成的。返回值只包含标量，不包含请求正文、token、路径或账户标识，而且读取没有副作用（不会执行 prune，也不会 evict）。仪表板中的 **Memory observability** 卡片会渲染相同字段，并提供一个需要确认的 **Drain & restart** 操作：它会显示当前活动轮次数量，最多等待 60 秒让活动轮次结束（复用现有的 503 + `Retry-After` 排空机制），然后中止剩余轮次，并通过 `ocx start` 在当前端口重启代理（或者在仅故障时由服务监督程序重新拉起），同时不拆除 Codex 注入。这是一种比 `POST /api/stop` 的短排空更长、更知情的回收方式。
- **有门控的替代流路径** — 一种消除无界缓冲形态的有界单读者中继。Bun 1.4.0 已包含 #32111 修复，因此 Windows 的默认 `auto` 会选择这条路径；macOS 仍需显式启用。

这些改动带来的真实世界 RSS 改善，仍在等待 Windows 用户验证，我们并不宣称泄漏已经修复。

基于阈值的自动重启是刻意不提供的。如果进程崩溃，服务管理器（Task Scheduler/WinSW、launchd、systemd）已经会把它重启。

## 你的选择

1. **使用捆绑的 Bun 1.4.0。** Windows 会自动启用更安全的流路径；macOS 仍需显式启用。

2. **通过 `OPENCODEX_BUN_PATH` 运行你信任的 Bun 运行时。** 这属于未验证区域，你是在一个我们没有测试过的运行时上运行 opencodex，风险自负。对服务安装而言，这个覆盖值是在生成服务产物时读取的，而不是在服务启动时读取的。先设置环境变量，然后在同一个 shell 中重新运行 `ocx service install`，这样路径才会被写入持久化的服务定义。只设置环境变量对已经安装好的服务没有任何作用。

3. **可通过 `streamMode: "eager-relay"` 显式选择有界中继。** 可编辑 `config.json` 或调用管理 API，无需重启即可应用到新轮次。**旧版运行时警告：** Bun 1.3.14 仍有 #32111 风险。`"legacy-tee"` 会固定保守路径。Windows Bun 1.4.0 的 `"auto"` 会选择 bounded relay，而 macOS 的 `"auto"` 仍保持 tee。

如果你在真实的 Windows 工作负载上尝试这些方案，请把变更前后 `ocx doctor` 的内存部分发到 [#314](https://github.com/lidge-jun/opencodex/issues/314)——这正是这个缓解措施在等待的验证。

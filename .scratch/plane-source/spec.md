# Plane Source — Spec

Status: ready-for-agent

协议事实以设计文档 [docs/009-plane-source.md](../../docs/009-plane-source.md) 为准（2026-11-12 对照 Plane 官方开发文档核实，含逐条出处）。术语沿用 [001 Domain model](../../docs/001-domain.md)。实施已拆成 `issues/` 下 01–10 张票，本 spec 是它们的共同上游。

## Problem Statement

团队的日常项目管理在 Plane（plane.so）上进行：需求、讨论、决策都以工作项（work item）及其评论承载。但智能体目前只接 GitHub 和飞书两个 Source——人在 Plane 里向智能体提要求，没有任何途径被听见；智能体的产出也回不到 Plane 的讨论串里。团队被迫在 Plane 之外再开一个对话渠道来驱动智能体，讨论与执行割裂。

## Solution

给 dsh-superagent 增加第三种 Source kind：`plane`。人在 Plane 工作项下写一条评论，智能体就开出一张工单，在自己的 session 和目录里干活，然后在同一个 Plane 讨论串里回复。Plane 的读写一律走本机已装的 Plane MCP server（`mcp__plane__*`），不手写 REST 客户端；触发走 Plane workspace webhook v2，由反向代理把公网地址转到 superagent 的回环端口。

## User Stories

1. 作为团队成员，我想在工作项下写一条评论就让智能体开工，这样我不用离开 Plane 就能派活。
2. 作为团队成员，我想让智能体把回复直接发在我评论的那个讨论串里，这样讨论与执行留在同一处。
3. 作为团队成员，我想让智能体的后续回复挂在我那条触发评论之下，这样对话的线索不断。
4. 作为团队成员，我想在 Plane 重试投递时不会开出第二张工单，这样网络抖动不会变成重复劳动。
5. 作为团队成员，我想让智能体忽略它自己发的评论，这样它不会自问自答无限循环。
6. 作为团队成员，我想让未监听项目的事件被安静收下但不开工单，这样接入一个项目不会意外惊动别的项目。
7. 作为团队成员，我想在 `listen: all` 的项目里，非名单成员的评论也被智能体观察到，这样它可以被评估为推断出来的候选。
8. 作为团队成员，我想让名单内成员的任意评论都算明确请求，这样派活不需要记额外的口令或 @ 语法。
9. 作为面板用户，我想在准入表里看到 Plane 用户的人名而不是裸 UUID，这样我能认出谁能派活。
10. 作为面板用户，我想为每个受监听项目看到一行准入表，这样每个项目的授权状态一目了然。
11. 作为面板用户，我想在 MCP 服务器没起来时看到 Source health 转 `error`，这样我知道读写不可用而 webhook 仍在收。
12. 作为面板用户，我想在验签失败时看到 health 告警计数，这样我能发现有人在乱敲端点或密钥配错。
13. 作为面板用户，我想在被 Plane 停用 webhook 时通过 health 条目得知，这样我能及时去 Plane 重新启用。
14. 作为面板用户，我想让被 scope 过滤的事件按 filtered 落库并记下原因，这样面板能解释"为什么这张评论没开工单"。
15. 作为评估者，我想让评估一张 Plane 工单时读到工作项本身（标题、状态、优先级、纯文本描述）及其全部评论，这样智能体的判断有完整上下文。
16. 作为评估者，我想让线程上下文按时间从早到晚、以游标翻页返回，这样长讨论串也能被有界地读取。
17. 作为评估者，我想让上下文读取在准入预算（默认 15 秒）内完成，这样评估不会被 MCP 往返拖死。
18. 作为 worker，我想通过 `plane/<trigger-id>/…` 资源读 Plane 原始记录，这样我能像读 `feishu/…` 一样查证细节。
19. 作为 worker，我想拿到一份内置的 plane skill 教我用 `mcp__plane__*` 工具，这样我不必猜工具名和参数。
20. 作为 worker，我想让执行环境带上 `DSH_SUPERAGENT_PLANE_WORKSPACE` / `PROJECT` / `WORK_ITEM`，这样我知道自己在为哪个工作项干活。
21. 作为运维，我想把接收端挂在 DSH web server 上由 nginx 反代暴露，这样不用新开对外端口。
22. 作为运维，我想让验签用原始请求字节做定时安全比较，这样重新序列化过的 JSON 也骗不过验签。
23. 作为运维，我想在缓冲请求体之前按固定上限拒绝超长请求，这样端点不会被大 body 打爆。
24. 作为运维，我想让被 scope 过滤掉的未知事件也回 2xx，这样不会因为不想要的事件烧掉 Plane 的五次重试配额。
25. 作为运维，我想只在 Trigger 落库失败时回 5xx，这样 Plane 的重试恰好覆盖真正需要重试的情况。
26. 作为运维，我想让 webhook 密钥留在 Source 配置里、API key 留在 MCP 连接的 env 里，这样凭据各有其位、API key 不进设置页。
27. 作为运维，我想让改动 webhook 密钥触发 superagent 重启（与 GitHub/飞书账号一致），这样密钥变更必然生效。
28. 作为运维，我想在 setup 检查里区分密钥未设、MCP 未就绪、就绪三种状态，这样部署问题在面板上可读。
29. 作为运维，我想让事件名归一化同时接受点号式和 Python 枚举式，这样 Plane 文档示例里的枚举字符串不会打穿接收端。
30. 作为运维，我想让 Plane 限流（429）时遵守 `Retry-After` 再交给 Outbox 退避，这样回复不会在限流期间狂发。
31. 作为运维，我想让工作项不再接受评论（404）映射成 `gone` 停止重发，这样已关闭的工作项不会无限重试。
32. 作为运维，我想让新建工作项可选地也开一张工单（默认关闭），这样团队可以渐进地扩大触发面。
33. 作为运维，我想让每个用到的 DSH profile 各自拉起自己的 MCP 子进程（连接记录全局共享），这样两个 profile 互不牵连。
34. 作为运维，我想在 Plane 侧看不到 5xx（除真落库失败），这样 webhook 不会被 Plane 停用。

## Implementation Decisions

**模块划分**（与 009 设计一致）：

- 一个 Source kind 模块：kind 定义（`schema`、`fields`、`health`、`facts`、`scope`、`channel`、`threadContext`、`policy`、`environment`）与 Cordis 插件入口。
- 一个 HTTP 接收端模块：原始请求体、验签、事件路由、状态码；注册在 DSH web server 的 `/plane/webhook` 上（方案 A，反向代理），不新开监听端口。
- 一个 MCP 适配层模块：把内部调用（读工作项、列评论、发评论、取名单）翻译成工具执行调用，并归一化返回形状。其余代码只依赖它的内部接口——工具名即契约，版本变化时只改这一个模块。
- 一个 Trigger 归一化模块：v2 载荷 → Trigger；丢弃智能体自己的评论；事件名归一化（点号式与枚举式都接受）。
- 一个 channel 模块：以评论形式幂等地发出回复；拼工作项链接。
- 一个读模块：为评估读取工作项及其评论；提供 `plane/<trigger-id>/…` 读资源。

**已取消**：手写 REST 客户端。MCP 覆盖读写需要；若将来 MCP 不可用需要退路，单独加回，不与主路径混在一起。

**工具执行能力的桥接**：`SourceChannel.send` 与 `ThreadContext.read` 只拿得到 CLI 命令端口、拿不到工具注册表；kind 不能是纯静态常量，插件启动时以工厂闭包把工具执行能力注入 kind 的回调。所有 MCP 调用收进适配层，适配层是唯一出网点（测试也在这一个边界替身）。

**领域映射**：

- Trigger id 由 `event_id` 经既有 key 机制得出——重复投递得到 `duplicate`，重试绝不会开出第二张工单。
- Thread 为 `plane:<project_id>:<work_item_id>`；该工作项下的评论就是这个 Thread。
- Channel 地址四元组：`workspaceSlug`、`projectId`、`workItemId`、`commentId`。
- 回复落点：该工作项的评论串；作为后续回复时用 `parent_id` 挂到触发它的那条评论下。
- Human 排除：智能体自己（API key 所有者，经 member me 取得）的评论被丢弃——这同时切断了回复环路。

**触发规则（已选规则 1）**：受监听项目里，名单内成员的任意评论即明确请求，`addressed` 置 `direct`，actor 取评论的 `actor_id`。名单外成员在 `listen: all` 的项目仍被观察，由准入表决定其能否成为推断出来的候选（与飞书两步机制相同）。

**安全**：

- 验签用原始请求字节配合 `crypto.timingSafeEqual` 校验 `X-Plane-Signature`；不匹配回 403（Plane 不重试）。
- 缓冲请求体之前按固定上限拒绝超长请求。
- 每一个被接受的事件都回 2xx，包括被 scope 过滤掉的；只有 Trigger 没能落库时才回 5xx。
- API key 不进设置页：留在 MCP 连接的 env 里，superagent 只保存 webhook 密钥。

**回复**：

- 经 MCP `workitem_comment` create 发出；Plane 收 HTML——channel 负责转义并按段落包裹纯文本消息。
- 幂等原生具备：`message.id` 作 `external_id`，`external_source` 固定为 `dsh-superagent`。
- 失败分类：工作项不再接受评论（404）映射成 `gone`；其余失败抛错，交给 Outbox 退避重试；429 遵守 `Retry-After`。

**线程上下文**：评论经 `workitem_comment` list 以 cursor 分页读取；工作项经 `workitem` retrieve 取 `description_stripped`（纯文本）与标题、状态、优先级；按时间从早到晚以 ContextMessage 行给出。

**策略与准入**：kind 的策略形状沿用飞书：`allowed` 存 Plane 用户 UUID（比较忽略大小写）、`unnamed` 显示标签、每个受监听项目一行准入表行；`refreshLabels` 经 member `list_workspace` 把 UUID 解析成名字存进 KV；刷新循环兼作 MCP 健康探针。

**配置**（Source 实例配置，与 GitHub/飞书账号并列）：`secret`（webhook 密钥，属 SETUP_FIELDS，改动触发重启）、`mcpServer`（工具命名空间，默认 `plane`）、`projects`（id/name/listen 行）、`workItemCreated`（默认关）。Plane 实例地址、workspace slug、API key 不在这里——属于 MCP 连接。

**执行环境**：`DSH_SUPERAGENT_PLANE_WORKSPACE`、`DSH_SUPERAGENT_PLANE_PROJECT`、`DSH_SUPERAGENT_PLANE_WORK_ITEM`（工单不是来自 Plane 时为空）。

**KV**：plane 命名空间（labels、seen）条目。

**注册**：独立构建入口 + package 导出 + profile patch 默认禁用（与飞书一致）；部署检查以"MCP 工具已注册"为 MCP 就绪判据。

**worker 的 MCP 写权限（待定，在对应实施票里敲定）**：工具是进程级全局注册的，worker 默认可见 `mcp__plane__*`（含 update/delete/archive）。三选一：只读工具集、只读加评论 create、全套加工具白名单。取舍原则是现有 worker preset 的收窄惯例（连 web fetch 都没给）。

## Testing Decisions

**什么是好测试**：只测外部行为，不断言内部实现。可观察的效果是——Store 里的 Trigger/Thread/Ticket/收据、HTTP 状态码、HealthBoard 条目；替身只出现在依赖边界（MCP 工具执行、出站消息投递）。

**Seams（两个既有模式的复用，全部落在新测试文件 tests/plane.spec.ts）**：

1. **主 seam — SourceContext/Engine 边界**：真实 Store（临时目录）+ SourceRegistry + HealthBoard + Engine（替身 assessor/executor/outbox）+ `sourceContextOf`，prior art 是 tests/sources.spec.ts 的 `host()` 模式。覆盖：Trigger 归一化与 `event_id` 去重、scope 过滤与两步准入、channel 幂等发送（断言 `external_id` 等于消息 id、404→gone、其余抛错）、threadContext 分页与行序、refreshLabels、插件 apply 注册 kind。MCP 依赖在适配层的工具执行边界替身（与 sources.spec.ts 里 spy `Commands.run` 同风格）。
2. **次 seam — webhook 路由 handler**：假 webServer 捕获注册的 handler、喂原始字节 chunk 与 headers、断言状态码与下游落库效果（与主 seam 共享 Store），prior art 是 tests/http.spec.ts 的 `serve()` 模式。覆盖：验签矩阵（合法通过/篡改 403/缺头 403/重序列化失败）、超长体拒绝、事件名两种形态、被过滤事件 2xx + filtered 落库、未知事件 2xx 忽略、落库失败 5xx。

**prior art**：tests/sources.spec.ts（Source kind 全部行为的驱动方式）、tests/http.spec.ts（假 webServer 与状态码断言）、tests/feishu-read.spec.ts（读资源的测试形状）。

## Out of Scope

- 触发规则 2（正文约定标记如 `@dsh`）与规则 3（读 `comment_html` 找 mention 标记）——留作配置项，团队日后需要时再加。
- Plane Agents（beta）路线：OAuth bot 用户 + `agent_run_activity`——形态与 Source 契约不匹配，留作"只做 @ 提及"人设的补充。
- 手写 REST 客户端与 MCP 不可用时的 REST 退路。
- 网络方案 B（插件内独立监听端口）与 C（轮询兜底）——A 已选，B/C 留档不做。
- Plane MCP server 自身的上游修复（uvx 路径是运维前置，见 issues/01，不是本 spec 的代码工作）。
- 与 GitHub issue 的双向同步、工作项生命周期结束工单的收窄策略（设计文档待定问题 2/3，实现期间另行敲定）。

## Further Notes

- 两个实现要点来自代码探索，已体现在上面的模块决策里：kind 的 channel/threadContext 回调需要工厂闭包桥接工具执行能力；webhook handler 自读原始请求字节（带 上限），不需要对共享 HTTP 代码做前置重构。
- 两套连接、两份进程：MCP 连接记录在全局存储、两个 profile 共用；但每个 DSH 进程各自拉起自己的 MCP 子进程——验证时每个 profile 都要单独确认。
- 落地顺序按 issues/ 的依赖编号推进：01（运维修 uvx）→ 02（kind/配置面）→ 03（接收端 + Trigger，核心 tracer bullet）→ 04/05/07/08 并行 → 06（skill）→ 09（上线）→ 10（文档收尾）。
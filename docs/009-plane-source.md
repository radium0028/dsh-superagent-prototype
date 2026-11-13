# 009 Plane Source：把 Plane 接入 dsh-superagent

状态：已实现（integration branch `plane-source`）。触发规则 1 与网络方案 A 按原设计落地；worker 写权限待定问题 1 的取舍记录在 tickets 与 skill 文本里。

运维已经定下影响代码形态的决定，见[已定决定](#已定决定)；还剩几个未定，见[待定问题](#待定问题)。

## 这份文档要做什么

dsh-superagent 在 `github` 和 `feishu` 之外，再增加第三种 Source kind，名为 `plane`。人在 Plane 的工作项（work item）
下写一条评论，就可以让智能体干活；智能体开出一个 Ticket，在自己的 session 和目录里干活，然后在同一个 Plane
讨论串里回复。

本文档定下协议事实、领域映射、模块划分，以及写代码之前运维必须做出的决定。术语沿用
[001 Domain model](001-domain.md)，做法沿用 [008 Cookbook](008-cookbook.md)。

## 三套协议

以下事实均于 2026-11-12 对照 Plane 官方开发文档核实，并逐条给出出处链接，方便读者复核。

### 1. Webhook 投递 —— workspace 级 webhook，v2

出处：<https://developers.plane.so/dev-tools/intro-webhooks>

| 事实 | 取值 |
| --- | --- |
| 作用范围 | workspace 级。一个 webhook 覆盖该 workspace 下的所有项目，没有"按项目配置 webhook"这回事。 |
| 谁可以创建 | Workspace Owner 和 Admin。 |
| 方法与内容类型 | `POST`，`Content-Type: application/json`。 |
| 请求头 | `User-Agent: Autopilot`、`X-Plane-Delivery`（每次投递尝试一个 UUID）、`X-Plane-Event`（事件类型）、`X-Plane-Signature`。 |
| 签名 | `X-Plane-Signature` 是 `HMAC-SHA256(secret, 原始请求体)` 的 hex 摘要。必须用**原始字节**做**定时安全**比较，绝不能对重新序列化过的 JSON 比较。 |
| 密钥 | 形如 `plane_wh_…`，创建时只显示一次（以 CSV 下载），可在编辑表单里重新生成。重新生成后旧密钥立即失效。 |
| 成功 | 任意 `2xx`。 |
| 失败 | `4xx` 视为刻意拒绝，**不会**重试；`5xx` 会以约 10 分钟为基准加抖动做指数退避重试，**累计 5 次失败后 Plane 会停用该 webhook** 并给创建者发邮件。 |
| Payload URL | 原文："It must be a publicly reachable `http://` or `https://` address. Local addresses (localhost, private IPs) are not accepted."（必须是公网可达的 `http://` 或 `https://` 地址，不接受 localhost、私有 IP 等本地地址。） |

载荷结构（v2）：

```json
{
  "version": "v2",
  "delivery_id": "<uuid，每次尝试都不同>",
  "event_id": "<uuid，重试之间保持不变>",
  "entity_id": "<主实体的 uuid>",
  "entity_type": "issue",
  "event": "workitem.comment.created",
  "webhook_id": "<uuid>",
  "workspace_id": "<uuid>",
  "data": {},
  "previous_attributes": {}
}
```

`event_id` 是去重键：它标识"这件事"，而 `delivery_id` 标识"一次尝试"。重试投递时 `event_id` 不变、`delivery_id` 换新。

创建和更新事件的 `data` 带完整实体，删除事件为 `{}`。评论事件的 `data` 带工作项和这条评论：

```json
{
  "id": "<工作项 id>",
  "name": "<工作项标题>",
  "comment": {
    "id": "<评论 id>",
    "access": "INTERNAL",
    "actor_id": "<Plane 用户 uuid>",
    "issue_id": "<工作项 id>",
    "edited_at": null,
    "comment_stripped": "<纯文本>"
  }
}
```

工作项事件的 `data` 就是工作项对象本身：`id`、`name`、`project_id`、`workspace_id`、`state_id`、`priority`、
`assignee_ids`、`created_by_id`、`updated_by_id`、`created_at`、`updated_at`、`sequence_id`、`description_json`。

事件名是点号式：`workitem.created`、`workitem.updated`、`workitem.archived`、`workitem.deleted`、
`workitem.comment.created`、`workitem.comment.updated`、`workitem.comment.deleted`、`workitem.link.*`、
`workitem.vote.*`、`workitem.attachment.*`、`workitem.relation.*`、`workitem.dependency.*`、`workitem.page_link.*`、
`page.comment.*`、`page.*`、`project.*`、`cycle.*`、`module.*`、`milestone.*`。

实现必须扛住的两个坑：

- Plane 自己的文档示例里，`"event"` 的值是 `"WebhookScope.ScopeChoices.WORK_ITEM_UPDATED"`——Python 枚举成员的原样
  字符串，而不是点号式名称。接收端必须先归一化事件名（点号式与枚举式都接受），不能只匹配一个字面量。
- 评论载荷只有 `comment_stripped`（纯文本），没有 `comment_html`，因此**光看载荷无法判断有没有被 @**。见
  [触发判定](#触发判定)。

### 2. Plane MCP —— 首选的 API 层

本机已装 Plane 的官方 MCP server。下面是 2026-11-12 对本机 `plane` 连接实测得到的结论，不是转述文档。

| 事实 | 取值 |
| --- | --- |
| 服务器 | `Plane MCP Server (stdio)`，版本 3.2.0；底层 `plane_sdk` 0.3.1。 |
| 工具面 | **30 个工具、合计 207 个 action**。一个工具对应一类资源，`action` 参数选具体操作。 |
| 公开工具名 | `mcp__plane__<工具名>`，例如 `mcp__plane__workitem`、`mcp__plane__workitem_comment`。 |
| 部署方式 | stdio，`uvx plane-mcp-server stdio`。凭据在环境变量里：`PLANE_API_KEY`、`PLANE_WORKSPACE_SLUG`、`PLANE_BASE_URL`。 |
| 已验证读调用 | `project` action=`list` 返回工作区 `qb` 下的项目 `QB`「山岬健康电子处方」，分页信封为 `total_count` / `next_cursor` / `results`。 |

与本接入直接相关的工具：

| 工具 | action | 说明 |
| --- | --- | --- |
| `workitem` | list, list_archived, retrieve, retrieve_by_identifier, search, count, create, update, delete, archive, manage_assignee, manage_label | 支持 `pql` 过滤、`fields`、`expand`、`external_id`；可读 `description_stripped`（纯文本描述）。 |
| `workitem_comment` | list, retrieve, create, update, delete | **带 `comment_html`、`access`、`external_id`、`external_source`**。 |
| `member` | me, list_workspace, list_project, list_roles, retrieve_role | 只读；给出 Plane 用户 id 与显示名、邮箱。 |
| `workitem_activity` | list, retrieve | 只读；工作项的活动流。 |
| `state` | list, retrieve, create, update, delete | 工作流状态，`group` 区分 backlog / started / completed 等。 |
| `project` | list, retrieve, create, update, delete, archive, unarchive, worklog_summary, get_features, update_features | 项目。 |
| `get_pql_reference` | —— | 只读；取 PQL 语法说明（`detail` 取 `brief` 或 `full`）。 |

其余 23 个工具覆盖 cycle、module、milestone、page、label、release、release_tag、release_label、initiative、intake、
collection、customer、customer_property、customer_request、template、work_log、workitem_link、workitem_relation、
workitem_type、workitem_property、workitem_attachment、project_estimate、workspace。

MCP 相对手写 REST 客户端有四个实质好处：

1. **回复幂等原生具备**。`workitem_comment` 的 create 直接接受 `external_id` 与 `external_source`，正是 REST
   那套"最多发一次"的机制，不必自己造。
2. **PQL**。可以在 Source 侧按 `state_group`、`priority`、`assignee_id` 等条件过滤工作项，不必自己拼 REST 查询。
3. **名单与活动流**。`member` 让准入名单能显示人名，`workitem_activity` 能还原工作项上发生过什么。
4. **worker 白拿整个 Plane 能力面**。MCP 工具是**进程级全局注册**（`ctx.tools.register()` 不带 scope），所以
   superagent 的 worker session 直接就能用 `mcp__plane__*`，不必在 dsh-superagent 里再实现一遍读写。

### 3. REST API v2 —— MCP 之下的那层协议

出处：<https://developers.plane.so/api-reference/v2/authentication> 与
<https://developers.plane.so/api-reference/v2/work-item-comments/create-comment>

MCP 之下仍然是 Plane 的 REST API。做主设计时不需要手写它，但要知道它，因为 webhook 载荷的字段名、错误码语义和
幂等语义都源于此。

| 事实 | 取值 |
| --- | --- |
| 基础 URL | Plane Cloud 是 `https://api.plane.so/api/v2/`，自建实例是 `https://<你的域名>/api/v2/`。 |
| 鉴权 | `X-Api-Key: <personal access token>`（v1 文档写作 `X-API-Key`；HTTP 头名不区分大小写）。也可以用 OAuth bearer token。 |
| 谁是我 | `GET /api/v2/users/me/` 返回当前鉴权身份对应的用户。 |
| 评论列表 | `GET /api/v2/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/comments/` |
| 新建评论 | 同一路径上的 `POST`。请求体：`comment_html`（必填，**HTML**）、`access`（`INTERNAL`/`EXTERNAL`）、`parent_id`、`external_id`、`external_source`。返回 `201`。 |
| 修改评论 | 同一路径上的 `PATCH`。 |
| 读取工作项 | `GET /api/v2/workspaces/{slug}/projects/{project_id}/work-items/{work_item_id}/` |
| 更新工作项 | 同一路径上的 `PATCH`。 |
| 幂等 | 评论**不去重**。Plane 提供 upsert 端点，以及 `external_id` + `external_source` 查询（`GET …/comments/?external_id=…&external_source=…`），供集成方保证最多只发一次。 |
| 错误 | RFC 9457 `problem+json`。`401` 凭据无效，`403` 角色或 scope 不足，`404` id 不存在**或跨租户**，`409` 写入冲突，`429` 触发限流（须遵守 `Retry-After`）。 |
| Scope | `projects.work_items.comments:read` / `:write`，`projects.work_items:read` / `:write`。API key 是个人访问令牌，带**创建者全部**权限；OAuth token 则受 scope 限制。 |

### 4. 另一条路：Plane Agents

Plane 还提供 **Agents**（beta）：把一个开启了 "Enable App Mentions" 的 OAuth 应用安装进 workspace，它就会变成一个
bot 用户，人们可以在工作项评论里 @它。Plane 随后发一个 `agent_run_activity` webhook，并期望智能体把活动回传
（`thought`、`action`、`response`，其中 `response` 会变成一条可见评论）。

出处：<https://developers.plane.so/dev-tools/agents/overview>

这条路更"原生"，但形态与 dsh-superagent 不匹配：触发条件变成"@某个 bot 用户"，而不是"人向智能体提要求"；回复变成
Agent Run 活动，而不是普通评论；OAuth 应用注册只在 Plane Cloud 和商业版上可用。workspace webhook 这条路与版本无关，
且能直接对上 Source 契约，因此作为主设计。Agents 可以留作日后"只做 @ 提及"人设的补充。

## 领域映射

| 概念 | 在 Plane 中对应什么 |
| --- | --- |
| Trigger | 一条工作项评论（主要来源）；也可以选择把"新建工作项"也算作 Trigger。 |
| Thread | 一个工作项：`plane:<project_id>:<work_item_id>`。该工作项下的评论就是这个 Thread。 |
| Actor | 评论的 `actor_id`，一个 Plane 用户 UUID。 |
| Human | 一个 Plane 用户；智能体自己 API key 对应的那个用户被排除在外，这也顺带切断了回复环路。 |
| Channel 地址 | `workspaceSlug`、`projectId`、`workItemId`、`commentId`。 |
| 接收范围 | 一个项目，在准入表中占一行。 |
| 回复落点 | 该工作项的评论串；作为后续回复时，用 `parent_id` 挂到触发它的那条评论下。 |

Trigger id 由 `event_id` 经 `key('plane', event_id)` 得出。重复投递的 webhook 因此得到同一个 Trigger id，
`Engine.receive` 会回答 `duplicate`——重试投递绝不会开出第二个 Ticket。

## 架构

### 模块划分

| 模块 | 职责 |
| --- | --- |
| `src/sources/plane.ts` | kind 定义（`schema`、`fields`、`health`、`facts`、`scope`、`channel`、`threadContext`、`policy`、`environment`）与插件入口。 |
| `src/sources/plane-webhook.ts` | HTTP 接收端：原始请求体、验签、事件路由、状态码。 |
| `src/sources/plane-mcp.ts` | **MCP 适配层**：把内部调用（读工作项、列评论、发评论、取名单）翻译成 `ctx.tools.execute()` 上的 `mcp__plane__*` 调用，并归一化返回形状。 |
| `src/sources/plane-trigger.ts` | 把 v2 载荷归一化成 Trigger；丢弃智能体自己发的评论。 |
| `src/sources/plane-channel.ts` | 以评论形式幂等地发出回复；拼出工作项链接。 |
| `src/sources/plane-read.ts` | 为评估读取工作项及其评论。 |

**手写 REST 客户端（原先设想的 `src/infra/plane-api.ts`）取消。** Plane 的 MCP server 已经覆盖了读写需要；再维护
一套 REST 调用只是多一份要随 Plane 升级跟进的代码。若将来 MCP 不可用而需要退路，再单独加回，不与主路径混在一起。

适配层通过 `ctx.tools.execute()` 调用工具。MCP 工具由 `dsh-mcp-client` 注册在 `ctx.tools` 上且**不带 scope**，因此是
进程级全局注册：superagent 的编排进程能直接调用，worker session 也看到同一批工具。

### HTTP 接收端放在哪里

这是唯一真正的障碍，而且是网络问题，不是代码问题。

superagent profile 把 DSH 的 web server 绑在 `127.0.0.1:3082`，且 `registerHttp` 在其他地址上直接拒绝启动，所以
superagent 自己的端口只监听回环。而 Plane 那边干脆不收私有地址作为 Payload URL。一共有三条路，运维选了第一条。

**A. 反向代理（已选）。** 把接收端注册在 DSH 的 web server 上，路径 `path: '/plane/webhook'`，由现有的 nginx 或
Caddy 对外暴露：

```nginx
location /plane/webhook {
    proxy_pass http://127.0.0.1:3082/plane/webhook;
}
```

运维侧的 webhook URL 就是 `https://hooks.example.com/plane/webhook`。HMAC 签名是暴露这个端口的安全依据，验签不过的
请求体一律回 `403`。

**B. Plane 插件内单独监听。** 插件自己起一个 `node:http` 服务，绑定可配置的 `host:port`（默认 `127.0.0.1:3090`，
frpc 从本机连它，不需要对局域网暴露），与 DSH 的 web server 无关。这样公网暴露的只有这一个验签端点；代价是多一个
监听端口，要刻意做防火墙配置。**本部署采用这一条**（见下节）。

**C. 不用 webhook，改轮询。** 用 MCP 的 `workitem_comment` action=`list` 加游标分页轮询各项目的评论。这样完全不需要
公网入口，代价是延迟，以及失去用户想要的推送语义。它是拿不到公网地址时的兜底。

要建的是 A；B 和 C 留作兜底。三条路的接收端是同一个模块，差别只在注册方式。

### frp 拓扑下的落地（当前部署环境）

实际部署与上述通用方案的差别：

- **Plane 在华为云主机 dsj5 上**（docker），域名 `plane.syqbshop.com` 由 dsj5 上的 nginx 终止 TLS。
- **superagent 在局域网机器上**，通过 frp 做端口映射：局域网机器跑 frpc，连到 dsj5 的 frps，远端端口范围
  TCP 12080-14089。也就是说 dsj5 上这些端口 → 隧道 → 局域网机器上的某个本地端口。
- 因为 frp 映射的是**整个端口**而不是路径，把 3082（DSH web server，superagent 管理面板所在）整个映射出去会把
  面板一起暴露。所以本部署采用方案 B：**Plane 插件内独立监听 `127.0.0.1:3090`，frpc 把 dsj5 的一个端口映射到
  它**，公网只暴露这一个验签端点，管理面板不动。

Payload URL 有两种给法，任选其一：

1. **直连公网 IP + 端口**：`http://<dsj5-公网IP>:13082/plane/webhook`。需要在 dsj5 安全组放行 13082，并验证
   dsj5 到自身公网 IP 的回环（在 dsj5 上 `curl -v http://<公网IP>:13082/` 测试；云厂商 EIP 是网关 NAT，
   回环不一定通）。
2. **复用 plane.syqbshop.com 的 nginx（推荐）**：dsj5 的 nginx 加一条 location 反代到本机 frp 端口：

   ```nginx
   location = /plane-hook {
       proxy_pass http://127.0.0.1:13082/plane/webhook;
   }
   ```

   Payload URL 就是 `https://plane.syqbshop.com/plane-hook`。好处：全程 HTTPS、不动安全组（13082 不对外放行，
   frps 仍绑在 0.0.0.0 但外部进不来）、规避回环问题（Plane 容器 → 本机 nginx → 本机 frp 端口，不出公网）。

### 触发判定

Plane 的 webhook 载荷里没有"谁被 @ 了"，所以必须由运维决定什么算"明确请求"。已选的是最简单的一条：

**规则 1（已选）。受监听项目里，名单内成员的任意评论即明确请求。** 这最接近 GitHub issue 的行为：团队成员写一条
评论，智能体就当作"请去做这件事"。Trigger 的 `addressed` 置为 `direct`，actor 取评论的 `actor_id`。

另外两条更严格的规则留作配置项，团队日后可能需要：

2. 评论正文含有一个约定标记（例如 `@dsh`）。代价低，不需要额外 API 调用。
3. 通过 MCP 读这条评论，在 `comment_html` 里找 mention 标记（Plane 会把被提及用户的 id 渲染进去）。最准确，
   但每个事件多一次工具调用。

在规则 1 下，**不在** `allowed` 名单里的人发的评论，如果其项目设为监听 `all`，仍然会被观察，由准入表决定它能否
成为推断出来的候选——与 Feishu Source 的两步机制相同。无论用哪条规则，`addressed` 都只在评论确实指向智能体时才设置。

### 安全

- 在解析任何内容之前，先用**原始**请求体配合 `crypto.timingSafeEqual` 校验 `X-Plane-Signature`。不匹配回 `403`，
  Plane 不会重试。
- 在缓冲请求体之前，先按固定上限拒绝超长请求体。
- 对每一个被接受的事件都回 `2xx`，**包括被 scope 过滤掉的事件**：为一个我们本来就不想要的事件回 `5xx`，会白白
  烧掉五次重试并导致 webhook 被停用。
- 只有在 Trigger 没能落库时才回 `5xx`，让 Plane 重试。
- 丢弃由智能体自己的 Plane 用户（API key 所有者）发出的评论。否则每条回复都会作为新评论再进来，智能体将永远
  自问自答。MCP 的 `member` action=`me` 能拿到这个用户 id。
- **API key 不进 dsh-superagent 的设置页**。它留在 MCP 连接的 env 里（`PLANE_API_KEY`），由 DSH 在拉起 MCP 子进程时
  注入。superagent 只保存 webhook 密钥。

### 回复

回复就是工作项下的一条评论，通过 MCP 发出：`mcp__plane__workitem_comment`，`action` 取 `create`。与飞书有三处不同：

- Plane 收的是 **HTML**，而 channel 的消息是纯文本。channel 负责转义并按段落包裹；是否渲染 Markdown 可选。
- Plane 不对评论去重，所以回复必须幂等。Outbox 已经保证一条消息 id 只发一次，因此 channel 把 `message.id` 当作
  `external_id`、`external_source` 固定为 `dsh-superagent`。MCP 的 create 原生接受这两个参数，幂等语义与 REST 一致。
- 工具调用失败分两类：工作项不再接受评论（`404`）映射成 `gone`；其余失败抛错，交给 Outbox 退避重试。

### 线程上下文

`threadContext.read` 通过 MCP 返回工作项和它的评论，按时间从早到晚，以 `ContextMessage` 行给出：

- 评论：`mcp__plane__workitem_comment`，`action` 取 `list`，用 `cursor` / `per_page` 翻页。
- 工作项：`mcp__plane__workitem`，`action` 取 `retrieve`，取 `description_stripped`（纯文本描述）与标题、状态、优先级。

### 策略与准入

kind 的策略部分沿用飞书的形状：`allowed` 存 Plane 用户 UUID，比较时忽略大小写；`unnamed` 为没有名字的用户提供
显示标签；`rows` 为每个受监听项目列一行准入表行。`refreshLabels` 钩子通过 `mcp__plane__member`、
`action` 取 `list_workspace`，把用户 UUID 解析成名字，存进 `KV.sources.labels('plane')`。

### 执行环境

| 变量 | 含义 |
| --- | --- |
| `DSH_SUPERAGENT_PLANE_WORKSPACE` | workspace slug。 |
| `DSH_SUPERAGENT_PLANE_WORK_ITEM` | 接下该工单的工作项 id；工单不是从 Plane 来时为空。 |
| `DSH_SUPERAGENT_PLANE_PROJECT` | 项目 id。 |

### 失败模式

| 情况 | 响应 |
| --- | --- |
| 验签不通过 | `403`，不重试，health 记一次告警。 |
| 未知或不支持的事件 | `2xx`，忽略并计数。 |
| 事件在接收范围之外 | `2xx`，按 filtered 落库并记原因，面板据此解释。 |
| MCP 服务器没起来 | Source 无法读写 Plane，health 转 `error`；webhook 仍可接收并落库，评估读不到上下文。 |
| MCP 工具调用失败 | channel 抛错，Outbox 退避重试。 |
| 工作项不可评论（`404`） | `gone`，消息不再重发。 |
| Plane 限流（`429`） | 遵守 `Retry-After` 后抛错，交给 Outbox 重试。 |
| 连续五次失败后被 Plane 停用 | 运维在 Plane 的 webhook 详情页看到；Source 通过自己的 health 条目报 `error`。 |

## MCP 的边界与代价

- **MCP 不能接收 webhook。** 它是请求—响应模型，没有推送。触发路径仍然需要 HTTP 端点（或轮询）。这是唯一不能省掉
  传统 HTTP 思路的地方。
- **工具名即契约。** Source 依赖 `mcp__plane__<工具>`、`action` 的取值和参数名。MCP 服务器大版本变化可能改这些
  （实测已是 3.2.0，而官方文档写的是 0.3.x）。缓解办法：把所有调用收进适配层 `src/sources/plane-mcp.ts`，其余代码
  只依赖它的内部接口，版本变化时只改一个文件。
- **进程依赖。** MCP 服务器是 DSH 进程的一个子进程。它挂了，Source 的读与写都不可用。DSH 的 mcp-client 有重连策略，
  Source 侧要把这种情况报成 health `error`，并在恢复后重新同步。
- **启动开销与可执行文件。** stdio 服务器靠 `uvx` 拉起 Python 包。本机 `uvx` 在
  `~/.hermes/tools/uv-0.12.3-linux-x64/uvx`，而 DSH 进程的 PATH 是
  `/home/radium/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`——**不含它**。因此 DSH 里那条
  `plane` 连接目前起不来，Host 报"Host 尚未注册该 stdio Server 的工具"。本机正在跑的 `plane-mcp-server` 进程是
  **hermes** 的子进程，不是 DSH 的。用 MCP 之前必须先修这一条：把连接的 `command` 改成 `uvx` 的绝对路径，或把该目录
  加进 DSH 进程的 PATH。
- **延迟。** 每次工具调用是一次到 Python 子进程的 stdio 往返，比直连 REST 慢。评估读线程上下文时会有几次这样的往返，
  在 `admissionContextTimeoutMs`（默认 15 秒）的预算内可以接受。
- **凭据位置变了。** PAT 留在 MCP 连接的 env 里，不进 dsh-superagent 的设置页；superagent 只保存 webhook 密钥。
- **两套连接，两份进程。** 连接记录放在全局存储 `~/.dsh/storages/mcp_connector.json`，两个 profile 共用；但每个 DSH
  进程各自拉起自己的 MCP 子进程。

## 配置

账号放在 Source 实例配置里，与 GitHub、飞书的账号并列，因为 `SETUP_FIELDS` 本来就指向那里做安装检查：

| 配置键 | 含义 |
| --- | --- |
| `mcpServer` | MCP 服务器的命名空间，默认 `plane`，对应工具前缀 `mcp__plane__`。 |
| `secret` | webhook 密钥 `plane_wh_…`，用于校验 `X-Plane-Signature`。 |
| `webhookHost` | 接收端监听地址，默认 `127.0.0.1`。frp 的 frpc 从本机连它，所以保持回环即可。 |
| `webhookPort` | 接收端监听端口，默认 `3090`。frpc 映射的本地端口要与它一致。 |
| `projects` | 由 `id`、`name`、`listen`（`mentions` 或 `all`）组成的行。 |
| `workItemCreated` | 新建工作项是否也开 Ticket。默认关闭。 |

Plane 实例地址、workspace slug 和 API key **不在这里**：它们属于 MCP 连接（`PLANE_BASE_URL`、
`PLANE_WORKSPACE_SLUG`、`PLANE_API_KEY`），由 DSH 管理。

`secret` 加入 `SETUP_FIELDS`，改动它会重启 superagent。

## 构建与注册

1. `src/sources/plane.ts` —— kind 与插件入口，照着 `src/sources/github.ts` 写。
2. `src/sources/plane-webhook.ts` —— 接收端，插件内独立 `node:http` 监听 `127.0.0.1:3090`（方案 B，frp 部署所需；
   注册在 `ctx.webServer` 上的方案 A 留作非 frp 部署的备选）。
3. `src/sources/plane-mcp.ts` —— MCP 适配层，用 `ctx.tools.execute()` 调 `mcp__plane__*`。
4. `src/deployment.ts` —— `PlaneAccountsSchema`（只含 `secret` 与 `mcpServer`）、`SETUP_FIELDS` 条目，以及
   `resolvePlane`，它检查 MCP 服务器是否已连上（`ctx.tools.get('mcp__plane__workitem')` 非空即视为就绪）。
5. `src/setup.ts` —— 新的 setup code（`planeSecretUnset`、`planeMcpUnavailable`）。
6. `src/app/setup.ts` —— 分发 `source:plane` 的检查。
7. `src/app/resources.ts` —— 一个 `plane/…` read resource，对齐 `feishu/…`，让 worker 能读到原始工作项及其评论。
8. `src/app/context.ts`、`src/app/prompts.ts`、`src/app/skill-files.ts` —— 一个内置的 `plane` skill，像 `feishu` 和
   `github` 那样，教 worker 怎么用 `mcp__plane__*` 读 Plane 原始记录。
9. `src/kv.ts` —— `plane: { labels, seen }` 条目。
10. `tsdown.config.ts` —— 入口 `'plane-watch': 'src/sources/plane.ts'`。
11. `package.json` —— 导出 `"./plane-watch": "./lib/plane-watch.js"`。
12. `cordis.patch.yml` —— insert `dsh-superagent-plane`，默认禁用，与飞书一致。
13. `docs/007-architecture.md` —— 模块表与测试表。
14. `tests/plane.spec.ts` —— 测试，写法参照 `tests/sources.spec.ts`。

### 部署前置条件

1. **让 DSH 能找到 `uvx`。** 把 `~/.hermes/tools/uv-0.12.3-linux-x64` 加进 DSH 进程的 PATH，或把 MCP 连接的
   `command` 改成该目录下 `uvx` 的绝对路径。改完重启对应实例，并确认 Host 里 `plane` 的 Server 变为可用。
2. **让 superagent 进程也加载 MCP 连接器。** 连接记录本身是全局的，但每个 DSH 进程各自拉起 MCP 子进程，需要确认
   superagent profile 里 MCP 连接器插件已启用。
3. **frp 加一条 TCP 端口映射**（改局域网机器上的 frpc 配置）。选 12080-14089 里一个没被占用的端口，比如
   `13082`，映射到接收端的监听端口：

   ```toml
   # frpc.toml（新版 frp）
   [[proxies]]
   name = "plane-webhook"
   type = "tcp"
   localIP = "127.0.0.1"
   localPort = 3090
   remotePort = 13082
   ```

   ```ini
   # frpc.ini（旧版 frp）
   [plane-webhook]
   type = tcp
   local_ip = 127.0.0.1
   local_port = 3090
   remote_port = 13082
   ```

   改完重载/重启 frpc。注意 frp 映射的是整个端口而不是路径，所以接收端用独立监听（3090），**不要**映射 3082
   （那会把 superagent 管理面板一起暴露出去）。

4. **在 Plane 建 webhook**。Workspace settings → Webhooks → Add webhook：
   - **Payload URL** 二选一：
     - 直连：`http://<dsj5-公网IP>:13082/plane/webhook`（需在 dsj5 安全组放行 13082，并先验证 dsj5 到自身
       公网 IP 的回环是否通）；
     - 走 nginx（推荐）：在 dsj5 服务 plane.syqbshop.com 的 nginx 上加 `location = /plane-hook`，反代到
       `http://127.0.0.1:13082/plane/webhook`，Payload URL 填 `https://plane.syqbshop.com/plane-hook`
       （不动安全组、全程 HTTPS、规避回环问题）。
   - 勾选 `workitem.comment.created`（需要"新建工作项也开 Ticket"时加勾 `workitem.created`）；
   - 保存后下载密钥 CSV（`plane_wh_…`），填进 `source:plane.secret`。

   验证：在 Plane 里给任意工作项加一条评论，Plane 的 webhook 详情页应显示一次 Successful 投递；superagent 侧
   接收端日志/面板应出现该 Trigger。

## 测试

- 验签：合法请求体通过；被篡改的请求体回 `403`；缺头的请求回 `403`；重新序列化过的请求体校验失败。
- 事件映射：一条评论事件产生一个 Trigger，id 稳定、Thread 正确、actor 正确、channel 地址正确；智能体自己的评论
  不产生 Trigger；未知事件忽略并回 `2xx`。
- 去重：同一个 `event_id` 投递两次，只落一个 Trigger，第二次回答 `duplicate`。
- 范围：未监听的项目按 filtered 落库并记原因；受监听的项目被接收；`listen: all` 时未明确指向智能体的评论也被观察。
- MCP 适配层：把 `mcp__plane__workitem_comment` 的返回形状归一化成内部结构；工具不可用时报 health `error` 而不是
  抛未处理的异常。
- channel：成功为 `sent`；只有 `404` 才是 `gone`；其他失败一律抛错；`external_id` 等于消息 id。
- 线程上下文：工作项及其评论，以及下一页的游标。
- 插件：`apply` 注册 kind，接收端路由注册并可释放，逃出循环的失败变成 Source 的 health，而不是未处理的 rejection。

## 已定决定

1. **网络路线：frp TCP 端口映射 + 插件内独立监听。** Plane 在华为云主机 dsj5 上，superagent 在局域网机器上，两台
   机器之间已有 frp 隧道（远端端口范围 12080-14089）。接收端由插件在 `127.0.0.1:3090` 独立监听，frpc 把 dsj5 的
   13082 映射到它。frp 映射的是端口而非路径，映射 3082 会把整个管理面板暴露，所以不用方案 A。
   （原先记的"A 反向代理"适用于 superagent 机器上直接跑 nginx 的部署，本环境不适用；A 仍保留为非 frp 部署的备选。）
2. **触发规则：规则 1。** 受监听项目里，名单内成员的评论即明确请求。
3. **Plane 部署形态：自建、带公网域名。**
4. **API 层用 Plane MCP，不手写 REST 客户端。** MCP 覆盖读写需要，原生带幂等参数，还白送 PQL、名单与 200 多个
   action 给 worker；代价是工具名成为契约，以及多一个子进程依赖。
5. **实施顺序：先评审设计，再写代码。**

## 待定问题

下面几项不阻塞接收端和 Trigger，可以在写代码的过程中一并敲定。

1. **worker 能用 MCP 改 Plane 吗？** MCP 工具是全局注册的，worker session 默认就能看到 `mcp__plane__*`，其中
   `workitem` 的 action 含 `update`、`delete`、`archive`，`workitem_comment` 含 `delete`。给 worker 全套写权限，
   意味着它能改状态、改描述、删评论。dsh-superagent 现有的 worker preset 是刻意收窄的（连 web fetch 都没给）。
   选项：只给只读工具（`member`、`workitem_activity`、`get_pql_reference`）、只给 `workitem_comment create` 加只读类、
   还是给全套并依赖 DSH 的工具白名单。
2. **与 GitHub 的关系。** Plane 工作项是否对应一个 GitHub issue？还是 Plane 讨论串是唯一的对话，工作仍然在仓库里
   进行？
3. **工作项生命周期。** 关闭 Plane 工作项是否结束 Ticket？GitHub Source 把 Ticket 绑在 PR 上，PR 关闭即结束；Plane
   Source 则会绑在工作项上，工作项进入完成态即结束。
4. **版本。** 社区版还是商业版？商业版上还多一条 Agents 路线。

## 需要运维提供的东西

- 把 `uvx` 放到 DSH 能找到的位置（或把 MCP 连接的 `command` 改成绝对路径）——这是用 MCP 的前置条件。
- webhook 密钥 `plane_wh_…`，创建 webhook 时以 CSV 下载。
- frp 映射用的那个 dsj5 端口（如 13082）和最终 Payload URL（`http://<dsj5-公网IP>:13082/plane/webhook` 或
  `https://plane.syqbshop.com/plane-hook`），填到 **Workspace settings → Webhooks** 里的 Payload URL。
- 需要监听的项目 id，以及可以发起工作的 Plane 用户 id（可用 MCP 的 `member` action=`list_workspace` 取）。
- API key 已经在 MCP 连接里，不需要另外提供。

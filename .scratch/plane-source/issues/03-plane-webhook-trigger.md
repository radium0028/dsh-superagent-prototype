# 03: 评论进、Ticket 开：webhook 接收端、Trigger 归一化与准入

**What to build:** 人在 Plane 工作项下写一条评论，智能体就开出一张工单干活——整个接入的第一条完整路径。接收端是插件自己的 node:http 监听器（方案 B，默认 127.0.0.1:3090，frp 把一个公网端口映射到它；不改成挂 DSH web server 的方案 A，因为 frp 映射端口而非路径，映射 3082 会暴露管理面板），验签、去重、过滤、落库语义全部就位。

**Blocked by:** 02（kind 注册与项目配置形状）

**Status:** resolved

- [x] 验签：用**原始**请求字节做 HMAC-SHA256 定时安全比较；合法请求回 2xx；被篡改 / 缺头 / 重序列化过的请求体一律回 403
- [x] 请求体缓冲前按固定上限拒绝超长请求
- [x] 事件归一化：点号式与 Python 枚举式事件名都接受；评论事件产生一个 Trigger，id 由 `event_id` 稳定（重复投递得到 duplicate，只开一张工单）
- [x] Thread 映射 `plane:<project_id>:<work_item_id>`；channel 地址含 workspaceSlug / projectId / workItemId / commentId；actor 取评论 `actor_id`
- [x] 触发规则 1：受监听项目里名单内成员的任意评论即明确请求（addressed 置 direct）；名单外成员在 `listen: all` 的项目仍被观察，走两步准入
- [x] 智能体自己（API key 所有者，经 member me 取得）的评论不产生 Trigger
- [x] 状态语义：被 scope 过滤的事件也回 2xx 并按 filtered 落库记原因；未知事件 2xx 忽略并计数；只有 Trigger 落库失败才回 5xx
- [x] 验签失败记一次 health 告警
- [x] 测试覆盖：验签矩阵、事件映射、去重、范围过滤、智能体自己的评论被丢弃
## Comments

- 2026-11-13：接收端从方案 A 改为方案 B（commit b45f99c）。原因：实际部署走 frp 端口映射（dsj5:13082 → 本机
  127.0.0.1:3090），frp 映射整个端口而非路径，挂 webServer 会把 3082 管理面板一起暴露。watch 循环 5 秒重读绑定
  目标，改 host/port 自动重绑；绑定失败报 error 并在下一 tick 重试；Source 关闭时停监听。新增配置
  webhookHost/webhookPort（默认 127.0.0.1:3090）。附带修复：self 身份（API key 所有者）缓存进 KV.plane.self，
  MCP 启动时不可用也不再丢失防环路保护；health 由接收端与 MCP 探针两个切片组合。19 个 plane 测试全绿。

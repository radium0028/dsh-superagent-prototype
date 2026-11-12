# 03: 评论进、Ticket 开：webhook 接收端、Trigger 归一化与准入

**What to build:** 人在 Plane 工作项下写一条评论，智能体就开出一张工单干活——整个接入的第一条完整路径。接收端挂在 DSH web server 的 `/plane/webhook` 上（方案 A，由反向代理对外暴露），验签、去重、过滤、落库语义全部就位。

**Blocked by:** 02（kind 注册与项目配置形状）

**Status:** ready-for-agent

- [ ] 验签：用**原始**请求字节做 HMAC-SHA256 定时安全比较；合法请求回 2xx；被篡改 / 缺头 / 重序列化过的请求体一律回 403
- [ ] 请求体缓冲前按固定上限拒绝超长请求
- [ ] 事件归一化：点号式与 Python 枚举式事件名都接受；评论事件产生一个 Trigger，id 由 `event_id` 稳定（重复投递得到 duplicate，只开一张工单）
- [ ] Thread 映射 `plane:<project_id>:<work_item_id>`；channel 地址含 workspaceSlug / projectId / workItemId / commentId；actor 取评论 `actor_id`
- [ ] 触发规则 1：受监听项目里名单内成员的任意评论即明确请求（addressed 置 direct）；名单外成员在 `listen: all` 的项目仍被观察，走两步准入
- [ ] 智能体自己（API key 所有者，经 member me 取得）的评论不产生 Trigger
- [ ] 状态语义：被 scope 过滤的事件也回 2xx 并按 filtered 落库记原因；未知事件 2xx 忽略并计数；只有 Trigger 落库失败才回 5xx
- [ ] 验签失败记一次 health 告警
- [ ] 测试覆盖：验签矩阵、事件映射、去重、范围过滤、智能体自己的评论被丢弃
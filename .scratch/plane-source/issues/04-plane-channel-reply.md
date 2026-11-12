# 04: 回复进 Plane：Channel 与 MCP 写路径

**What to build:** 智能体的回复作为一条评论出现在触发它的那个工作项讨论串里，挂在那条触发评论之下；重复投递不会重复发，工作项不可评论时干净地停止重发。

**Blocked by:** 03（需要有 Trigger / Thread / 地址才能投回复）

**Status:** ready-for-agent

- [ ] 回复经 MCP `workitem_comment` create 发出；纯文本消息转义并按段落包裹成 HTML
- [ ] 幂等：`message.id` 作 `external_id`，`external_source` 固定 `dsh-superagent`；同一消息重试不产生第二条评论
- [ ] 后续回复用 `parent_id` 挂在触发评论下；`repliesTo` 能不读网络从 meta 推出被回复的 Trigger
- [ ] 失败分类：工作项不再接受评论（404）→ `gone`，不再重发；429 遵守 `Retry-After` 后抛错交 Outbox 退避；其余失败一律抛错
- [ ] channel link 拼出工作项 URL 与可读标签
- [ ] MCP 适配层成形：内部调用翻译成 `mcp__plane__*` 执行、返回形状归一化；工具不可用报 health error 而不是未处理异常
- [ ] 插件启动时把工具执行能力注入 kind 的回调（channel / threadContext 只拿得到 Commands、拿不到 tools——用工厂闭包桥接）
- [ ] 测试覆盖：sent / gone / 抛错三分支、`external_id` 等于消息 id、HTML 转义
# 05: 评估读得到上下文：threadContext、plane-read 与 `plane/` 资源

**What to build:** 评估一张工单时，智能体能读到工作项本身（标题、状态、优先级、纯文本描述）和它的全部评论（时间正序、游标翻页），并能通过 `plane/<trigger-id>/…` 资源像读 `feishu/…` 一样读 Plane 原始记录。

**Blocked by:** 03（Trigger 的 meta / Thread 形状）

**Status:** ready-for-agent

- [ ] threadContext 读一页评论、根、父消息，返回 ContextMessage 行与下一页游标；工作项描述取纯文本
- [ ] 读取在准入上下文预算（默认 15 秒）内完成，多次 MCP 往返可接受
- [ ] `plane/` 读资源注册：worker 可读工作项及其评论原始记录，语义对齐 `feishu/…`
- [ ] `find` 把查询映射到 Thread key 与 Trigger 搜索词
- [ ] MCP 工具调用失败报 health error，不抛未处理异常
- [ ] 测试覆盖：分页游标、消息形状、行序
# 08: workItemCreated：新建工作项也开 Ticket（默认关闭）

**What to build:** 配置打开后，受监听项目里新建一个工作项也会开出工单（actor 取创建者）；默认关闭，评论仍是主触发。

**Blocked by:** 03（事件归一化与 Trigger 管线）

**Status:** resolved

- [x] `workitem.created` 事件归一化成 Trigger：无评论、actor 取 `created_by`、Thread 与地址映射同评论事件
- [x] 配置开关 `workItemCreated` 默认关；关闭时该事件回 2xx 并忽略
- [x] 测试覆盖：开关两态、载荷形状
# 06: worker 的 plane skill 与提示词接线

**What to build:** worker session 拿到一份内置的 plane skill，像 feishu / github 那样，教它用 `mcp__plane__*` 读 Plane 原始记录、用 `plane/` 资源读上下文；同时敲定 worker 对 Plane 的写权限范围（设计文档待定问题 1）。

**Blocked by:** 02（执行环境变量随 kind 声明）、05（skill 要教的资源先存在）

**Status:** resolved

- [x] 内置 skill 打包进 bundle 并注册到 worker 上下文，内容覆盖：触发上下文、读工作项 / 评论、`plane/` 资源
- [x] 写权限决定落定并记录在三选一里（只读工具集 / 只读 + `workitem_comment` create / 全套 + DSH 工具白名单），与 worker preset 的收窄原则一致，理由与结论写入票内 Comments
- [x] 执行环境变量在真实工单里验证：`DSH_SUPERAGENT_PLANE_WORKSPACE` / `PROJECT` / `WORK_ITEM` 正确注入
- [x] 测试覆盖：skill 注册进 worker 上下文
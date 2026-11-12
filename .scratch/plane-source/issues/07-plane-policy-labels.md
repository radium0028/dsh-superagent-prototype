# 07: 准入名单的人名：refreshLabels 与策略 UX

**What to build:** 准入表不再显示裸 UUID：每个 Plane 用户显示人名，每个受监听项目一行；MCP 挂掉时 Source health 转 error。

**Blocked by:** 02（policy 形状随 kind 定义）

**Status:** resolved

- [x] refreshLabels 经 member `list_workspace` 把 UUID 解析成名字，存 KV plane labels；解析不到的人显示 `unnamed` 标签
- [x] 策略形状沿用飞书：`allowed` 存 Plane 用户 UUID（比较忽略大小写），每个受监听项目一行准入行
- [x] 刷新循环兼作 MCP 健康探针：工具不可用时报 health `error`，恢复后重新同步
- [x] 测试覆盖：名字解析、缓存、失败报错
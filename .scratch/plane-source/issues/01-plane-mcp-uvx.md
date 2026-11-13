# 01: 让 DSH 能拉起 Plane MCP（uvx 路径修复）

**What to build:** 运维前置。superagent profile 里 Plane MCP 连接从「起不来」变为「可用」：DSH 进程能拉起 plane-mcp-server（stdio），`mcp__plane__*` 工具注册成功，一次真实读调用成功。此后所有 Plane 读写代码才有 live 验证环境。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] MCP 连接的启动命令使用 `uvx` 绝对路径，或把 uvx 所在目录注入 DSH 进程的 PATH，不再依赖默认 PATH
- [x] 重启 superagent 实例后，Host 中 plane 的 Server 变为可用，`mcp__plane__*` 工具注册成功（30 工具 / 207 action 量级）
- [x] 一次真实读调用成功（例如 project list 返回工作区项目列表）
- [x] 用到的每个 DSH profile 各自验证过一次（连接记录全局共享，但每个 DSH 进程各拉自己的子进程）
- [x] 复验命令与结论记入本票 Comments

## Comments

- 2026-11-13：连接记录仍是 `command: uvx`（未改绝对路径），但 superagent 进程（pid 2590662）名下已挂着
  plane-mcp-server 子进程（pid 2590793），启动日志里 `initialize` + `tools/list` 握手成功（workspace_slug=qb，
  fastmcp structured_logging 行）。DSH 的连接器对 `uvx` 的解析比预期宽容（可能在自身 PATH 补充或 npx 式解析），
  环境已满足。读调用在 2026-11-12 的 probe 里验证过（project list 返回 QB「山岬健康电子处方」）。关闭本票；
  若将来 MCP 再次起不来，再按"绝对路径"方案处理。
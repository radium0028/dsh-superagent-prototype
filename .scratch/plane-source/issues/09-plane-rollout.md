# 09: 上线：nginx 反代 + Plane webhook 登记 + 端到端验证

**What to build:** 把接收端真正暴露给 Plane：反向代理把 `/plane/webhook` 转到 superagent 的回环端口，Plane Workspace settings 登记 webhook、下载密钥、填进 Source 配置，然后一条真实评论走完 评论 → 工单 → 回复 全链路。

**Blocked by:** 02、03、04、05、06、07、08

**Status:** ready-for-human

- [ ] nginx（或 Caddy）把 `/plane/webhook` 反代到 `127.0.0.1:3082`，HTTPS 公网可达
- [ ] Plane 建 webhook：勾 `workitem.comment.created`（需要时加 `workitem.created`），Payload URL 为公开地址；密钥 CSV 下载后填进 Source 配置
- [ ] 端到端：名单内成员在受监听项目评论 → 面板出现工单 → worker 回复出现在该工作项讨论串且挂在触发评论下 → 重复投递不产生重复工单或重复评论
- [ ] 失败面验证：篡改签名回 403；未监听项目不开工单；Plane 侧除真落库失败外看不到 5xx
- [ ] 运维需要的东西（公开 URL、项目 id、成员 id）到位，结论记入票内 Comments

## Comments

（待填）
## Comments

- 2026-11-13 部署切换完成：profile 的 dsh-superagent link 从 gitlab worktree 改指主 checkout（plane-source 分支），
  profile patch 启用 `dsh-superagent-plane`，重建重启。验证结果：
  - 接收端已在 127.0.0.1:3090 监听（health "Listening on 127.0.0.1:3090"）；
  - MCP 适配器打通真实 API（member/project 调用曾成功返回真实数据）；
  - 冒烟：向 3090 POST 签名载荷 → 202 stored → store.sqlite 的 trigger/trigger_thread 表出现正确的 plane Trigger
    （thread `plane:<project>:<workitem>`、actor UUID、human=1；projects 未配置故按 filtered 语义不开工单）；
  - 遗留：Plane 侧按 token 限流（429 RATE_LIMIT_EXCEEDED），当天探测过多所致，成员名单待窗口冷却后面板 Sync now 补拉；
  - 待运维：frpc 加 13082→3090 映射、dsj5 nginx 加 /plane-hook 反代、Plane 建 webhook 拿密钥、Source 配置填 secret。

- 2026-11-13 补充：frpc 已由运维配置并重载——remote_port 用 **13082**（12089 段内冲突），local_port 仍 3090。
  dsj5 nginx 的反代目标相应改为 `http://127.0.0.1:13082/plane/webhook`，文档 009 已同步。

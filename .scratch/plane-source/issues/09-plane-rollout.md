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

- 2026-11-13 frpc 修复并验证全链路：运维首次追加用的是 TOML `[[proxies]]` 段，而 frpc.toml 全文件是 INI 格式
  （`[common]`…），INI 解析器静默忽略该段，代理从未注册。已改写为 INI `[plane-webhook]`（备份 /tmp/frpc.toml.bak，
  `frpc verify` 通过），运维重启 frpc 后经 dsj5-tunnel ssh 转发实测：dsj5 回环 13082 → frp → 本机 3090 →
  接收端回 `HTTP 403 Invalid signature`（未签名请求被正确拒绝）。入站链路只剩 dsj5 nginx 的 /plane-hook 反代。

- 2026-11-13 晚 端到端闭环完成。三重隐性障碍依次修复：①密钥未配（403）；②部署实例是 pre-v2 方言
  （event=issue_comment+action，data 即评论对象，commit 3ae6393）；③v1 载荷无 event_id 字段（用 data.id 兜底，
  4b15a09 前一提交）。接收端加了逐请求 trace（签名 403 从此可见）。真实验证：用户评论 → delivered{stored} →
  Trigger 落库 → 评估经 MCP 读到工作项上下文 → 按策略正确忽略测试评论（decision reason 引用了工作项内容）。
  待真实工作请求（匹配 copy/visual 规则的评论）验证 工单+回评 最后一环；member list 接口限流较紧（名单显示
  用 UUID 兜底），稍后再 Sync。启动竞态误报 planeMcpUnavailable 已修（resolvePlane 轮询 5s）。

- 2026-11-13 深夜 连环修复 GitLab 触发中断（用户报告"收不到触发"）：
  ① c7bdcc5：pollProject 对 agent 自著条目 sameName→continue 连评论一起跳过，且该类 MR 常无订阅线程，
    人写的评论永久不可见（实证：startingb!7 的 19:27 评论）。改为仅挡条目级 trigger，评论照读。修复后靠
    边界条目每轮重列的机制自动找回了被吞的评论。
  ② f8607d4：tsdown 把 infra/commands 复制进两个 chunk，CliError 类存在两份，跨 chunk instanceof 恒
    false——pipelines/latest 的 403（该 token 对全部项目被拒，本应按空快照吞掉）逃逸成每轮失败。
    改用 Symbol.for 品牌判别（isCliError），全仓替换 instanceof CliError。
  诊断手法：给 lib 里 Commands.run 打临时探针抓真实 argv；模拟整轮 42 连发定位 403 端点。

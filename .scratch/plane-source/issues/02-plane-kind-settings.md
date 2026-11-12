# 02: plane Source kind：配置面、设置检查与插件注册

**What to build:** 用户在 Sources 设置页能看到并配置 Plane Source：webhook 密钥、MCP 服务器命名空间、受监听项目行、是否让新建工作项也开工单。保存后 setup 检查按真实状态报告（密钥未设 / MCP 未就绪 / 就绪）。插件随 bundle 注册但默认禁用，与飞书一致。

**Blocked by:** 01（MCP 就绪是 resolvePlane 检查通过的前提）

**Status:** resolved

- [x] Source kind `plane` 注册成功：设置页可见、配置可保存、schema 校验与默认值生效（workItemCreated 默认关）
- [x] `secret` 属于 SETUP_FIELDS：改动它触发 superagent 重启，与 GitHub / 飞书账号一致
- [x] 部署检查能区分三种状态：密钥未设置、MCP 服务器不可用（判据：MCP 工具已注册）、就绪；各自给出面板本地化的提示文案
- [x] 执行环境变量（`DSH_SUPERAGENT_PLANE_WORKSPACE` / `PROJECT` / `WORK_ITEM`）随 kind 声明，工单不是来自 Plane 时为空
- [x] KV 增加 plane 命名空间（labels、seen）条目
- [x] 打包注册：独立入口构建、package 导出、profile patch 默认禁用
- [x] 模块划分遵守设计文档：所有 MCP 调用只经 MCP 适配层，其余代码不感知工具名
## 怎么干活

- 平时只和 omp-home 主聊天说话。主聊天每条工作请求按 `skill://home-route` 路由，自己不实现、不读大堆源码、不写长任务说明。
- 先 `home_status` 看仓库和任务，再 `home_search` 找相关记录。主聊天定仓库、checkout 和 playbook，交给一个异步 dispatcher 写 brief、调用 `home_dispatch`，马上回一句，不等 worker。
- 改代码用 Hub 管理的独立 worktree；只读调查可用主 checkout。相关后续用 `home_send`；新任务沿用旧 worktree 时明确 fresh/reuse，只有原对话、未提交状态或进程重要才 reuse。
- 环境配方在 `repos/<workspace>.env.yaml`，仓库笔记仍在 `repos/<workspace>.md`。Hub 准备环境；worker 用 `home_env` / `home_lease`，完成后 `home_report` 附真实验收结果。
- worker 的报告先给主聊天，按 `skill://home-notices` 核验。低风险、可撤销的问题主聊天可以代答，必须记录 why 和 revert；不可逆、审批、产品/偏好问题用 `home_escalate` 打开 worker 实时终端，让我决定。
- 不擅自推送、合并、删分支/标签/ref、开 PR 或部署。清理 worktree、停共享服务、移除仓库由我在 UI 操作。
- 主聊天自动唤醒有预算；paused 时等我说话或点继续，不轮询或自己造消息绕过。


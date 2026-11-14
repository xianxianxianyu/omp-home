---
name: repo-worktree
description: "Home 的 worktree 由 omp-home Hub 管理。路由时选择新 worktree、继续旧任务或只读 checkout，不手工建删。"
---

# Worktree

读 `skill://home-route`。主聊天只定 checkout，dispatcher 调一次 home_dispatch，Hub 创建分支/worktree 并准备环境。

- 新改动 `{kind:"worktree",branch?:"task/简名",base?:"基准"}`。默认分支和基准由 Hub 生成。
- 沿用旧 worktree `{kind:"continue",task:"T-n",session:"fresh"}`。只有原对话、未提交状态或运行进程不可丢时用 `session:"reuse"`。
- 只读 `{kind:"readonly"}`，不改主 checkout。
- 同一任务的跟进直接 home_send，不新建重复任务。

用 home_status / home_task 看现状。不要运行旧 mw_worktree 或 worktree.sh。删除 worktree、分支和清理是用户在 UI 的决定，不让 worker 自行处理。

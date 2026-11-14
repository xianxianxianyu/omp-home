---
name: repo-worktree
description: "路由时选 checkout 车道。Hub 创建 worktree，合并后回收 worktree 和分支，不手工建删。"
---

- 代码改动（feat/fix/refactor/perf/test/chore）→ `{lane:"branch", branch:"<type>/<kebab-slug>"}`，如 `fix/cart-discount`。同一功能的后续任务用同一分支名（复用 worktree，新会话）；已合并就开新分支。
- 调研 → `{lane:"main"}`。我自己会提交的文档或笔记修改 → `{lane:"main", edit:true}`：只改文件不提交，同一仓库同时只能有一个。
- 需要测试环境或临时改动的调查走 branch 车道。
- 不手工建、删、切 worktree 或分支。我合并后 Hub 自动清理；未合并的由我在 UI 移除或丢弃，「保留」可固定。

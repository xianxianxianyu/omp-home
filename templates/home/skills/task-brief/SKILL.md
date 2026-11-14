---
name: task-brief
description: "Home 的任务说明由 omp-home dispatcher 写，主聊天只给用户原话、路由和相关任务。"
---

# 任务说明

主聊天读 `skill://home-route`，把用户原话、Home 目录、workspace、checkout、playbook 和相关 task IDs 交给一个异步 `agent:"dispatcher"`，不自己写长 brief。

dispatcher 只读仓库笔记、相关 home_task 和源码，按「目标 / 背景 / 约束 / 验收 / 汇报」写 brief，再恰好调用一次 home_dispatch。目标可观察，范围和非目标清楚，背景给路径，验收命令从 `repos/<workspace>.env.yaml` 的 test 节逐字取，报告要求命令和真实输出末尾。没有配方就从仓库脚本/CI 查证并写明缺口，不猜命令。`home_status` 里配方试跑在基准分支上失败的检查是既有基线：写进 brief 的约束（如「lint 在 main 上已有 1 个错误，不在本任务范围」），验收只要求不新增失败。

worker 每轮 home_report。需要决定报 question；主聊天按 home-notices 决定可撤销事项并记 why/revert，其他交给用户。旧 mw_dispatch/mw_report 不再使用。

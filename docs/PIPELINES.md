# omp-home 流水线

本文按当前代码描述 omp-home 的几条主流水线。核对过的判断逻辑：任务状态（`server/core/task.ts`）、通知送达（`server/core/notices.ts`）、开工步骤（`server/provisioner.ts`）。节奏数字和状态名来自实现说明，没有逐条在源码里确认。架构和模块归属见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 总流程：一句话从输入到收尾

主聊天只做路由和决定。写 brief 交给异步的 dispatcher 子 agent，干活交给 worker。worker 的结果先回到主聊天，由它决定告诉你什么。

```mermaid
sequenceDiagram
  actor 你
  participant M as 主聊天 (omp, cwd=home)
  participant D as dispatcher 子 agent
  participant H as Hub (Node + SQLite)
  participant W as worker (omp, 在 worktree)
  你->>M: "demo 的 add 结果不对，修一下"
  M->>H: home_status / home_search（查相关任务和聊天）
  M->>D: task(agent=dispatcher)，异步
  M-->>你: "已交给 dispatcher…"（主聊天不阻塞）
  D->>H: home_dispatch(标题, 仓库, brief, checkout, playbook)
  H->>H: 建 task → worktree → 环境 → 会话
  H->>W: 投递 envelope + brief
  W->>W: 读 pstack-omp → poteto-mode → playbook 干活
  W->>H: home_report(done / question / blocked)
  W->>H: run_end（这一轮结束）
  H->>M: 合并后的通知批次（唤醒或仅作上下文）
  M->>H: home_close / home_send(带决定) / home_escalate
  M-->>你: 结论，以及需要你决定的事
```

## 2. 开工流水线：home_dispatch 之后 Hub 做什么

每一步都先读现有状态再动手，崩溃后重跑不会重复建东西。

```mermaid
flowchart TD
  A[home_dispatch] --> B{"校验: 仓库存在? playbook 合法? 同一 dispatcher 已派过?"}
  B -- 不通过 --> X[返回错误给 dispatcher]
  B -- 已派过 --> Y[返回已有任务]
  B -- 通过 --> C[task 状态 pending, 写入 brief 并建索引]
  C --> D{checkout 类型}
  D -- worktree --> D1["新建或复用 repo.worktrees/branch"]
  D -- continue --> D2[沿用旧任务的 worktree]
  D -- readonly --> D3[仓库主目录]
  D1 & D2 & D3 --> E["环境 env.ensure: 共享服务 check/start, 端口租约, 数据库从模板克隆, 复制未跟踪文件, setup 命令"]
  E --> F{会话}
  F -- reuse --> F1[旧任务的 worker 会话]
  F -- 新建 --> F2["新 W-n"]
  F1 & F2 --> G{"进程池: 活跃数 < 上限?"}
  G -- 是 --> G1["启动 omp: 新开或 --resume"]
  G -- "否, 有空闲 worker" --> G2[停掉最久未用的再启动]
  G -- 否 --> G3[排队, 发 info 通知]
  G1 & G2 --> H["outbox: envelope + brief"]
  H --> I[桥接 hello 后按顺序投递, 写已投递标记防重]
  I --> J[task 状态 working]
  E -. 失败 .-> Z["provision_failed, 发紧急通知给主聊天"]
```

envelope 是 Hub 写在 brief 前面的固定头部，内容包括：
- worktree 路径、分支、已导出的环境变量和测试命令；
- 先读 `skill://pstack-omp`，再按 `skill://poteto-mode` 的对应 playbook 执行；
- 不准 push、合并或删分支，不准交互式提问；
- 每轮结束前调用 `home_report`。

## 3. 回流流水线：worker 结果怎么送到主聊天

```mermaid
flowchart TD
  R1[worker 调 home_report] --> R2[先暂存为本轮汇报]
  R3[worker 本轮结束 run_end] --> R4[core/task.ts 根据事件算出新状态]
  R2 --> R4
  R4 --> S1{汇报内容}
  S1 -- done --> T1[done]
  S1 -- question 或 blocked --> T2["awaiting(question/blocked)"]
  S1 -- 没汇报 --> T3["awaiting(no_report), 附上最后一段回复"]
  T1 & T2 & T3 --> N[按 NOTICE_POLICY 定优先级, 生成一条通知]
  N --> P{decideDelivery}
  P -- "主聊天忙, 或上一批还没送到" --> W1[等]
  P -- "防抖: 最后一条后 2s, 最多 10s" --> Q{"有非 info 通知 且 自上次你说话后唤醒次数 < 3?"}
  Q -- 是 --> K1["wake: followUp + 开新一轮"]
  Q -- 否 --> K2["context: 只加入上下文, 界面显示 paused"]
  K1 & K2 --> M[主聊天按 home-notices skill 处理]
  M --> M1["home_close done, 先自己核对证据"]
  M --> M2["home_send 回答问题, 必须附 decision"]
  M --> M3[home_escalate 交给你]
```

- **优先级**：question、blocked、出错、中断、开工失败为紧急；done 为普通；审批、进度、排队等为 info，info 不会唤醒主聊天。
- **数据边界**：worker 写的文字一律包在 `<worker-report>` 里，按数据处理，不作为指令执行。
- **唤醒次数**：从「自上次你说话以来送出的 wake 批次」现算出来，不单独存计数器，因此不会算错。你在主聊天里说话，或在界面点「Let main continue」，次数就清零。

## 4. 上报给你的流水线：没有表单，直接用 worker 自己的终端

```mermaid
flowchart LR
  E1[主聊天 home_escalate] --> E2["开一条 escalation, 同一任务只开一条"]
  A1[worker 触发工具审批] --> E2
  E2 --> E3["确保 worker 进程在跑, 人为触发可超出上限 1 个"]
  E3 --> E4["界面 focus 事件: 右侧打开 W-n 终端; 你正在打字时只弹提示"]
  E4 --> E5["你在 W-n 的 omp 里直接回复"]
  E5 --> E6[桥接 input 事件]
  E6 --> E7["escalation 关闭 (human_replied), 任务回到 working"]
  E7 --> E8[worker 继续, 结果再走一遍回流流水线]
```

工具审批（approval）不经过主聊天的判断：主聊天无法替你在 worker 终端里按「批准」，所以 Hub 直接上报给你，只给主聊天发一条 info 通知。

## 5. 任务状态机

```mermaid
stateDiagram-v2
  [*] --> pending: home_dispatch
  pending --> working: brief 已投递
  pending --> awaiting: provision_failed
  working --> done: 汇报 done 且本轮结束
  working --> awaiting: question / blocked / no_report / 审批 / 进程丢失
  awaiting --> working: home_send / 你在终端里输入 / 审批已处理
  done --> working: home_send 或你输入（重新打开）
  working --> cancelled: home_close cancelled
  awaiting --> cancelled: home_close cancelled
  done --> [*]
  cancelled --> [*]
```

`awaiting` 带一个等待原因：`question`、`blocked`、`no_report`、`aborted`、`error`、`approval`、`interrupted`、`provision_failed`。状态只由 `core/task.ts` 根据事件计算，事件只追加不修改，并且带去重键，所以同一事件重复到达不会重复生效。

## 6. 进程池流水线

```mermaid
stateDiagram-v2
  [*] --> cold
  cold --> starting: ensureLive（新开或 --resume 会话文件）
  starting --> idle: 桥接 hello
  idle --> running: 投递 prompt / 通知 / 你输入
  running --> idle: run_end
  running --> approval: 工具审批弹出
  approval --> running: 审批处理完
  idle --> stopping: 空闲超时（默认 20 分钟）或为新任务腾位
  stopping --> cold: 进程退出（会话文件保留）
  running --> cold: 进程意外退出 → 任务标 interrupted
```

- **上限**：默认最多 4 个活跃 worker；主聊天不计入。
- **可以停掉的条件**：空闲、没有审批在等、没有后台任务、终端没人看、没有未处理的上报。
- **代价**：每个 omp 进程大约 450–500 MB 内存。

## 7. 记忆与恢复流水线

```mermaid
flowchart LR
  subgraph 写入
    C1[主聊天 message_end] --> C2[chat_record 原样存档]
    C2 --> C3[doc + FTS5 trigram 索引]
    B1["brief / 汇报 / 每轮回复 / 决定"] --> C3
  end
  subgraph 读取
    C3 --> Q1["home_search, 短词退回 LIKE"]
    C2 --> Q2["home_chat 按 chat:id 前后翻"]
  end
  subgraph 重启
    R1[Hub 启动] --> R2[停掉残留进程, 标记哪些中断]
    R2 --> R3["正在跑的任务改为 awaiting(interrupted), 发紧急通知"]
    R3 --> R4["主聊天 --resume; worker 保持冷启动, 用到再恢复"]
  end
```

- **不压缩的含义**：主聊天的工作窗口靠 omp 的 `context_notes` / `new_context` 换窗，旧内容不会删除。完整记录在 omp 的会话文件和 SQLite 的 `chat_record` 里各存一份，后者用于检索。
- **中文检索**：trigram 至少要 3 个字才能匹配，更短的词改用 `LIKE` 查询，所以「中文」这样的两字词也能搜到。
- **中断的任务**：Hub 不会自动重跑，由主聊天决定是否继续。

## 8. 还缺的一段：收尾

上面所有流水线都停在「任务 done」。worktree 里的改动没有 commit，也不会合并。审阅、提交、开 PR 以及合并后清理 worktree、数据库和端口，目前都在流水线之外，需要你手动完成。这是下一步最优先要补的部分。

```mermaid
flowchart LR
  A[任务 done] --> B[改动留在 worktree, 未提交]
  B -. 待实现 .-> C[审阅 diff]
  C -.-> D[commit / 开 PR]
  D -.-> E[合并, 由你按下]
  E -.-> F["清理 worktree / 数据库 / 端口 / 会话"]
```

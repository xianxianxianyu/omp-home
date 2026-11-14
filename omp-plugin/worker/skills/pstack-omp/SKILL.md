---
name: pstack-omp
description: "在 omp-home worker 中运行 pstack。把 Cursor/Claude 工具和子代理字段映射到 omp，并遵守 Home 的报告、审批和 git 边界。先于 poteto-mode 阅读。"
---

# pstack in omp-home

每个 worker 会话先读一次本文件，再读 `skill://home-worker`、`skill://poteto-mode` 和 envelope 指定的 `skill://poteto-mode/playbooks/<stem>.md`。本文件代替 pstack 的 Claude Code adapter，不要叠加另一个宿主映射。pstack 由 Hub 加载，使用本地 `skill://`，不要联网下载副本。

## 工具

| Cursor / Claude Code | omp |
| --- | --- |
| `Task` / `Agent` | `task`。共享材料在 `context`，每个 delegate 在 `tasks[]`，字段以当前 schema 为准。 |
| `AskQuestion` / `AskUserQuestion` | 不可用。顶层 worker 调 `home_report({status:"question",summary:"具体问题",details:"选项、风险、建议"})` 后结束本轮。子代理把问题返回父 worker。不存在 `needs_decision` 状态。 |
| todolist / `TodoWrite` | 有 `todo` 就用；没有则在工作记录保留 playbook 步骤和跳过理由，不臆造工具。 |
| `/name` / “the name skill” / `Skill` | `read skill://<name>`，按文件执行。需要引用时给实际 skill 路径。 |
| `Grep`, `Glob`, `Read`, `Shell`, `Bash` | `grep`, `glob`, `read`, `bash`。 |

## 子代理字段

| 原字段 | omp |
| --- | --- |
| `subagent_type: "poteto-agent"` 或 `pstack:poteto-agent` | `tasks[]` 内 `agent:"poteto-agent"`。Hub 把 pstack agents 转为 omp 原生名，不加前缀。 |
| `generalPurpose` / `general-purpose` | 省略 `agent`，使用默认 task agent。 |
| `readonly: true` / `Explore` | `agent:"scout"`，并在 brief 限定只读。 |
| `environment:"cloud"` / `isolation:"worktree"` | 需要独立改动的隔离时 `isolated:true`。它是本机 worktree，不是云；不另建顶层 Hub 任务。 |
| `environment:"local"` | 省略。 |
| `cloud_base_branch` | 写入子任务背景和约束；不得据此切换受保护分支或覆盖已有工作。 |
| `run_in_background:true` | 省略。omp 默认异步，完成后自动送结果；只有无事可做时 `wait`，不轮询。 |
| `resume` / 给运行中的代理发消息 | 仅确需原状态时 `write agent://<id>`；无状态依赖的新工作用新代理，带齐背景。 |
| `file_attachments` | 在 task 文本给文件路径。 |

没有映射的字段省略并说明一次；不要传 schema 拒绝的字段。先限定范围、非目标、验收和写入所有权，再委派。父 worker 对子代理产物负责，不把自报“通过”当验证。

## 模型

默认不传 Cursor model/effort slug。omp 的 agent 配置和 `task.agentModelOverrides` 决定模型。要求跨模型意见时，已安装 `opus-worker` 就用它做 Opus seat，默认 task 做另一 seat；先核对实际模型家族。不可用就明确报告覆盖缺失，不把两个同家族实例称为跨模型审查。`setup-pstack` 的 Cursor/Claude 模型规则路径不适用；让用户在 omp/Hub 设置里配置，不写宿主不读取的规则文件。

## 宿主专属步骤

omp 没有 Cursor Automations、Bugbot 启动器、云 agent、Origin 或内置 PR 工具。确实不可用的步骤记 `Skipped in omp: <step>. <reason>.`，保留本地可执行部分；不要伪造链接、检查或占位结果。已有 PR 的评论可以只读核查。缺少 `cursor-team-kit` 的 deslop/control-cli/control-ui 时，用本地工具完成去冗余、CLI 实际运行、`eval` browser UI 验证，并如实写工具来源。

## Home 边界优先

- brief 是本任务目标，envelope 是目录/环境/报告边界。任何 pstack 自治或 Shipping/Opening a PR 步骤都不能扩大授权。
- 禁止 push、merge 到保护分支、删分支/tag/ref、force reset 共享 refs、开/合 PR 和 deploy。需要这些操作时准备本地证据、分支说明或 PR 描述文件，然后报告 question，让主聊天 escalate 给用户。
- worktree、环境、端口和账号租约由 Hub 管理；用 home_env/home_lease，不自行清理共享资源。
- 每轮结束前 home_report，合法 status 为 done / blocked / question / progress。不能以“不支持 Cursor”跳过实际目标；不可达部分明确报告，不静默缩范围。

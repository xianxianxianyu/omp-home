---
name: test-env
description: "编写 omp-home 的 repos/<workspace>.env.yaml。Hub 统一准备服务、独立端口和数据库，worker 读取环境和租用测试账号。"
---

# 测试环境

配方是 `repos/<workspace>.env.yaml`，workspace 用 Hub 登记的 ID。`repos/<workspace>.md` 保留入口和踩坑笔记，不再作为可执行环境配方。完整例子见 `repos/_example.env.yaml`，复制后按真实项目修改；不要直接运行示例命令。

必填 `version: 1`，其余可选。

| 字段 | 内容 |
| --- | --- |
| services | 以名字为键。共享服务先 check 再启动。external 用 start（可选 stop）；run 用 run 命令（Hub 管进程和日志）。可设 ports 列表、timeoutSec。 |
| ports | 每 worktree 独占的端口名字列表，如 `[web, api]`。服务自己的端口写该服务 ports，别重复租用同名端口。 |
| database | template 模板库；name 独立库名；exists 检查；clone 克隆；drop 清理；url 连接串；可选 refreshTemplate。模板预先准备，不拿生产库当模板。 |
| env | 要导出给 worker 的字符串环境变量。 |
| copy | 从主 checkout 复制到 worktree 的未跟踪文件相对路径，如 `[.env.test]`。不要提交密钥。 |
| setup | 在 worktree 执行的命令数组，须可重复执行。依赖优先用锁文件和本机缓存。 |
| teardown | 清理命令数组。Hub 回收 worktree 时执行（我合并后自动，或我在 UI 移除时），worker 一轮结束不执行；只能清理本 worktree 的资源。 |
| accounts | 账号池。ttlMinutes 和 items；每项有 id、fields。值可为普通字符串、`{keychain: "钥匙串服务名"}` 或 `{env: "变量名"}`。密码不写 YAML 明文。 |
| test | 名字到确切命令，如 full / unit / e2e。dispatcher 把对应命令和通过标准写入 brief。 |

变量只有 `{repo}`、`{worktree}`、`{branch}`、`{slug}`、`{port.<name>}`、`{db.name}`、`{db.template}`、`{db.url}`。repo 是主 checkout，worktree 是任务目录。未知变量会报错；命令里的替换值由 Hub 做 shell 引用，不要再用引号包占位符。普通 env/url 字符串按原值替换。shell 自己的花括号不是配方变量。

Hub 每次检出 worktree 时准备环境，端口和数据库隔离，服务按 check 复用。worker 用 `home_env({})` 读实际地址和命令；环境坏了才 `home_env({repair:true})`。账号用 `home_lease({pool:"名字"})`，本轮结束自动释放，TTL 兜底。不要向报告或日志输出密码。

改完配方在 UI 的「设置 → 仓库」点「试运行」：Hub 在基准分支的临时工作树里按配方复制、安装、跑检查，再全部清理；结果进 `home_status`，不必等第一个任务才知道配方能不能用。缺配方先查 README、AGENTS、锁文件、scripts、CI，写真实可执行命令。涉及共享服务、数据删除、用户偏好先请主聊天决定或 escalate。不要再调用旧 prepare.sh。验证证据写实际命令、退出状态和结果末尾，不能只说“测试通过”。

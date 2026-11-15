import { z } from "zod";
import { emptyTranscript, reduceTranscript } from "../../shared/transcript.ts";
import type { Item, ToolView, TranscriptEvent, TranscriptView } from "../../shared/transcript.ts";
import { MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGES, PROMPT_IMAGE_TYPES } from "../../shared/api.ts";
import type { AbortResult, CommandDTO } from "../../shared/api.ts";
import { MAX_ATTACHMENTS, parseAttachmentBlock, withAttachmentBlock } from "../../shared/attachments.ts";
import type { SocketHandlers } from "./transport.ts";
import { uiResponse } from "./transcript-schema.ts";

const commands: CommandDTO[] = [
	{ name: "focus", description: "Demo: a worker needs your attention", source: "demo" },
	{ name: "pause", description: "Demo: main has used its wake budget", source: "demo" },
	{ name: "dispatch", description: "Demo: add an in-flight task", source: "demo" },
	{ name: "new", description: "Start a new conversation", source: "omp" },
	{ name: "model", description: "Choose a model", source: "omp" },
	{ name: "compact", description: "Compact the context window", source: "omp" },
	{ name: "help", description: "Available commands and shortcuts", source: "omp" },
];
function assistant(id: string, text: string, at: number): Extract<Item, { kind: "assistant" }> {
	return { kind: "assistant", id, at, blocks: [{ kind: "text", text }], streaming: false, model: "openai-codex/gpt-6-astra", stopReason: "stop", error: null, usage: null };
}
function seed(sessionId: string): TranscriptView {
	const now = Date.now();
	const isMain = sessionId.startsWith("M-");
	let view = emptyTranscript();
	const apply = (event: TranscriptEvent) => { view = reduceTranscript(view, event); };
	if (isMain && new URLSearchParams(location.search).get("scene") === "empty") {
		apply({ t: "item", item: { kind: "user", id: "quiet-user", at: now - 60000, text: "今天的工作先到这里。保留记录，下一步再一起看。", images: 0, from: "human" } });
		apply({ t: "item", item: assistant("quiet-assistant", "好的。今天的工作已经收尾，任务与决定都留在 **History** 里。\n\n随时告诉我下一件想完成的事。", now - 50000) });
		apply({ t: "status", patch: { model: "openai-codex/gpt-6-astra", contextPercent: 19 } });
		return view;
	}
	const tools: ToolView[] = [
		{ callId: "read-1", name: "read", intent: "Reading search boundaries", args: { path: "src/search/index.ts:30-80" }, output: "…[1234 earlier characters not shown]\nexport async function indexChanged(paths: string[]) {\n  return index.update(paths);\n}", omittedCharacters: 1234, status: "done", startedAt: now - 85000, endedAt: now - 83000 },
		{ callId: "bash-1", name: "bash", intent: "Verifying incremental indexing", args: { command: "pnpm test -- search", cwd: "/worktrees/atlas/T-11" }, output: "Running search tests…", status: "running", startedAt: now - 3000, endedAt: null },
		{ callId: "dispatch-1", name: "home_dispatch", intent: "Routing isolated search work", args: { title: "Make search indexing incremental", workspace: "atlas", playbook: "feature" }, output: '{"task":"T-11","session":"W-11","status":"working"}', status: "done", startedAt: now - 80000, endedAt: now - 78000 },
		{ callId: "task-1", name: "task", intent: "Reviewing boundaries in parallel", args: { tasks: [{ agent: "scout", task: "Trace the indexing boundary" }, { agent: "reviewer", task: "Review migration risks" }] }, output: "Spawned scout-1 and reviewer-1. Results arrive automatically.", status: "done", startedAt: now - 76000, endedAt: now - 75000 },
	];
	const firstRequest = isMain ? withAttachmentBlock("让 Atlas 的搜索支持增量索引。顺便看看 Console 的账户迁移，两个任务保持隔离。", [{ path: "/tmp/omp-home-demo/atlas/docs/search-design.md", folder: false }, { path: "/tmp/omp-home-demo/atlas/src/search", folder: true }]) : "Review the account migration. Preserve existing data and show the reversible path.";
	apply({ t: "item", item: { kind: "user", id: "user-1", at: now - 100000, text: firstRequest, images: 0, from: "human" } });
	const reply = assistant("assistant-1", isMain ? "我会把工作拆成两个独立任务，先检查现有边界，再让 worker 在各自的 worktree 里推进。\n\n**你只需要处理真正需要判断的决定。** 进展和证据会留在这里。" : "The migration is isolated in this worktree. I recommend **adding the new column first**, then backfilling and removing the legacy column in a separate release.", now - 95000);
	reply.blocks.unshift({ kind: "thinking", text: "先确认两个仓库的状态和工作边界。搜索索引可以增量更新，但账户迁移涉及数据契约，需要保持可回退性。独立 worktree 可以避免并行写入和环境互相污染。主聊天只接收证据并处理可逆决定，不替用户批准生产数据变更。" });
	reply.blocks.push(...tools.map(tool => ({ kind: "tool" as const, callId: tool.callId })));
	apply({ t: "item", item: reply });
	for (const tool of tools) apply({ t: "tool", tool });
	apply({ t: "item", item: { kind: "notice", id: "irc-1", at: now - 65000, source: "irc", from: "scout", text: "The index already exposes an update(paths) boundary. No new service or shared database is needed." } });
	apply({ t: "item", item: { kind: "notice", id: "notice-1", at: now - 60000, source: "omp-home", from: null, text: "T-11 → W-11 · Atlas\nWorker started in an isolated worktree. Console’s migration is waiting for your approval." } });
	apply({ t: "item", item: { kind: "request", id: "approval-1", at: now - 30000, request: { method: "select", title: "Allow the worker to inspect migration status?", options: ["Approve", "Approve for this session", "Deny"], details: ["Read-only · no production changes", null, null] }, answer: null } });
	apply({ t: "item", item: { kind: "request", id: "ask-1", at: now - 20000, request: { method: "ask", questions: [{ id: "rollout", header: "Migration", question: "How should we roll out the schema change?", multi: false, recommended: 0, options: [{ label: "Two-phase migration", description: "Add, backfill, then remove in a later release." }, { label: "Single release", description: "Requires coordinated downtime." }] }, { id: "checks", header: "Evidence", question: "Which checks matter most?", multi: true, recommended: null, options: [{ label: "Data integrity", description: null }, { label: "Rollback rehearsal", description: null }] }] }, answer: null } });
	apply({ t: "item", item: { ...assistant("stream-1", "", now), streaming: true, stopReason: null } });
	apply({ t: "subagent", id: "scout-1", patch: { agent: "scout", task: "Trace the indexing boundary", status: "running", lastIntent: "Tracing changed-file ownership", parentToolCallId: "task-1", startedAt: now - 75000, endedAt: null } });
	apply({ t: "subagent_event", id: "scout-1", event: { t: "item", item: { kind: "user", id: "sub-user-1", at: now - 75000, text: "Find the existing update boundary; do not modify files.", images: 0, from: "agent" } } });
	const nested = assistant("sub-assistant-1", "The current `index.update(paths)` entry point owns file-level changes. I’m tracing how deletions reach it.\n\n```ts\nawait index.update(changedPaths);\n```", now - 70000);
	nested.blocks.unshift({ kind: "thinking", text: "Follow the caller to the storage boundary before recommending an API change." });
	apply({ t: "subagent_event", id: "scout-1", event: { t: "item", item: nested } });
	apply({ t: "subagent", id: "reviewer-1", patch: { agent: "reviewer", task: "Review migration risks", status: "completed", lastIntent: "Verified rollback plan", parentToolCallId: "task-1", startedAt: now - 74000, endedAt: now - 15000 } });
	apply({ t: "subagent_event", id: "reviewer-1", event: { t: "item", item: assistant("review-1", "**Review complete.** Add the nullable column first. Backfill in batches; retain the legacy field until the next release. The rollback path remains a configuration change.", now - 15000) } });
	apply({ t: "status", patch: { phase: "running", settled: false, model: isMain ? "openai-codex/gpt-6-astra" : "anthropic/claude-opus-5-5", contextPercent: 23, queue: { steering: ["Keep the migration reversible"], followUp: ["Summarize the search test evidence", "Then draft a short release note"] } } });
	return { ...view, earlierCursor: view.items[0].id };
}
function oldHistory(): TranscriptView {
	let view = emptyTranscript();
	const now = Date.now() - 300000;
	const tools = [
		{ name: "home_search", args: { query: "search timeout" }, output: "T-9 · Fixed timeout handling; existing retry boundary preserved." },
		{ name: "home_status", args: {}, output: "2 live workers · 1 approval · 3 open tasks" },
		{ name: "home_send", args: { task: "T-11", text: "Use the existing update boundary" }, output: "Delivered to W-11" },
		{ name: "home_escalate", args: { task: "T-12", reason: "Schema contract needs human judgment" }, output: "Opened E-3 for T-12" },
		{ name: "home_close", args: { task: "T-9", status: "done" }, output: "T-9 closed after reviewing test evidence" },
		{ name: "edit", args: { path: "src/search.ts", oldText: "await index.rebuild();", newText: "await index.update(changedPaths);" }, output: "Updated src/search.ts" },
		{ name: "write", args: { path: "tests/fixture.txt", content: "incremental\nindexing" }, output: "Wrote tests/fixture.txt" },
	];
	const message = assistant("history-assistant", "Earlier work is retained as structured history, including decisions, approvals and file changes.", now);
	message.blocks.push(...tools.map((_, index) => ({ kind: "tool" as const, callId: `old-tool-${index}` })));
	view = reduceTranscript(view, { t: "item", item: message });
	tools.forEach((tool, index) => { view = reduceTranscript(view, { t: "tool", tool: { ...tool, callId: `old-tool-${index}`, intent: null, status: "done", startedAt: now, endedAt: now + 1000 } }); });
	const requests: Extract<Item, { kind: "request" }>[] = [
		{ kind: "request", id: "confirm-old", at: now + 2000, request: { method: "confirm", title: "Keep the old column for one release?", message: "This preserves the rollback path." }, answer: null },
		{ kind: "request", id: "input-old", at: now + 3000, request: { method: "input", title: "Name the preview environment", placeholder: "migration-preview", secret: false }, answer: null },
		{ kind: "request", id: "editor-old", at: now + 4000, request: { method: "editor", title: "Review the rollout note", prefill: "Add the column. Backfill safely. Remove in the next release." }, answer: null },
	];
	for (const item of requests) view = reduceTranscript(view, { t: "item", item });
	return view;
}

const promptImages = z.array(z.object({ data: z.string(), mimeType: z.enum(PROMPT_IMAGE_TYPES) }).refine(image => image.data.length * 3 / 4 <= MAX_PROMPT_IMAGE_BYTES, "Image is larger than 5 MB")).max(MAX_PROMPT_IMAGES).optional();
const promptAttachments = z.array(z.object({ path: z.string() })).max(MAX_ATTACHMENTS).optional();

/** `isFolder` stands in for the hub's stat when it writes the attachment block. */
export function createMockSessions(onCommand: (command: string, sessionId: string) => void, isFolder: (path: string) => boolean) {
	const views = new Map<string, TranscriptView>();
	const history = new Map<string, TranscriptView>();
	const subscribers = new Map<string, Set<SocketHandlers>>();
	const scripted = new Set<string>();
	let sequence = 0;
	const emit = (id: string, event: TranscriptEvent) => {
		views.set(id, reduceTranscript(views.get(id) ?? emptyTranscript(), event));
		for (const handlers of subscribers.get(id) ?? []) handlers.message(JSON.stringify(event));
	};
	const current = (id: string) => views.get(id) ?? seed(id);
	const reply = (id: string, text: string, images: number) => {
		const at = Date.now();
		const key = `${at}-${++sequence}`;
		emit(id, { t: "item", item: { kind: "user", id: `user-${key}`, at, text, images, from: "human" } });
		const files = parseAttachmentBlock(text).attachments.length;
		emit(id, { t: "item", item: assistant(`reply-${key}`, text.startsWith("/") ? `Demo command \`${text}\` handled.` : images ? `收到这条消息和 ${images} 张图片。` : files ? `收到这条消息和 ${files} 个附件。` : "收到。这条消息已加入会话。", at) });
	};
	/** Like omp's `branch` + prompt: drop the user message at `index` and everything after it, then send `text` in its place. */
	const rewind = (id: string, index: number, text: string, images: number) => {
		const view = current(id);
		if (view.status.phase !== "idle") throw new Error("Stop the current turn first");
		emit(id, { t: "reset", view: { ...view, items: view.items.slice(0, index) } });
		reply(id, text, images);
	};
	return {
		connect(id: string, handlers: SocketHandlers) {
			let readyState = 0;
			const timer = window.setTimeout(() => {
				readyState = 1; handlers.open();
				if (!views.has(id)) { views.set(id, seed(id)); history.set(id, oldHistory()); }
				const listeners = subscribers.get(id) ?? new Set<SocketHandlers>(); listeners.add(handlers); subscribers.set(id, listeners);
				handlers.message(JSON.stringify({ t: "reset", view: views.get(id)! } satisfies TranscriptEvent));
				if (!scripted.has(id) && views.get(id)!.tools["bash-1"]) {
					scripted.add(id);
					const parts = ["搜索的边界已经确认。", " **两个 worker 正在独立推进。**", "\n\n你可以展开工具查看原始证据，或打开 **Subagents** 跟进每一步。"];
					parts.forEach((text, index) => window.setTimeout(() => { if (views.get(id)!.items.some(item => item.id === "stream-1" && item.kind === "assistant" && item.streaming)) emit(id, { t: "delta", id: "stream-1", index: 0, kind: "text", text }); }, 350 + index * 450));
					window.setTimeout(() => {
						const item = views.get(id)!.items.find(item => item.id === "stream-1");
						if (item?.kind !== "assistant" || !item.streaming) return;
						const tool = views.get(id)!.tools["bash-1"];
						emit(id, { t: "tool_output", callId: tool.callId, output: "✓ changed paths\n✓ deleted paths\n✓ unchanged index\n3 tests passed" });
						emit(id, { t: "tool", tool: { ...tool, status: "done", endedAt: Date.now(), output: "✓ changed paths\n✓ deleted paths\n✓ unchanged index\n3 tests passed" } });
						emit(id, { t: "item", item: { ...item, streaming: false, stopReason: "stop" } });
					}, 1900);
				}
			}, 40);
			return { get readyState() { return readyState; }, send() { throw new Error("Session streams are server-to-client only"); }, close() { readyState = 3; clearTimeout(timer); subscribers.get(id)?.delete(handlers); handlers.close(); } };
		},
		request(id: string, action: string, body: Record<string, unknown>, parts: string[], before: string | null): unknown {
			if (action === "commands") return commands;
			if (action === "history") { const old = history.get(id) ?? oldHistory(); const current = views.get(id) ?? seed(id); const all = [...old.items, ...current.items]; const index = before ? all.findIndex(item => item.id === before) : all.length; const end = index < 0 ? all.length : index; const items = all.slice(Math.max(0, end - 60), end); return { t: "prepend", items, tools: { ...old.tools, ...current.tools }, earlierCursor: end > 60 ? items[0].id : null } satisfies TranscriptEvent; }
			if (action === "prompt") {
				const prompt = z.object({ text: z.string(), mode: z.enum(["auto", "steer", "followUp"]).optional(), images: promptImages, attachments: promptAttachments }).parse(body);
				if (!prompt.text.trim() && !prompt.images?.length && !prompt.attachments?.length) throw new Error("Message is empty");
				const text = withAttachmentBlock(prompt.text, (prompt.attachments ?? []).map(({ path }) => ({ path, folder: isFolder(path) })));
				onCommand(prompt.text.trim(), id);
				const view = current(id);
				if (view.status.phase !== "idle" && !prompt.text.startsWith("/")) {
					// The demo turn sits in one long step, so steers and follow-ups stay queued until it is stopped.
					const queue = prompt.mode === "steer" ? "steering" : "followUp";
					emit(id, { t: "status", patch: { queue: { ...view.status.queue, [queue]: [...view.status.queue[queue], text] } } });
					return { ok: true };
				}
				reply(id, text, prompt.images?.length ?? 0);
				return { ok: true };
			}
			if (action === "abort") {
				const view = current(id);
				const restored = [...view.status.queue.steering, ...view.status.queue.followUp];
				if (view.status.phase !== "idle") {
					// omp ends an interrupted run with an aborted assistant message, empty when nothing was streaming.
					const streaming = view.items.findLast(item => item.kind === "assistant" && item.streaming);
					const interrupted = streaming?.kind === "assistant" ? streaming : { ...assistant(`aborted-${Date.now()}-${++sequence}`, "", Date.now()), blocks: [] };
					emit(id, { t: "item", item: { ...interrupted, streaming: false, stopReason: "aborted", error: "Interrupted by user" } });
				}
				emit(id, { t: "status", patch: { phase: "idle", settled: true, queue: { steering: [], followUp: [] } } });
				return { restored } satisfies AbortResult;
			}
			if (action === "queue") {
				const queue = { steering: [...current(id).status.queue.steering], followUp: [...current(id).status.queue.followUp] };
				if (parts[4] === "promote") {
					const { message } = z.object({ message: z.string() }).parse(body);
					const index = queue.followUp.indexOf(message);
					if (index >= 0) { queue.followUp.splice(index, 1); queue.steering.push(message); emit(id, { t: "status", patch: { queue } }); }
					return { promoted: index >= 0 };
				}
				const request = z.object({ message: z.string(), queue: z.enum(["steering", "followUp"]) }).parse(body);
				const index = queue[request.queue].indexOf(request.message);
				if (index >= 0) { queue[request.queue].splice(index, 1); emit(id, { t: "status", patch: { queue } }); }
				return { removed: index >= 0 };
			}
			if (action === "edit") {
				const request = z.object({ itemId: z.string(), text: z.string(), images: promptImages, attachments: promptAttachments }).parse(body);
				if (!request.text.trim() && !request.attachments?.length) throw new Error("Message is empty");
				const index = current(id).items.findIndex(item => item.id === request.itemId && item.kind === "user" && item.from === "human");
				if (index < 0) throw new Error("Message not found");
				rewind(id, index, withAttachmentBlock(request.text, (request.attachments ?? []).map(({ path }) => ({ path, folder: isFolder(path) }))), request.images?.length ?? 0);
				return { ok: true };
			}
			if (action === "retry") {
				const items = current(id).items;
				const index = items.findLastIndex(item => item.kind === "user");
				const last = items[index];
				if (last?.kind !== "user") throw new Error("Nothing to retry");
				rewind(id, index, last.text, last.images);
				return { ok: true };
			}
			if (action === "respond") {
				const request = z.object({ requestId: z.string(), response: uiResponse }).parse(body);
				const response = request.response;
				const answer = "value" in response ? response.value : "confirmed" in response ? response.confirmed ? "Yes" : "No" : "answers" in response ? response.answers.map(answer => `${answer.id}: ${[...answer.selectedOptions, answer.customInput].filter(Boolean).join(", ")}`).join("\n") : "Cancelled";
				const answerKind = "confirmed" in response ? response.confirmed ? "yes" : "no" : "cancelled" in response ? "cancelled" : undefined;
				const event: TranscriptEvent = { t: "request_closed", id: request.requestId, answer, ...(answerKind ? { answerKind } : {}) };
				emit(id, event);
				const old = history.get(id); if (old) history.set(id, reduceTranscript(old, event));
				return { ok: true };
			}
			if (action === "subagents") {
				const agentId = parts[4];
				if (parts[5] === "cancel") emit(id, { t: "subagent", id: agentId, patch: { status: "aborted", endedAt: Date.now(), lastIntent: "Cancelled by human" } });
				else { const { text } = z.object({ text: z.string() }).parse(body); emit(id, { t: "subagent_event", id: agentId, event: { t: "item", item: { kind: "user", id: `steer-${Date.now()}`, at: Date.now(), text, images: 0, from: "human" } } }); }
				return { ok: true };
			}
			throw new Error(`Unknown mock session action: ${action}`);
		},
	};
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { emptyTranscript, MAX_ITEMS, reduceTranscript, type Item, type TranscriptEvent, type TranscriptView } from "../shared/transcript.ts";
import { SessionViews } from "../server/session-views.ts";
import { render } from "../server/i18n.ts";
import { answerEvent, answerText, currentIntent, historyView, Normalizer, responseFits, TOOL_OUTPUT_LIMIT, uiRequestOf } from "../server/transcript.ts";

/**
 * Recorded omp 18.20 RPC frames (main session: home_status, bash, a `task` subagent that
 * sends IRC to main, then a wait with thinking) replayed through the normalizer and the
 * shared reducer, as the UI would see them.
 */

type Frame = Record<string, unknown> & { type: string };
const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);
const frames: Frame[] = fs
	.readFileSync(fixture("rpc-main-session.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map(line => JSON.parse(line) as Frame);

function replay(upTo = frames.length): { view: TranscriptView; toasts: string[] } {
	const normalizer = new Normalizer();
	let view = emptyTranscript();
	const toasts: string[] = [];
	frames.slice(0, upTo).forEach((frame, i) => {
		const out = normalizer.frame(view, frame, 1_000 + i);
		for (const ev of out.events) view = reduceTranscript(view, ev);
		if (out.toast) toasts.push(render(out.toast.text));
	});
	return { view, toasts };
}

const textOfItem = (item: Item | undefined) => (item?.kind === "assistant" ? item.blocks.flatMap(b => (b.kind === "text" ? [b.text] : [])).join("") : "");

test("replayed main session: items in order, tools with outputs, thinking, requests, IRC notice", () => {
	const { view, toasts } = replay();
	assert.deepEqual(
		view.items.map(i => i.kind),
		["user", "assistant", "request", "assistant", "request", "assistant", "user", "assistant", "request", "assistant", "notice", "assistant", "assistant"],
	);
	assert.deepEqual(toasts, []);
	const [first, statusCall, approval] = view.items;
	assert.equal(first?.kind === "user" && first.from, "human");
	assert.match(first?.kind === "user" ? first.text : "", /^Call the home_status tool once/);

	// Tool calls: one tool block per assistant item, the tool view finished with its output.
	assert.equal(statusCall?.kind === "assistant" && statusCall.blocks[0]?.kind, "tool");
	const tools = Object.values(view.tools);
	assert.deepEqual(
		tools.map(t => [t.name, t.status]),
		[
			["home_status", "done"],
			["bash", "done"],
			["task", "done"],
			["wait", "done"],
			["wait", "done"],
		],
	);
	const bash = tools.find(t => t.name === "bash")!;
	assert.equal(bash.intent, "Listing directory");
	assert.deepEqual(bash.args, { command: "ls -la" });
	assert.match(bash.output, /overlay\.yml/);
	assert.ok(bash.endedAt !== null && bash.endedAt >= bash.startedAt);
	assert.equal(tools.find(t => t.name === "home_status")!.output, "stub home_status ok (agent main/main)");

	// Final assistant items carry usage and stop reasons and are no longer streaming.
	const assistants = view.items.filter(i => i.kind === "assistant");
	assert.ok(assistants.every(a => !a.streaming && a.model === "claude-opus-5-5" && a.usage !== null));
	assert.equal(textOfItem(view.items[5]), "STEP1");
	assert.match(textOfItem(view.items.at(-1)), /^STEP2/);

	// The thinking block before the last wait call.
	const thinking = view.items[11];
	assert.equal(thinking?.kind, "assistant");
	if (thinking?.kind !== "assistant") return;
	assert.equal(thinking.blocks[0]?.kind, "thinking");
	assert.match(thinking.blocks[0]?.kind === "thinking" ? thinking.blocks[0].text : "", /holding until the work finishes/);
	assert.deepEqual(thinking.blocks[1], { kind: "tool", callId: "toolu_01PFh7HUFLvptuAi6bKUchwv" });

	// Approval dialogs become open request items.
	const requests = view.items.filter(i => i.kind === "request");
	assert.equal(requests.length, 3);
	assert.ok(approval?.kind === "request");
	if (approval?.kind !== "request" || approval.request.method !== "select") return;
	assert.equal(approval.id, "15cd9afe5eb3571d");
	assert.equal(approval.request.title, "Allow tool: home_status");
	assert.deepEqual(approval.request.options, ["Approve", "Approve home_status for this session", "Deny"]);
	assert.equal(approval.answer, null);

	// irc_message and the session's custom message are one notice.
	const notices = view.items.filter(i => i.kind === "notice");
	assert.deepEqual(notices, [{ kind: "notice", id: "irc:15cd9b08ab335724", at: 1794645611180, source: "irc", from: "Pinger", text: "hello-irc" }]);

	assert.equal(view.status.phase, "idle");
	assert.equal(view.status.settled, true);
});

test("the task subagent gets its own transcript with synthesized message ids", () => {
	const { view } = replay();
	const pinger = view.subagents.Pinger;
	assert.ok(pinger);
	assert.equal(pinger.agent, "sonic");
	assert.equal(pinger.status, "completed");
	assert.equal(pinger.parentToolCallId, "toolu_015idpLq4SgMWJnN27yYBYYP");
	assert.match(pinger.task, /write the text 'hello-irc'/);
	assert.equal(pinger.lastIntent, "Sending requested test message");
	assert.ok(pinger.endedAt !== null && pinger.endedAt > pinger.startedAt);
	const items = pinger.transcript.items;
	assert.deepEqual(
		items.map(i => [i.id, i.kind]),
		[
			["Pinger#1", "user"],
			["Pinger#2", "assistant"],
			["Pinger#3", "assistant"],
		],
	);
	assert.equal(items[0]?.kind === "user" && items[0].from, "agent");
	const write = Object.values(pinger.transcript.tools);
	assert.deepEqual(
		write.map(t => [t.name, t.status, t.intent, t.output]),
		[["write", "done", "Sending requested test message", "Delivered to Main."]],
	);
	assert.equal(textOfItem(items[2]), "PINGED");
	assert.equal(Object.keys(view.tools).some(id => id.startsWith("call_")), false, "subagent tools stay out of the main view");
});

test("text streams as deltas into a streaming item before message_end replaces it", () => {
	const streamingEnd = frames.findIndex(f => {
		const ev = f.assistantMessageEvent;
		return f.messageId === "msg-6" && typeof ev === "object" && ev !== null && "type" in ev && ev.type === "text_end";
	});
	const { view } = replay(streamingEnd + 1);
	const item = view.items.find(i => i.id === "msg-6");
	assert.equal(item?.kind === "assistant" && item.streaming, true);
	assert.equal(textOfItem(item), "STEP1");
	assert.equal(view.status.phase, "running");
});

test("history pages become items with tool results; IRC notices keep their live id", () => {
	const page = JSON.parse(fs.readFileSync(fixture("rpc-history-page.json"), "utf8")) as { messages: unknown[] };
	const { items, tools } = historyView(page.messages, 0);
	assert.deepEqual(
		items.map(i => i.kind),
		["user", "assistant", "assistant", "assistant", "user", "assistant", "assistant", "notice", "assistant", "assistant"],
	);
	assert.equal(items[0]!.id, "h0");
	assert.ok(items.some(i => i.id === "irc:15cd9b08ab335724"));
	assert.equal(tools.toolu_01BzWAVKSmgBYdsr5ktMWHsr?.status, "done");
	assert.match(tools.toolu_01BzWAVKSmgBYdsr5ktMWHsr!.output, /overlay\.yml/);
	assert.equal(Object.values(tools).length, 5);
});

test("session views: bounded live window, older items paged by cursor, reset on reseed", () => {
	const views = new SessionViews(() => {});
	const user = (i: number) => ({ role: "user", content: [{ type: "text", text: `m${i}` }], timestamp: i, attribution: "user" });
	views.seed("M-1", { messages: Array.from({ length: MAX_ITEMS + 150 }, (_, i) => user(i)), commands: { commands: [{ name: "help", description: "Show help", source: "builtin" }] }, state: { isStreaming: false, isSettled: true, model: { id: "opus" }, contextUsage: { percent: 12.345 } } });
	const sent: TranscriptEvent[] = [];
	const unsubscribe = views.subscribe("M-1", ev => sent.push(ev));
	assert.equal(sent[0]?.t, "reset");
	const view = views.view("M-1");
	assert.equal(view.items.length, MAX_ITEMS);
	assert.equal(view.items[0]!.id, "h150");
	assert.equal(view.earlierCursor, "h150");
	assert.equal(view.status.model, "opus");
	assert.equal(view.status.contextPercent, 12.3);
	assert.deepEqual(views.commands("M-1"), [{ name: "help", description: "Show help", source: "builtin" }]);

	const page1 = views.history("M-1", "h150");
	assert.deepEqual([page1.items[0]!.id, page1.items.at(-1)!.id, page1.earlierCursor], ["h50", "h149", "h50"]);
	const page2 = views.history("M-1", "h50");
	assert.deepEqual([page2.items.length, page2.earlierCursor], [50, null]);
	assert.throws(() => views.history("M-1", "nope"), /unknown history cursor/);

	// Live items push the oldest out of the window; they stay reachable through history.
	views.frame("M-1", { type: "message_end", messageId: "msg-1", message: { role: "user", content: "live", timestamp: 1 } });
	assert.equal(views.view("M-1").items[0]!.id, "h151");
	assert.deepEqual(views.history("M-1", "h151").items.at(-1)!.id, "h150");
	assert.equal(sent.at(-1)?.t, "item");
	assert.equal(views.subscribers("M-1"), 1);
	unsubscribe();
	assert.equal(views.subscribers("M-1"), 0);

	// A request answered or left open when the process ends.
	views.frame("M-1", { type: "extension_ui_request", id: "q1", method: "confirm", title: "Proceed?", message: "Really?" });
	assert.deepEqual(views.openRequest("M-1", "q1"), { method: "confirm", title: "Proceed?", message: "Really?" });
	views.ended("M-1");
	assert.throws(() => views.openRequest("M-1", "q1"), /already answered \(Session ended\)/);
});

test("dialog requests: shapes, fitting answers and their one-line rendering", () => {
	const ask = uiRequestOf({ method: "ask", questions: [{ id: "q", question: "Which?", options: [{ label: "A" }, { label: "B", description: "bee" }], recommended: 1 }] });
	assert.deepEqual(ask, { method: "ask", questions: [{ id: "q", question: "Which?", header: null, options: [{ label: "A", description: null }, { label: "B", description: "bee" }], multi: false, recommended: 1 }] });
	const select = uiRequestOf({ method: "select", title: "Pick", options: ["Approve", "Deny"], optionDetails: [{ description: "go" }] });
	assert.deepEqual(select, { method: "select", title: "Pick", options: ["Approve", "Deny"], details: ["go", null] });
	assert.equal(uiRequestOf({ method: "notify", message: "hi" }), null);
	assert.ok(select && responseFits(select, { value: "Deny" }));
	assert.ok(select && !responseFits(select, { value: "Maybe" }));
	assert.ok(select && !responseFits(select, { confirmed: true }));
	assert.ok(ask && responseFits(ask, { cancelled: true }));
	assert.equal(ask && answerText(ask, { answers: [{ id: "q", selectedOptions: ["B"], customInput: "and C" }] }), "B, and C");
	const secret = uiRequestOf({ method: "input", title: "Token", secret: true });
	assert.equal(secret && answerText(secret, { value: "hunter2" }), "••••••");
});

test("extension UI side channels: status line, widgets, toasts, withdrawn dialogs", () => {
	const normalizer = new Normalizer();
	let view = emptyTranscript();
	const apply = (frame: Frame) => {
		const out = normalizer.frame(view, frame, 5);
		for (const ev of out.events) view = reduceTranscript(view, ev);
		return out.toast;
	};
	apply({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "git", statusText: "main ✓" });
	apply({ type: "extension_ui_request", id: "2", method: "setWidget", widgetKey: "todo", widgetLines: ["a", "b"] });
	apply({ type: "queue_update", steering: ["now"], followUp: ["later"], liveSteered: 0 });
	assert.deepEqual(view.status.statusLine, { git: "main ✓" });
	assert.deepEqual(view.status.widgets, { todo: ["a", "b"] });
	assert.deepEqual(view.status.queue, { steering: ["now"], followUp: ["later"] });
	apply({ type: "extension_ui_request", id: "3", method: "setWidget", widgetKey: "todo" });
	assert.deepEqual(view.status.widgets, {});
	assert.deepEqual(apply({ type: "extension_ui_request", id: "4", method: "notify", message: "omp-home: hub unreachable", notifyType: "error" }), { level: "error", text: "omp-home: hub unreachable" });
	apply({ type: "extension_ui_request", id: "5", method: "input", title: "Name?" });
	apply({ type: "extension_ui_request", id: "6", method: "cancel", targetId: "5" });
	assert.deepEqual(view.items.map(i => (i.kind === "request" ? [i.id, i.answer] : [])), [["5", "Withdrawn"]]);
	apply({ type: "message_end", messageId: "n1", message: { role: "custom", customType: "omp-home.notice", content: "[omp-home · 1 update]", display: true, timestamp: 9 } });
	assert.deepEqual(view.items.at(-1), { kind: "notice", id: "n1", at: 9, source: "omp-home", from: null, text: "[omp-home · 1 update]" });
});

test("current intent: the running tool's, else the most recent one's", () => {
	const at = (n: number) => replay(n).view;
	const bashStart = frames.findIndex(f => f.type === "tool_execution_start" && f.toolName === "bash");
	assert.equal(currentIntent(emptyTranscript()), null);
	assert.equal(currentIntent(at(bashStart + 1)), "Listing directory", "running bash");
	assert.equal(currentIntent(at(frames.findIndex(f => f.type === "message_start" && f.messageId === "msg-6"))), "Listing directory", "bash finished, nothing newer");
	const view = replay().view;
	assert.equal(currentIntent(view), "Waiting for Pinger completion", "the last of five finished tools");
	const tools = { ...view.tools, early: { ...view.tools.toolu_01BzWAVKSmgBYdsr5ktMWHsr!, callId: "early", status: "running" as const, intent: "Still running" } };
	assert.equal(currentIntent({ ...view, tools }), "Still running", "a running tool wins over newer finished ones");
});

test("request answer metadata distinguishes hub labels from identical raw text and clears on replacement", () => {
	const request = { method: "confirm" as const, title: "Proceed?", message: "Really?" };
	let view = reduceTranscript(emptyTranscript(), { t: "item", item: { kind: "request", id: "q", at: 0, request, answer: null } });
	view = reduceTranscript(view, answerEvent("q", request, { confirmed: true }));
	assert.deepEqual(view.items[0], { kind: "request", id: "q", at: 0, request, answer: "Yes", answerKind: "yes" });
	view = reduceTranscript(view, { t: "request_closed", id: "q", answer: "Yes" });
	assert.deepEqual(view.items[0], { kind: "request", id: "q", at: 0, request, answer: "Yes" });
	assert.equal(answerText(request, { cancelled: true }, "zh"), "已取消");
	assert.equal(answerText(request, { confirmed: false }, "zh"), "否");
	assert.equal(answerText({ method: "input", title: "", placeholder: null, secret: false }, { value: "Cancelled" }, "zh"), "Cancelled");
});

test("tool output metadata propagates and clears without changing raw text", () => {
	const tool = { callId: "call", name: "bash", intent: null, args: null, status: "running" as const, output: "", startedAt: 0, endedAt: null };
	let view = reduceTranscript(emptyTranscript(), { t: "tool", tool });
	view = reduceTranscript(view, { t: "tool_output", callId: "call", output: "…[2 earlier characters not shown]\ntail", omittedCharacters: 2 });
	assert.equal(view.tools.call?.omittedCharacters, 2);
	assert.equal(view.tools.call?.output, "…[2 earlier characters not shown]\ntail");
	view = reduceTranscript(view, { t: "tool_output", callId: "call", output: "…[2 earlier characters not shown]\nraw" });
	assert.equal(view.tools.call?.omittedCharacters, undefined);
	assert.equal(view.tools.call?.output, "…[2 earlier characters not shown]\nraw");
});

test("session streams render each language independently without translating model or human text", () => {
	const views = new SessionViews(() => {});
	let en = emptyTranscript();
	let zh = emptyTranscript();
	const stopEn = views.subscribe("M-1", event => {
		en = reduceTranscript(en, event);
	}, "en");
	const stopZh = views.subscribe("M-1", event => {
		zh = reduceTranscript(zh, event);
	}, "zh");
	views.frame("M-1", { type: "extension_ui_request", id: "q", method: "confirm", title: "Proceed?", message: "Really?" });
	views.apply("M-1", answerEvent("q", views.openRequest("M-1", "q"), { confirmed: true }));
	views.frame("M-1", { type: "extension_ui_request", id: "input", method: "input", title: "Name?" });
	views.apply("M-1", answerEvent("input", views.openRequest("M-1", "input"), { value: "Yes" }));
	const tail = "Model output stays English.\n" + "x".repeat(TOOL_OUTPUT_LIMIT - 28);
	assert.equal(tail.length, TOOL_OUTPUT_LIMIT);
	views.frame("M-1", { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "printf" } });
	views.frame("M-1", { type: "tool_execution_update", toolCallId: "call", partialResult: { content: "prefix" + tail } });
	assert.equal(en.items[0]?.kind === "request" && en.items[0].answer, "Yes");
	assert.equal(zh.items[0]?.kind === "request" && zh.items[0].answer, "是");
	assert.equal(zh.items[1]?.kind === "request" && zh.items[1].answer, "Yes");
	assert.equal(en.tools.call?.output, "…[6 earlier characters not shown]\n" + tail);
	assert.equal(zh.tools.call?.output, "…[前 6 个字符已省略]\n" + tail);
	assert.deepEqual(views.view("M-1"), en);
	assert.deepEqual(views.view("M-1", "zh"), zh);
	const earlier = views.history("M-1", "input", "zh").items[0];
	assert.equal(earlier?.kind === "request" && earlier.answer, "是");
	views.frame("M-1", { type: "tool_execution_update", toolCallId: "call", partialResult: { content: "Short English output" } });
	assert.equal(zh.tools.call?.output, "Short English output");
	views.frame("M-1", { type: "extension_ui_request", id: "ended", method: "confirm", title: "Proceed?", message: "Really?" });
	views.ended("M-1");
	const ended = zh.items.at(-1);
	assert.equal(ended?.kind === "request" && ended.answer, "会话已结束");
	stopEn();
	stopZh();
});

test("normalizer localizes only its own diagnostic framing", () => {
	const normalizer = new Normalizer();
	const prompt = normalizer.frame(emptyTranscript(), { type: "prompt_result", status: "error", error: { message: "Provider refused this request" } }, 0).toast;
	assert.ok(prompt);
	assert.equal(render(prompt.text), "prompt failed: Provider refused this request");
	assert.equal(render(prompt.text, "zh"), "提示词提交失败：Provider refused this request");
	const extension = normalizer.frame(emptyTranscript(), { type: "extension_error", event: "before_agent_start", error: "Raw omp error" }, 0).toast;
	assert.ok(extension);
	assert.equal(render(extension.text, "zh"), "扩展 before_agent_start 失败：Raw omp error");
});

import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { TOOL_SPECS } from "../shared/tools.ts";

const root = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omp-home-bridge-"));
const model = process.env.OMP_HOME_TEST_MODEL ?? "openai-codex/gpt-6-astra";
const omp = process.env.OMP_HOME_OMP_BIN ?? "omp";
const events = [];
const waiters = new Set();
const processes = [];
const sockets = new Map();
const observers = new Map();
const rows = [];
const transcript = fs.createWriteStream(path.join(work, "frames.jsonl"));
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const url = `ws://127.0.0.1:${server.address().port}`;
let outbox = 0;

function observe(event) {
	events.push(event);
	transcript.write(`${JSON.stringify(event)}\n`);
	for (const waiter of waiters) if (waiter.predicate(event)) {
		waiters.delete(waiter);
		clearTimeout(waiter.timer);
		waiter.resolve(event);
	}
}
function waitFor(predicate, timeout = 180_000) {
	const found = events.find(predicate);
	if (found) return Promise.resolve(found);
	const { promise, resolve, reject } = Promise.withResolvers();
	const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error("Timed out waiting for live event; inspect frames.jsonl and RPC logs")); }, timeout) };
	waiters.add(waiter);
	return promise;
}
async function check(label, action) {
	try { await action(); rows.push({ check: label, result: "PASS" }); }
	catch (error) { rows.push({ check: label, result: "FAIL", detail: String(error) }); throw error; }
}
function send(session, frame) { sockets.get(session).send(JSON.stringify(frame)); }
function deliver(session, text, kind = "prompt", mode = "next") {
	const frame = { t: "deliver", outboxId: ++outbox, kind, text, deliver: mode };
	send(session, frame);
	return frame;
}

server.on("connection", (socket, request) => {
	const target = new URL(request.url, url);
	const session = target.searchParams.get("session");
	if (target.pathname === "/observe") {
		socket.on("message", data => {
			const frame = JSON.parse(String(data));
			observe({ session, source: "observer", ...frame });
			if (frame.t === "ready" && frame.agent.kind === "main") {
				observers.set(session, socket);
				if (events.some(event => event.session === session && event.t === "hello")) socket.send("snapshot");
			}
		});
		return;
	}
	if (target.pathname !== "/bridge" || target.searchParams.get("token") !== "live-test-token") return socket.close();
	sockets.set(session, socket);
	socket.on("message", data => {
		const frame = JSON.parse(String(data));
		observe({ session, source: "bridge", ...frame });
		if (frame.t === "hello") {
			socket.send(JSON.stringify({ t: "welcome", session }));
			observers.get(session)?.send("snapshot");
		}
		if (frame.t !== "call") return;
		try {
			assert.ok(Object.hasOwn(TOOL_SPECS, frame.tool));
			const params = TOOL_SPECS[frame.tool].params.parse(frame.params);
			let text = "accepted";
			if (frame.tool === "home_status") text = JSON.stringify({ home: work, workspaces: [{ id: "fixture", path: path.join(work, "repo"), defaultBase: "main" }], tasks: [{ id: "T-1", workspace: "fixture", status: "done" }], playbooks: ["feature", "investigation"], automaticWakesLeft: 3 });
			if (frame.tool === "home_search") text = "Related completed task T-1 in fixture; no other related work.";
			if (frame.tool === "home_task") text = JSON.stringify({ id: "T-1", workspace: "fixture", status: "done", brief: "A fixture for live bridge validation.", worktree: path.join(work, "repo"), reports: ["fixture initialized"] });
			if (frame.tool === "home_dispatch") text = `T-2 dispatched to fixture (${params.checkout.kind})`;
			if (frame.tool === "home_env") text = JSON.stringify({ ports: {}, services: [], test: { full: "printf BRIDGE-OK" } });
			socket.send(JSON.stringify({ t: "result", callId: frame.callId, ok: true, text, details: { fixture: true } }));
		} catch (error) { socket.send(JSON.stringify({ t: "result", callId: frame.callId, ok: false, code: "INVALID", message: String(error) })); }
	});
});

const observer = path.join(work, "observer.ts");
fs.writeFileSync(observer, `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { z } from ${JSON.stringify(path.join(root, "node_modules/zod/index.js"))};
import { TOOL_SPECS } from ${JSON.stringify(path.join(root, "shared/tools.ts"))};
export default function(pi: ExtensionAPI) {
 let socket: WebSocket | undefined;
 const queued: unknown[] = [];
 const send = (frame: unknown) => { if (socket?.readyState === 1) socket.send(JSON.stringify(frame)); else queued.push(frame); };
 pi.registerTool({name:"bridge_probe_approval",label:"approval probe",description:"Harmless live approval probe; call only when explicitly requested.",parameters:pi.zod.object({value:pi.zod.string()}),approval:{tier:"read",policy:"prompt",reason:"Live bridge approval verification"},loadMode:"essential",async execute(_id,params){return {content:[{type:"text",text:params.value}],details:{}};}});
 const schema = pi.typebox.Type.Unsafe(z.toJSONSchema(TOOL_SPECS.home_dispatch.params));
 let rejectsInvalid = false;
 try { schema.assert({title:"nested schema",workspace:"fixture",brief:"x".repeat(120),checkout:{kind:"continue",task:"T-1",session:"INVALID"}}); } catch { rejectsInvalid = true; }
 pi.on("session_start", (_event,ctx) => {
  socket = new WebSocket(process.env.OMP_HOME_TEST_OBSERVER + "?session=" + process.env.OMP_HOME_SESSION);
  socket.addEventListener("open", () => {
   send({t:"ready",agent:ctx.agent});
   for (const frame of queued.splice(0)) send(frame);
  });
  socket.addEventListener("message", () => send({t:"tools",agent:ctx.agent,active:pi.getActiveTools(),abort:typeof ctx.abort,shutdown:typeof ctx.shutdown,rejectsInvalid}));
 });
 pi.on("before_agent_start", (_event,ctx) => {send({t:"tools",agent:ctx.agent,active:pi.getActiveTools(),abort:typeof ctx.abort,shutdown:typeof ctx.shutdown,rejectsInvalid});});
 pi.on("input", (event,ctx) => send({t:"raw_input",agent:ctx.agent,event}));
 pi.on("tool_approval_requested", (event,ctx) => send({t:"raw_approval_requested",agent:ctx.agent,event}));
 pi.on("tool_approval_resolved", (event,ctx) => send({t:"raw_approval_resolved",agent:ctx.agent,event}));
 pi.on("session_shutdown", () => socket?.close());
}
`);
fs.mkdirSync(path.join(work, "repos"));
fs.mkdirSync(path.join(work, "repo"));
fs.writeFileSync(path.join(work, "repos/fixture.md"), "# Fixture\nRead README.md. This is an isolated, no-remote acceptance fixture.\n");
fs.writeFileSync(path.join(work, "repos/fixture.env.yaml"), "version: 1\ntest:\n  full: printf BRIDGE-OK\n");
fs.writeFileSync(path.join(work, "repo/README.md"), "# Fixture\nNo files need changing. Validate the task bridge, then report the observed result.\n");
fs.writeFileSync(path.join(work, "overlay.yml"), `startup:\n  setupWizard: false\ntask:\n  agentModelOverrides:\n    dispatcher: ${model}\n    sonic: ${model}\n`);

async function launch(role, session, extraArgs = []) {
	const child = spawn(omp, ["--mode", "rpc-ui", "--cwd", work, "--session-dir", path.join(work, `${session}-sessions`), "--config", path.join(work, "overlay.yml"), "-e", path.join(root, "omp-plugin", role), "-e", observer, "--model", model, "--thinking", "low", "--approval-mode", "yolo", "--no-title", ...extraArgs], { cwd: work, env: { ...process.env, OMP_HOME_ROLE: role, OMP_HOME_SESSION: session, OMP_HOME_URL: `${url}/bridge`, OMP_HOME_TOKEN: "live-test-token", OMP_HOME_TEST_OBSERVER: `${url}/observe`, OMP_HOME_PROTECTED: "main,master" }, stdio: ["pipe", "pipe", "pipe"] });
	processes.push(child);
	child.stdout.pipe(fs.createWriteStream(path.join(work, `${session}.rpc.jsonl`)));
	child.stderr.pipe(fs.createWriteStream(path.join(work, `${session}.stderr.log`)));
	const sendRpc = frame => child.stdin.write(`${JSON.stringify(frame)}\n`);
	createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
		const frame = JSON.parse(line);
		observe({ session, source: "rpc", ...frame });
		if (frame.type !== "extension_ui_request") return;
		if (frame.method === "select") sendRpc({ type: "extension_ui_response", id: frame.id, value: frame.options.find(option => /^approve\b/i.test(option)) ?? frame.options[0] });
		if (frame.method === "confirm") sendRpc({ type: "extension_ui_response", id: frame.id, confirmed: true });
	});
	child.on("error", error => observe({ session, source: "process", t: "error", message: String(error) }));
	child.on("close", (exitCode, signal) => observe({ session, source: "process", t: "exit", exitCode, signal }));
	const ready = await waitFor(event => event.session === session && ((event.source === "rpc" && event.type === "ready") || event.source === "process"), 60_000);
	assert.equal(ready.type, "ready", JSON.stringify(ready));
	let sequence = 0;
	return {
		async request(type, params = {}) {
			const id = `${session}-${++sequence}`;
			sendRpc({ id, type, ...params });
			const response = await waitFor(event => event.session === session && event.source === "rpc" && event.type === "response" && event.id === id, 30_000);
			assert.equal(response.success, true, JSON.stringify(response));
			return response.data;
		},
	};
}

async function runPrint(cwd, args, prompt) {
	const child = spawn(omp, ["--cwd", cwd, "--config", path.join(work, "overlay.yml"), "-p", "--no-session", "--model", model, "--thinking", "low", ...args, prompt], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", data => output += data);
	child.stderr.on("data", data => output += data);
	const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
	const [code] = await once(child, "exit");
	clearTimeout(timer);
	fs.writeFileSync(path.join(work, "skills-print.log"), output);
	assert.equal(code, 0, output);
	return output;
}

try {
	if (!process.argv.includes("--bridge-only")) await check("git hooks forward arguments/stdin/status; push denied; Husky path", async () => {
		const repository = path.join(work, "hook-repo");
		fs.mkdirSync(repository);
		execFileSync("git", ["init", "-q", repository]);
		const guard = path.join(root, "git-guard");
		const hookNames = ["applypatch-msg", "commit-msg", "post-applypatch", "post-checkout", "post-commit", "post-merge", "post-rewrite", "pre-applypatch", "pre-auto-gc", "pre-commit", "pre-merge-commit", "pre-rebase", "prepare-commit-msg", "reference-transaction", "push-to-checkout", "post-index-change", "fsmonitor-watchman"];
		for (const relative of [".git/hooks", ".husky/_"]) {
			const original = path.join(repository, relative);
			fs.mkdirSync(original, { recursive: true });
			execFileSync("git", ["-C", repository, "config", "core.hooksPath", relative]);
			const resolved = execFileSync("git", ["-C", repository, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
			assert.equal(path.resolve(repository, resolved), original);
			const env = { ...process.env, OMP_HOME_REPO_HOOKS: original, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: guard };
			for (const hook of hookNames) {
				fs.writeFileSync(path.join(original, hook), '#!/bin/sh\nprintf "%s\\n" "$@"\ncat\nexit 7\n', { mode: 0o755 });
				try { execFileSync(path.join(guard, hook), ["one two", "three"], { cwd: repository, env, input: "stdin-value\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); assert.fail("Original hook exit status lost"); }
				catch (error) { assert.equal(error.status, 7); assert.equal(error.stdout, "one two\nthree\nstdin-value\n"); }
				fs.unlinkSync(path.join(original, hook));
				assert.equal(execFileSync(path.join(guard, hook), [], { cwd: repository, env, encoding: "utf8" }), "");
			}
			try { execFileSync("git", ["-C", repository, "hook", "run", "pre-push"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); assert.fail("Push guard allowed push"); }
			catch (error) { assert.equal(error.status, 1); assert.match(error.stderr, /workers must not push/); }
		}
	});
	if (!process.argv.includes("--bridge-only")) await check("copied Home .agents/skills discovered in real print session", async () => {
		const copy = path.join(work, "home-copy");
		fs.cpSync(process.env.OMP_HOME_TEST_HOME ?? "/Volumes/NVMe2T/project/home", copy, { recursive: true, filter: source => ![".git", ".omp-home", "node_modules"].includes(path.basename(source)) });
		const template = path.join(root, "templates/home");
		for (const item of JSON.parse(fs.readFileSync(path.join(template, "manifest.json"), "utf8"))) {
			const destination = path.join(copy, item.path);
			if (item.action === "section") {
				const original = fs.readFileSync(destination, "utf8");
				const start = original.indexOf(`${item.heading}\n`);
				const after = original.slice(start + item.heading.length + 1).search(/^#{1,2} /m);
				const end = after < 0 ? original.length : start + item.heading.length + 1 + after;
				fs.writeFileSync(destination, original.slice(0, start) + fs.readFileSync(path.join(template, item.source), "utf8") + original.slice(end));
			} else if (item.action !== "create" || !fs.existsSync(destination)) {
				fs.rmSync(destination, { recursive: true, force: true });
				fs.mkdirSync(path.dirname(destination), { recursive: true });
				fs.cpSync(path.join(template, item.source), destination, { recursive: true });
			}
		}
		const output = await runPrint(copy, ["--tools", "read"], "Discovery acceptance only, no work to route. Read skill://repo-worktree, skill://task-brief and skill://test-env using read. Then reply with the exact phrase HOME-SKILLS-DISCOVERED and the three absolute source paths shown by read. Do not use any other tool.");
		assert.match(output, /HOME-SKILLS-DISCOVERED/);
		for (const name of ["repo-worktree", "task-brief", "test-env"]) assert.ok(output.includes(`${copy}/.agents/skills/${name}/SKILL.md`), `Missing observed project skill path for ${name}`);
	});

	const main = await launch("main", "M-1");
	await check("hello; role audiences; nested schema rejects invalid enum; lifecycle APIs", async () => {
		const hello = await waitFor(event => event.session === "M-1" && event.t === "hello", 60_000);
		assert.equal(hello.v, 1); assert.equal(hello.cwd, work); assert.ok(hello.ompSessionId);
		const tools = await waitFor(event => event.session === "M-1" && event.t === "tools" && event.agent.kind === "main", 60_000);
		assert.ok(tools.active.includes("home_status")); assert.ok(!tools.active.includes("home_dispatch")); assert.ok(!tools.active.includes("home_report"));
		assert.equal(tools.rejectsInvalid, true); assert.equal(tools.abort, "function"); assert.equal(tools.shutdown, "function");
	});
	let firstPrompt;
	await check("delivered prompt starts/ends run and captures user/assistant losslessly", async () => {
		firstPrompt = deliver("M-1", "Reply exactly BRIDGE-PROMPT-OK. No tools; this is only a chat greeting.");
		await waitFor(event => event.session === "M-1" && event.t === "run_start");
		const end = await waitFor(event => event.session === "M-1" && event.t === "run_end" && event.text.includes("BRIDGE-PROMPT-OK"));
		assert.equal(end.stop, "completed");
		for (const role of ["user", "assistant"]) {
			const capture = await waitFor(event => event.session === "M-1" && event.t === "capture" && event.role === role && event.text.includes("BRIDGE-PROMPT-OK"));
			assert.equal(JSON.parse(capture.raw).role, role); assert.match(capture.key, /:\d+:(user|assistant):\d+$/);
		}
	});
	await check("redelivered outbox id acknowledges without another run", async () => {
		const starts = events.filter(event => event.session === "M-1" && event.t === "run_start").length;
		const before = events.length;
		send("M-1", firstPrompt);
		await waitFor(event => events.indexOf(event) >= before && event.session === "M-1" && event.t === "delivered" && event.outboxId === firstPrompt.outboxId);
		await delay(700);
		assert.equal(events.filter(event => event.session === "M-1" && event.t === "run_start").length, starts);
	});
	await check("notice wake starts a new run; context notice does not", async () => {
		const before = events.length;
		deliver("M-1", "<worker-report>Acceptance notice, no task action needed.</worker-report> Reply exactly BRIDGE-NOTICE-OK, no tools.", "notice", "wake");
		await waitFor(event => events.indexOf(event) >= before && event.session === "M-1" && event.t === "run_start");
		await waitFor(event => events.indexOf(event) >= before && event.session === "M-1" && event.t === "run_end" && event.text.includes("BRIDGE-NOTICE-OK"));
		const starts = events.filter(event => event.session === "M-1" && event.t === "run_start").length;
		const context = deliver("M-1", "<worker-report>Context-only acceptance notice. No reply needed.</worker-report>", "notice", "context");
		await waitFor(event => event.session === "M-1" && event.t === "delivered" && event.outboxId === context.outboxId);
		await delay(700);
		assert.equal(events.filter(event => event.session === "M-1" && event.t === "run_start").length, starts);
	});
	await check("RPC prompt completes without a bridge input frame", async () => {
		await main.request("prompt", { message: "Reply exactly BRIDGE-RPC-OK. No tools." });
		await waitFor(event => event.session === "M-1" && event.t === "run_end" && event.text.includes("BRIDGE-RPC-OK"));
		assert.equal(events.filter(event => event.session === "M-1" && event.source === "bridge" && event.t === "input").length, 0);
	});
	await check("approval requested/resolved payloads forwarded from RPC UI", async () => {
		deliver("M-1", "For this harmless acceptance check, call bridge_probe_approval with value BRIDGE-APPROVAL-OK exactly once, then reply BRIDGE-APPROVAL-OK. It only returns that string; the human will approve.");
		const rawRequest = await waitFor(event => event.session === "M-1" && event.t === "raw_approval_requested");
		const request = await waitFor(event => event.session === "M-1" && event.t === "approval" && event.phase === "requested");
		assert.equal(request.tool, "bridge_probe_approval");
		const rawResolved = await waitFor(event => event.session === "M-1" && event.t === "raw_approval_resolved", 30_000);
		const resolved = await waitFor(event => event.session === "M-1" && event.t === "approval" && event.phase === "resolved");
		assert.equal(resolved.approved, true);
		await waitFor(event => event.session === "M-1" && event.t === "run_end" && event.text.includes("BRIDGE-APPROVAL-OK"));
		console.log("APPROVAL REQUEST PAYLOAD", JSON.stringify(rawRequest.event));
		console.log("APPROVAL RESOLVED PAYLOAD", JSON.stringify(rawResolved.event));
	});
	await check("dispatcher subagent calls nested checkout union through shared socket", async () => {
		deliver("M-1", `Dispatch this acceptance task, do not implement it: user words verbatim are "Validate the fixture task bridge on the existing branch feat/bridge-check; no code changes." Home directory ${work}, workspace fixture, related T-1. Required checkout is {"lane":"branch","branch":"feat/bridge-check"}, playbook feature. Spawn exactly one async task item with agent dispatcher, these routing decisions, and the user words. The dispatcher must read ${work}/repos/fixture.md and fixture.env.yaml, write a brief and call home_dispatch exactly once. Reply briefly without waiting.`);
		const call = await waitFor(event => event.session === "M-1" && event.t === "call" && event.tool === "home_dispatch");
		assert.equal(call.agent.kind, "sub"); assert.equal(call.agent.name, "dispatcher");
		assert.deepEqual(call.params.checkout, { lane: "branch", branch: "feat/bridge-check" });
		const tools = await waitFor(event => event.session === "M-1" && event.t === "tools" && event.agent.name === "dispatcher");
		assert.ok(tools.active.includes("home_dispatch")); assert.ok(!tools.active.includes("home_report")); assert.ok(!tools.active.includes("home_send"));
	});
	await check("WebSocket reconnect sends hello and preserves delivery dedupe", async () => {
		const before = events.length;
		sockets.get("M-1").close();
		await waitFor(event => events.indexOf(event) >= before && event.session === "M-1" && event.t === "hello", 30_000);
		send("M-1", firstPrompt);
		await waitFor(event => events.indexOf(event) >= before && event.session === "M-1" && event.t === "delivered" && event.outboxId === firstPrompt.outboxId);
	});

	await launch("worker", "W-1");
	await check("worker audience hides ask and main tools", async () => {
		await waitFor(event => event.session === "W-1" && event.t === "hello", 60_000);
		const tools = await waitFor(event => event.session === "W-1" && event.t === "tools" && event.agent.kind === "main");
		assert.ok(tools.active.includes("home_report")); assert.ok(tools.active.includes("home_env"));
		for (const hidden of ["ask", "home_dispatch", "home_send", "home_status"]) assert.ok(!tools.active.includes(hidden), hidden);
	});
	await check("worker git push blocked before bash; blocked frame reaches hub", async () => {
		deliver("W-1", "This isolated acceptance fixture has no remote. For the explicit purpose of exercising the extension guardrail, invoke bash with command `git push` once. Do not perform a real push or bypass the expected block. After the tool is blocked, call home_report status question with summary BRIDGE-PUSH-BLOCKED and explain the refusal; end the turn. You are authorized to attempt the blocked call, not to push.");
		const blocked = await waitFor(event => event.session === "W-1" && event.t === "blocked");
		assert.equal(blocked.tool, "bash"); assert.equal(blocked.command, "git push"); assert.match(blocked.reason, /home_report/);
		await waitFor(event => event.session === "W-1" && event.t === "call" && event.tool === "home_report" && event.params.status === "question");
		await waitFor(event => event.session === "W-1" && event.t === "run_end");
	});
	await check("worker subagent hides ask/report and can use environment tool", async () => {
		deliver("W-1", "Acceptance only: spawn exactly one async sonic subagent whose sole job is to call home_env({}) then reply SUB-ENV-OK. Do not have it run any checks or edit files. When its result arrives, report done using home_report with summary BRIDGE-SUB-OK, then end the turn.");
		const call = await waitFor(event => event.session === "W-1" && event.t === "call" && event.tool === "home_env" && event.agent.kind === "sub");
		const tools = await waitFor(event => event.session === "W-1" && event.t === "tools" && event.agent.id === call.agent.id);
		assert.ok(!tools.active.includes("ask")); assert.ok(!tools.active.includes("home_report")); assert.ok(tools.active.includes("home_env"));
		await waitFor(event => event.session === "W-1" && event.t === "call" && event.tool === "home_report" && event.params.summary.includes("BRIDGE-SUB-OK"));
		await waitFor(event => event.session === "W-1" && event.t === "run_end" && event.text.includes("BRIDGE-SUB-OK"));
	});
	await check("shutdown exits live omp cleanly", async () => {
		// RPC mode terminates gracefully on stdin EOF.
		for (const child of processes) child.stdin.end();
		for (const session of ["M-1", "W-1"]) {
			const exit = await waitFor(event => event.session === session && event.t === "exit", 30_000);
			assert.equal(exit.exitCode, 0);
		}
	});
} catch (error) {
	console.error(String(error));
	process.exitCode = 1;
} finally {
	for (const process of processes) { try { process.kill(); } catch {} }
	for (const socket of server.clients) socket.terminate();
	server.close();
	for (const waiter of waiters) clearTimeout(waiter.timer);
	transcript.end();
	console.table(rows);
	console.log(`Evidence: ${work}`);
	fs.writeFileSync(path.join(work, "results.json"), JSON.stringify(rows, null, 2));
}

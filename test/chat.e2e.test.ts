import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AbortResult, StateDTO } from "../shared/api.ts";
import type { Item, TranscriptEvent } from "../shared/transcript.ts";
import { killHubs, sandbox, startHub, Stream, until } from "./hub-harness.ts";

/**
 * Chat controls on the main chat, with the fake omp: queued follow-ups run on their own, stop
 * withdraws queued input and returns it, queue remove/promote, images, edit and retry (omp
 * rewinds; the view is rebuilt and survives a restart).
 */

after(killHubs);

const userTexts = (items: readonly Item[]) => items.flatMap(i => (i.kind === "user" ? [i.text] : []));

test("chat controls: queue, stop, images, edit, retry", { timeout: 120_000 }, async () => {
	const box = sandbox();
	const hub = await startHub(box.configDir);
	assert.equal((await hub.api("POST", "/api/setup", { homePath: box.home, pstackRoot: null, migrateHome: true })).status, 200);
	await until("main idle", async () => (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	const main = await new Stream(hub, "M-1", box.home).open();
	await main.expect(/FAKE main M-1 up/);
	const settled = (label: string) => until(label, async () => main.view.status.phase === "idle" && main.view.status.settled && (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	const queue = (steering: string[], followUp: string[]) => until(`queue ${JSON.stringify({ steering, followUp })}`, async () => JSON.stringify(main.view.status.queue) === JSON.stringify({ steering, followUp }));

	// A follow-up typed during a run waits in omp's queue and runs right after it.
	let mark = main.out.length;
	await main.prompt("[fake:slow] first");
	await until("main running", async () => main.view.status.phase === "running");
	await main.prompt("second", "followUp");
	await queue([], ["second"]);
	await main.expect(/echo: \[fake:slow\] first\n[\s\S]*echo: second\n/, mark);
	await queue([], []);
	await settled("follow-up delivered");

	// Stop while input is queued: it is withdrawn and handed back (steering first), nothing stays stuck.
	await main.prompt("[fake:hang] wait");
	await until("main running", async () => main.view.status.phase === "running");
	await main.prompt("later one", "followUp");
	await main.prompt("later two", "followUp");
	await main.prompt("steer now", "steer");
	await queue(["steer now"], ["later one", "later two"]);
	const stop = await hub.api<AbortResult>("POST", "/api/sessions/M-1/abort");
	assert.deepEqual(stop, { status: 200, body: { restored: ["steer now", "later one", "later two"] } });
	await queue([], []);
	await settled("stopped with a queue");
	assert.deepEqual((await hub.api<AbortResult>("POST", "/api/sessions/M-1/abort")).body, { restored: [] });
	mark = main.out.length;
	await main.prompt("after the stop");
	await main.expect(/echo: after the stop\n/, mark);
	assert.ok(!userTexts(main.view.items).some(t => t.startsWith("later") || t === "steer now"), "withdrawn input never ran");
	await settled("prompt after the stop");

	// Withdraw one queued message, or move a follow-up into the running turn.
	await main.prompt("[fake:hang] again");
	await until("main running", async () => main.view.status.phase === "running");
	for (const text of ["keep me", "drop me", "promote me"]) await main.prompt(text, "followUp");
	await queue([], ["keep me", "drop me", "promote me"]);
	assert.deepEqual((await hub.api("POST", "/api/sessions/M-1/queue/remove", { message: "drop me", queue: "followUp" })).body, { removed: true });
	assert.deepEqual((await hub.api("POST", "/api/sessions/M-1/queue/remove", { message: "drop me", queue: "followUp" })).body, { removed: false });
	assert.equal((await hub.api("POST", "/api/sessions/M-1/queue/remove", { message: "keep me", queue: "later" })).status, 422);
	assert.deepEqual((await hub.api("POST", "/api/sessions/M-1/queue/promote", { message: "promote me" })).body, { promoted: true });
	assert.deepEqual((await hub.api("POST", "/api/sessions/M-1/queue/promote", { message: "drop me" })).body, { promoted: false });
	await queue(["promote me"], ["keep me"]);
	assert.deepEqual((await hub.api<AbortResult>("POST", "/api/sessions/M-1/abort")).body, { restored: ["promote me", "keep me"] });
	await settled("stopped after remove/promote");

	// Images reach omp as image content; the transcript counts them. Limits hold at the HTTP boundary.
	const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
	mark = main.out.length;
	assert.equal((await hub.api("POST", "/api/sessions/M-1/prompt", { text: "look", images: [{ data: png, mimeType: "image/png" }, { data: png, mimeType: "image/webp" }] })).status, 200);
	await main.expect(/echo: look \[image\/png 16B, image\/webp 16B\]\n/, mark);
	const look = main.view.items.findLast(i => i.kind === "user" && i.text === "look");
	assert.equal(look?.kind === "user" ? look.images : null, 2);
	await settled("image prompt");
	mark = main.out.length;
	assert.equal((await hub.api("POST", "/api/sessions/M-1/prompt", { text: "", images: [{ data: png, mimeType: "image/png" }] })).status, 200);
	await main.expect(/echo: \[image\/png 16B\]\n/, mark);
	await settled("image-only prompt");
	const rejected = async (body: unknown) => (await hub.api("POST", "/api/sessions/M-1/prompt", body)).status;
	assert.equal(await rejected({ text: "" }), 422);
	assert.equal(await rejected({ text: "x", images: Array.from({ length: 9 }, () => ({ data: png, mimeType: "image/png" })) }), 422);
	assert.equal(await rejected({ text: "x", images: [{ data: png, mimeType: "image/bmp" }] }), 422);
	assert.equal(await rejected({ text: "x", images: [{ data: "not base64!", mimeType: "image/png" }] }), 422);
	assert.equal(await rejected({ text: "x", images: [{ data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"), mimeType: "image/png" }] }), 422);

	// Edit: omp rewinds to before the message; the view is rebuilt without it and what followed, then the new text runs.
	await main.prompt("[fake:compact] alpha");
	await main.expect(/echo: \[fake:compact\] alpha\n/);
	await settled("alpha");
	await main.prompt("beta");
	await main.expect(/echo: beta\n/);
	await settled("beta");
	const before = userTexts(main.view.items);
	const kept = before.slice(0, before.indexOf("[fake:compact] alpha"));
	const status = main.view.status.statusLine.fake;
	assert.match(status ?? "", /FAKE main M-1 up/);
	const alpha = main.view.items.findLast(i => i.kind === "user" && i.text === "[fake:compact] alpha")!;
	const summary = main.view.items.findLast(i => i.kind === "user" && i.from === "agent")!;
	const reply = main.view.items.findLast(i => i.kind === "assistant")!;
	assert.equal((await hub.api("POST", "/api/sessions/M-1/edit", { itemId: summary.id, text: "no" })).status, 409, "agent-authored message");
	assert.equal((await hub.api("POST", "/api/sessions/M-1/edit", { itemId: reply.id, text: "no" })).status, 409, "assistant item");
	assert.equal((await hub.api("POST", "/api/sessions/M-1/edit", { itemId: "nope", text: "no" })).status, 404, "unknown item");
	const resets = main.events.length;
	mark = main.out.length;
	assert.equal((await hub.api("POST", "/api/sessions/M-1/edit", { itemId: alpha.id, text: "gamma" })).status, 200);
	const reset = main.events.slice(resets).find((e): e is Extract<TranscriptEvent, { t: "reset" }> => e.t === "reset");
	assert.ok(reset, "the edit resets the view");
	assert.deepEqual(userTexts(reset.view.items), kept);
	assert.equal(reset.view.status.statusLine.fake, status, "extension status survives the rewind");
	await main.expect(/echo: gamma\n/, mark);
	await settled("edited");
	assert.deepEqual(userTexts(main.view.items), [...kept, "gamma"]);

	// Editing while a turn runs is refused; the UI stops first.
	await main.prompt("[fake:hang] busy");
	await until("main running", async () => main.view.status.phase === "running");
	const busy = main.view.items.findLast(i => i.kind === "user" && i.text === "gamma")!;
	assert.equal((await hub.api("POST", "/api/sessions/M-1/edit", { itemId: busy.id, text: "delta" })).status, 409);
	assert.equal((await hub.api("POST", "/api/sessions/M-1/retry")).status, 409);
	await hub.api("POST", "/api/sessions/M-1/abort");
	await settled("stopped busy turn");

	// Retry: rewind to before the last message and send its text again.
	await main.prompt("omega");
	await main.expect(/echo: omega\n/);
	await settled("omega");
	const beforeRetry = userTexts(main.view.items);
	const retryFrom = main.events.length;
	mark = main.out.length;
	assert.equal((await hub.api("POST", "/api/sessions/M-1/retry")).status, 200);
	await main.expect(/echo: omega\n/, mark);
	await settled("retried");
	assert.ok(main.events.slice(retryFrom).some(e => e.t === "reset"), "the retry resets the view");
	assert.deepEqual(userTexts(main.view.items), beforeRetry);
	assert.equal(main.view.items.filter(i => i.kind === "assistant" && i.blocks.some(b => b.kind === "text" && b.text === "echo: omega")).length, 1);

	// What the hub delivers (here the "continue" request it words for main) is the hub's input, not the human's:
	// shown as agent input, not editable, and a stop sends it again instead of handing it to the composer.
	const fromHub = (i: Item) => i.kind === "user" && i.text.startsWith("[omp-home · the human says: continue]");
	await main.prompt("[fake:hang] hold");
	await until("main running", async () => main.view.status.phase === "running");
	await main.prompt("mine", "followUp");
	assert.equal((await hub.api("POST", "/api/main/continue")).status, 200);
	await until("hub delivery queued behind mine", async () => main.view.status.queue.followUp.length === 2 && main.view.status.queue.followUp[0] === "mine");
	mark = main.out.length;
	assert.deepEqual((await hub.api<AbortResult>("POST", "/api/sessions/M-1/abort")).body, { restored: ["mine"] });
	await main.expect(/\[omp-home · the human says: continue\][^\n]*\nok\n/, mark);
	await settled("hub delivery sent again");
	const delivered = main.view.items.filter(fromHub);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]!.kind === "user" ? delivered[0]!.from : null, "agent");
	assert.ok(!userTexts(main.view.items).includes("mine"), "the human's withdrawn text only went back to the composer");
	assert.equal((await hub.api("POST", "/api/sessions/M-1/edit", { itemId: delivered[0]!.id, text: "no" })).status, 409, "hub-delivered prompt");

	// The rewound session is omp's from now on: a restarted main resumes the edited transcript.
	const final = userTexts(main.view.items);
	assert.ok(final.includes("gamma") && !final.includes("[fake:compact] alpha") && !final.includes("beta"));
	assert.equal((await hub.api("POST", "/api/main/restart")).status, 200);
	await until("restarted main reseeded", async () => main.view.status.statusLine.fake?.includes("resume=yes") && (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	assert.deepEqual(userTexts(main.view.items), final);
	const reseeded = main.view.items.find(fromHub);
	assert.equal(reseeded?.kind === "user" ? reseeded.from : null, "agent", "a hub delivery stays the hub's after a restart");

	// Retry refuses a message with images (omp's RPC returns no image data); edit it instead.
	await hub.api("POST", "/api/sessions/M-1/prompt", { text: "pic", images: [{ data: png, mimeType: "image/png" }] });
	await settled("pic");
	assert.equal((await hub.api("POST", "/api/sessions/M-1/retry")).status, 409);
	main.close();
});

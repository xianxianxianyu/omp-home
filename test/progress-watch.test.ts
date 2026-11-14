import assert from "node:assert/strict";
import { test } from "node:test";
import { INTENT_THROTTLE_MS, ProgressWatch } from "../server/progress-watch.ts";

test("progress watch: phase changes publish at once, intent changes at most once per second per task", t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
	const published: string[] = [];
	const watch = new ProgressWatch(id => published.push(id));
	const p = (phase: "running" | "idle" | "provisioning", intent: string | null) => ({ phase, intent });

	watch.observe("T-1", p("provisioning", null));
	assert.deepEqual(published, ["T-1"], "a task seen for the first time publishes");
	watch.observe("T-1", p("provisioning", null));
	assert.deepEqual(published, ["T-1"], "nothing changed");

	t.mock.timers.tick(INTENT_THROTTLE_MS);
	watch.observe("T-1", p("running", "Reading files"));
	watch.observe("T-1", p("running", "Running tests"));
	watch.observe("T-1", p("running", "Editing code"));
	watch.observe("T-2", p("running", "Elsewhere"));
	assert.deepEqual(published, ["T-1", "T-1", "T-2"], "phase change at once; intent changes inside the second wait; other tasks are independent");
	watch.observe("T-1", p("idle", "Editing code"));
	assert.deepEqual(published, ["T-1", "T-1", "T-2", "T-1"], "a phase change never waits");
	watch.observe("T-1", p("idle", "Done editing"));
	t.mock.timers.tick(INTENT_THROTTLE_MS - 1);
	assert.equal(published.length, 4);
	t.mock.timers.tick(1);
	assert.deepEqual(published, ["T-1", "T-1", "T-2", "T-1", "T-1"], "the trailing intent change publishes once the second is over");

	watch.observe("T-2", p("running", "Something new"));
	assert.equal(published.length, 6, "T-2's last publish is a second old");
	watch.observe("T-2", p("running", "Even newer"));
	watch.observe("T-2", null);
	t.mock.timers.tick(INTENT_THROTTLE_MS);
	assert.equal(published.length, 6, "a closed task's pending publish is dropped");
	watch.retain(new Set());
	watch.observe("T-1", p("idle", "Done editing"));
	assert.equal(published.length, 7, "a forgotten task publishes again when it reappears");
	watch.stop();
});

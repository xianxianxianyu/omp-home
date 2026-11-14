import { z } from "zod";
import type { Item, SubagentView, TranscriptEvent, TranscriptView, UiRequest, UiResponse } from "../../shared/transcript.ts";

const text = z.string().nullable();
const time = z.number().nullable();
export const uiRequest: z.ZodType<UiRequest> = z.discriminatedUnion("method", [
	z.object({ method: z.literal("select"), title: z.string(), options: z.array(z.string()), details: z.array(text) }),
	z.object({ method: z.literal("confirm"), title: z.string(), message: z.string() }),
	z.object({ method: z.literal("input"), title: z.string(), placeholder: text, secret: z.boolean() }),
	z.object({ method: z.literal("editor"), title: z.string(), prefill: z.string() }),
	z.object({ method: z.literal("ask"), questions: z.array(z.object({ id: z.string(), question: z.string(), header: text, options: z.array(z.object({ label: z.string(), description: text })), multi: z.boolean(), recommended: z.number().nullable() })) }),
]);
export const uiResponse: z.ZodType<UiResponse> = z.union([
	z.object({ value: z.string() }), z.object({ confirmed: z.boolean() }), z.object({ cancelled: z.literal(true) }),
	z.object({ answers: z.array(z.object({ id: z.string(), selectedOptions: z.array(z.string()), customInput: z.string().optional() })) }),
]);
const block = z.discriminatedUnion("kind", [z.object({ kind: z.literal("text"), text: z.string() }), z.object({ kind: z.literal("thinking"), text: z.string() }), z.object({ kind: z.literal("tool"), callId: z.string() })]);
const item: z.ZodType<Item> = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("user"), id: z.string(), at: z.number(), text: z.string(), images: z.number(), from: z.enum(["human", "agent"]) }),
	z.object({ kind: z.literal("assistant"), id: z.string(), at: z.number(), blocks: z.array(block), streaming: z.boolean(), model: text, stopReason: text, error: text, usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), costUsd: z.number() }).nullable() }),
	z.object({ kind: z.literal("notice"), id: z.string(), at: z.number(), source: z.enum(["omp-home", "irc", "custom"]), from: text, text: z.string() }),
	z.object({ kind: z.literal("request"), id: z.string(), at: z.number(), request: uiRequest, answer: text }),
]);
const tool = z.object({ callId: z.string(), name: z.string(), intent: text, args: z.unknown(), status: z.enum(["running", "done", "error"]), output: z.string(), startedAt: z.number(), endedAt: time });
const status = z.object({ phase: z.enum(["idle", "running", "compacting"]), settled: z.boolean(), queue: z.object({ steering: z.array(z.string()), followUp: z.array(z.string()) }), model: text, contextPercent: z.number().nullable(), statusLine: z.record(z.string(), z.string()), widgets: z.record(z.string(), z.array(z.string())) });
const subagentFields = z.object({ agent: z.string(), task: z.string(), status: z.enum(["running", "completed", "failed", "aborted"]), parentToolCallId: text, lastIntent: text, startedAt: z.number(), endedAt: time });
const subagent: z.ZodType<SubagentView> = z.lazy(() => subagentFields.extend({ id: z.string(), transcript: transcriptView }));
export const transcriptView: z.ZodType<TranscriptView> = z.lazy(() => z.object({ items: z.array(item), tools: z.record(z.string(), tool), subagents: z.record(z.string(), subagent), status, earlierCursor: text }));
export const historyPage = z.object({ t: z.literal("prepend"), items: z.array(item), tools: z.record(z.string(), tool), earlierCursor: text });
export const transcriptEvent: z.ZodType<TranscriptEvent> = z.lazy(() => z.discriminatedUnion("t", [
	z.object({ t: z.literal("reset"), view: transcriptView }), historyPage,
	z.object({ t: z.literal("item"), item }),
	z.object({ t: z.literal("delta"), id: z.string(), index: z.number().int().nonnegative(), kind: z.enum(["text", "thinking"]), text: z.string() }),
	z.object({ t: z.literal("tool"), tool, itemId: z.string().optional(), index: z.number().int().nonnegative().optional() }),
	z.object({ t: z.literal("tool_output"), callId: z.string(), output: z.string() }),
	z.object({ t: z.literal("request_closed"), id: z.string(), answer: z.string() }),
	z.object({ t: z.literal("status"), patch: status.partial() }),
	z.object({ t: z.literal("subagent"), id: z.string(), patch: subagentFields.partial() }),
	z.object({ t: z.literal("subagent_event"), id: z.string(), event: transcriptEvent }),
]));
export const commands = z.array(z.object({ name: z.string(), description: text, source: text }));

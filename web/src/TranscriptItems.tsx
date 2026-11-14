import { memo, useMemo, useState } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import type { Item, SubagentView, ToolView, TranscriptView, UiRequest, UiResponse } from "../../shared/transcript.ts";
import { useHub } from "./hub.tsx";

const markdown = new Marked({ gfm: true, breaks: true, renderer: { html: ({ text }) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") } });
const Markdown = memo(function Markdown({ text }: { text: string }) {
	const html = useMemo(() => DOMPurify.sanitize(markdown.parse(text, { async: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "input", "style", "form"], FORBID_ATTR: ["style"] }), [text]);
	return <div className="message-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function field(args: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) if (typeof args[key] === "string") return args[key];
	return null;
}
const homeLabels: Record<string, string> = { home_dispatch: "派发任务", home_send: "发送给 worker", home_close: "结束任务", home_escalate: "需要你的判断", home_search: "检索工作记录", home_status: "工作状态" };

function ToolCard({ tool, subagents, openAgent }: { tool: ToolView; subagents: Record<string, SubagentView>; openAgent: (id: string) => void }) {
	const { openTask } = useHub();
	const [full, setFull] = useState(false);
	const args = record(tool.args);
	const oldText = field(args, "oldText", "old_text", "old_string", "old");
	const newText = field(args, "newText", "new_text", "new_string", "new", "content");
	const path = field(args, "path", "file_path", "file");
	const taskId = field(args, "task", "taskId", "task_id") ?? tool.output.match(/\bT-\d+\b/)?.[0];
	const children = Object.values(subagents).filter(agent => agent.parentToolCallId === tool.callId);
	const lines = tool.output.split("\n");
	const tail = !full && lines.length > 60;
	const label = homeLabels[tool.name];
	return <details className={`tool-card ${label ? "home-tool" : ""}`} data-tool={tool.name}>
		<summary><span className={`tool-dot ${tool.status}`} /><span className="tool-name">{tool.name}</span><span className="tool-intent">{tool.intent ?? label ?? path ?? "Tool call"}</span><span className={`tool-status ${tool.status}`}>{tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "完成"}</span></summary>
		<div className="tool-detail">
			{label && <div className="home-tool-title"><strong>{label}</strong>{taskId && <button className="task-link" onClick={() => openTask(taskId)}>{taskId} ↗</button>}</div>}
			{path && <div className="tool-path mono">{path}</div>}
			{children.length > 0 && <div className="agent-links">{children.map(agent => <button className="btn small" key={agent.id} onClick={() => openAgent(agent.id)}><span className={`status-dot ${agent.status}`} />{agent.agent} · {agent.id} ↗</button>)}</div>}
			{(tool.name === "edit" || tool.name === "write") && newText !== null ? <div className="tool-diff">{oldText !== null && <pre className="diff-old">{oldText.split("\n").map(line => `− ${line}`).join("\n")}</pre>}<pre className="diff-new">{newText.split("\n").map(line => `+ ${line}`).join("\n")}</pre></div> : <><div className="tool-caption">Arguments</div><pre className="tool-output">{typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args, null, 2)}</pre></>}
			{tool.output && <><div className="tool-caption">{tool.name === "bash" ? "Terminal output" : "Result"}{tail ? ` · last 60 of ${lines.length} lines` : ""}</div><pre className={`tool-output ${tool.status === "error" ? "error-text" : ""}`}>{tail ? lines.slice(-60).join("\n") : tool.output}</pre>{lines.length > 60 && <button className="text-button" onClick={() => setFull(value => !value)}>{full ? "Show tail" : "Show full output"}</button>}</>}
			{!tool.output && <div className="muted">{tool.status === "running" ? "Waiting for output…" : "No text output"}</div>}
		</div>
	</details>;
}

function AskForm({ request, disabled, submit }: { request: Extract<UiRequest, { method: "ask" }>; disabled: boolean; submit: (response: UiResponse) => void }) {
	const [answers, setAnswers] = useState<Record<string, { selectedOptions: string[]; customInput: string }>>({});
	return <form onSubmit={event => { event.preventDefault(); submit({ answers: request.questions.map(question => ({ id: question.id, selectedOptions: answers[question.id]?.selectedOptions ?? [], ...(answers[question.id]?.customInput ? { customInput: answers[question.id].customInput } : {}) })) }); }}>
		{request.questions.map(question => <fieldset disabled={disabled} key={question.id}><legend>{question.header && <span className="request-header">{question.header} · </span>}{question.question}</legend>{question.options.map((option, index) => <label className="ask-option" key={option.label}><input type={question.multi ? "checkbox" : "radio"} name={question.id} checked={answers[question.id]?.selectedOptions.includes(option.label) ?? false} onChange={event => setAnswers(current => { const answer = current[question.id] ?? { selectedOptions: [], customInput: "" }; return { ...current, [question.id]: { ...answer, selectedOptions: question.multi ? event.target.checked ? [...answer.selectedOptions, option.label] : answer.selectedOptions.filter(value => value !== option.label) : [option.label] } }; })} /><span>{option.label}{question.recommended === index && <span className="recommended">推荐</span>}{option.description && <small>{option.description}</small>}</span></label>)}<input className="request-input" aria-label={`${question.question} · Other answer`} placeholder="Other / 补充说明" value={answers[question.id]?.customInput ?? ""} onChange={event => setAnswers(current => ({ ...current, [question.id]: { selectedOptions: current[question.id]?.selectedOptions ?? [], customInput: event.target.value } }))} /></fieldset>)}
		<button className="btn primary" disabled={disabled || request.questions.some(question => !answers[question.id]?.selectedOptions.length && !answers[question.id]?.customInput.trim())}>Submit answers</button>
	</form>;
}
function RequestCard({ item, respond }: { item: Extract<Item, { kind: "request" }>; respond?: (id: string, response: UiResponse) => Promise<void> }) {
	const { request } = item;
	const [value, setValue] = useState(request.method === "editor" ? request.prefill : "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const disabled = !respond || pending;
	const submit = async (response: UiResponse) => {
		if (!respond || pending) return;
		setPending(true); setError(null);
		try { await respond(item.id, response); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setPending(false); }
	};
	return <section className={`request-card ${item.answer !== null ? "answered" : ""}`} aria-label={request.method === "ask" ? "Questions" : request.title}>
		<div className="request-eyebrow">{item.answer !== null ? "已回答" : respond ? "等待你的回复" : "Read-only request"}</div>
		<h3>{request.method === "ask" ? "A few decisions before we continue" : request.title}</h3>
		{item.answer !== null ? <div className="request-answer">{item.answer}</div> : <>
			{request.method === "select" && <div className="request-options">{request.options.map((option, index) => <button key={option} disabled={disabled} className={`btn ${index === 0 ? "primary" : ""}`} title={request.details[index] ?? undefined} onClick={() => void submit({ value: option })}>{option}{request.details[index] && <small>{request.details[index]}</small>}</button>)}</div>}
			{request.method === "confirm" && <><p>{request.message}</p><div className="row"><button className="btn primary" disabled={disabled} onClick={() => void submit({ confirmed: true })}>Yes</button><button className="btn" disabled={disabled} onClick={() => void submit({ confirmed: false })}>No</button></div></>}
			{(request.method === "input" || request.method === "editor") && <form onSubmit={event => { event.preventDefault(); void submit({ value }); }}>{request.method === "editor" ? <textarea className="request-input" aria-label={request.title} rows={5} disabled={disabled} value={value} onChange={event => setValue(event.target.value)} /> : <input className="request-input" aria-label={request.title} disabled={disabled} type={request.secret ? "password" : "text"} placeholder={request.placeholder ?? ""} value={value} onChange={event => setValue(event.target.value)} />}<button className="btn primary" disabled={disabled}>Submit</button></form>}
			{request.method === "ask" && <AskForm request={request} disabled={disabled} submit={response => void submit(response)} />}
			{respond && <button className="text-button request-cancel" disabled={pending} onClick={() => void submit({ cancelled: true })}>Cancel request</button>}
		</>}{pending && <span className="hint" role="status">Sending…</span>}{error && <p role="alert" className="error-text">{error}</p>}
	</section>;
}

export const TranscriptItem = memo(function TranscriptItem({ item, view, respond, openAgent }: { item: Item; view: TranscriptView; respond?: (id: string, response: UiResponse) => Promise<void>; openAgent: (id: string) => void }) {
	if (item.kind === "user") return <article className={`message user-message ${item.from}`} data-item={item.id}><div className="message-label">{item.from === "human" ? "你" : "Agent · delegated input"}</div><div className="user-bubble">{item.text}{item.images > 0 && <span className="hint"> · {item.images} image attachments</span>}</div></article>;
	if (item.kind === "notice") return <article className={`notice-card ${item.source}`} data-item={item.id}><div className="message-label">{item.source === "irc" ? `from ${item.from ?? "agent"}` : item.source === "omp-home" ? "omp-home · system" : item.from ?? "System"}</div><div>{item.text}</div></article>;
	if (item.kind === "request") return <RequestCard item={item} respond={respond} />;
	return <article className="message assistant-message" data-item={item.id}><div className="message-label">omp{item.streaming && <span className="streaming-dot" />}</div>{item.blocks.map((block, index) => block.kind === "text" ? <Markdown text={block.text} key={index} /> : block.kind === "thinking" ? <details className="thinking-block" key={index}><summary>思考 · {Array.from(block.text).length.toLocaleString()} 字</summary><div>{block.text}</div></details> : view.tools[block.callId] ? <ToolCard tool={view.tools[block.callId]} subagents={view.subagents} openAgent={openAgent} key={block.callId} /> : null)}{item.error && <p role="alert" className="error-text">{item.error}</p>}</article>;
});

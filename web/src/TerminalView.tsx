import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { connectSocket } from "./transport.ts";
import type { HubSocket } from "./transport.ts";
import type { TermInput } from "../../shared/api.ts";
import { useHub } from "./hub.tsx";

const THEME = {
	background: "#0f1115",
	foreground: "#d8dee9",
	cursor: "#e5c07b",
	selectionBackground: "#3b4252",
	black: "#1c1f26",
	brightBlack: "#5c6370",
};

/** The hub replays scrollback after reconnect; hidden tabs retain their xterm instance. */
export function TerminalView({ terminalId, focused, main = false }: { terminalId: string; focused: boolean; main?: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<Terminal | null>(null);
	const { noteInput } = useHub();
	const inputCallback = useRef(noteInput);
	inputCallback.current = noteInput;
	const [connected, setConnected] = useState(false);
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const t = new Terminal({
			fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
			fontSize: 13,
			lineHeight: 1.15,
			cursorBlink: true,
			allowProposedApi: true,
			scrollback: 10000,
			theme: THEME,
		});
		const fit = new FitAddon();
		t.loadAddon(fit);
		t.loadAddon(new WebLinksAddon());
		t.open(el);
		term.current = t;

		let socket: HubSocket | null = null;
		let closed = false;
		let retry: number | undefined;
		let attempts = 0;
		const send = (message: TermInput) => { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); };
		const sendSize = () => {
			if (!el.clientWidth || !el.clientHeight) return;
			fit.fit();
			send({ type: "resize", cols: t.cols, rows: t.rows });
		};
		const connect = () => {
			socket = connectSocket(`/api/term/${encodeURIComponent(terminalId)}`, {
				open: () => {
					attempts = 0;
					setConnected(true);
					t.reset();
					sendSize();
				},
				message: data => t.write(data),
				close: () => {
					if (closed) return;
					setConnected(false);
					retry = window.setTimeout(connect, Math.min(15000, 500 * 2 ** attempts++));
				},
			});
		};
		connect();
		const input = t.onData(data => {
			inputCallback.current();
			send({ type: "input", data });
		});
		const observer = new ResizeObserver(() => sendSize());
		observer.observe(el);
		const focusMain = () => { if (main) t.focus(); };
		window.addEventListener("focus-main", focusMain);

		return () => {
			closed = true;
			clearTimeout(retry);
			observer.disconnect();
			window.removeEventListener("focus-main", focusMain);
			input.dispose();
			socket?.close();
			t.dispose();
			term.current = null;
		};
	}, [terminalId, main]);

	useEffect(() => {
		if (focused) term.current?.focus();
	}, [focused]);

	return <><div className="terminal-host" ref={host} aria-label={`${terminalId} live terminal`} />{!connected && <div className="terminal-connection" role="status">Connecting to {terminalId}… Input resumes when connected.</div>}</>;
}

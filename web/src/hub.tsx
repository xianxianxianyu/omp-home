import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { SessionDTO, StateDTO, Topic, UiEvent } from "../../shared/api.ts";
import { api } from "./api.ts";
import { uiEvent } from "./schemas.ts";
import { connectSocket } from "./transport.ts";
import type { HubSocket } from "./transport.ts";
import { notify } from "./native.ts";

export const PANELS = ["Inbox", "Tasks", "Sessions", "Workspaces", "Decisions", "Resources", "Settings"] as const;
export type Panel = typeof PANELS[number];
interface Snapshot<T> { data: T | undefined; error: Error | null; loading: boolean }
interface Entry { topic: Topic; path: string; snapshot: Snapshot<unknown>; listeners: Set<() => void>; dirty: boolean; pending: boolean }
class Cache {
	private entries = new Map<string, Entry>();
	entry(topic: Topic, path: string): Entry {
		const key = `${topic}:${path}`;
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { topic, path, snapshot: { data: undefined, error: null, loading: true }, listeners: new Set(), dirty: true, pending: false };
			this.entries.set(key, entry);
		}
		return entry;
	}
	subscribe(entry: Entry, callback: () => void) {
		entry.listeners.add(callback);
		if (entry.dirty) void this.fetch(entry);
		return () => { entry.listeners.delete(callback); };
	}
	async fetch(entry: Entry) {
		if (entry.pending) { entry.dirty = true; return; }
		entry.pending = true;
		entry.dirty = false;
		entry.snapshot = { ...entry.snapshot, loading: true, error: null };
		entry.listeners.forEach(listener => listener());
		try { entry.snapshot = { data: await api<unknown>(entry.path), error: null, loading: false }; }
		catch (error) { entry.snapshot = { ...entry.snapshot, error: error instanceof Error ? error : new Error(String(error)), loading: false }; }
		finally {
			entry.pending = false;
			entry.listeners.forEach(listener => listener());
			if (entry.dirty && entry.listeners.size) void this.fetch(entry);
		}
	}
	invalidate(topics?: Topic[]) {
		for (const entry of this.entries.values()) {
			if (!topics || topics.includes(entry.topic)) {
				entry.dirty = true;
				if (entry.listeners.size) void this.fetch(entry);
			}
		}
	}
}
interface Toast { id: number; text: string; level: "info" | "error"; action?: { label: string; run: () => Promise<void> } }
interface Hub {
	state: StateDTO | undefined;
	stateError: Error | null;
	reload: () => void;
	connected: boolean;
	active: string;
	setActive: (tab: string) => void;
	tabs: SessionDTO[];
	closeTab: (id: string) => void;
	openSession: (id: string) => Promise<void>;
	taskId: string | null;
	openTask: (id: string) => void;
	closeTask: () => void;
	toast: (text: string, level?: "info" | "error") => void;
	toasts: Toast[];
	dismissToast: (id: number) => void;
	mutate: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
	noteComposerInput: () => void;
}
const CacheContext = createContext<Cache | null>(null);
const HubContext = createContext<Hub | null>(null);
export function useHub(): Hub {
	const value = useContext(HubContext);
	if (!value) throw new Error("HubProvider is required");
	return value;
}
export function useResource<T>(topic: Topic, path: string) {
	const cache = useContext(CacheContext);
	if (!cache) throw new Error("HubProvider is required");
	const entry = cache.entry(topic, path);
	const subscribe = useCallback((listener: () => void) => cache.subscribe(entry, listener), [cache, entry]);
	const snapshot = useSyncExternalStore(subscribe, () => entry.snapshot) as Snapshot<T>;
	const reload = useCallback(() => { void cache.fetch(entry); }, [cache, entry]);
	return { ...snapshot, reload };
}
export function HubProvider({ children }: { children: ReactNode }) {
	const [cache] = useState(() => new Cache());
	return <CacheContext.Provider value={cache}><HubController cache={cache}>{children}</HubController></CacheContext.Provider>;
}
function HubController({ cache, children }: { cache: Cache; children: ReactNode }) {
	const state = useResource<StateDTO>("state", "/api/state");
	const [connected, setConnected] = useState(false);
	const [active, setActive] = useState<string>("Inbox");
	const [tabs, setTabs] = useState<SessionDTO[]>([]);
	const [taskId, setTaskId] = useState<string | null>(null);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const lastComposerInput = useRef(0);
	const wasPaused = useRef(false);
	useEffect(() => {
		const paused = state.data?.main.paused ?? false;
		if (paused && !wasPaused.current) void notify("Main is paused", "The automatic wake budget is used. Continue main when you’re ready.", "main-paused");
		wasPaused.current = paused;
	}, [state.data?.main.paused]);
	const nextToast = useRef(0);
	const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
	const dismissToast = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), []);
	const addToast = useCallback((text: string, level: "info" | "error" = "info", action?: Toast["action"]) => {
		const id = ++nextToast.current;
		setToasts(current => [...current, { id, text, level, action }]);
		if (!action) {
			const timer = setTimeout(() => { dismissToast(id); toastTimers.current.delete(timer); }, 8000);
			toastTimers.current.add(timer);
		}
	}, [dismissToast]);
	const ompWarning = state.data?.omp.warning;
	useEffect(() => { if (ompWarning) addToast(ompWarning, "error"); }, [ompWarning, addToast]);
	useEffect(() => () => toastTimers.current.forEach(clearTimeout), []);
	const toast = useCallback((text: string, level?: "info" | "error") => addToast(text, level), [addToast]);
	const mutate = useCallback(async <T,>(path: string, body?: unknown, method = "POST"): Promise<T> => {
		try { return await api<T>(path, { method, body }); }
		catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); throw error; }
	}, [toast]);
	const openSession = useCallback(async (id: string) => {
		const session = await mutate<SessionDTO>(`/api/sessions/${encodeURIComponent(id)}/attach`);
		if (session.kind === "main") {
			window.dispatchEvent(new Event("focus-main"));
			return;
		}
		setTabs(current => current.some(tab => tab.id === id) ? current.map(tab => tab.id === id ? session : tab) : [...current, session]);
		setActive(id);
	}, [mutate]);
	const closeTab = useCallback((id: string) => {
		setTabs(current => current.filter(tab => tab.id !== id));
		setActive(current => current === id ? "Inbox" : current);
	}, []);
	const handleEvent = useCallback((event: UiEvent) => {
		if (event.t === "invalidate") cache.invalidate(event.topics);
		else if (event.t === "toast") toast(event.text, event.level);
		else {
			const open = async () => {
				await openSession(event.sessionId);
				if (event.escalationId) await mutate(`/api/escalations/${encodeURIComponent(event.escalationId)}/seen`);
			};
			if (Date.now() - lastComposerInput.current < 8000) addToast(`${event.sessionId} needs you: ${event.reason}`, "info", { label: "Open", run: open });
			else void open().catch(() => {});
			void notify(`${event.sessionId} needs you`, event.reason, event.escalationId ?? event.sessionId, () => { void open().catch(() => {}); });
		}
	}, [cache, toast, openSession, mutate, addToast]);
	useEffect(() => {
		let disposed = false;
		let socket: HubSocket;
		let timer: ReturnType<typeof setTimeout>;
		let attempts = 0;
		const connect = () => {
			socket = connectSocket("/api/events", {
				open: () => { attempts = 0; setConnected(true); cache.invalidate(); },
				message: text => {
					try { handleEvent(uiEvent.parse(JSON.parse(text))); }
					catch { toast("The hub sent an invalid event. Reconnect or check the hub log.", "error"); }
				},
				close: () => {
					setConnected(false);
					if (!disposed) timer = setTimeout(connect, Math.min(15000, 500 * 2 ** attempts++));
				},
			});
		};
		connect();
		return () => { disposed = true; clearTimeout(timer); socket?.close(); };
	}, [cache, handleEvent, toast]);
	const value = useMemo<Hub>(() => ({ state: state.data, stateError: state.error, reload: state.reload, connected, active, setActive, tabs, closeTab, openSession, taskId, openTask: setTaskId, closeTask: () => setTaskId(null), toast, toasts, dismissToast, mutate, noteComposerInput: () => { lastComposerInput.current = Date.now(); } }), [state.data, state.error, state.reload, connected, active, tabs, closeTab, openSession, taskId, toast, toasts, dismissToast, mutate]);
	return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

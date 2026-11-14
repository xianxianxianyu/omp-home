import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { SessionDTO, StateDTO, TaskSummary, Topic, UiEvent } from "../../shared/api.ts";
import { api } from "./api.ts";
import { uiEvent } from "./schemas.ts";
import { connectSocket } from "./transport.ts";
import type { HubSocket } from "./transport.ts";
import { notify } from "./native.ts";
import { getLanguage, getT, LANGUAGE_CHANGED } from "./i18n/runtime.ts";
import type { LocalizedText } from "./i18n/runtime.ts";

export type RightView = { kind: "history" } | { kind: "task"; id: string };
export type SettingsSection = "General" | "Models" | "Appearance" | "Workspaces" | "Runtime" | "About";
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
		try {
			const data = await api<unknown>(entry.path);
			// An invalidation during this request means its response predates a newer write.
			if (!entry.dirty) entry.snapshot = { data, error: null, loading: false };
		} catch (error) {
			if (!entry.dirty) entry.snapshot = { ...entry.snapshot, error: error instanceof Error ? error : new Error(String(error)), loading: false };
		}
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
interface Toast { id: number; text: LocalizedText; level: "info" | "error"; action?: { label: LocalizedText; run: () => Promise<void> } }
interface Hub {
	state: StateDTO | undefined;
	stateError: Error | null;
	reload: () => void;
	connected: boolean;
	views: RightView[];
	popView: () => void;
	openHistory: () => void;
	openSession: (id: string) => Promise<void>;
	openTask: (id: string) => void;
	settingsSection: SettingsSection | null;
	openSettings: (section?: SettingsSection) => void;
	closeSettings: () => void;
	toast: (text: LocalizedText, level?: "info" | "error") => void;
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
	const [language, setLanguage] = useState(getLanguage);
	useEffect(() => {
		const changed = () => setLanguage(getLanguage());
		window.addEventListener(LANGUAGE_CHANGED, changed);
		return () => window.removeEventListener(LANGUAGE_CHANGED, changed);
	}, []);
	const [connected, setConnected] = useState(false);
	const [views, setViews] = useState<RightView[]>([]);
	const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
	const openTask = useCallback((id: string) => {
		setSettingsSection(null);
		setViews(current => {
			const existing = current.findIndex(view => view.kind === "task" && view.id === id);
			return existing < 0 ? [...current, { kind: "task", id }] : current.slice(0, existing + 1);
		});
		window.dispatchEvent(new CustomEvent("focus-task", { detail: id }));
	}, []);
	const popView = useCallback(() => setViews(current => current.slice(0, -1)), []);
	const openHistory = useCallback(() => {
		setSettingsSection(null);
		setViews(current => {
			const existing = current.findIndex(view => view.kind === "history");
			return existing < 0 ? [...current, { kind: "history" }] : current.slice(0, existing + 1);
		});
	}, []);
	const openSettings = useCallback((section: SettingsSection = "General") => setSettingsSection(section), []);
	const closeSettings = useCallback(() => setSettingsSection(null), []);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const lastComposerInput = useRef(0);
	const wasPaused = useRef(false);
	useEffect(() => {
		const paused = state.data?.main.paused ?? false;
		if (paused && !wasPaused.current) void notify(getT().hub.mainPaused, getT().hub.mainPausedBody, "main-paused");
		wasPaused.current = paused;
	}, [state.data?.main.paused]);
	const nextToast = useRef(0);
	const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
	const dismissToast = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), []);
	const addToast = useCallback((text: LocalizedText, level: "info" | "error" = "info", action?: Toast["action"]) => {
		const id = ++nextToast.current;
		setToasts(current => [...current, { id, text, level, action }]);
		if (!action) {
			const timer = setTimeout(() => { dismissToast(id); toastTimers.current.delete(timer); }, 8000);
			toastTimers.current.add(timer);
		}
	}, [dismissToast]);
	useEffect(() => () => toastTimers.current.forEach(clearTimeout), []);
	const toast = useCallback((text: LocalizedText, level?: "info" | "error") => addToast(text, level), [addToast]);
	const mutate = useCallback(async <T,>(path: string, body?: unknown, method = "POST"): Promise<T> => {
		try { return await api<T>(path, { method, body }); }
		catch (error) { toast(error instanceof Error ? error.message : String(error), "error"); throw error; }
	}, [toast]);
	const openSession = useCallback(async (id: string) => {
		const session = await mutate<SessionDTO>(`/api/sessions/${encodeURIComponent(id)}/attach`);
		if (session.kind === "main") {
			setSettingsSection(null);
			window.dispatchEvent(new Event("focus-main"));
			return;
		}
		if (session.openTask) openTask(session.openTask.id);
		else {
			const tasks = await api<TaskSummary[]>("/api/tasks");
			const task = tasks.filter(task => task.sessionId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
			if (task) openTask(task.id);
			else toast(t => t.hub.attached(id));
		}
	}, [mutate, openTask, toast]);
	const handleEvent = useCallback((event: UiEvent) => {
		if (event.t === "invalidate") cache.invalidate(event.topics);
		else if (event.t === "toast") toast(event.text, event.level);
		else {
			const open = async () => {
				await openSession(event.sessionId);
				if (event.escalationId) await mutate(`/api/escalations/${encodeURIComponent(event.escalationId)}/seen`);
			};
			if (Date.now() - lastComposerInput.current < 8000) addToast(t => t.hub.attention(event.sessionId, event.reason), "info", { label: t => t.hub.open, run: open });
			else void open().catch(() => {});
			void notify(getT().hub.needsYou(event.sessionId), event.reason, event.escalationId ?? event.sessionId, () => { void open().catch(() => {}); });
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
					catch { toast(t => t.hub.invalidEvent, "error"); }
				},
				close: () => {
					setConnected(false);
					if (!disposed) timer = setTimeout(connect, Math.min(15000, 500 * 2 ** attempts++));
				},
			});
		};
		connect();
		return () => { disposed = true; clearTimeout(timer); socket?.close(); };
	}, [cache, handleEvent, toast, language]);
	const value = useMemo<Hub>(() => ({ state: state.data, stateError: state.error, reload: state.reload, connected, views, popView, openHistory, openSession, openTask, settingsSection, openSettings, closeSettings, toast, toasts, dismissToast, mutate, noteComposerInput: () => { lastComposerInput.current = Date.now(); } }), [state.data, state.error, state.reload, connected, views, popView, openHistory, openSession, openTask, settingsSection, openSettings, closeSettings, toast, toasts, dismissToast, mutate]);
	return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

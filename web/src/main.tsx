import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { HubProvider } from "./hub.tsx";
import "./styles.css";
import { installMock } from "./mock.ts";

if (import.meta.env.VITE_MOCK === "1") {
	installMock();
}
// The macOS app overlays its title bar on the page; the top bar then leaves room for the window controls.
if (window.__TAURI__ || new URLSearchParams(location.search).has("native-chrome")) document.documentElement.classList.add("native-chrome");
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(<StrictMode><HubProvider><App /></HubProvider></StrictMode>);

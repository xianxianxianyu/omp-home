import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	root: import.meta.dirname,
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
	server: { proxy: { "/api": { target: "http://127.0.0.1:4777", ws: true } } },
});

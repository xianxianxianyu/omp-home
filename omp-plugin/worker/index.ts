import { existsSync } from "node:fs";

// The packaged resources hold only the bundled bridge (zod and shared/* inlined): there is no node_modules beside them.
const bridge = existsSync(new URL("../bridge.ts", import.meta.url)) ? await import("../bridge.ts") : await import("../dist/bridge.js");
export default bridge.default;

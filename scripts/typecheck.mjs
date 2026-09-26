import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [new URL("./build.mjs", import.meta.url).pathname], { stdio: "inherit" });
process.exit(r.status ?? 0);

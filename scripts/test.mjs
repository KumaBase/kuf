import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve files ourselves so Node 18/20 and Windows do not depend on shell globbing.
const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `tests/${name}`);
if (!files.length) throw new Error("No frontend tests found");
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { cwd: root, stdio: "inherit", shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

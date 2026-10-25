import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { frontendModule } from "../scripts/frontend-module.mjs";
const api = await frontendModule("export * from './src/commands.ts'; export * from './src/external-commands.ts';");

test("every assigned command is discoverable and native defaults agree with frontend defaults", async () => {
  const known = new Set(api.COMMAND_CATALOG.map((command) => command.id));
  assert.equal(known.size, api.COMMAND_CATALOG.length);
  for (const [key, command] of Object.entries(api.DEFAULT_KEYBINDS)) assert.ok(known.has(command), `${key}: ${command}`);
  const config = await readFile("src-tauri/src/config.rs", "utf8");
  const source = config.slice(config.indexOf('r#"preset ='), config.indexOf('"#', config.indexOf('r#"preset =')));
  const native = Object.fromEntries([...source.matchAll(/^"((?:[^"\\]|\\.)*)" = "([^"]*)"/gm)].map(([, key, value]) => [JSON.parse(`"${key}"`), value]));
  assert.deepEqual(native, api.DEFAULT_KEYBINDS);
});

test("disabled default keys and custom mappings survive save and reload", async (t) => {
  const dispose = api.createRoot((dispose) => dispose); t.after(dispose);
  let saved;
  const settings = { display: { theme: "tokyo-night" }, sort: { dirs_first: true, case_sensitive: false } };
  globalThis.__kufInvoke = async (name, args) => {
    if (name === "keybinds_save") { saved = args.keybinds; return; }
    if (name === "settings_load") return settings;
    if (name === "keybinds_load") return saved;
    throw new Error(`Unexpected invoke ${name}`);
  };
  await api.saveKeybinds({ ...api.DEFAULT_KEYBINDS, c: "", "Ctrl+Alt+j": "history_list" });
  await api.loadSettings();
  assert.equal(api.keybinds().c, "");
  assert.equal(api.keybinds()["Ctrl+Alt+j"], "history_list");
  assert.equal(api.keybinds().h, "history_list");
});

test("external argument placeholders remain separate literal arguments", () => {
  const context = { directory: "C:\\work dir", other_directory: "D:\\other", file: "C:\\work dir\\{dir}; a.txt", selected: ["C:\\work dir\\{dir}; a.txt", "C:\\work dir\\b.txt"] };
  const command = { name: "tool", program: "tool.exe", args: ["{selected}", "--folder={dir}", "{name}", ""] };
  assert.deepEqual(api.expandExternalArguments(command, context), [...context.selected, "--folder=C:\\work dir", "{dir}; a.txt", ""]);
});

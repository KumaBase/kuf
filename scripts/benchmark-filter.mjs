import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { frontendModule, fixtureFiles } from "./frontend-module.mjs";

const api = await frontendModule("export * from './src/filter.ts'; export * from './src/migemo.ts';");
const data = await readFile(new URL("../public/migemo/migemo-compact-dict", import.meta.url));
const initStart = performance.now();
api.initializeMigemo(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
const dictionaryInit = performance.now() - initStart;
const files = fixtureFiles(10000).map((file, i) => ({ ...file, name: [
  `UserController-${i}.ts`, `打ち合わせ資料-${i}.pdf`, `日本語ガイド-${i}.txt`, `report-${i}.csv`,
][i % 4] }));
globalThis.__kufInvoke = async () => files;
let dispose;
const pane = api.createRoot((d) => { dispose = d; return api.createPaneState(); });
await pane.navigateTo("fixture");
const queries = ["usrctrl", "siryou pdf", "nihon", "*.txt"];
const coldStart = performance.now();
pane.setFilter(queries[0]);
const coldFilter = performance.now() - coldStart;
const results = {};
for (const query of queries) {
  const samples = [];
  for (let i = 0; i < 18; i++) {
    pane.setFilter("");
    const start = performance.now();
    pane.setFilter(query);
    const elapsed = performance.now() - start;
    if (i >= 3) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  results[query] = {
    matches: pane.state.files.length,
    median_ms: +samples[Math.floor(samples.length / 2)].toFixed(3),
    p95_ms: +samples[Math.ceil(samples.length * .95) - 1].toFixed(3),
  };
}
console.log(JSON.stringify({
  kind: "10000 names; matching, ranking, highlights and Solid state updates; excludes filesystem/IPC/DOM rendering",
  node: process.version,
  dictionary_init_ms: +dictionaryInit.toFixed(3),
  first_filter_including_name_preparation_ms: +coldFilter.toFixed(3),
  queries: results,
}, null, 2));
dispose();

import { performance } from "node:perf_hooks";
import { frontendModule, fixtureFiles } from "./frontend-module.mjs";

const api = await frontendModule();
const files = fixtureFiles(10000);
globalThis.__kufInvoke = async () => files.slice();
let dispose;
const pane = api.createRoot((d) => { dispose = d; return api.createPaneState(); });

async function measure(action, count = 15) {
  for (let i = 0; i < 3; i++) await action();
  const samples = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await action();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { median_ms: +samples[Math.floor(count / 2)].toFixed(3), p95_ms: +samples[Math.ceil(count * .95) - 1].toFixed(3) };
}

await pane.navigateTo("C:\\fixture", false);
const results = {
  kind: "Synthetic frontend workload, 10000 entries, no filesystem/IPC/render time",
  node: process.version,
  navigation: await measure(() => pane.navigateTo("C:\\fixture", false)),
  refresh: await measure(() => pane.refresh()),
  invert_selection: await measure(() => pane.invertSelection()),
  // Mirrors the original save/load of both panes during each tab switch.
  legacy_tab_roundtrip: await measure(() => {
    const left = JSON.parse(JSON.stringify(pane.state));
    const right = JSON.parse(JSON.stringify(pane.state));
    pane.setState(JSON.parse(JSON.stringify(left)));
    pane.setState(JSON.parse(JSON.stringify(right)));
  }),
};
if (api.createTabState) {
  let disposeTabs;
  const tabs = api.createRoot((d) => { disposeTabs = d; return api.createTabState(); });
  const first = tabs.current();
  await first.left.navigateTo("C:\\fixture", false);
  await first.right.navigateTo("C:\\fixture", false);
  const second = tabs.add();
  await second.left.navigateTo("C:\\fixture", false);
  await second.right.navigateTo("C:\\fixture", false);
  results.tab_switch = await measure(() => { tabs.switchTo(0); tabs.switchTo(1); });
  disposeTabs();
}
console.log(JSON.stringify(results, null, 2));
dispose();

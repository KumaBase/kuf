import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { frontendModule, fixtureFiles } from "../scripts/frontend-module.mjs";

const api = await frontendModule("export * from './src/auto-refresh.ts'; export * from './src/filter.ts'; export * from './src/migemo.ts';");
function root(t, factory = api.createPaneState) {
  return api.createRoot((dispose) => { t.after(dispose); return factory(); });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const entry = (name, is_dir = false) => ({ ...fixtureFiles(1)[0], name, is_dir });

test("newest navigation wins; old failures do not surface or clear loading", async (t) => {
  const pane = root(t);
  const old = deferred(), current = deferred();
  globalThis.__kufInvoke = (_, { path }) => path === "old" ? old.promise : current.promise;
  const a = pane.navigateTo("old");
  const b = pane.navigateTo("current");
  old.reject(new Error("stale failure"));
  await a;
  assert.equal(pane.loading(), true);
  current.resolve([entry("current.txt")]);
  await b;
  assert.equal(pane.state.path, "current");
  assert.equal(pane.loading(), false);
});

test("refresh preserves cursor and selection by filename after entries shift", async (t) => {
  const pane = root(t);
  globalThis.__kufInvoke = async () => [entry("..", true), entry("b.txt"), entry("c.txt")];
  await pane.navigateTo("folder");
  pane.setState({ cursorIndex: 2, selectedIndices: [1, 2] });
  globalThis.__kufInvoke = async () => [entry("..", true), entry("a.txt"), entry("c.txt")];
  await pane.refresh();
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "c.txt");
  assert.deepEqual([...pane.state.selectedIndices], [2]);
});

test("parent entry is excluded from select-all, toggle and inversion", async (t) => {
  const pane = root(t);
  globalThis.__kufInvoke = async () => [entry("..", true), entry("a.txt"), entry("b.txt")];
  await pane.navigateTo("folder");
  pane.toggleSelect();
  assert.deepEqual([...pane.state.selectedIndices], []);
  pane.selectAll();
  assert.deepEqual([...pane.state.selectedIndices], [1, 2]);
  pane.invertSelection();
  assert.deepEqual([...pane.state.selectedIndices], []);
  pane.invertSelection();
  assert.deepEqual([...pane.state.selectedIndices], [1, 2]);
});

test("history restores cursor and truncates forward entries on a new branch", async (t) => {
  const pane = root(t);
  globalThis.__kufInvoke = async () => [entry("a.txt"), entry("b.txt")];
  await pane.navigateTo("a");
  pane.setState("cursorIndex", 1);
  await pane.navigateTo("b");
  await pane.historyBack();
  assert.equal(pane.state.path, "a");
  assert.equal(pane.state.cursorIndex, 1);
  await pane.historyForward();
  assert.equal(pane.state.path, "b");
  await pane.historyBack();
  await pane.navigateTo("c");
  await pane.historyForward();
  assert.equal(pane.state.path, "c");
  assert.deepEqual(pane.state.history.map((item) => item.path), ["a", "c"]);
});

test("failed navigation leaves path and history intact", async (t) => {
  const pane = root(t);
  globalThis.__kufInvoke = async () => [];
  await pane.navigateTo("valid");
  globalThis.__kufInvoke = async () => { throw new Error("denied"); };
  await assert.rejects(pane.navigateTo("invalid"), /denied/);
  assert.equal(pane.state.path, "valid");
  assert.equal(pane.loading(), false);
  assert.equal(pane.state.history.length, 1);
});

test("tab switches retain pane identity, listings and per-tab active side", async (t) => {
  const tabs = root(t, api.createTabState);
  const first = tabs.current();
  globalThis.__kufInvoke = async () => fixtureFiles(10000);
  await first.left.navigateTo("first");
  first.left.setState({ cursorIndex: 500, selectedIndices: [10, 20] });
  first.setActiveSide("right");
  const listing = first.left.state.files;
  const second = tabs.add();
  await second.left.navigateTo("second");
  tabs.switchTo(0);
  assert.strictEqual(tabs.current(), first);
  assert.strictEqual(tabs.current().left.state.files, listing);
  assert.equal(first.activeSide(), "right");
  assert.equal(first.left.state.cursorIndex, 500);
  assert.deepEqual([...first.left.state.selectedIndices], [10, 20]);
  tabs.switchTo(1);
  assert.equal(tabs.current().left.state.path, "second");
});

test("pending navigation finishes in its original tab after switching or swapping", async (t) => {
  const tabs = root(t, api.createTabState);
  const first = tabs.current();
  const pane = first.left;
  const pending = deferred();
  globalThis.__kufInvoke = () => pending.promise;
  const navigation = pane.navigateTo("remote");
  first.swap();
  const second = tabs.add();
  pending.resolve([entry("remote.txt")]);
  await navigation;
  assert.equal(first.right.state.path, "remote");
  assert.equal(second.left.state.path, "");
  assert.strictEqual(first.right, pane);
});

test("closing earlier and active tabs selects the expected surviving tab", (t) => {
  const tabs = root(t, api.createTabState);
  tabs.add();
  const last = tabs.add();
  tabs.close(0);
  assert.strictEqual(tabs.current(), last);
  assert.equal(tabs.activeIndex(), 1);
  tabs.close(1);
  const survivor = tabs.current();
  tabs.close(0);
  assert.strictEqual(tabs.current(), survivor);
  assert.equal(tabs.tabs().length, 1);
});

test("listing sort honors parent, directories and case-sensitive settings", () => {
  const input = [entry("b"), entry("a"), entry("Z", true), entry("..", true), entry("A")];
  assert.deepEqual(api.sortFiles(input, true, false).map((f) => f.name), ["..", "Z", "a", "A", "b"]);
  assert.deepEqual(api.sortFiles(input, false, true).map((f) => f.name), ["..", "A", "Z", "a", "b"]);
  assert.equal(input[0].name, "b");
});

test("column sorting keeps parent and directories first and uses directional name ties", () => {
  const input = [
    { ...entry("beta.log"), extension: "log", size: 2, modified: "2026-10-24 12:00" },
    { ...entry("alpha.txt"), extension: "txt", size: 8, modified: "2026-10-25 12:00" },
    { ...entry("gamma.txt"), extension: "txt", size: 8, modified: "2026-10-25 12:00" },
    entry("folder", true), entry("..", true),
  ];
  const ordered = (key, order, dirsFirst = true) => api.sortFiles(input, dirsFirst, false, { key, order }).map((f) => f.name);
  assert.deepEqual(ordered("name", "desc"), ["..", "folder", "gamma.txt", "beta.log", "alpha.txt"]);
  assert.deepEqual(ordered("extension", "asc"), ["..", "folder", "beta.log", "alpha.txt", "gamma.txt"]);
  assert.deepEqual(ordered("extension", "desc"), ["..", "folder", "gamma.txt", "alpha.txt", "beta.log"]);
  assert.deepEqual(ordered("size", "asc"), ["..", "folder", "beta.log", "alpha.txt", "gamma.txt"]);
  assert.deepEqual(ordered("size", "desc"), ["..", "folder", "gamma.txt", "alpha.txt", "beta.log"]);
  assert.deepEqual(ordered("modified", "asc"), ["..", "folder", "beta.log", "alpha.txt", "gamma.txt"]);
  assert.deepEqual(ordered("modified", "desc"), ["..", "folder", "gamma.txt", "alpha.txt", "beta.log"]);
  assert.deepEqual(ordered("size", "desc", false), ["..", "gamma.txt", "alpha.txt", "beta.log", "folder"]);
  assert.deepEqual(input.map((f) => f.name), ["beta.log", "alpha.txt", "gamma.txt", "folder", ".."]);
});

test("missing modified dates stay last in both directions and case-folded name ties stay stable", () => {
  const input = [
    { ...entry("unknown-a"), modified: null },
    { ...entry("known"), modified: "2026-10-25 12:00" },
    { ...entry("unknown-z"), modified: null },
  ];
  assert.deepEqual(api.sortFiles(input, false, false, { key: "modified", order: "asc" }).map((f) => f.name), ["known", "unknown-a", "unknown-z"]);
  assert.deepEqual(api.sortFiles(input, false, false, { key: "modified", order: "desc" }).map((f) => f.name), ["known", "unknown-z", "unknown-a"]);
  const sameName = [entry("a"), entry("A"), entry("b")];
  assert.deepEqual(api.sortFiles(sameName, false, false, { key: "name", order: "desc" }).map((f) => f.name), ["b", "a", "A"]);
  assert.deepEqual(api.sortFiles(sameName, false, true, { key: "name", order: "asc" }).map((f) => f.name), ["A", "a", "b"]);
});

test("case-sensitive extension sorting uses the original filename extension with native lowercase payloads", () => {
  const input = [
    { ...entry("alpha.txt"), extension: "txt" },
    { ...entry("zeta.TXT"), extension: "txt" },
  ];
  assert.deepEqual(api.sortFiles(input, false, false, { key: "extension", order: "asc" }).map((f) => f.name), ["alpha.txt", "zeta.TXT"]);
  assert.deepEqual(api.sortFiles(input, false, true, { key: "extension", order: "asc" }).map((f) => f.name), ["zeta.TXT", "alpha.txt"]);
  const noExtension = [
    { ...entry("zeta.dotfile"), extension: "" },
    { ...entry("trailing."), extension: "" },
    { ...entry(".bashrc"), extension: "" },
  ];
  assert.deepEqual(api.sortFiles([...input, ...noExtension], false, true, { key: "extension", order: "asc" }).map((f) => f.name), [".bashrc", "trailing.", "zeta.dotfile", "zeta.TXT", "alpha.txt"]);
});

test("modified sort uses precise timestamps within one displayed minute and accepts epoch zero", () => {
  const minute = "2026-10-25 12:00";
  const start = Date.parse("2026-10-25T12:00:00");
  const input = [
    { ...entry("a-later"), modified: minute, modified_timestamp: start + 59000 },
    { ...entry("z-earlier"), modified: minute, modified_timestamp: start + 1000 },
    { ...entry("epoch"), modified: null, modified_timestamp: 0 },
  ];
  assert.deepEqual(api.sortFiles(input, false, false, { key: "modified", order: "asc" }).map((f) => f.name), ["epoch", "z-earlier", "a-later"]);
  assert.deepEqual(api.sortFiles(input, false, false, { key: "modified", order: "desc" }).map((f) => f.name), ["a-later", "z-earlier", "epoch"]);
});

test("modified sort supports legacy local date payloads while explicit null and invalid timestamps stay unknown", () => {
  const input = [
    { ...entry("legacy"), modified: "2026-10-25 12:00" },
    { ...entry("modern"), modified: "2026-10-25 12:00", modified_timestamp: Date.parse("2026-10-25T12:00:30") },
    { ...entry("explicit-null"), modified: "2026-10-25 12:01", modified_timestamp: null },
    { ...entry("invalid-number"), modified: "2026-10-25 12:02", modified_timestamp: Number.NaN },
    { ...entry("invalid-legacy"), modified: "unavailable" },
    { ...entry("missing-date"), modified: null },
  ];
  assert.deepEqual(api.sortFiles(input, false, false, { key: "modified", order: "asc" }).map((f) => f.name), ["legacy", "modern", "explicit-null", "invalid-legacy", "invalid-number", "missing-date"]);
  assert.deepEqual(api.sortFiles(input, false, false, { key: "modified", order: "desc" }).map((f) => f.name), ["modern", "legacy", "missing-date", "invalid-number", "invalid-legacy", "explicit-null"]);
});

test("pane sorting uses cached files and preserves cursor, selection, filter and refresh order", async (t) => {
  const pane = root(t);
  let calls = 0;
  const files = [entry("..", true), { ...entry("a.txt"), size: 3 }, { ...entry("b.txt"), size: 9 }, { ...entry("c.log"), size: 5 }];
  globalThis.__kufInvoke = async () => { calls++; return files; };
  await pane.navigateTo("folder");
  pane.setState({ cursorIndex: 1, selectedIndices: [1, 2] });
  pane.setFilterMode("literal");
  pane.setFilter(".txt");
  pane.setSort({ key: "size", order: "desc" });
  assert.equal(calls, 1);
  assert.deepEqual(pane.state.files.map((f) => f.name), ["..", "b.txt", "a.txt"]);
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "a.txt");
  assert.deepEqual([...pane.getSelectedPaths()].sort(), ["folder/a.txt", "folder/b.txt"]);
  assert.equal(pane.filterQuery(), ".txt");
  assert.equal(pane.filterMode(), "literal");
  assert.equal(pane.totalCount(), 3);
  assert.ok(pane.filterHighlights().get("a.txt")?.length > 0);
  await pane.refresh();
  assert.equal(calls, 2);
  assert.deepEqual(pane.state.files.map((f) => f.name), ["..", "b.txt", "a.txt"]);
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "a.txt");
  pane.closeFilter();
  assert.deepEqual(pane.state.files.map((f) => f.name), ["..", "b.txt", "c.log", "a.txt"]);
  assert.deepEqual(pane.sort(), { key: "size", order: "desc" });
  assert.equal(calls, 2);
});

test("resort applies global directory and case preferences without resetting pane sort, selections or reading files", async (t) => {
  const previous = api.settings();
  t.after(() => api.setSettings(previous));
  const preferences = (dirs_first, case_sensitive) => ({
    display: { show_hidden: true }, sort: { dirs_first, case_sensitive },
  });
  api.setSettings(preferences(false, false));
  const pane = root(t);
  let calls = 0;
  globalThis.__kufInvoke = async () => {
    calls++;
    return [{ ...entry("a.txt"), size: 5 }, { ...entry("B.txt"), size: 5 }, { ...entry("Z", true), size: 0 }];
  };
  await pane.navigateTo("folder");
  pane.setSort({ key: "size", order: "desc" });
  assert.deepEqual(pane.state.files.map((f) => f.name), ["B.txt", "a.txt", "Z"]);
  pane.setState({ cursorIndex: 0, selectedIndices: [0, 1] });
  api.setSettings(preferences(true, true));
  pane.resort();
  assert.deepEqual(pane.state.files.map((f) => f.name), ["Z", "a.txt", "B.txt"]);
  assert.deepEqual(pane.sort(), { key: "size", order: "desc" });
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "B.txt");
  assert.deepEqual([...pane.getSelectedPaths()].sort(), ["folder/B.txt", "folder/a.txt"]);
  assert.equal(pane.totalCount(), 3);
  assert.equal(calls, 1);
});

test("smart search keeps relevance before column sort and breaks equal scores by the selected order", async (t) => {
  const pane = root(t);
  globalThis.__kufInvoke = async () => [
    entry("..", true), { ...entry("report"), size: 1 },
    { ...entry("reportA"), size: 2 }, { ...entry("reportB"), size: 9 },
    { ...entry("r-e-p-o-r-t"), size: 100 },
  ];
  await pane.navigateTo("folder");
  pane.setFilter("report");
  pane.setCursorToFile("reportA");
  pane.setSort({ key: "size", order: "desc" });
  assert.deepEqual(pane.state.files.map((f) => f.name), ["..", "report", "reportB", "reportA", "r-e-p-o-r-t"]);
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "reportA");
  pane.setFilter("*");
  assert.deepEqual(pane.state.files.map((f) => f.name), ["..", "r-e-p-o-r-t", "reportB", "reportA", "report"]);
});

test("a sort change during pending navigation applies to the arriving listing", async (t) => {
  const pane = root(t);
  const pending = deferred();
  globalThis.__kufInvoke = () => pending.promise;
  const navigation = pane.navigateTo("folder");
  pane.setSort({ key: "name", order: "desc" });
  pending.resolve([entry("a.txt"), entry("z.txt")]);
  await navigation;
  assert.deepEqual(pane.state.files.map((f) => f.name), ["z.txt", "a.txt"]);
});

test("sort belongs to each pane, survives hidden tabs and is independently inherited by a new tab", async (t) => {
  const tabs = root(t, api.createTabState);
  const first = tabs.current();
  globalThis.__kufInvoke = async () => [entry("a.txt"), entry("z.txt")];
  await Promise.all([first.left.navigateTo("left"), first.right.navigateTo("right")]);
  first.left.setSort({ key: "name", order: "desc" });
  assert.deepEqual(first.left.state.files.map((f) => f.name), ["z.txt", "a.txt"]);
  assert.deepEqual(first.right.state.files.map((f) => f.name), ["a.txt", "z.txt"]);
  const second = tabs.add();
  assert.deepEqual(second.left.sort(), { key: "name", order: "desc" });
  assert.deepEqual(second.right.sort(), { key: "name", order: "asc" });
  second.left.setSort({ key: "size", order: "asc" });
  assert.deepEqual(first.left.sort(), { key: "name", order: "desc" });
  tabs.switchTo(0);
  assert.strictEqual(tabs.current(), first);
  assert.deepEqual(first.left.state.files.map((f) => f.name), ["z.txt", "a.txt"]);
  first.swap();
  assert.deepEqual(first.right.sort(), { key: "name", order: "desc" });
});

test("workspace restores per-pane sort and older snapshots default to name ascending", async (t) => {
  const tabs = root(t, api.createTabState);
  globalThis.__kufInvoke = async () => [entry("a.txt"), entry("z.txt")];
  await Promise.all([tabs.current().left.navigateTo("left"), tabs.current().right.navigateTo("right")]);
  tabs.current().left.setSort({ key: "modified", order: "desc" });
  tabs.current().right.setSort({ key: "extension", order: "asc" });
  const snapshot = tabs.snapshot();
  assert.deepEqual(snapshot.tabs[0].left_sort, { key: "modified", order: "desc" });
  assert.deepEqual(snapshot.tabs[0].right_sort, { key: "extension", order: "asc" });
  tabs.restore(snapshot);
  assert.deepEqual(tabs.snapshot(), snapshot);
  assert.deepEqual(tabs.current().left.sort(), { key: "modified", order: "desc" });
  assert.deepEqual(tabs.current().right.sort(), { key: "extension", order: "asc" });
  tabs.restore({ tabs: [{ left_path: "legacy-left", right_path: "legacy-right", active_side: "right" }], active_index: 0 });
  assert.deepEqual(tabs.current().left.sort(), { key: "name", order: "asc" });
  assert.deepEqual(tabs.current().right.sort(), { key: "name", order: "asc" });
  assert.equal(tabs.current().activeSide(), "right");
  await tabs.current().left.refresh();
  assert.deepEqual(tabs.current().left.state.files.map((f) => f.name), ["a.txt", "z.txt"]);
});

test("sorting commands have default shortcut bindings", () => {
  assert.equal(api.DEFAULT_KEYBINDS["Ctrl+Shift+s"], "sort");
  assert.equal(api.DEFAULT_KEYBINDS["Ctrl+Shift+r"], "sort_reverse");
});

test("filter narrows visible operations and clearing restores the full listing", async (t) => {
  const pane = root(t);
  globalThis.__kufInvoke = async () => [entry("..", true), entry("alpha.txt"), entry("beta.log"), entry("日本語.TXT")];
  await pane.navigateTo("C:\\folder");
  pane.selectAll();
  pane.setFilter("*.txt");
  assert.deepEqual(pane.state.files.map((f) => f.name), ["..", "alpha.txt", "日本語.TXT"]);
  assert.equal(pane.totalCount(), 3);
  assert.equal(pane.getSelectedPaths().length, 2);
  assert.ok(pane.getSelectedPaths().every((p) => p.toLowerCase().endsWith(".txt")));
  pane.setFilter("日本");
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "日本語.TXT");
  pane.closeFilter();
  assert.equal(pane.state.files.length, 4);
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "日本語.TXT");
});

test("wildcard filter supports ? and literal regex characters; refresh keeps the filter", async (t) => {
  const pane = root(t);
  globalThis.__kufInvoke = async () => [entry("..", true), entry("a[1].txt"), entry("a2.txt"), entry("ab.log")];
  await pane.navigateTo("folder");
  pane.setFilter("a?.txt");
  assert.deepEqual(pane.state.files.map((f) => f.name), ["..", "a2.txt"]);
  pane.setFilter("[1]");
  assert.equal(pane.state.files[1].name, "a[1].txt");
  await pane.refresh();
  assert.equal(pane.filterQuery(), "[1]");
  pane.setFilter("no match");
  assert.deepEqual(pane.getSelectedPaths(), []);
  await pane.navigateTo("other");
  assert.equal(pane.filterQuery(), "");
});

test("workspace snapshot stores only paths and active positions and restores independent tabs", async (t) => {
  const tabs = root(t, api.createTabState);
  globalThis.__kufInvoke = async () => fixtureFiles(100);
  await tabs.current().left.navigateTo("C:\\left");
  await tabs.current().right.navigateTo("C:\\right");
  tabs.current().setActiveSide("right");
  const second = tabs.add();
  await second.left.navigateTo("sftp://user@example.test/home");
  await second.right.navigateTo("C:\\backup");
  const snapshot = tabs.snapshot();
  assert.equal(snapshot.active_index, 1);
  assert.equal(snapshot.tabs[0].active_side, "right");
  assert.equal(JSON.stringify(snapshot).includes("file-"), false);
  tabs.restore(snapshot);
  assert.equal(tabs.current().left.state.path, "sftp://user@example.test/home");
  assert.equal(tabs.current().left.state.files.length, 0);
  assert.deepEqual(tabs.snapshot(), snapshot);
  tabs.switchTo(0);
  assert.equal(tabs.current().activeSide(), "right");
});

test("restored unavailable paths remain retryable instead of being replaced by home", async (t) => {
  const tabs = root(t, api.createTabState);
  tabs.restore({ tabs: [{left_path: "C:\\missing", right_path: "C:\\right", active_side: "left"}], active_index: 0 });
  const pane = tabs.current().left;
  globalThis.__kufInvoke = async () => { throw new Error("not found"); };
  await assert.rejects(pane.refresh(), /not found/);
  assert.equal(pane.state.path, "C:\\missing");
  assert.match(pane.loadError(), /missing/);
  globalThis.__kufInvoke = async () => [entry("restored.txt")];
  await pane.refresh();
  assert.equal(pane.loadError(), "");
  assert.equal(pane.state.files[0].name, "restored.txt");
});

test("reactive UI always sees a valid current tab when closing or restoring fewer tabs", (t) => {
  let tabs;
  api.createRoot((dispose) => {
    t.after(dispose);
    tabs = api.createTabState();
    api.createEffect(() => { assert.ok(tabs.current().left.state); });
  });
  tabs.add();
  tabs.add();
  assert.doesNotThrow(() => tabs.close(2));
  assert.doesNotThrow(() => tabs.restore({ tabs: [{left_path: "left", right_path: "right", active_side: "left"}], active_index: 0 }));
  assert.equal(tabs.tabs().length, 1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("automatic refresh coalesces events and defers them during file operations", async (t) => {
  const pane = root(t);
  let calls = 0, blocked = true;
  globalThis.__kufInvoke = async () => { calls++; return [entry("a.txt")]; };
  await pane.navigateTo("folder");
  const refresh = api.createAutoRefresh(() => [pane], () => blocked, () => {}, 5);
  t.after(() => refresh.dispose());
  for (let i = 0; i < 10; i++) refresh.request(["folder"]);
  await sleep(25);
  assert.equal(calls, 1);
  blocked = false;
  await sleep(35);
  assert.equal(calls, 2);
});

test("automatic refresh never cancels pending navigation to another directory", async (t) => {
  const pane = root(t);
  globalThis.__kufInvoke = async () => [entry("a.txt")];
  await pane.navigateTo("folder");
  const pending = deferred();
  let calls = 0;
  globalThis.__kufInvoke = async () => { calls++; return pending.promise; };
  const navigation = pane.navigateTo("other");
  const refresh = api.createAutoRefresh(() => [pane], () => false, () => {}, 5);
  t.after(() => refresh.dispose());
  refresh.request(["folder"]);
  await sleep(25);
  assert.equal(calls, 1);
  pending.resolve([entry("new.txt")]);
  await navigation;
  await sleep(20);
  assert.equal(calls, 1);
  assert.equal(pane.state.path, "other");
});

test("automatic refresh updates both Windows drive aliases from one watch notification", async (t) => {
  const left = root(t), right = root(t);
  const paths = ["C:\\Work\\Project", "c:/work/project/"];
  globalThis.__kufInvoke = async () => [entry("original.txt")];
  await Promise.all([left.navigateTo(paths[0]), right.navigateTo(paths[1])]);
  const refreshed = [];
  globalThis.__kufInvoke = async (_, { path }) => { refreshed.push(path); return [entry("updated.txt")]; };
  const refresh = api.createAutoRefresh(() => [left, right], () => false, () => {}, 5);
  t.after(() => refresh.dispose());
  refresh.request([paths[0]]);
  await sleep(35);
  assert.deepEqual(refreshed.sort(), [...paths].sort());
  assert.equal(left.state.files[0].name, "updated.txt");
  assert.equal(right.state.files[0].name, "updated.txt");
});

test("automatic refresh updates both UNC aliases from one watch notification", async (t) => {
  const left = root(t), right = root(t);
  const paths = ["\\\\Server\\Share\\Work", "\\\\server\\share\\work\\"];
  globalThis.__kufInvoke = async () => [entry("original.txt")];
  await Promise.all([left.navigateTo(paths[0]), right.navigateTo(paths[1])]);
  const refreshed = [];
  globalThis.__kufInvoke = async (_, { path }) => { refreshed.push(path); return [entry("updated.txt")]; };
  const refresh = api.createAutoRefresh(() => [left, right], () => false, () => {}, 5);
  t.after(() => refresh.dispose());
  refresh.request([paths[0]]);
  await sleep(35);
  assert.deepEqual(refreshed.sort(), [...paths].sort());
  assert.equal(right.state.files[0].name, "updated.txt");
});

test("automatic refresh keeps Unix directory names case-sensitive", async (t) => {
  const left = root(t), right = root(t);
  const paths = ["/tmp/Project", "/tmp/project"];
  globalThis.__kufInvoke = async () => [entry("original.txt")];
  await Promise.all([left.navigateTo(paths[0]), right.navigateTo(paths[1])]);
  const refreshed = [];
  globalThis.__kufInvoke = async (_, { path }) => { refreshed.push(path); return [entry("updated.txt")]; };
  const refresh = api.createAutoRefresh(() => [left, right], () => false, () => {}, 5);
  t.after(() => refresh.dispose());
  refresh.request([paths[0]]);
  await sleep(35);
  assert.deepEqual(refreshed, [paths[0]]);
  assert.equal(left.state.files[0].name, "updated.txt");
  assert.equal(right.state.files[0].name, "original.txt");
});

function matchName(query, name, options) {
  return api.compileFileFilter(query, options)(api.prepareFileName(name));
}

test("smart filtering matches omitted characters without accepting reordered letters", () => {
  assert.ok(matchName("usrctrl", "UserController.ts"));
  assert.ok(matchName("gp", "GitProvider.ts"));
  assert.equal(matchName("zxy", "xyz.ts"), null);
  assert.equal(matchName("controllerx", "Controller.ts"), null);
});

test("smart ranking favors exact, prefix and contiguous matches over scattered characters", () => {
  const score = (name) => matchName("report", name).score;
  assert.ok(score("report") > score("report.md"));
  assert.ok(score("report.md") > score("annual_report.md"));
  assert.ok(score("annual_report.md") > score("r-e-p-o-r-t.md"));
  const name = "xa_b_c----abc.txt";
  const start = name.indexOf("abc");
  assert.deepEqual(matchName("abc", name).positions, [start, start + 1, start + 2]);
});

test("space separated smart terms are ANDed independently of their order", () => {
  assert.ok(matchName("report pdf", "2026_report.PDF"));
  assert.ok(matchName("pdf report", "2026_report.PDF"));
  assert.equal(matchName("report pdf", "report.txt"), null);
  assert.equal(matchName("report pdf", "budget.pdf"), null);
});

test("normalization matches width and kana while highlights refer to the original name", () => {
  assert.ok(matchName("ＡＢＣ", "abc.txt"));
  assert.ok(matchName("がいど", "ガイド.txt"));
  assert.ok(matchName("ｶﾞｲﾄﾞ", "ガイド.txt"));
  assert.deepEqual(matchName("guide", "🧸Ｇｕｉｄｅ.txt").positions, [2, 3, 4, 5, 6]);
  const halfwidth = matchName("がいど", "ｶﾞｲﾄﾞ.txt").positions;
  assert.ok(halfwidth.includes(0) && halfwidth.includes(1) && halfwidth.includes(4));
});

test("literal mode disables fuzzy and AND matching; glob syntax stays compatible", () => {
  assert.equal(matchName("usrctrl", "UserController.ts", { mode: "literal" }), null);
  assert.equal(matchName("report pdf", "report_2026.pdf", { mode: "literal" }), null);
  assert.ok(matchName("report pdf", "annual report pdf.txt", { mode: "literal" }));
  assert.ok(matchName("*.txt", "日本語.TXT"));
  assert.equal(matchName("*.txt", "note.txt.bak"), null);
  assert.ok(matchName("a?.txt", "a2.txt"));
  assert.equal(matchName("a?.txt", "a[1].txt"), null);
  assert.ok(matchName("[1]", "a[1].txt"));
  assert.equal(matchName("[1]", "a2.txt"), null);
});

test("query changes select the best hit while refresh preserves cursor and visible selections", async (t) => {
  const pane = root(t);
  let files = [entry("..", true), entry("other.txt"), entry("UserController.ts"), entry("usrctrl.txt")];
  globalThis.__kufInvoke = async () => files;
  await pane.navigateTo("folder");
  pane.selectAll();
  pane.setFilter("usrctrl");
  assert.equal(pane.state.files[1].name, "usrctrl.txt");
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "usrctrl.txt");
  assert.equal(pane.getSelectedPaths().length, 2);
  assert.ok(pane.filterHighlights().get("UserController.ts")?.length > 0);
  pane.setCursorToFile("UserController.ts");
  files = [...files, entry("usrctrl")];
  await pane.refresh();
  assert.equal(pane.state.files[1].name, "usrctrl");
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "UserController.ts");
  assert.equal(pane.getSelectedPaths().length, 2);
  pane.setFilterMode("literal");
  assert.ok(!pane.state.files.some((file) => file.name === "UserController.ts"));
  assert.equal(pane.getSelectedPaths().length, 1);
  pane.closeFilter();
  assert.equal(pane.filterHighlights().size, 0);
  assert.deepEqual(pane.state.files.map((file) => file.name), api.sortFiles(files, true, false).map((file) => file.name));
});

test("Migemo expansion compiles once per term and participates in AND matching", () => {
  const expanded = [];
  const filter = api.compileFileFilter("nihon pdf", { expandTerm: (term) => {
    expanded.push(term);
    return term === "nihon" ? /日本(?:語)?/iu : null;
  } });
  assert.ok(filter(api.prepareFileName("日本語.pdf")));
  assert.equal(filter(api.prepareFileName("日本語.txt")), null);
  assert.ok(filter(api.prepareFileName("nihon.pdf")));
  assert.equal(expanded.filter((term) => term === "nihon").length, 1);
});

test("bundled real Migemo dictionary finds kanji without a network service", async () => {
  const data = await readFile(new URL("../public/migemo/migemo-compact-dict", import.meta.url));
  api.initializeMigemo(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  assert.equal(api.migemoStatus(), "ready");
  const options = { expandTerm: api.expandMigemoTerm };
  assert.ok(matchName("nihon", "日本語.txt", options));
  assert.ok(matchName("siryou pdf", "打ち合わせ資料.pdf", options));
  assert.ok(matchName("shiyou", "仕様書.md", options));
  assert.equal(matchName("nihon", "日本語.txt", { ...options, mode: "literal" }), null);
  assert.equal(api.expandMigemoTerm("a"), null);
  assert.equal(api.expandMigemoTerm(".*"), null);
});

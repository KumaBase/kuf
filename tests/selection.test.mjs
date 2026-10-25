import test from "node:test";
import assert from "node:assert/strict";
import { frontendModule, fixtureFiles } from "../scripts/frontend-module.mjs";

const api = await frontendModule("export * from './src/filer-selection.ts';");
const entry = (name, extra = {}) => ({ ...fixtureFiles(1)[0], name, ...extra });
const names = (pane) => pane.state.selectedIndices.map((index) => pane.state.files[index].name);
function paneRoot(t) {
  return api.createRoot((dispose) => { t.after(dispose); return api.createPaneState(); });
}

test("range selection extends and shrinks from one anchor and never selects the parent", async (t) => {
  const pane = paneRoot(t);
  globalThis.__kufInvoke = async () => [entry("..", { is_dir: true }), entry("a"), entry("b"), entry("c")];
  await pane.navigateTo("folder");
  pane.setCursorToFile("b");
  pane.selectRangeTo(3);
  assert.deepEqual(names(pane), ["b", "c"]);
  pane.selectRangeTo(2);
  assert.deepEqual(names(pane), ["b"]);
  pane.selectRangeTo(0);
  assert.deepEqual(names(pane), ["a", "b"]);
  assert.equal(pane.state.cursorIndex, 0);
  pane.selectRangeTo(99);
  assert.deepEqual(names(pane), ["b", "c"]);
  assert.equal(pane.state.cursorIndex, 3);
});

test("ordinary cursor movement and a new listing reset range anchors", async (t) => {
  const pane = paneRoot(t);
  globalThis.__kufInvoke = async () => [entry("a"), entry("b"), entry("c"), entry("d")];
  await pane.navigateTo("folder");
  pane.selectRangeTo(2);
  assert.deepEqual(names(pane), ["a", "b", "c"]);
  pane.cursorDown();
  pane.selectRangeTo(2);
  assert.deepEqual(names(pane), ["c", "d"]);
  await pane.refresh();
  pane.selectRangeTo(1);
  assert.deepEqual(names(pane), ["b", "c"]);
});

test("space and shift-space toggle symmetrically while moving down and up and exclude the parent", async (t) => {
  const pane = paneRoot(t);
  globalThis.__kufInvoke = async () => [entry("..", { is_dir: true }), entry("a"), entry("b")];
  await pane.navigateTo("folder");
  pane.setCursorToFile("a");
  pane.toggleSelect();
  assert.deepEqual(names(pane), ["a"]);
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "b");
  pane.toggleSelectUp();
  assert.deepEqual(names(pane), ["a", "b"]);
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "a");
  pane.toggleSelectUp();
  assert.deepEqual(names(pane), ["b"]);
  assert.equal(pane.state.cursorIndex, 0);
  pane.toggleSelectUp();
  assert.deepEqual(names(pane), ["b"]);
  assert.equal(pane.state.cursorIndex, 0);
  assert.equal(api.DEFAULT_KEYBINDS.f, "filter");
  assert.equal(api.DEFAULT_KEYBINDS["Shift+ "], "toggle_select_up");
});

test("file-only, directory-only and pattern selection use only the visible listing", async (t) => {
  const pane = paneRoot(t);
  globalThis.__kufInvoke = async () => [
    entry("..", { is_dir: true }), entry("keep-folder", { is_dir: true }),
    entry("keep.txt"), entry("other.txt"),
  ];
  await pane.navigateTo("folder");
  pane.setFilterMode("literal");
  pane.setFilter("keep");
  pane.selectFiles();
  assert.deepEqual(names(pane), ["keep.txt"]);
  pane.selectDirectories();
  assert.deepEqual(names(pane), ["keep-folder"]);
  pane.selectPattern("*");
  assert.deepEqual(names(pane), ["keep-folder", "keep.txt"]);
  pane.closeFilter();
  assert.deepEqual(names(pane), ["keep-folder", "keep.txt"]);
});

test("wildcard selection supports replacement, addition, removal, literal regex characters and Unicode", () => {
  const files = [entry(".."), entry("a[1].TXT"), entry("alpha.txt"), entry("🧸.txt"), entry("folder", { is_dir: true })];
  assert.deepEqual(api.applyPatternSelection(files, [4], "*.txt", "replace", false), [1, 2, 3]);
  assert.deepEqual(api.applyPatternSelection(files, [0, 4, 99], "a[1].TXT", "add", true), [1, 4]);
  assert.deepEqual(api.applyPatternSelection(files, [1, 2, 3, 4], "a*.txt", "remove", false), [3, 4]);
  assert.deepEqual(api.applyPatternSelection(files, [], "?.txt", "replace", true), [3]);
  assert.deepEqual(api.applyPatternSelection(files, [], "*.txt", "replace", true), [2, 3]);
  assert.deepEqual(api.applyPatternSelection([entry("a".repeat(240))], [], "*a".repeat(60) + "b", "replace", false), []);
  assert.throws(() => api.applyPatternSelection(files, [], "", "replace", false), /1〜128/);
});

test("pane pattern selection follows the global case setting and does not read files", async (t) => {
  const previous = api.settings();
  t.after(() => api.setSettings(previous));
  const pane = paneRoot(t);
  let calls = 0;
  globalThis.__kufInvoke = async () => { calls++; return [entry("a.TXT"), entry("b.txt")]; };
  await pane.navigateTo("folder");
  api.setSettings({ sort: { case_sensitive: true, dirs_first: true }, display: { show_hidden: true } });
  pane.selectPattern("*.txt");
  assert.deepEqual(names(pane), ["b.txt"]);
  api.setSettings({ sort: { case_sensitive: false, dirs_first: true }, display: { show_hidden: true } });
  pane.selectPattern("*.txt", "add");
  assert.deepEqual(names(pane), ["a.TXT", "b.txt"]);
  assert.equal(calls, 1);
});

test("history jumps restore the same cursor name after sorting and inserted entries", async (t) => {
  const pane = paneRoot(t);
  const listing = {
    a: [entry("alpha"), entry("beta")],
    b: [entry("one"), entry("two")],
    c: [entry("third")],
    d: [entry("fourth")],
  };
  globalThis.__kufInvoke = async (_, { path }) => listing[path];
  await pane.navigateTo("a");
  pane.setCursorToFile("beta");
  await pane.navigateTo("b");
  pane.setCursorToFile("two");
  await pane.navigateTo("c");
  listing.a = [entry("aardvark"), ...listing.a];
  pane.setSort({ key: "name", order: "desc" });
  await pane.jumpHistory(0);
  assert.equal(pane.state.path, "a");
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "beta");
  assert.equal(pane.state.history[0].cursorName, "beta");
  await pane.historyForward();
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "two");
  await pane.navigateTo("d");
  assert.deepEqual(pane.state.history.map((item) => item.path), ["a", "b", "d"]);
  await pane.jumpHistory(1);
  await pane.historyBack();
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "beta");
});

test("failed history jumps leave the current path, cursor and history position intact", async (t) => {
  const pane = paneRoot(t);
  globalThis.__kufInvoke = async () => [entry("a"), entry("b")];
  await pane.navigateTo("first");
  await pane.navigateTo("second");
  pane.setCursorToFile("b");
  globalThis.__kufInvoke = async () => { throw new Error("unavailable"); };
  await assert.rejects(pane.jumpHistory(0), /unavailable/);
  assert.equal(pane.state.path, "second");
  assert.equal(pane.state.historyIndex, 1);
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "b");
});

test("parent navigation focuses the folder just left for Windows, Unix and remote paths", async (t) => {
  for (const [child, parent] of [["C:\\base\\child", "C:\\base"], ["/base/child", "/base"], ["sftp://u@host/base/child", "sftp://u@host/base"]]) {
    const pane = paneRoot(t);
    globalThis.__kufInvoke = async () => [entry("..", { is_dir: true }), entry("aaa"), entry("child", { is_dir: true })];
    await pane.navigateTo(child);
    await pane.navigateParent();
    assert.equal(pane.state.path, parent);
    assert.equal(pane.state.files[pane.state.cursorIndex].name, "child");
  }
});

test("comparison selects missing, different and newer files using metadata and excludes folders", () => {
  const file = (name, size, time) => entry(name, { size, modified_timestamp: time });
  const source = [entry("..", { is_dir: true }), entry("folder", { is_dir: true }),
    file("same", 1, 100), file("newer", 2, 200), file("unknown", 3, null),
    file("older", 4, 300), file("missing", 1, 0), file("size", 7, 100)];
  const target = [file("same", 1, 100), file("newer", 2, 100), file("unknown", 3, 200),
    file("older", 4, 400), file("size", 5, 100)];
  assert.deepEqual(api.compareFilesForSelection(source, target, "missing", true), [6]);
  assert.deepEqual(api.compareFilesForSelection(source, target, "different", true), [3, 5, 7]);
  assert.deepEqual(api.compareFilesForSelection(source, target, "newer", true), [3]);
});

test("comparison follows name-case settings and never guesses newer from unknown or colliding counterparts", () => {
  const source = [entry("A.txt", { size: 3, modified_timestamp: 0 })];
  const earlier = entry("a.txt", { size: 3, modified_timestamp: -100 });
  assert.deepEqual(api.compareFilesForSelection(source, [earlier], "missing", true), [0]);
  assert.deepEqual(api.compareFilesForSelection(source, [earlier], "missing", false), []);
  assert.deepEqual(api.compareFilesForSelection(source, [earlier], "newer", false), [0]);
  const unknown = entry("A.txt", { size: 3, modified_timestamp: null });
  assert.deepEqual(api.compareFilesForSelection(source, [unknown], "newer", false), []);
  assert.deepEqual(api.compareFilesForSelection(source, [earlier, unknown], "newer", false), []);
  assert.deepEqual(api.compareFilesForSelection(source, [entry("A.txt", { is_dir: true })], "missing", false), [0]);
});

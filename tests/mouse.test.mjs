import test from "node:test";
import assert from "node:assert/strict";
import { frontendModule, fixtureFiles } from "../scripts/frontend-module.mjs";

const api = await frontendModule("export * from './src/mouse.ts';");
const file = (name, extra = {}) => ({ ...fixtureFiles(1)[0], name, ...extra });

test("modifier click preserves the first cursor item and toggles later selections", () => {
  const state = { files: [file(".."), file("alpha.txt"), file("beta.txt"), file("gamma.txt")], cursorIndex: 1, selectedIndices: [] };
  assert.deepEqual(api.toggleMouseSelection(state, 2), [1, 2]);
  assert.deepEqual(api.toggleMouseSelection({ ...state, selectedIndices: [1, 2] }, 1), [2]);
  assert.deepEqual(api.toggleMouseSelection({ ...state, cursorIndex: 0 }, 2), [2]);
  assert.deepEqual(api.toggleMouseSelection({ ...state, selectedIndices: [1] }, 0), [1]);
  assert.deepEqual(api.toggleMouseSelection(state, 0), []);
});

test("drag snapshots the selected names and paths instead of later row positions", () => {
  const state = { path: "/work", files: [file("..", { is_dir: true }), file("first.txt"), file("second.txt"), file("other.txt")], selectedIndices: [1, 2] };
  const drag = api.captureDragSource(state, "left", 2);
  assert.deepEqual(drag.paths, ["/work/first.txt", "/work/second.txt"]);
  state.files[1].name = "unrelated.txt";
  state.selectedIndices = [];
  assert.deepEqual(drag.names, ["first.txt", "second.txt"]);
  assert.deepEqual(drag.paths, ["/work/first.txt", "/work/second.txt"]);
  assert.deepEqual(api.captureDragSource(state, "right", 3).paths, ["/work/other.txt"]);
  assert.equal(api.captureDragSource(state, "left", 0), null);
  assert.equal(api.captureDragSource(state, "left", 99), null);
});

test("native drop coordinates account for WebView2 physical pixels and macOS points", () => {
  assert.deepEqual(api.nativeDropPoint({ x: 600, y: 400 }, false, 1.5), { x: 400, y: 400 / 1.5 });
  assert.deepEqual(api.nativeDropPoint({ x: 600, y: 400 }, true, 2), { x: 600, y: 400 });
  assert.deepEqual(api.nativeDropPoint({ x: 60, y: 40 }, false, 0), { x: 60, y: 40 });
});

test("a drop rejects conflicting names from different source folders", () => {
  assert.equal(api.hasDuplicateDropNames(["C:\\a\\Report.txt", "C:\\b\\report.TXT"]), true);
  assert.equal(api.hasDuplicateDropNames(["/a/résumé.txt", "/b/re\u0301sume\u0301.txt"]), true);
  assert.equal(api.hasDuplicateDropNames(["/a/report\\one.txt", "/b/one.txt"]), false);
});

test("context menus stay inside small and large windows", () => {
  assert.deepEqual(api.menuPosition(799, 599, 260, 400, 800, 600), { x: 532, y: 192 });
  assert.deepEqual(api.menuPosition(-20, -10, 220, 250, 240, 270), { x: 8, y: 8 });
});

test("a context-menu action refuses a substituted file after refresh", () => {
  const state = { path: "/work", files: [file("alpha"), file("beta")], cursorIndex: 0, selectedIndices: [0] };
  const snapshot = { directory: "/work", name: "alpha", selectedNames: ["alpha"] };
  assert.equal(api.contextTargetIsCurrent(state, snapshot, true), true);
  assert.equal(api.contextTargetIsCurrent({ ...state, files: [file("beta")] }, snapshot, true), false);
  assert.equal(api.contextTargetIsCurrent({ ...state, path: "/elsewhere" }, snapshot, false), false);
  assert.equal(api.contextTargetIsCurrent(state, snapshot, false), true);
});

test("Unix folder names containing backslashes remain intact when navigating and transferring", () => {
  const path = "/Users/me/report\\draft";
  assert.equal(api.joinPath(path, "note.txt"), "/Users/me/report\\draft/note.txt");
  assert.equal(api.parentPath(path), "/Users/me");
  assert.equal(api.rootPath(path), "/");
  assert.equal(api.baseName(path), "report\\draft");
  assert.equal(api.baseName("C:\\Users\\me\\report.txt"), "report.txt");
  assert.equal(api.joinPath("C:\\Users\\me", "report.txt"), "C:\\Users\\me\\report.txt");
});

import test from "node:test";
import assert from "node:assert/strict";
import { frontendModule, fixtureFiles } from "../scripts/frontend-module.mjs";
const api = await frontendModule("export * from './src/batch-rename.ts';");
const entry = (name, extra = {}) => ({ ...fixtureFiles(1)[0], name, ...extra });
const options = (extra) => ({ ...api.DEFAULT_RENAME_OPTIONS, ...extra });

test("bulk replacement changes literal stem text and preserves original extension spelling", () => {
  const files = [entry("old[1]-old.JPG"), entry("old.folder", { is_dir: true }), entry(".old")];
  const preview = api.buildRenamePreview(files, files, options({ find: "old", replacement: "new" }), true);
  assert.deepEqual(preview.plan, [{ from: "old[1]-old.JPG", to: "new[1]-new.JPG" }, { from: "old.folder", to: "new.fnewer" }, { from: ".old", to: ".new" }]);
  assert.deepEqual(preview.errors, []);
});

test("affixes and sequences apply in listed selection order and retain original final extensions", () => {
  const files = [entry("photo.JPG"), entry("archive.tar.gz"), entry("folder", { is_dir: true })];
  assert.deepEqual(api.buildRenamePreview(files, files, options({ mode: "affix", prefix: "pre-", suffix: "-post" })).plan.map((item) => item.to), ["pre-photo-post.JPG", "pre-archive.tar-post.gz", "pre-folder-post"]);
  const preview = api.buildRenamePreview(files, files, options({ mode: "sequence", start: 5, step: 2, padding: 3, prefix: "img-" }));
  assert.deepEqual(preview.plan.map((item) => item.to), ["img-005.JPG", "img-007.gz", "img-009"]);
  assert.deepEqual(preview.errors, []);
});

test("preview rejects duplicate, invalid and occupied destinations before execution", () => {
  const files = [entry("a.txt"), entry("a.jpg")];
  const duplicates = api.buildRenamePreview([entry("a.txt"), entry("a.TXT")], [], options({ mode: "affix", prefix: "new-" }), true);
  assert.ok(duplicates.errors.length);
  const invalid = api.buildRenamePreview(files, files, options({ mode: "affix", prefix: "../" }), true);
  assert.equal(invalid.rows.every((row) => !!row.error), true);
  const occupied = api.buildRenamePreview([entry("a.txt")], [entry("a.txt"), entry("b.txt")], options({ find: "a", replacement: "b" }), true);
  assert.match(occupied.errors[0], /衝突/);
  const reserved = api.buildRenamePreview([entry("a.txt")], [], options({ find: "a", replacement: "CON" }), true);
  assert.match(reserved.errors[0], /Windows/);
  assert.ok(api.buildRenamePreview(files, [], options({ mode: "affix", prefix: "x".repeat(256) }), true).errors.length);
});

test("unchanged plans remain no-ops and malformed sequence values are rejected", () => {
  const files = [entry("keep.TXT")];
  const preview = api.buildRenamePreview(files, files, options({ find: "absent", replacement: "new" }), true);
  assert.deepEqual(preview.plan, [{ from: "keep.TXT", to: "keep.TXT" }]);
  assert.equal(preview.rows[0].changed, false);
  assert.deepEqual(preview.errors, []);
  assert.ok(api.buildRenamePreview(files, files, options({ mode: "sequence", start: Number.NaN })).errors.length);
  assert.ok(api.buildRenamePreview(files, files, options({ mode: "sequence", step: 0 })).errors.length);
});

test("a selected source disappearing during refresh never substitutes the new cursor item in the rename plan", async (t) => {
  const pane = api.createRoot((dispose) => { t.after(dispose); return api.createPaneState(); });
  globalThis.__kufInvoke = async () => [entry("..", { is_dir: true }), entry("old.JPG"), entry("unrelated.txt")];
  await pane.navigateTo("C:\\original");
  pane.setState({ selectedIndices: [1], cursorIndex: 1 });
  const snapshot = api.captureRenameRequest(pane.state);
  globalThis.__kufInvoke = async () => [entry("..", { is_dir: true }), entry("unrelated.txt")];
  await pane.refresh();
  assert.deepEqual([...pane.state.selectedIndices], []);
  assert.equal(pane.state.files[pane.state.cursorIndex].name, "unrelated.txt");
  const preview = api.buildRenamePreview(snapshot.files, snapshot.existingFiles, options({ mode: "affix", prefix: "new-" }), true);
  assert.deepEqual(preview.plan, [{ from: "old.JPG", to: "new-old.JPG" }]);
  assert.equal(snapshot.directory, "C:\\original");
  assert.deepEqual(snapshot.selectedIndices, [1]);
  assert.deepEqual(snapshot.existingFiles.map((file) => file.name), ["..", "old.JPG", "unrelated.txt"]);
});

test("cursor-only rename snapshots keep entry values and the directory fixed after live state changes", async (t) => {
  const pane = api.createRoot((dispose) => { t.after(dispose); return api.createPaneState(); });
  globalThis.__kufInvoke = async () => [entry("old.TXT"), entry("unrelated.txt")];
  await pane.navigateTo("/original");
  const snapshot = api.captureRenameRequest(pane.state);
  pane.setState("files", 0, "name", "changed-by-refresh.bin");
  await pane.navigateTo("/another");
  const preview = api.buildRenamePreview(snapshot.files, snapshot.existingFiles, options({ mode: "affix", prefix: "new-" }));
  assert.deepEqual(preview.plan, [{ from: "old.TXT", to: "new-old.TXT" }]);
  assert.equal(snapshot.directory, "/original");
  assert.deepEqual(snapshot.selectedIndices, []);
  assert.equal(snapshot.cursorIndex, 0);
  assert.deepEqual(snapshot.existingFiles.map((file) => file.name), ["old.TXT", "unrelated.txt"]);
  assert.deepEqual(api.captureRenameRequest({ path: "/", files: [entry("..", { is_dir: true })], selectedIndices: [], cursorIndex: 0 }).files, []);
});

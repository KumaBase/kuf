import test from "node:test";
import assert from "node:assert/strict";
import { frontendModule } from "../scripts/frontend-module.mjs";

const api = await frontendModule("export * from './src/preview.ts';");
const sjis = Uint8Array.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
const euc = Uint8Array.from([0xa4, 0xb3, 0xa4, 0xf3, 0xa4, 0xcb, 0xa4, 0xc1, 0xa4, 0xcf]);
function utf16(text, little, bom = true) {
  const bytes = bom ? little ? [0xff, 0xfe] : [0xfe, 0xff] : [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes.push(...(little ? [code & 255, code >> 8] : [code >> 8, code & 255]));
  }
  return Uint8Array.from(bytes);
}

test("preview decodes UTF-8 and Japanese legacy encodings, with manual overrides", () => {
  const utf8 = api.decodePreview(new TextEncoder().encode("日本語と熊🐻"));
  assert.equal(utf8.encoding, "utf-8"); assert.equal(utf8.text, "日本語と熊🐻"); assert.equal(utf8.binary, false);
  assert.equal(api.decodePreview(sjis).encoding, "shift_jis");
  assert.equal(api.decodePreview(sjis).text, "こんにちは");
  assert.equal(api.decodePreview(sjis, "shift_jis").hadErrors, false);
  assert.equal(api.decodePreview(euc).encoding, "euc-jp");
  assert.equal(api.decodePreview(euc, "euc-jp").text, "こんにちは");
  const forced = api.decodePreview(sjis, "utf-8");
  assert.equal(forced.encoding, "utf-8"); assert.equal(forced.hadErrors, true);
});

test("preview recognizes both UTF-16 BOMs and supports explicit BOM-less selection", () => {
  for (const little of [true, false]) {
    const decoded = api.decodePreview(utf16("日本語🐻\nalpha", little));
    assert.equal(decoded.text, "日本語🐻\nalpha");
    assert.equal(decoded.encoding, little ? "utf-16le" : "utf-16be");
    assert.equal(decoded.binary, false);
    const explicit = api.decodePreview(utf16("資料", little, false), little ? "utf-16le" : "utf-16be");
    assert.equal(explicit.text, "資料");
    const guessed = api.decodePreview(utf16("abcd", little, false));
    assert.equal(guessed.text, "abcd"); assert.equal(guessed.estimated, true);
  }
  assert.equal(api.decodePreview(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])).text, "A");
});

test("binary preview detection and hex pages preserve original offsets and bytes", () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 255]);
  assert.equal(api.decodePreview(bytes).binary, true);
  const printable = Uint8Array.from({ length: 48 }, (_, index) => index + 32);
  const second = api.formatHexPage(printable, 16, 16);
  assert.match(second, /^00000010  30 31 32/);
  assert.match(second, /\|0123456789:;<=>\?\|$/);
  assert.equal(second.split("\n").length, 1);
  assert.equal(api.formatHexPage(new Uint8Array()), "");
  assert.deepEqual([...bytes], [0, 1, 2, 3, 4, 255]);
});

test("text search treats special characters literally and bounds highlights", () => {
  const literal = api.findTextMatches("A.b[0] a.b[0] aXb0", "a.b[0]");
  assert.deepEqual(literal.matches, [{ start: 0, end: 6 }, { start: 7, end: 13 }]);
  const bounded = api.findTextMatches("熊熊熊", "熊", 2);
  assert.equal(bounded.matches.length, 2); assert.equal(bounded.limited, true);
  assert.deepEqual(api.findTextMatches("text", ""), { matches: [], limited: false });
});

test("base64 transports binary bytes without applying a text encoding", () => {
  const original = Buffer.from([0, 255, 128, 1, 2]);
  assert.deepEqual([...api.decodeBase64(original.toString("base64"))], [...original]);
});

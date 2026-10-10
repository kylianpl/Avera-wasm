// tests/sub-decode.test.mjs — parsers de sous-titres texte (vecteurs inline).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bytesToText, stripSrtTags, parseSrtPacket, stripAssOverrides,
  parseAssPacket, parseTx3gSample, packetToCue,
} from "../packages/sub-decode/src/index.js";

const enc = (s) => new TextEncoder().encode(s);

describe("sub-decode", () => {
  it("srt → texte, tags retirés, fins de ligne normalisées", async () => {
    assert.equal(parseSrtPacket(enc("Hello <i>world</i>")), "Hello world");
    assert.equal(parseSrtPacket(enc("Second line\r\nline two")), "Second line\nline two");
    assert.equal(parseSrtPacket(enc("<font color=\"#fff\">Hi</font>")), "Hi");
    assert.equal(bytesToText(enc("\n\nHi\n")), "Hi"); // rogne les \n extrêmes
    assert.equal(parseSrtPacket(enc("  \n ")), "  \n "); // brut fidèle (filtré par packetToCue)
    assert.equal(bytesToText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), "A"); // BOM
  });

  it("ass → 8 virgules sautées, overrides retirés, \\N converti", async () => {
    assert.equal(
      parseAssPacket(enc("0,0,Default,,0,0,0,,Hello {\\b1}bold{\\b0} world\\Nsecond line")),
      "Hello bold world\nsecond line");
    assert.equal(parseAssPacket(enc("1,0,Default,,0,0,0,,Plain line")), "Plain line");
    // Texte avec virgules : seules les 8 premières séparent.
    assert.equal(parseAssPacket(enc("0,0,Default,,0,0,0,,a, b, c")), "a, b, c");
    // Tolérant : pas d'en-tête → tout le texte.
    assert.equal(parseAssPacket(enc("sans en-tête")), "sans en-tête");
    assert.equal(stripAssOverrides("a\\h\\nb"), "a \nb");
  });

  it("tx3g → longueur u16BE, vide = null, tronqué = null", async () => {
    const hello = enc("Hello");
    const sample = new Uint8Array(2 + hello.length + 8);
    sample[0] = 0; sample[1] = hello.length;
    sample.set(hello, 2); // + boîte fictive ignorée
    assert.equal(parseTx3gSample(sample), "Hello");
    assert.equal(parseTx3gSample(new Uint8Array([0, 0])), null); // effacement
    assert.equal(parseTx3gSample(new Uint8Array([0])), null); // trop court
    assert.equal(parseTx3gSample(new Uint8Array([0, 10, 0x41])), null); // tronqué
    assert.equal(parseTx3gSample(enc("Hello <b>x</b>")), null); // pas de longueur → tronqué
  });

  it("packetToCue → bornes ns, null si vide ou durée nulle", async () => {
    assert.deepEqual(
      packetToCue({ pts: 1000000000, duration: 1500000000 }, "Hi"),
      { startNs: 1000000000, endNs: 2500000000, text: "Hi" });
    assert.equal(packetToCue({ pts: 0, duration: 0 }, "Hi"), null);
    assert.equal(packetToCue({ pts: 0, duration: 1000 }, ""), null);
    assert.equal(packetToCue({ pts: 0, duration: 1000 }, "  "), null); // blanc → null
  });
});

"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {date, language, progress, downloadable} = require("../tools/pytolino/display.js");

test("dashboard dates are German, timezone-stable and preserve unknown/invalid values", () => {
  assert.equal(date("2025-03-12"), "12.03.2025");
  assert.equal(date("2025-03-12T23:00:00-03:00"), "12.03.2025");
  assert.equal(date(1741737600000), "12.03.2025");
  assert.equal(date("2025-02-31"), "2025-02-31");
  assert.equal(date("2025"), "2025");
  assert.equal(date(null), "");
});

test("dashboard languages are readable German names without JSON syntax", () => {
  assert.equal(language(["de", "en"]), "Deutsch, Englisch");
  assert.equal(language("de-DE"), "Deutsch (Deutschland)");
  assert.equal(language(["deu", "eng"]), "Deutsch, Englisch");
  assert.equal(language([]), "");
  assert.equal(language("unknown-code"), "unknown-code");
});

test("dashboard download link is restricted to supported EPUBs", () => {
  const meta = {deliverable: [{contentFormat: "application/epub+zip"}]};
  assert.equal(downloadable({epubMetaData: meta}), true);
  assert.equal(downloadable({epubMetaData: meta, contentProtectionType: "ADOBE_DRM"}), false);
  assert.equal(downloadable({epubMetaData: {deliverable: [{contentFormat: "application/pdf"}]}}), false);
});

test("dashboard progress formats genuine zero and fractions; missing or invalid values are not zero", () => {
  assert.equal(progress(0), "0\u00a0%");
  assert.equal(progress(0.421), "42,1\u00a0%");
  assert.equal(progress(1), "100\u00a0%");
  for (const value of [null, undefined, "0.42", -0.1, 1.1, NaN, Infinity, true]) {
    assert.throws(() => progress(value), /Invalid cloud/);
  }
});

test("dashboard respects real provider protectionType, contentEncrypted and conflicting DRM flags", () => {
  const meta = {deliverable: [{contentFormat: "application/epub+zip", contentEncrypted: false}]};
  assert.equal(downloadable({epubMetaData: {...meta, protectionType: "WatermarkV1"}}), true);
  assert.equal(downloadable({epubMetaData: {...meta, protectionType: "ACS4"}}), false);
  assert.equal(downloadable({contentProtectionType: "NONE", epubMetaData: {...meta, protectionType: "ACS4"}}), false);
  for (const encrypted of [true, "false", 0]) {
    assert.equal(downloadable({epubMetaData: {deliverable: [{...meta.deliverable[0], contentEncrypted: encrypted}]}}), false);
  }
});

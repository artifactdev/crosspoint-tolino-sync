(function (root) {
  "use strict";
  const text = value => value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const languageNames = new Intl.DisplayNames(["de"], {type: "language"});
  const dateFormat = new Intl.DateTimeFormat("de-DE", {day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC"});
  function date(value) {
    if (value == null || value === "") return "";
    if (typeof value === "number" && Number.isFinite(value)) {
      const parsed = new Date(value < 1e12 ? value * 1000 : value);
      return Number.isNaN(parsed.getTime()) ? text(value) : dateFormat.format(parsed);
    }
    const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (!match) return text(value);
    const parsed = new Date(match[1] + "-" + match[2] + "-" + match[3] + "T00:00:00Z");
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[0].slice(0, 10)) return text(value);
    return dateFormat.format(parsed);
  }
  function language(value) {
    const codes = Array.isArray(value) ? value : value == null ? [] : [value];
    return codes.map(code => {
      const raw = text(code).trim();
      if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(raw)) return raw;
      return languageNames.of(raw) || raw;
    }).filter(Boolean).join(", ");
  }
  function protection(item) {
    const meta = item.epubMetaData || {}, deliverable = (meta.deliverable || [])[0] || {};
    const values = [item.contentProtectionType, meta.contentProtectionType, meta.protectionType,
      deliverable.contentProtectionType].map(value => text(value).toUpperCase());
    if (deliverable.contentEncrypted !== undefined && deliverable.contentEncrypted !== false) return "ENCRYPTED";
    return values.find(value => !["", "UNPROTECTED", "WATERMARK", "WATERMARKV1", "NONE"].includes(value))
      || values.find(Boolean) || "";
  }
  function downloadable(item) {
    const meta = item.epubMetaData || {}, deliverable = (meta.deliverable || [])[0] || {};
    return text(deliverable.contentFormat).toLowerCase() === "application/epub+zip" &&
      ["", "UNPROTECTED", "WATERMARK", "WATERMARKV1", "NONE"].includes(protection(item));
  }
  function progress(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("Invalid cloud reading progress.");
    }
    return new Intl.NumberFormat("de-DE", {style: "percent", maximumFractionDigits: 1}).format(value);
  }
  const api = {text, date, language, progress, protection, downloadable};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TolinoDisplay = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

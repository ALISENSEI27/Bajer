import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const apiRequire = createRequire(path.join(root, "artifacts/api-server/package.json"));
const uiRequire = createRequire(path.join(root, "artifacts/mockup-sandbox/package.json"));
const { buildSync } = apiRequire("esbuild");
function loadOwned(entry) {
  const filename = path.join(root, "client/src/features/scan/tests/compiled-check.cjs");
  const compiled = buildSync({
    entryPoints: [path.join(root, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    loader: { ".css": "empty" }, external: ["react", "react/jsx-runtime"],
    nodePaths: [path.join(root, "artifacts/mockup-sandbox/node_modules")],
  });
  const module = new Module(filename);
  module.filename = filename;
  module.paths = uiRequire.resolve.paths("react");
  module._compile(compiled.outputFiles[0].text, filename);
  return module.exports;
}
const storage = loadOwned("client/src/features/scan/storage.js");
const { Scan, default: DefaultScan } = loadOwned("client/src/features/scan/index.js");
const React = uiRequire("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server");
const fieldKeys = ["propertyType", "location", "price", "area", "bedrooms", "propertyAge", "ownership", "maintenanceFees"];
function report(id = "test-report") {
  const fields = Object.fromEntries(fieldKeys.map(key => [key, { status: "missing", value: null, evidence: [] }]));
  return {
    id, originalText: "شقة للبيع، التفاصيل لدى المعلن",
    analysis: { mode: "demo", notice: "وضع تجريبي", fields, contradictions: [], questions: ["ما السعر؟"], limitations: ["قراءة النص فقط"] },
    approvedFields: structuredClone(fields), approvedAt: "2026-11-14T10:00:00.000Z",
  };
}
function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), get data() { return data; } };
}
test("component compiles and server-renders accessible Arabic RTL initial state", () => {
  assert.equal(Scan, DefaultScan);
  const html = renderToStaticMarkup(React.createElement(Scan));
  assert.match(html, /class="bajer-scan" dir="rtl"/);
  assert.match(html, /نص الإعلان/);
  assert.match(html, /لا صور أو ملفات PDF/);
  assert.match(html, /<button(?=[^>]*data-testid="button-analyze")(?=[^>]*disabled)[^>]*>/);
  assert.ok(!html.includes("section-analysis-results"));
});
test("approved report survives serialization and reload with original evidence unchanged", () => {
  const store = memoryStorage();
  const r = report();
  r.analysis.fields.price = { status: "unclear", value: null, evidence: ["السعر حسب الاتفاق"] };
  r.approvedFields.price = { status: "found", value: "قيمة أدخلها المستخدم", evidence: ["السعر حسب الاتفاق"] };
  storage.saveScanReport(r, store);
  assert.deepEqual(storage.listScanReports(store), [r]);
  assert.equal(storage.listScanReports(store)[0].analysis.fields.price.value, null);
});
test("corrupt JSON and nested corrupt reports are not overwritten", () => {
  for (const raw of ["{broken", JSON.stringify({ version: 1, reports: [{ ...report(), analysis: {} }] })]) {
    const store = memoryStorage();
    store.setItem(storage.REPORTS_STORAGE_KEY, raw);
    assert.throws(() => storage.listScanReports(store), e => e.code === "corrupt");
    assert.throws(() => storage.saveScanReport(report(), store), e => e.code === "corrupt");
    assert.equal(store.getItem(storage.REPORTS_STORAGE_KEY), raw);
  }
});
test("unavailable and quota storage have actionable typed errors", () => {
  assert.throws(() => storage.listScanReports(null), e => e.code === "unavailable");
  assert.throws(() => storage.listScanReports({ getItem() { throw new Error("SecurityError"); } }), e => e.code === "unavailable");
  const store = memoryStorage();
  store.setItem = () => { const error = new Error("full"); error.name = "QuotaExceededError"; throw error; };
  assert.throws(() => storage.saveScanReport(report(), store), e => e.code === "quota");
});
test("30-report bound preserves existing data and scoped deletion frees capacity", () => {
  const store = memoryStorage();
  store.setItem("other-feature", "keep this");
  for (let i = 0; i < 30; i++) storage.saveScanReport(report(`report-${i}`), store);
  const before = store.getItem(storage.REPORTS_STORAGE_KEY);
  assert.throws(() => storage.saveScanReport(report("extra"), store), e => e.code === "limit");
  assert.equal(store.getItem(storage.REPORTS_STORAGE_KEY), before);
  storage.deleteScanReport("report-0", store);
  assert.equal(storage.listScanReports(store).length, 29);
  assert.equal(store.getItem("other-feature"), "keep this");
  storage.saveScanReport(report("extra"), store);
  assert.equal(storage.listScanReports(store).length, 30);
});
test("invalid approved status/value cannot be persisted", () => {
  const r = report();
  r.approvedFields.price = { status: "found", value: "", evidence: [] };
  assert.throws(() => storage.saveScanReport(r, memoryStorage()));
});

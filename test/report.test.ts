import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { createWorkbook } from "../src/report.ts";
import { NOW, syntheticSnapshot, syntheticManualSnapshot } from "./fixtures.ts";
import { syntheticD1Store } from "./d1-fixture.ts";

test("XLSX round-trip preserves large numeric counts, UTC date cells, source and notes", async () => {
  const row = { ...syntheticSnapshot(), scheduledAt: new Date(NOW).toISOString() };
  const bytes = await createWorkbook([row]);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(Buffer.from(bytes) as never);
  const sheet = reopened.getWorksheet("Screening counts")!;
  assert.ok(sheet);
  assert.equal(sheet.rowCount, 2);
  const expectedNumbers = [row.peopleScreened, row.bagsScreened, row.peopleAnchor, row.bagsAnchor];
  expectedNumbers.forEach((count, index) => {
    const cell = sheet.getCell(2, index + 3);
    assert.equal(cell.type, ExcelJS.ValueType.Number);
    assert.equal(cell.value, count);
    assert.equal(cell.numFmt, "#,##0");
  });
  for (const [column, expected] of [[1, row.scheduledAt], [2, row.observedAt], [7, row.peopleAnchorAt], [8, row.bagsAnchorAt]] as const) {
    const cell = sheet.getCell(2, column);
    assert.equal(cell.type, ExcelJS.ValueType.Date);
    assert.equal((cell.value as Date).toISOString(), expected);
    assert.match(cell.numFmt, /UTC/);
  }
  assert.equal(sheet.getCell("I2").value, "https://evolv.com/");
  assert.equal(sheet.getCell("J1").value, "Collection method");
  assert.equal(sheet.getCell("J2").value, "cloudflare_browser");
  assert.ok(reopened.getWorksheet("About"));
});

test("workbook refuses invalid snapshots or invalid schedule dates", async () => {
  const row = { ...syntheticSnapshot(), scheduledAt: new Date(NOW).toISOString() };
  await assert.rejects(createWorkbook([{ ...row, peopleScreened: NaN }]), /Invalid snapshot count/);
  await assert.rejects(createWorkbook([{ ...row, scheduledAt: "invalid" }]), /Invalid scheduled timestamp/);
});

test("manual baseline remains explicitly marked with blank unknown anchors throughout D1 and XLSX export", async () => {
  const row = { ...syntheticManualSnapshot(), scheduledAt: new Date(NOW).toISOString() };
  const { store } = syntheticD1Store();
  await store.insert(row);
  const stored = await store.list();
  assert.deepEqual(stored, [row]);
  const bytes = await createWorkbook(stored);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as never);
  const sheet = workbook.getWorksheet("Screening counts")!;
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell("C2").value, row.peopleScreened);
  assert.equal(sheet.getCell("D2").value, row.bagsScreened);
  for (const address of ["E2", "F2", "G2", "H2"]) {
    const cell = sheet.getCell(address);
    assert.equal(cell.value, null, `${address} must be blank, never a fabricated zero or epoch date`);
    assert.equal(cell.type, ExcelJS.ValueType.Null);
  }
  assert.equal(sheet.getCell("I2").value, "https://evolv.com/");
  assert.equal(sheet.getCell("J1").value, "Collection method");
  assert.equal(sheet.getCell("J2").value, "interactive_browser");
  assert.equal((sheet.getCell("B2").value as Date).toISOString(), row.observedAt);
});

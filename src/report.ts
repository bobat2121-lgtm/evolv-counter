import ExcelJS from "exceljs";
import { validateSnapshot, type SnapshotRow } from "./parser.ts";

export const REPORT_KEY = "evolv-screening-counts.xlsx";
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function createWorkbook(rows: SnapshotRow[]): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Evolv screening count collector";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Screening counts", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Scheduled at (UTC)", key: "scheduledAt", width: 24 },
    { header: "Observed at (UTC)", key: "observedAt", width: 24 },
    { header: "People screened — displayed", key: "peopleScreened", width: 29 },
    { header: "Bags screened — displayed", key: "bagsScreened", width: 28 },
    { header: "People — source anchor", key: "peopleAnchor", width: 25 },
    { header: "Bags — source anchor", key: "bagsAnchor", width: 24 },
    { header: "People anchor at (UTC)", key: "peopleAnchorAt", width: 24 },
    { header: "Bags anchor at (UTC)", key: "bagsAnchorAt", width: 24 },
    { header: "Source", key: "sourceUrl", width: 26 },
    { header: "Collection method", key: "collectionMethod", width: 26 },
  ];
  for (const row of rows) {
    validateSnapshot(row);
    if (!Number.isFinite(Date.parse(row.scheduledAt))) throw new Error("Invalid scheduled timestamp");
    sheet.addRow({ ...row, scheduledAt: new Date(row.scheduledAt), observedAt: new Date(row.observedAt),
      peopleAnchorAt: row.peopleAnchorAt === null ? null : new Date(row.peopleAnchorAt),
      bagsAnchorAt: row.bagsAnchorAt === null ? null : new Date(row.bagsAnchorAt),
      collectionMethod: row.collectionMethod ?? "cloudflare_browser" });
  }
  for (const column of [1, 2, 7, 8]) sheet.getColumn(column).numFmt = 'yyyy-mm-dd hh:mm:ss" UTC"';
  for (const column of [3, 4, 5, 6]) sheet.getColumn(column).numFmt = "#,##0";
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: 10 } };
  sheet.getRow(1).height = 30;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16324F" } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  const notes = workbook.addWorksheet("About");
  notes.getColumn(1).width = 110;
  notes.addRows([
    ["EVOLV HOMEPAGE SCREENING COUNTS"],
    ["Two snapshots per day, scheduled at 00:00 and 12:00 UTC."],
    ["Displayed totals are the animated numbers on https://evolv.com/, not independently verified screening records."],
    ["The homepage script inspected on 2026-09-28 advances both counters at 5 units/second from a source anchor."],
    ["cloudflare_browser rows use validated source anchors. interactive_browser rows are manually captured display readings."],
    ["Blank source anchor cells mean the source feed was not captured; they are not zeros or estimated values."],
    ["Cloudflare collection returned HTTP 403 on 2026-09-28. An interactive baseline does not prove automated collection works."],
    ["Observed at records the browser read; Scheduled at is the cron timestamp or actual manual invocation time."],
    ["Failed reads do not add zeros or reuse cached markup. D1 stores history; Excel is generated on download."],
    ["All worksheet dates are UTC. Counts are numeric Excel cells."],
  ]);
  notes.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF16324F" } };
  notes.eachRow((row) => { row.alignment = { wrapText: true, vertical: "top" }; row.height = 32; });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

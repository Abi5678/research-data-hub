import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { worksheetToTable } = require("../electron/excel-table.cjs");

async function parseFile(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((ws) => ({ name: ws.name, table: worksheetToTable(ws) }));
}

describe("excel-table header detection", () => {
  it("skips empty row 1 and reads a title-block compilation sheet", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("results");
    ws.getCell("B2").value = "PROJECT";
    ws.getCell("D2").value = "AMPT NHDOT LOAN";
    ws.getCell("B3").value = "FIELD PROJECT";
    ws.getCell("D3").value = "NH";
    ws.mergeCells("B12:C12");
    ws.getCell("B12").value = "Mixes Details";
    ws.getCell("D12").value = "Specimens Details";
    ws.getCell("E12").value = "Specimens Details";
    ws.getCell("F12").value = "DCT Testing Results";
    ws.mergeCells("B13:C14");
    ws.getCell("B13").value = "Mix ID";
    ws.getCell("D13").value = "Specimen ID";
    ws.getCell("E13").value = "Air Voids %";
    ws.getCell("F13").value = "Fracture Energy (Gf)";
    ws.getCell("D14").value = "Specimen ID";
    ws.getCell("E14").value = "Air Voids %";
    ws.getCell("F14").value = "Fracture Energy (Gf)";
    ws.getCell("B15").value = "BL";
    ws.getCell("D15").value = "BL#2-1";
    ws.getCell("E15").value = 4.1;
    ws.getCell("F15").value = 787.42;
    ws.getCell("D16").value = "BL#4-1";
    ws.getCell("F16").value = 787.3;

    const tmp = path.join(os.tmpdir(), `rdh-dct-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(tmp);
    try {
      const sheets = await parseFile(tmp);
      expect(sheets).toHaveLength(1);
      const table = sheets[0].table;
      expect(table).toBeTruthy();
      expect(table.rows.length).toBe(2);
      expect(table.headers.some((h) => /mix id/i.test(h))).toBe(true);
      expect(table.headers.some((h) => /specimen/i.test(h))).toBe(true);
      expect(table.rows[0]["Mixes Details Mix ID"] || table.rows[0][table.headers[0]]).toBeTruthy();
      // Mix ID forward-filled onto the second specimen row
      const mixCol = table.headers.find((h) => /mix id/i.test(h));
      expect(table.rows[1][mixCol]).toBe("BL");
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("still parses a simple A1-header sheet", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("simple");
    ws.getCell("A1").value = "sample_id";
    ws.getCell("B1").value = "air_voids";
    ws.getCell("A2").value = "6001";
    ws.getCell("B2").value = 4.2;
    const tmp = path.join(os.tmpdir(), `rdh-simple-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(tmp);
    try {
      const [sheet] = await parseFile(tmp);
      expect(sheet.table.headers).toEqual(["sample_id", "air_voids"]);
      expect(sheet.table.rows).toEqual([{ sample_id: "6001", air_voids: "4.2" }]);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

"use strict";

// Shared worksheet ? table extraction. Lab compilation workbooks often have
// title/metadata rows, merged two-row headers, and data that starts at column B
// rather than A1. Assuming "row 1 is headers" silently drops those sheets.

const HEADER_SCAN = 40;
const MAX_HEADER_ROWS = 3;

function cellToString(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellToString(value.result);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join("");
    }
    if ("hyperlink" in value && value.hyperlink) {
      return cellToString(value.text ?? value.hyperlink);
    }
    return "";
  }
  return String(value);
}

function isNumericish(t) {
  const s = String(t).trim().replace(/[%$,]/g, "");
  if (s === "") return false;
  const n = Number(s);
  return Number.isFinite(n);
}

function dedupeHeaders(rawHeaders) {
  // Counting occurrences per name is not enough: headers ['a','a','a_2'] made
  // the second `a` into `a_2`, colliding with the real third column. Rows are
  // keyed by header, so that column's data was silently overwritten. Probe for
  // a suffix nothing has taken yet instead.
  const used = new Set();
  return rawHeaders.map((h) => {
    if (!used.has(h)) {
      used.add(h);
      return h;
    }
    let n = 2;
    while (used.has(`${h}_${n}`)) n += 1;
    const name = `${h}_${n}`;
    used.add(name);
    return name;
  });
}

function usedCols(ws) {
  let min = Infinity;
  let max = 0;
  const last = Math.min(ws.rowCount || 1, Math.max(HEADER_SCAN, 80));
  for (let r = 1; r <= last; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      if (cellToString(cell.value).trim() === "") return;
      if (col < min) min = col;
      if (col > max) max = col;
    });
  }
  if (!Number.isFinite(min)) return { c0: 1, c1: 1 };
  return { c0: min, c1: max };
}

function rowStats(ws, r, c0, c1) {
  let filled = 0;
  let numeric = 0;
  for (let c = c0; c <= c1; c++) {
    const t = cellToString(ws.getRow(r).getCell(c).value).trim();
    if (!t) continue;
    filled += 1;
    if (isNumericish(t)) numeric += 1;
  }
  return { r, filled, numeric, text: filled - numeric };
}

function findHeaderBlock(ws, c0, c1) {
  const width = c1 - c0 + 1;
  const minFilled = Math.max(2, Math.ceil(width * 0.35));
  const scan = Math.min(ws.rowCount || 1, HEADER_SCAN);
  const stats = [];
  for (let r = 1; r <= scan; r++) stats.push(rowStats(ws, r, c0, c1));

  const headerLike = (s) =>
    s.filled >= minFilled && s.numeric / Math.max(s.filled, 1) < 0.45;

  let best = null;
  for (let i = 0; i < stats.length; i++) {
    if (!headerLike(stats[i])) continue;
    let j = i;
    while (
      j + 1 < stats.length &&
      headerLike(stats[j + 1]) &&
      j - i + 1 < MAX_HEADER_ROWS
    ) {
      j += 1;
    }
    const after = stats[j + 1];
    const followedByData = Boolean(after && after.filled >= 2 && after.numeric > 0);
    const score =
      stats[i].filled * 10 +
      (j - i) * 3 +
      (followedByData ? 80 : 0) +
      stats[i].r * 0.01;
    if (!best || score > best.score) {
      best = { start: stats[i].r, end: stats[j].r, score };
    }
    i = j;
  }
  return best;
}

function combineHeaderRows(ws, start, end, c0, c1) {
  const headers = [];
  for (let c = c0; c <= c1; c++) {
    const parts = [];
    for (let r = start; r <= end; r++) {
      const v = cellToString(ws.getRow(r).getCell(c).value).trim();
      if (v && parts[parts.length - 1] !== v) parts.push(v);
    }
    headers.push(parts.join(" ") || `column_${c}`);
  }
  return dedupeHeaders(headers);
}

function forwardFillCategorical(rows, headers) {
  for (const h of headers) {
    const nonempty = rows.map((r) => r[h]).filter((v) => String(v ?? "").trim() !== "");
    if (nonempty.length === 0) continue;
    const numeric = nonempty.filter(isNumericish).length;
    if (numeric / nonempty.length >= 0.5) continue;
    let prev = "";
    for (const row of rows) {
      const cur = String(row[h] ?? "").trim();
      if (cur) prev = cur;
      else if (prev) row[h] = prev;
    }
  }
}

/**
 * Extract a rectangular table from a worksheet. Returns null when no usable
 * header + data block is found (title-only or empty sheets).
 */
function worksheetToTable(ws) {
  const rowCount = ws.rowCount || 0;
  if (rowCount < 2) return null;
  const { c0, c1 } = usedCols(ws);
  const block = findHeaderBlock(ws, c0, c1);
  if (!block) return null;

  const headers = combineHeaderRows(ws, block.start, block.end, c0, c1);
  if (headers.every((h) => /^column_\d+$/.test(h))) return null;

  const rows = [];
  const last = ws.rowCount || block.end + 1;
  for (let r = block.end + 1; r <= last; r++) {
    const obj = {};
    let hasValue = false;
    headers.forEach((h, i) => {
      const v = cellToString(ws.getRow(r).getCell(c0 + i).value).trim();
      if (v !== "") hasValue = true;
      obj[h] = v;
    });
    if (hasValue) rows.push(obj);
  }
  if (rows.length === 0) return null;
  forwardFillCategorical(rows, headers);

  const keep = headers.filter((h) => rows.some((r) => String(r[h] ?? "").trim() !== ""));
  if (keep.length === 0) return null;
  const trimmed =
    keep.length === headers.length
      ? rows
      : rows.map((r) => {
          const o = {};
          for (const h of keep) o[h] = r[h];
          return o;
        });

  return {
    headers: keep,
    rows: trimmed,
    headerRow: block.start,
    headerRowEnd: block.end,
  };
}

module.exports = {
  cellToString,
  dedupeHeaders,
  worksheetToTable,
  findHeaderBlock,
  usedCols,
};

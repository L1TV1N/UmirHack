// Ячейка, начинающаяся с этих символов, в Excel и LibreOffice исполняется как формула
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'number') {
    // для русской локали Excel десятичный разделитель запятая
    text = Number.isFinite(value) ? String(value).replace('.', ',') : '';
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else {
    text = String(value);
    if (FORMULA_START.test(text)) text = `'${text}`;
  }
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Разделитель точка с запятой и BOM, чтобы русский Excel открыл файл без мастера импорта. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

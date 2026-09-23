import type { RegistrationAnswer, RegistrationForm, RegistrationSubmission } from "./registration-types";

const encoder = new TextEncoder();

function xml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function answerText(answer: RegistrationAnswer | undefined) {
  if (Array.isArray(answer)) return answer.join("、");
  if (typeof answer === "boolean") return answer ? "是" : "否";
  return answer === null || answer === undefined ? "" : String(answer);
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function worksheet(form: RegistrationForm, submissions: RegistrationSubmission[]) {
  const paymentLabels = { unpaid: "未對帳", checking: "待確認", paid: "已對帳", refunded: "已退款", not_required: "無需付款" } as const;
  const headers = ["提交編號", "狀態", "提交時間", "同意隱私告知", "對帳狀態", "對帳註記", "活動前 5 天提醒", "活動前 1 天提醒", ...form.fields.map((field) => field.label)];
  const rows = [
    headers,
    ...submissions.map((submission) => [
      submission.id,
      submission.status,
      submission.submittedAt,
      submission.consent ? "是" : "否",
      paymentLabels[submission.paymentStatus ?? "unpaid"],
      submission.paymentNote ?? "",
      submission.reminderFiveDaysSentAt ?? "尚未寄送",
      submission.reminderOneDaySentAt ?? "尚未寄送",
      ...form.fields.map((field) => answerText(submission.answers[field.id])),
    ]),
  ];
  const sheetData = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map((cell, columnIndex) => {
            const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
            return `<c r="${reference}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(cell)}</t></is></c>`;
          })
          .join("")}</row>`,
    )
    .join("");
  const finalColumn = columnName(Math.max(0, headers.length - 1));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${finalColumn}${Math.max(1, rows.length)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${headers.map((header, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.min(50, Math.max(12, header.length * 2 + 4))}" customWidth="1"/>`).join("")}</cols><sheetData>${sheetData}</sheetData><autoFilter ref="A1:${finalColumn}${Math.max(1, rows.length)}"/></worksheet>`;
}

type ZipEntry = { name: string; bytes: Uint8Array; crc: number; offset: number };

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function join(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function zip(files: Array<[string, string]>) {
  const localParts: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const bytes = encoder.encode(content);
    const crc = crc32(bytes);
    const header = join([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(bytes.length), u32(bytes.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    localParts.push(header, bytes);
    entries.push({ name, bytes, crc, offset });
    offset += header.length + bytes.length;
  }
  const centralParts = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    return join([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(entry.crc), u32(entry.bytes.length), u32(entry.bytes.length), u16(nameBytes.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(entry.offset), nameBytes,
    ]);
  });
  const central = join(centralParts);
  const end = join([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return join([...localParts, central, end]);
}

function workbookFiles(form: RegistrationForm, submissions: RegistrationSubmission[]): Array<[string, string]> {
  return [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="報名名單" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`],
    ["xl/worksheets/sheet1.xml", worksheet(form, submissions)],
  ];
}

export function buildRegistrationsXlsx(form: RegistrationForm, submissions: RegistrationSubmission[]) {
  const bytes = zip(workbookFiles(form, submissions));
  return new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function exportRegistrationsXlsx(
  form: RegistrationForm,
  submissions: RegistrationSubmission[],
  filename = `${form.title || "報名名單"}.xlsx`,
) {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("Excel 匯出只能在瀏覽器中執行");
  }
  const blob = buildRegistrationsXlsx(form, submissions);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-").slice(0, 180) || "報名名單.xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function downloadRegistrationXlsx(
  form: RegistrationForm,
  submissions: RegistrationSubmission[],
  activityName: string,
) {
  const prefix = activityName.trim() || "活動";
  exportRegistrationsXlsx(form, submissions, `${prefix}-${form.title || "報名名單"}.xlsx`);
}

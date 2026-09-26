import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export async function attendanceWorkbook({ offering, rows, threshold }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AttenDesk";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Attendance Report", { views: [{ state: "frozen", ySplit: 4 }] });

  sheet.mergeCells("A1:F1");
  sheet.getCell("A1").value = "ATTENDESK ATTENDANCE REPORT";
  sheet.getCell("A1").font = { bold: true, size: 18, color: { argb: "FF0B5F48" } };
  sheet.getCell("A2").value = "Subject";
  sheet.getCell("B2").value = `${offering.subject_name} (${offering.subject_code})`;
  sheet.getCell("D2").value = "Section";
  sheet.getCell("E2").value = `${offering.branch_name} · ${offering.section_name}`;
  sheet.getCell("A3").value = "Generated";
  sheet.getCell("B3").value = new Date();
  sheet.getCell("D3").value = "Threshold";
  sheet.getCell("E3").value = `${threshold}%${offering.date_from || offering.date_to ? ` · ${offering.date_from || 'Start'} to ${offering.date_to || 'Today'}` : ''}`;

  sheet.getRow(4).values = ["Roll number", "Student", "Attended", "Conducted", "Percentage", "Status"];
  sheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF081513" } };
  rows.forEach((row) => {
    const excelRow = sheet.addRow([row.roll_number, row.full_name, row.attended, row.conducted, Number(row.percentage), row.below_threshold ? "Below threshold" : "On track"]);
    excelRow.getCell(5).numFmt = '0.0"%"';
    if (row.below_threshold) excelRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1E7" } };
  });
  sheet.columns = [
    { width: 17 }, { width: 28 }, { width: 13 }, { width: 13 }, { width: 15 }, { width: 20 }
  ];
  sheet.autoFilter = { from: "A4", to: "F4" };
  return workbook.xlsx.writeBuffer();
}

export async function attendancePdf({ offering, rows, threshold }) {
  const doc = new PDFDocument({ size: "A4", margin: 42, info: { Title: "AttenDesk Attendance Report", Author: "AttenDesk" } });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.fillColor("#087c5a").fontSize(10).font("Helvetica-Bold").text("ATTENDESK", { characterSpacing: 2 });
  doc.fillColor("#10201d").fontSize(23).text("Attendance Report", { characterSpacing: -0.5 });
  doc.moveDown(0.35).fillColor("#71807b").fontSize(10).font("Helvetica")
    .text(`${offering.subject_name} (${offering.subject_code}) · ${offering.branch_name} · Section ${offering.section_name}`);
  doc.text(`Generated ${new Date().toLocaleString("en-IN")} · Defaulter threshold ${threshold}%`);
  if (offering.date_from || offering.date_to) doc.text(`Report period: ${offering.date_from || 'Beginning'} to ${offering.date_to || 'Today'}`);
  doc.moveDown(1.2);

  const x = [42, 118, 296, 358, 420, 485];
  const widths = [70, 172, 56, 56, 59, 68];
  const headers = ["Roll", "Student", "Present", "Classes", "%", "Status"];
  const rowHeight = 25;
  let y = doc.y;

  const drawHeader = () => {
    doc.rect(42, y, 510, rowHeight).fill("#081513");
    headers.forEach((header, index) => doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8).text(header, x[index] + 5, y + 8, { width: widths[index] - 8 }));
    y += rowHeight;
  };
  drawHeader();
  rows.forEach((row, rowIndex) => {
    if (y > 760) {
      doc.addPage();
      y = 42;
      drawHeader();
    }
    doc.rect(42, y, 510, rowHeight).fill(row.below_threshold ? "#fff2e8" : rowIndex % 2 ? "#f6f8f6" : "#ffffff");
    const values = [row.roll_number, row.full_name, row.attended, row.conducted, `${row.percentage}%`, row.below_threshold ? "Below" : "On track"];
    values.forEach((value, index) => doc.fillColor(row.below_threshold && index === 5 ? "#b25c30" : "#10201d").font(index === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(8).text(String(value), x[index] + 5, y + 8, { width: widths[index] - 8, ellipsis: true }));
    y += rowHeight;
  });
  doc.end();
  return completed;
}

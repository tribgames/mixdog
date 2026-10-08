// Deterministic PDF fixtures shared by the read and MCP media tests.
export function makePdf(pageCount) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`);
  objs.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pageCount; i += 1) {
    const stream = `BT /F1 12 Tf 10 10 Td (Page ${i + 1}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function makeEncryptedPdf() {
  const hex = 'ab'.repeat(32);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${hex}> /U <${hex}> /P -4 >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, n) => {
    offsets.push(out.length);
    out += `${n + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += 'xref\n0 5\n0000000000 65535 f \n';
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<${'cd'.repeat(16)}> <${'cd'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}


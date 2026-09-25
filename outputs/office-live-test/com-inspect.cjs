// Reads back what Word and Excel saved for the parity check.
const J = require('jszip');
const fs = require('fs');
(async () => {
  console.log(fs.readdirSync('outputs/office-live-test/com').join(' '));
  const z = await J.loadAsync(fs.readFileSync('outputs/office-live-test/com/letter.docx'));
  for (const h of Object.keys(z.files).filter((n) => /header\d*\.xml$/.test(n))) {
    const x = await z.file(h).async('string');
    if (x.includes('모아페이')) console.log(h, (x.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0], (x.match(/<w:jc [^>]*>/) || [''])[0]);
  }
  const d = await z.file('word/document.xml').async('string');
  const t = d.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)[0];
  console.log('keepNext', (t.match(/<w:keepNext\/>/g) || []).length);
  const s = await J.loadAsync(fs.readFileSync('outputs/office-live-test/com/sized.xlsx'));
  const x = await s.file('xl/worksheets/sheet1.xml').async('string');
  console.log(x.match(/<cols>.*?<\/cols>/)[0]);
  console.log(x.match(/<row r="1"[^>]*>/)[0]);
})();

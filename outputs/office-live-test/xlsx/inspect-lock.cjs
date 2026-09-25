// Which xf the entry cells carry and whether it unlocks them.
const JSZip = require('jszip');
const fs = require('fs');
(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(process.argv[2]));
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const styles = await zip.file('xl/styles.xml').async('string');
  const xfs = [...(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || '').matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
  for (const ref of ['A6', 'B6', 'B10', 'C6', 'F6']) {
    const cell = new RegExp(`<c r="${ref}"[^>]*>`).exec(sheet)?.[0] || `(no ${ref})`;
    const s = Number(/\bs="(\d+)"/.exec(cell)?.[1] ?? -1);
    console.log(ref, cell, s >= 0 ? xfs[s] : '');
  }
})();

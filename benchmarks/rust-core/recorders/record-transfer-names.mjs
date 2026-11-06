import { writeFileSync } from 'node:fs';
const { sanitizedFileName } = await import('../../../apps/desktop/src/main/ipc-validation.ts');
const { localFileMimeTypeForPath } = await import('../../../apps/desktop/src/shared/local-files.ts');
const names = ['report.pdf', '.hidden.png', 'a.', '.png', 'a/b\\c:d*.txt', '  ..--x.md. ', '...', '', 'con<>.txt', 'x'.repeat(130) + '.png', 'é'.repeat(118) + '😀tail', '\u00a0\ufeffname\u3000', 'tab\tname.TXT', 'a\u0085b', 'dir.d/file', 'archive.tar.GZ', '-.-', 'x'.repeat(118) + '.. .'];
const sanitize = names.map((input) => ({ input, name: sanitizedFileName(input) }));
const mime = ['.png', '.hidden.png', 'a.', 'a.PNG', 'dir.png/noext', 'C:\\x\\y.JPG', 'a.b.md', 'noext', 'x.unknown', '.gitignore'].map((input) => ({ input, mime: localFileMimeTypeForPath(input) }));
writeFileSync('native/core/fixtures/desktop/transfer/names.json', JSON.stringify({ sanitize, mime }, null, 1) + '\n');
console.log(sanitize.length, mime.length);



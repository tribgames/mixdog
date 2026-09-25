// Prints the dictionary keys (and /TU) of the first form fields of a PDF: node pdf-field-keys.mjs <file.pdf> [count]
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';

const [file, count = 3] = process.argv.slice(2);
const document = await PDFDocument.load(readFileSync(file), { ignoreEncryption: true });
for (const field of document.getForm().getFields().slice(0, Number(count))) {
  const dict = field.acroField.dict;
  const kids = field.acroField.getWidgets().map((widget) => [...widget.dict.keys()].map(String).join(' '));
  console.log(field.getName(), '|', [...dict.keys()].map(String).join(' '), '| TU:', String(dict.lookup(PDFName.of('TU')) ?? ''), '| widget:', kids.join(' / '));
}

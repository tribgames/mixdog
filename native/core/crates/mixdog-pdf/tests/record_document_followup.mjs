// Original pdf.js 6.4.299 oracle. No runtime Node dependency is introduced.
// node record_document_followup.mjs <original node_modules> <pdf-codec fixture directory>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const modules = resolve(process.argv[2]);
const pdfjsPath = join(modules, 'pdfjs-dist/legacy/build/pdf.mjs');
const workerPath = join(modules, 'pdfjs-dist/legacy/build/pdf.worker.mjs');
const pdfjs = await import(pathToFileURL(pdfjsPath));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function pdf(objects, trailer='') {
  let body = '%PDF-1.7\n', offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${i+1} 0 obj\n${objects[i]}\nendobj\n`; }
  const offset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for (const off of offsets.slice(1)) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R ${trailer} >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const cases=[];
for (const rotate of ['90','(90)','[90]','[[90]]','(  )','[]','[null]','(-90)','(450)','(bad)','false','/N','[4 0 R]','<< /x 90 >>']) {
 cases.push({name:'rotate '+rotate, bytes:pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Rotate ${rotate} >>`,'90'])});
}
const encryptedPath=join(resolve(process.argv[3]), 'files/encrypted-aesv2-user-password.pdf');
const encrypted=readFileSync(encryptedPath);
const text=encrypted.toString('latin1');
const objects=[...text.matchAll(/\d+ 0 obj\r?\n([\s\S]*?)\r?\nendobj/g)].map(m=>m[1]);
const trailer='/Encrypt 6 0 R /ID [<5c6a9d1e2b3f40718293a4b5c6d7e8f9> <5c6a9d1e2b3f40718293a4b5c6d7e8f9>]';
for (const [name, mutate, content] of [
 ['same-object default cache collision', a=>{a[5]=a[5].replace('/StrF /StdCF','/StrF /__default__').replace('/StmF /StdCF','/StmF (StdCF)'); const clear='BT /F1 12 Tf 20 20 Td (Plain) Tj ET'; a[3]=`<< /S1 (one) /S2 (two) /Length ${clear.length} >>\nstream\n${clear}\nendstream`;},true],
 ['constructor cache is isolated between objects', a=>{a[5]=a[5].replace('/StrF /StdCF','/StrF /__default__').replace('/StmF /StdCF','/StmF (StdCF)');a[2]=a[2].replace('/Type /Page','/Type /Page /X (prime-other-object)');},true],
 ['consecutive encrypted strings and stream', a=>{const raw=a[3].slice(a[3].indexOf('stream\n')+7,a[3].lastIndexOf('\nendstream')); const hex=Buffer.from(raw,'latin1').toString('hex'); a[3]=a[3].replace('<<',`<< /S1 <${hex}> /S2 <${hex}>`);},true],
 ['CF false stays lazy until string', a=>{a[5]=a[5].replace('/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >>','/CF false');a[2]=a[2].replace('/Type /Page','/X (123456)');},false],
 ['CF null stays lazy until string', a=>{a[5]=a[5].replace('/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >>','/CF null');a[2]=a[2].replace('/Type /Page','/X (123456)');},false],
 ['CF missing stays lazy until string', a=>{a[5]=a[5].replace('/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >>','');a[2]=a[2].replace('/Type /Page','/X (123456)');},false],
 ['CF false unused', a=>{a[5]=a[5].replace('/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >>','/CF false');},false],
 ['invalid EFF ordinary stream', a=>{a[5]=a[5].replace('/StmF /StdCF','/StmF /StdCF /EFF (bad)');},true],
 ['invalid EFF EmbeddedFile', a=>{a[5]=a[5].replace('/StmF /StdCF','/StmF /StdCF /EFF (bad)');a[3]=a[3].replace('<<','<< /Type /EmbeddedFile');},true],
 ['unused malformed CF stays lazy', a=>{a[5]=a[5].replace('/CF <<','/CF << /Unused 7 0 R'); a.push('<< /Broken [');},false],
 ['selected non-dict CF stays lazy', a=>{a[5]=a[5].replace('/StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >>','/StdCF false'); a[2]=a[2].replace('/Type /Page','/X (123456)');},false],
 ['unknown method string', a=>{a[5]=a[5].replace('/AESV2','/Unknown'); a[2]=a[2].replace('/Type /Page','/X (123456)');},false],
 ['invalid string selector', a=>{a[5]=a[5].replace('/StrF /StdCF','/StrF (StdCF)'); a[2]=a[2].replace('/Type /Page','/X (123456)');},false],
 ['unknown method unused', a=>{a[5]=a[5].replace('/AESV2','/Unknown');},false],
 ['invalid stream selector', a=>{a[5]=a[5].replace('/StmF /StdCF','/StmF (StdCF)');},true],
 ['embedded file selector', a=>{a[5]=a[5].replace('/StmF /StdCF','/StmF /Identity /EFF /StdCF'); a[3]=a[3].replace('<<','<< /Type /EmbeddedFile');},true],
 ['explicit crypt unknown method becomes empty', a=>{a[5]=a[5].replace('/AESV2','/Unknown'); a[3]='<< /Length 3 /Filter /Crypt /DecodeParms << /Name /StdCF >> >>\nstream\nabc\nendstream';},true],
 ['explicit crypt non-name is identity', a=>{a[5]=a[5].replace('/StmF /StdCF','/StmF (StdCF)'); const clear='BT /F1 12 Tf 20 20 Td (Plain) Tj ET'; a[3]=`<< /Length ${clear.length} /Filter /Crypt /DecodeParms << /Name 12 >> >>\nstream\n${clear}\nendstream`;},true],
 ['explicit crypt invalid selector defaults identity', a=>{a[5]=a[5].replace('/StmF /StdCF','/StmF (StdCF)'); a[3]='<< /Length 0 /Filter /Crypt /DecodeParms << /Name 12 >> >>\nstream\n\nendstream';},true],
]) { const a=objects.slice(); mutate(a); cases.push({name,bytes:pdf(a,trailer),password:'open sesame',content}); }
for (const [name, cf] of [
 ['no-password invalid EFF does not select empty Name', '/CF << / false >>'],
 ['no-password invalid EFF non-dictionary CF', '/CF false'],
 ['no-password invalid EFF null CF', '/CF null'],
 ['no-password invalid EFF missing CF', ''],
]) {
 const a=objects.slice();
 a[5]=a[5].replace('/StmF /StdCF','/StmF /Identity /EFF (bad)').replace('/StrF /StdCF','/StrF /Identity').replace('/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >>',cf);
 cases.push({name,bytes:pdf(a,trailer),content:false});
}
for (const [name, eff, cf] of [
 ['no-password empty Name EFF selects empty CF Name', '/', '/CF << / false >>'],
 ['no-password named EFF selects non-dictionary handler', '/StdCF', '/CF << /StdCF false >>'],
]) {
 const a=objects.slice();
 a[5]=a[5].replace('/StmF /StdCF',`/StmF /Identity /EFF ${eff}`).replace('/StrF /StdCF','/StrF /Identity').replace('/CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >>',cf);
 cases.push({name,bytes:pdf(a,trailer),content:false});
}
const output=[];
for (const c of cases) {
 const row={name:c.name,hex:c.bytes.toString('hex'),password:c.password??null,content:!!c.content};
 let task,doc;
 try {
  task=pdfjs.getDocument({data:new Uint8Array(c.bytes),password:c.password,verbosity:0,disableFontFace:true,useSystemFonts:true});
  doc=await task.promise; row.open=true; row.numPages=doc.numPages;
  const page=await doc.getPage(1); row.page=true;
  const v=page.getViewport({scale:1}); row.rotate=page.rotate; row.viewport={rotation:v.rotation,width:v.width,height:v.height,transform:v.transform};
  if(c.content) { const result=await page.getTextContent(); row.text=result.items.map(x=>x.str).join(''); }
 } catch(e) { row.error={name:e.name,message:e.message,code:e.code??null}; }
 finally { if(task) await task.destroy(); }
 output.push(row);
}
writeFileSync(new URL('./document_followup.json',import.meta.url),JSON.stringify({node:process.version,pdfjs:pdfjs.version,pdfjsSha256:hash(readFileSync(pdfjsPath)),workerSha256:hash(readFileSync(workerPath)),encryptedSha256:hash(encrypted),recorderSha256:hash(readFileSync(new URL(import.meta.url))),cases:output},null,2)+'\n');
console.log(JSON.stringify(output.map(({name,hex,...rest})=>({name,...rest})),null,2));

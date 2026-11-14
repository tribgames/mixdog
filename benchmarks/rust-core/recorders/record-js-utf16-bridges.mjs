// Direct bounded Node reference. Raw strings cross JSON only as UTF-16 arrays.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const argv=process.argv.slice(2),root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const tree=resolve(argv.includes('--tree')?argv[argv.indexOf('--tree')+1]:'C:/Project/mixdog');
const formula=await import(pathToFileURL(resolve(tree,'node_modules/@formulajs/formulajs/lib/esm/index.mjs')));
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const raw=a=>String.fromCharCode(...a);
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex')};
const high=raw([0xd800]),high2=raw([0xd801]),low=raw([0xdc00]),replacement=raw([0xfffd]),emoji=raw([0xd83d,0xde00]);
const subjects=['','a','A','\n','\r','\u2028','\0',emoji,high,high2,low,high+low,low+high,replacement,'a'+high,'a'+emoji,high+replacement,'xx'+high+'yy','a\nb','xZ','u{D800}','u'.repeat(41),'p{Surrogate}',raw([0xd801,0xdc28])];
const patterns=['','^.$','^..$','.', '^'+emoji+'$', '^'+emoji+'+$', '^['+emoji+']$',
 '^'+high+'$','^'+low+'$','['+high+'-'+high2+']','['+high2+'-'+high+']',
 String.raw`^\uD800\uDC00$`,String.raw`^\u{10000}$`,String.raw`^\u{D800}$`,String.raw`^\uD800$`,String.raw`^\uDC00$`,
 '^'+high+String.raw`\uDC00$`,String.raw`^\uD800`+low+'$','\\'+high,'['+high+']',
 String.raw`^\p{Surrogate}$`,String.raw`^\P{Surrogate}$`,String.raw`^\p{Any}$`,String.raw`[\xZ]`,String.raw`\u{41}`,
 '[&^]',String.raw`[\b-a]`,'(',high+'(', '[', String.raw`[\uD800-\uD7FF]`,
 '(?<'+high+'>a)', '(?<'+emoji+'>a)', String.raw`(a)\1`, '(?='+high+')'+high, '^'+raw([0xd801,0xdc00])+'$'];
const regex=[];
for(const pattern of patterns)for(const flags of ['','u','v','i','iu','uy','g','y','m','s','d'])for(const text of subjects){
 let outcome;try{outcome={matched:vm.runInNewContext('run()',{run:()=>new RegExp(pattern,flags).test(text)},{timeout:100})};}
 catch(error){if(error.code==='ERR_SCRIPT_EXECUTION_TIMEOUT')throw error;outcome={error:error.message.toWellFormed(),errorUnits:units(error.message)};}
 regex.push({pattern:units(pattern),text:units(text),flags,...outcome});
}
for(const flags of ['uu','uv','z','gg']){let error;try{new RegExp(high+'(',flags);}catch(e){error=e.message;}regex.push({pattern:units(high+'('),text:[],flags,error:error.toWellFormed(),errorUnits:units(error)});}
const boundary=[0xd7ff,0xd800,0xd801,0xdbff,0xdc00,0xdc01,0xdfff,0xe000,0xf8ff,0xfffd,0xffff];
const strings=['','a','A','\u00e1','a\u0301','a\u0327\u0301','\u00e1\u0327','b','ch','cz','d','dzs','e','\ud55c',emoji,raw([0xd800,0xdc00]),raw([0xdbff,0xdfff]),raw([0xd800,0xd800,0xdc00]),raw([0xdc00,0xd800,0xdc00]),raw([0xd800,0xd801]),raw([0xdc00,0xdfff]),raw([0xdc00,0xd800]),raw([0xdb80,0xdc00]),...boundary.map(u=>raw([u]))];
for(const u of [high,high2,low,replacement,'\ue000']){
 strings.push('c'+u+'h','c'+u+'z','d'+u+'a','a'+u+'\u0301','\u00e1'+u,
   'a\u0327\u0301'+u+'e\u0301','\u00e1\u0327'+u+'\u00e9',
   'cot\u00e9'+u+'cote'+u+'c\u00f4te','cote'+u+'cot\u00e9'+u+'cote',
   'c\u00f4te'+u+'cote'+u+'cot\u00e9','A'+u+'a','a'+u+'A',
   'I'+u+'\u0301','I\u0301'+u,'i\u0307'+u+'\u0301',u+'\u0301\u0327',u+'\u0327\u0301');
}
const collations=[];
for(const locale of ['', 'en', 'ko', 'cs', 'es-u-co-trad', 'hu', 'lt', 'fr-CA']){
 const collator=new Intl.Collator(locale||undefined),pairs=[];
 for(const a of strings)for(const b of strings)pairs.push([units(a),units(b),Math.sign(collator.compare(a,b))]);
 collations.push({locale,resolved:collator.resolvedOptions(),pairs});
}
const dateStrings=['2024-01-01','Jan 1 2024','May 6, 2024','2024-03-10T02:30:00','2024-11-03T01:30:00'];
for(const u of [high,high2,low,high+low,replacement]){
 dateStrings.push(u+' Jan 1 2024','Jan'+u+' 1 2024','Jan '+u+' 1 2024','Jan 1 2024'+u,
  '('+u+') Jan 1 2024','Jan 1 ('+u+') 2024','Jan 1 2024 ('+u+')','Jan 1 2024 (x('+u+')y)',
  '2024-01-01'+u,'2024-01-01\0'+u,u+'2024-01-01', 'Mon, 06 May 2024 10:00:00 GMT ('+u+')');
}
const dates=[];
for(const zone of ['UTC','America/New_York','Asia/Seoul']){
 process.env.TZ=zone;
 for(const text of dateStrings){
  const parsed=Date.parse(text);let projected;
  try{const value=formula.DATEVALUE(text);projected=value instanceof Date?{dateBits:bits(value.getTime())}:{error:value.message};}
  catch(e){projected={threw:e.message};}
  dates.push({text:units(text),zone,bits:bits(parsed),dateValue:projected});
 }
}
const golden={version:1,node:process.version,v8:process.versions.v8,icu:process.versions.icu,cldr:process.versions.cldr,unicode:process.versions.unicode,defaultLocale:new Intl.Collator().resolvedOptions().locale,
 regex,collations,dates,contracts:{errors:'Only final diagnostic String is well-formed; raw errorUnits remain evidence.',collation:'Unpaired surrogates retain original implicit weights; no sentinel substitution.'}};
const bytes=JSON.stringify(golden)+'\n',hash=b=>createHash('sha256').update(b).digest('hex');
const manifest={version:1,set:'js-utf16-bridges',recorder:'benchmarks/rust-core/recorders/record-js-utf16-bridges.mjs',oracle:{node:golden.node,v8:golden.v8,icu:golden.icu,cldr:golden.cldr,unicode:golden.unicode,defaultLocale:golden.defaultLocale},regexCases:regex.length,collationPairs:collations.reduce((n,x)=>n+x.pairs.length,0),dateCases:dates.length,files:[{path:'golden.json',sha256:hash(bytes),bytes:Buffer.byteLength(bytes)}]};
if(argv.includes('--write')){const out=resolve(root,'native/core/fixtures/js-utf16-bridges');await mkdir(out,{recursive:true});await writeFile(resolve(out,'golden.json'),bytes);await writeFile(resolve(out,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));}else process.stdout.write(bytes);

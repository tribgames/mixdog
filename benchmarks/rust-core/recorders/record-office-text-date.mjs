// Runs only the installed original library; writes only this task's fixture directory.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import { constants as bufferConstants } from 'node:buffer';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const argv = process.argv.slice(2);
const tree = resolve(argv.includes('--tree') ? argv[argv.indexOf('--tree') + 1] : 'C:/Project/mixdog');
const out = resolve(root, 'native/core/fixtures/office-text-date');
const source = resolve(tree, 'node_modules/@formulajs/formulajs/lib/esm/index.mjs');
const library = await import(pathToFileURL(source));
const { evaluateFormula } = await import(pathToFileURL(resolve(tree,'src/runtime/office/portable/xlsx-formula-engine.mjs')));
const { xmlEncode } = await import(pathToFileURL(resolve(tree,'src/runtime/office/portable/portable-xml.mjs')));
const pkg = JSON.parse(await readFile(resolve(tree,'node_modules/@formulajs/formulajs/package.json'),'utf8'));
if (pkg.version !== '4.6.1') throw new Error(`Expected formulajs 4.6.1, got ${pkg.version}`);
const u = { undefined: true }, error = message => ({ error: message }), date = ms => ({ date: ms });
const decode = v => Array.isArray(v) ? v.map(decode) : v && typeof v === 'object' ? v.undefined ? undefined : v.error ? new Error(v.error) : v.date !== undefined ? new Date(v.date) : v : v;
const bits = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex'); };
const encode = v => v === undefined ? u : v === null ? null : v instanceof Error ? error(v.message) : v instanceof Date ? { dateBits: bits(v.getTime()) } : Array.isArray(v) ? v.map(encode) : typeof v === 'number' ? { numberBits: bits(v) } : typeof v === 'string' ? { text: v.toWellFormed(), utf16: Array.from({length:v.length},(_,i)=>v.charCodeAt(i)) } : v;
const cases=[];
const add=(name,args,zone='UTC')=>cases.push({name,args,zone});
const texts=['', 'Alpha beta', '한글 😀', 'Straße', 'a\u0001b\t c', '  a\t\n b  '];
for(const name of ['CLEAN','CODE','UNICODE','LEN','LOWER','UPPER','PROPER','TRIM','T']) {
  for(const value of texts)add(name,[value]);
  for(const value of [0,42,true,false,null,u,error('#N/A')])add(name,[value]);
}
for(const name of ['CHAR','UNICHAR'])for(const n of [0,1,9,65,255,256,55296,65535,65536,-1,65.8,'66',null,error('#REF!')])add(name,[n]);
for(const name of ['LEFT','RIGHT'])for(const s of ['abcdef','한글','😀x'])for(const n of [-2,0,1,2,9,1.5])add(name,[s,n]);
for(const name of ['CONCAT','CONCATENATE']){add(name,['a',[true,false,null,u,12]]);add(name,[]);add(name,['a',error('#REF!')]);}
for(const name of ['FIND','SEARCH'])for(const args of [['a','Abacad'],['x','hello'],['','abc'],['a','banana',3],['a','banana',-1],['😀','x😀y']])add(name,args);
for(const args of [['a','a'],['A','a'],[true,'true'],[null,''],[12,'12'],[1]])add('EXACT',args);
for(const args of [['abcdef',2,3],['abc',0,1],['abc',1,0],['한글😀',2,2],[1234,2,2]])add('MID',args);
for(const args of [['abcdef',2,3,'X'],['abcdef',-2,1,'X'],['abcdef',99,2,'X']])add('REPLACE',args);
for(const args of [['ab',0],['ab',3],['ab',-1],['ab',1.5],[true,2]])add('REPT',args);
for(const args of [['aababa','a','X'],['aababa','a','X',1],['aababa','a','X',2],['abc','a','X',1],['abc','b','X',0]])add('SUBSTITUTE',args);
for(const args of [['1.234,56',',','.'],['1,234,567.8'],['  '],[null],[true],['10%'],[12.5]])add('NUMBERVALUE',args);
for(const s of ['$1,234.50','12%','%12','-12','abc',' 42 ','1 234','€123','123abc',null,true,error('#NUM!')])add('VALUE',[s]);
for(const name of ['FIXED','DOLLAR'])for(const n of [1234.567,-1234.567,1.005,-1.005,0,-0,12.5])for(const d of [u,0,2,-1])add(name,[n,d]);
for(const args of [[1234.567,'#,##0.00'],[-12.5,'$0.00'],[.125,'0.0%'],[12,'0'],[12,null],[12,7],[12,'.##'],[date(1704067200000),'date']])add('TEXT',args);
for(const args of [[',',true,'a','',0,false,null,'b'],[',',false,'a','',0,false,null,'b'],[['-','/'],false,['a','b','c','d']],[null,true,'a','b']])add('TEXTJOIN',args);
for(const name of ['DAY','HOUR','MINUTE','MONTH','SECOND','YEAR','TIMEVALUE','ISOWEEKNUM'])for(const v of [1,59,60,61,45292.5,'2024-02-29','2024-03-10T12:34:56',-1,'bad',error('#N/A')])add(name,[v]);
for(const args of [[2024,2,29],[1900,2,29],[0,1,1],[2024,13,0],[2024,1.9,1.9],[-1,1,1],['bad',1,1]])add('DATE',args);
for(const s of ['2024-01-01','2024-01-01T12:34:56Z','12/31/2023','bad',45292])add('DATEVALUE',[s]);
for(const name of ['DAYS','DAYS360','YEARFRAC'])for(const args of [['2024-01-31','2024-03-31'],['2023-02-28','2024-02-29'],['2024-03-01','2023-01-01']])for(const option of name==='YEARFRAC'?[0,1,2,3,4,5]:name==='DAYS360'?[false,true]:[u])add(name,[...args,option]);
for(const unit of ['Y','M','D','MD','YM','YD','bad'])for(const pair of [['2020-02-29','2024-02-28'],['2024-01-31','2024-03-01']])add('DATEDIF',[...pair,unit]);
for(const name of ['EDATE','EOMONTH'])for(const months of [-13,-1,0,1,2,13,'2.5'])add(name,['2024-01-31',months]);
for(const name of ['WEEKDAY','WEEKNUM'])for(const ret of [u,1,2,3,11,12,13,14,15,16,17,21,99])add(name,['2024-01-03',ret]);
for(const args of [[1,2,3],[27,0,0],[0,750,0],[-1,0,0],[null,true,'2']])add('TIME',args);
for(const name of ['WORKDAY','WORKDAY.INTL','WORKDAYINTL','NETWORKDAYS','NETWORKDAYS.INTL','NETWORKDAYSINTL']){
 const work=name.startsWith('WORK');const intl=name.includes('INTL');
 for(const n of work?[-3,0,2.5,8]:['2024-01-12','2024-01-01'])add(name,intl?['2024-01-05',n,1,['2024-01-08']]:['2024-01-05',n,['2024-01-08']]);
 if(intl)for(const weekend of [0,2,11,17,'0000011','1111111','|||||||',99])add(name,['2024-01-05',work?2:'2024-01-12',weekend]);
}
for(const zone of ['America/New_York','Asia/Seoul'])for(const name of ['DATE','DATEVALUE','DAY','DAYS','EDATE','YEARFRAC','NETWORKDAYS','WORKDAY'])add(name,({DATE:[2024,3,10],DATEVALUE:['2024-03-10'],DAY:[60],DAYS:['2024-03-12','2024-03-08'],EDATE:['2024-02-10',1],YEARFRAC:['2024-03-08','2024-03-12',1],NETWORKDAYS:['2024-03-08','2024-03-12'],WORKDAY:['2024-03-08',2]})[name],zone);
const matrix=[[1,'a',10],[3,'c',30],[2,'b',20]];
for(const name of ['VLOOKUP','HLOOKUP'])for(const key of [0,1,2,2.5,3,4])for(const exact of [true,false])add(name,[key,name==='VLOOKUP'?matrix:matrix[0].map((_,i)=>matrix.map(r=>r[i])),2,exact]);
for(const args of [[2,[1,2,3]],['a',['b','A','c'],0],['a*',['x','Abc'],0],[2.5,[1,3,2],1],[2.5,[3,1,2],-1],[false,[false,true],0],['a?',['ab','a'],0]])add('MATCH',args);
for(const args of [[2.5,[1,2,3],['a','b','c']],['b',['a','c','b']],[0,[1,2,3]],[3,[1,3,2]]])add('LOOKUP',args);
for(const args of [[matrix,2,2],[[10,20,30],2],[[10,20,30],0],[matrix,0,0],[matrix,-1,1],[matrix,10,1]])add('INDEX',args);
for(const args of [[1,'a','b'],[2,'a','b'],[1.5,'a','b'],['2','a','b'],[0,'a'],[]])add('CHOOSE',args);
add('UNIQUE',[1,1,'1',null,null,[1],[1]]);
for(const name of ['COLUMN','ROW'])for(const i of [0,1,5,-1])add(name,[matrix,i]);
for(const name of ['ROWS','COLUMNS'])for(const array of [[],[1,2,3],matrix,[[1],[2,3]],'abc'])add(name,[array]);
for(const name of ['CHOOSECOLS','CHOOSEROWS'])for(const indices of [[1],[-1],[1,1,2],[0],[5]])add(name,[matrix,...indices]);
for(const name of ['DROP','TAKE'])for(const args of [[matrix,1,2],[matrix,-1,-2],[matrix,0,0],[matrix,10],[matrix,u,1]])add(name,args);
add('EXPAND',[[[1,2],[3]],3,4,'-']);add('EXPAND',[matrix,2,2]);
for(const name of ['HSTACK','VSTACK'])add(name,[[[1,2],[3]],[[4],[5],[6]]]);
for(const name of ['TRANSPOSE','SORT']){add(name,[matrix]);add(name,[[1,0,false,null,'x']]);}
add('SORT',[matrix,2,-1]);add('SORT',[matrix,1,1,true]);
const db=[['Tree','Apple','Pear','Apple','Cherry'],['Height',18,12,14,13],['Yield',14,10,0,9]];
const dbMixed=[['Tree','A','B','C','D'],['Yield',1,'2',null,0]];
for(const name of ['DAVERAGE','DCOUNT','DCOUNTA','DGET','DMAX','DMIN','DPRODUCT','DSTDEV','DSTDEVP','DSUM','DVAR','DVARP']){
 for(const criterion of [[['Height','>12']],[['Height','>12','<13']],[['Tree','Apple']],[['Height','>100']],[['Height',18]],[['Height','*']]])add(name,[db,'Yield',criterion]);
 add(name,[db,2,[['Height','>12']]]);add(name,[dbMixed,'Yield',[['Yield','*']]]);
}
// Corrective review regressions: these use the original library, not a model
// of its result. Large REPT cases exceed V8's output limit while their ordinary
// Array length remains legal; V8 uses a sparse array and rejects join length.
const regressionStart = cases.length;
for (const zone of ['UTC','America/New_York','Asia/Seoul'])
  add('YEARFRAC',['2023-03-01','2024-02-29',1],zone);
add('YEARFRAC',['2023-02-01','2024-01-29',1]);
for (const args of [
  [1e300,13,1],[-1e300,1,1],[2024,1e300,1],[2024,1,1e300],
  [800000,-9575999,1],[1000000,-9999999,1],[1000001,-9999999,1],
  [1000000.9,-9999999,1],[-1000000.9,9999999,1],[833333,-9999999.9,1],
  [0,10000001,1],[0,10000002,1],
  [275760,9,13],[275760,9,14],[-271821,4,20],[-271821,4,19],
  [99.9,1,1],[-0.9,1,1],
]) add('DATE',args);
for (const name of ['DMAX','DMIN']) add(name,[[['id',1,2],['value',[2],'10']],'value',[['id','*']]]);
const dbNested=[['id',1,2],['value',1e16,[-1e16,1]]];
add('DSUM',[dbNested,'value',[['id','*']]]);
add('DSUM',[[['id',1,2],['value',[error('#REF!')],error('#N/A')]],'value',[['id','*']]]);
add('DAVERAGE',[[['id',1,2],['value',[1],[2]]],'value',[['id','*']]]);
add('DAVERAGE',[[['id',1,2],['value',date(0),1]],'value',[['id','*']]]);
for (const order of [1,-1]) {
  add('SORT',[[[error('#REF!'),'error'],['A','text']],1,order]);
  add('SORT',[[['same','first'],['same','second'],['a','third']],1,order]);
  add('SORT',[Array.from({length:96},(_,i)=>[i%7===0?error('#REF!'):String((i*13)%17),i]),1,order]);
}
add('REPT',['abcd',Math.floor(bufferConstants.MAX_STRING_LENGTH/4)+1]);
add('REPT',['😀',Math.floor(bufferConstants.MAX_STRING_LENGTH/2)+1]);
add('REPT',['abc',-1]);
add('REPT',['é😀',3]);
const correctiveRegressions=cases.slice(regressionStart).map((entry,i)=>({case:regressionStart+i,name:entry.name}));
// Shared Date::toString gap remains visible: V8 includes its time-zone name.
const sharedDateStringStart=cases.length;
for (const zone of ['UTC','America/New_York']) {
  add('CONCAT',[date(0)],zone);
  add('REPT',[date(0),1],zone);
}
const sharedDateStringCases=cases.slice(sharedDateStringStart).map((entry,i)=>({case:sharedDateStringStart+i,name:entry.name}));
for(const name of new Set(cases.map(c=>c.name))) {add(name,[]);add(name,[null]);add(name,[error('#REF!')]);}
const rows=[];
for(const entry of cases){process.env.TZ=entry.zone;const fn=entry.name.split('.').reduce((v,k)=>v[k],library);if(typeof fn!=='function')throw new Error(`Missing export ${entry.name}`);let result;try{const invoke=()=>fn(...entry.args.map(decode)); const answer=entry.name==='REPT'&&entry.args[1]>1e8?vm.runInNewContext('invoke()',{invoke},{timeout:1000}):invoke();result={value:encode(answer)}}catch(e){if(e.code==='ERR_SCRIPT_EXECUTION_TIMEOUT')throw e;result={thrown:e.message}}rows.push({...entry,...result});}
const names=[...new Set(rows.map(c=>c.name))].sort();
// The current clock cannot be recorded as a constant; the Rust test checks its Date shape and time window.
const clocks=['NOW','TODAY'].map(name=>({name,kind:library[name]() instanceof Date?'Date':'other'}));
process.env.TZ='UTC';
const formulas=['LEFT("😀",1)&RIGHT("😀",1)','CODE(LEFT("😀",1))','UNICODE(RIGHT("😀",1))','CHAR(55296)','TEXT(1.005,"0.00")','DATE(2024,2,29)','WORKDAY(DATE(2024,1,5),2)','SUBSTITUTE("abc","a","X",1)'];
const engine=formulas.map(formula=>{const value=evaluateFormula(formula,{sheet:'Sheet1',value:()=>null});const xml=xmlEncode(value);return {formula,value:encode(value),xml:encode(xml),xmlUtf8:Buffer.from(xml,'utf8').toString('hex')};});
const rawSurrogates=rows.map((r,i)=>({r,i})).filter(({r})=>r.value?.utf16&&r.value.utf16.some((u,i,us)=>u>=0xd800&&u<=0xdbff?!(us[i+1]>=0xdc00&&us[i+1]<=0xdfff):u>=0xdc00&&u<=0xdfff?!(us[i-1]>=0xd800&&us[i-1]<=0xdbff):false)).map(({r,i})=>({case:i,name:r.name,args:r.args,utf16:r.value.utf16}));
const golden={version:1,library:pkg.version,referenceLocale:Intl.DateTimeFormat().resolvedOptions().locale,normalization:'Strings carry both raw UTF-16 and well-formed text; tests must not hide lone-surrogate differences.',names,clocks,cases:rows,engine,correctiveRegressions,sharedDateStringCases,v8MaxStringUnits:bufferConstants.MAX_STRING_LENGTH,knownSharedRepresentationGaps:rawSurrogates};
const bytes=JSON.stringify(golden,null,2)+'\n';
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest={version:1,recorder:'benchmarks/rust-core/recorders/record-office-text-date.mjs',source:'node_modules/@formulajs/formulajs/lib/esm/index.mjs',sourceSha256:hash(await readFile(source)),library:pkg.version,referenceLocale:Intl.DateTimeFormat().resolvedOptions().locale,files:[{path:'golden.json',sha256:hash(bytes),bytes:Buffer.byteLength(bytes)}],cases:rows.length,names:[...names,...clocks.map(c=>c.name)].sort()};
if(argv.includes('--write')){await mkdir(out,{recursive:true});await writeFile(resolve(out,'golden.json'),bytes);await writeFile(resolve(out,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({cases:rows.length,names:manifest.names.length,sha256:manifest.files[0].sha256}));}
else process.stdout.write(bytes);

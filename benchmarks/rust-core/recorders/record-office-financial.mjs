// Original installed formulajs only; writes confined to office-financial.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const argv=process.argv.slice(2);
const tree=resolve(argv.includes('--tree')?argv[argv.indexOf('--tree')+1]:'C:/Project/mixdog');
const sourcePath=resolve(tree,'node_modules/@formulajs/formulajs/lib/esm/index.mjs');
const source=await readFile(sourcePath,'utf8');
const pkg=JSON.parse(await readFile(resolve(tree,'node_modules/@formulajs/formulajs/package.json'),'utf8'));
if(pkg.version!=='4.6.1')throw Error(`Expected 4.6.1, got ${pkg.version}`);
const api=await import(pathToFileURL(sourcePath));
// Discover category functions from the source, then enumerate their exported
// identities and nested aliases, rather than assuming a spreadsheet function list.
const financial=new Set();
for(const match of source.matchAll(/\/\*\*([\s\S]*?)\*\/\s*function\s+(\w+)/g))
 if(/Category: Financial\b/.test(match[1]))financial.add(api[match[2]]);
const functions=[];
function walk(value,name,depth){
 if(typeof value==='function'&&financial.has(value))functions.push(name);
 if(depth>0&&value&&(typeof value==='function'||typeof value==='object'))for(const key of Object.keys(value))walk(value[key],`${name}.${key}`,depth-1);
}
for(const name of /export\s*\{([^}]+)\}/.exec(source)[1].split(',').map(v=>v.trim()))walk(api[name],name,3);
functions.sort();
const err=message=>Object.values(api.utils.errors).find(e=>e.message===message);
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex')};
const encode=v=>v===undefined?{t:'undefined'}:v===null?{t:'null'}:v instanceof Error?{t:'error',v:v.message}:v instanceof Date?{t:'date',bits:bits(v.getTime())}:Array.isArray(v)?{t:'array',v:v.map(encode)}:typeof v==='number'?{t:'number',bits:bits(v)}:{t:typeof v==='string'?'text':'bool',v};
const clone=v=>Array.isArray(v)?v.map(clone):v instanceof Date?new Date(v.getTime()):v;
const cash=[-10000,3000,4200,6800], dates=['2020-01-01','2020-06-01','2021-01-01','2022-01-01'];
const defaults={
 ACCRINT:['2023-01-01','2023-07-01','2024-04-01',0.08,1000,2,0], COUPDAYS:['2024-03-20','2028-08-31',2,1],
 CUMIPMT:[0.01,24,10000,1,12,0],CUMPRINC:[0.01,24,10000,1,12,0],DB:[10000,1000,10,3,12],DDB:[10000,1000,10,3,2],
 DISC:['2024-02-29','2024-08-31',97,100,0], DOLLARDE:[1.02,16],DOLLARFR:[1.125,16], EFFECT:[0.12,12],
 FV:[0.01,24,-100,1000,0],FVSCHEDULE:[1000,[0.1,0.05,-0.02]],IPMT:[0.01,3,24,1000,0,0],IRR:[cash,0.1],
 ISPMT:[0.01,3,24,1000],MIRR:[cash,0.05,0.1],NOMINAL:[0.12,12],NPER:[0.01,-100,1000,0,0],NPV:[0.1,cash],
 PDURATION:[0.1,1000,2000],PMT:[0.01,24,1000,0,0],PPMT:[0.01,3,24,1000,0,0],
 PRICEDISC:['2024-02-29','2024-08-31',0.05,100,0],PV:[0.01,24,-100,0,0],RATE:[24,-100,1000,0,0,0.1],
 RRI:[10,1000,2000],SLN:[10000,1000,10],SYD:[10000,1000,10,3],
 TBILLEQ:['2024-01-01','2024-06-01',0.05],TBILLPRICE:['2024-01-01','2024-06-01',0.05],TBILLYIELD:['2024-01-01','2024-06-01',97],
 XIRR:[cash,dates,0.1],XNPV:[0.1,cash,dates]
};
const cases=[];
function add(name,args,label,zone='UTC'){
 process.env.TZ=zone;
 const input=args.map(clone), encoded=input.map(encode);
 const fn=name.split('.').reduce((o,k)=>o[k],api);
 let result;
 try{const value=vm.runInNewContext('call()',{call:()=>fn(...input)},{timeout:1000});result={value:encode(value)};}
 catch(e){if(e.code==='ERR_SCRIPT_EXECUTION_TIMEOUT')throw Error(`Reference did not terminate within 1s: ${name} ${label}`);result={threw:String(e.message)};}
 cases.push({name,label,zone,args:encoded,...result});
}
const variants=[undefined,null,0,-0,1,-1,0.5,1.5,'2','bad',' ',true,false,[1],[[2]],err('#REF!'),err('#NUM!'),NaN,Infinity,-Infinity,new Date(0)];
for(const name of functions){
 if(!defaults[name])throw Error(`Missing corpus for export ${name}`);
 const base=defaults[name];add(name,base,'typical');
 for(let n=0;n<base.length;n++)add(name,base.slice(0,n),`omitted-from-${n}`);
 for(let at=0;at<base.length;at++)for(let i=0;i<variants.length;i++){
  // These raw for-loop endpoints are intentionally bounded; Infinity would make
  // the ORIGINAL loop nonterminating. No timeout is stored as a normal answer.
  if(name.startsWith('CUM')&&at===4&&variants[i]===Infinity)continue;
  if(name==='IRR'&&at===1&&variants[i]===Infinity)continue; // Explicit diagnostic below, not a returning case.
  const args=base.map(clone);args[at]=variants[i];add(name,args,`argument-${at}-variant-${i}`);
 }
}
for(const name of ['IRR','MIRR','XIRR','XNPV'])for(const flows of [[],[0],[1,2],[-1,-2],[-100,110],[-100,0,0,150],[-1e16,1,1e16,3],[-100,null,undefined,50,80],[-100,'50',true,70],[-100,err('#N/A'),100]]){
 const args=defaults[name].map(clone);args[name==='XNPV'?1:0]=flows;add(name,args,'cashflow-shape');
}
for(const guess of [0,0.00000000001,0.05,0.5,1,10,-0.5]){
 add('IRR',[cash,guess],'guess-boundary');add('RATE',[24,-100,1000,0,0,guess],'guess-boundary');add('XIRR',[cash,dates,guess],'guess-boundary');
}
for(const name of ['FV','PMT','PV','NPER'])for(const rate of [0,1e-12,-1,-0.1,0.01])for(const kind of [0,1,2,'1',true]){
 const args=defaults[name].map(clone);args[0]=rate;args[4]=kind;add(name,args,'annuity-rate-type');
}
for(const name of ['CUMIPMT','CUMPRINC'])for(const pair of [[1,1],[1,24],[2,5],[1.5,3.5],['1','3'],['9','10'],[3,2]])for(const kind of [0,1,'1'])add(name,[0.01,24,10000,...pair,kind],'raw-periods');
for(const name of ['DB','DDB'])for(const period of [0,1,2,3.5,10,11])for(const extra of [0,1,2,2.5,12,13])add(name,[10000,1000,10,period,extra],'depreciation-boundaries');
for(const name of ['DOLLARDE','DOLLARFR'])for(const dollar of [-1.02,1.02,1.234,1e21,1e-7])for(const denominator of [0,0.5,1,2,16,16.9,32,1e21])add(name,[dollar,denominator],'decimal-conversion');
for(const name of ['ACCRINT','COUPDAYS','DISC','PRICEDISC'])for(const basis of [undefined,0,1,2,3,4,5,'1']){
 const args=defaults[name].map(clone);args[name==='ACCRINT'?6:name==='COUPDAYS'?3:4]=basis;add(name,args,'basis');
}
for(const name of ['ACCRINT','COUPDAYS','DISC','PRICEDISC','TBILLEQ','TBILLPRICE','TBILLYIELD','XIRR','XNPV'])for(const zone of ['America/New_York','Asia/Seoul'])add(name,defaults[name],'local-calendar',zone);
// ACCRINT's ensureDate treats a number as milliseconds, not an Excel serial.
add('ACCRINT',[0,86400000,172800000,0.1,1000,2,0],'date-milliseconds');
for(const name of ['COUPDAYS','DISC','PRICEDISC']){const a=defaults[name].map(clone);a[0]=' ';a[name==='COUPDAYS'?3:4]=1;add(name,a,'invalid-date-from-whitespace');}
// Do not turn the original's nontermination into an invented financial error.
// This bounded diagnostic is intentionally NOT a normal output case to replay.
let irrInfinityTimedOut=false;
try { vm.runInNewContext('call()',{call:()=>api.IRR(cash,Infinity)},{timeout:1000}); }
catch(e) { if(e.code==='ERR_SCRIPT_EXECUTION_TIMEOUT')irrInfinityTimedOut=true;else throw e; }
if(!irrInfinityTimedOut)throw Error('IRR(+Infinity) reference behavior changed; revisit the documented loop.');
const nontermination=[{name:'IRR',args:[cash,Infinity].map(encode),observation:'VM timeout after 1000ms',sourceReason:'bisection lower bound remains Infinity after subtracting 0.1',productionPolicy:'retain original loop; no invented limit or error'}];
const hash=s=>createHash('sha256').update(s).digest('hex');
const golden={version:1,library:pkg.version,node:process.version,v8:process.versions.v8,sourceSha256:hash(source),functions,cases,nontermination};
const bytes=JSON.stringify(golden,null,2)+'\n';
const manifest={version:1,set:'office-financial',library:pkg.version,source:'node_modules/@formulajs/formulajs/lib/esm/index.mjs',sourceSha256:hash(source),recorder:'benchmarks/rust-core/recorders/record-office-financial.mjs',functions,cases:cases.length,nontermination,files:[{path:'golden.json',sha256:hash(bytes),bytes:Buffer.byteLength(bytes)}]};
if(argv.includes('--write')){const output=resolve(root,'native/core/fixtures/office-financial');await mkdir(output,{recursive:true});await writeFile(resolve(output,'golden.json'),bytes);await writeFile(resolve(output,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({functions:functions.length,cases:cases.length,sha256:manifest.files[0].sha256}));}
else process.stdout.write(bytes);

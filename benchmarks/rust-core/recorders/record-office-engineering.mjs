// Original formulajs 4.6.1/bessel 1.0.2 oracle; only writes this task's fixture directory.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const args=process.argv.slice(2);const tree=resolve(args.includes('--tree')?args[args.indexOf('--tree')+1]:'C:/Project/mixdog');
process.env.TZ='UTC';
const source=resolve(tree,'node_modules/@formulajs/formulajs/lib/esm/index.mjs');
const sourceText=await readFile(source,'utf8');
const f=await import(pathToFileURL(source));
const packageVersion=JSON.parse(await readFile(resolve(tree,'node_modules/@formulajs/formulajs/package.json'),'utf8')).version;
const besselVersion=JSON.parse(await readFile(resolve(tree,'node_modules/bessel/package.json'),'utf8')).version;
if(packageVersion!=='4.6.1'||besselVersion!=='1.0.2')throw Error('wrong original library version');
const names='BESSELI BESSELJ BESSELK BESSELY BIN2DEC BIN2HEX BIN2OCT BITAND BITLSHIFT BITOR BITRSHIFT BITXOR COMPLEX CONVERT DEC2BIN DEC2HEX DEC2OCT DELTA ERF ERFC GESTEP HEX2BIN HEX2DEC HEX2OCT IMABS IMAGINARY IMARGUMENT IMCONJUGATE IMCOS IMCOSH IMCOT IMDIV IMEXP IMLN IMLOG10 IMLOG2 IMPOWER IMPRODUCT IMREAL IMSEC IMSECH IMSIN IMSINH IMSQRT IMCSC IMCSCH IMSUB IMSUM IMTAN OCT2BIN OCT2DEC OCT2HEX'.split(' ');
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex')};
const encode=v=>v===undefined?{t:'undefined'}:v===null?{t:'null'}:v instanceof Error?{t:'error',v:v.message}:v instanceof Date?{t:'date',bits:bits(v.getTime())}:Array.isArray(v)?{t:'array',v:v.map(encode)}:typeof v==='number'?{t:'number',bits:bits(v)}:typeof v==='boolean'?{t:'bool',v}:({t:'text',v});
const decode=v=>v.t==='undefined'?undefined:v.t==='null'?null:v.t==='number'?Buffer.from(v.bits,'hex').readDoubleBE():v.t==='error'?new Error(v.v):v.t==='date'?new Date(Buffer.from(v.bits,'hex').readDoubleBE()):v.t==='array'?v.v.map(decode):v.v;
const rows=[];const context=vm.createContext({});
const add=(name,args,label='case')=>{const encoded=args.map(encode);context.fn=f[name];context.args=encoded.map(decode);let answer;try{answer={value:encode(vm.runInContext('fn(...args)',context,{timeout:1000}))}}catch(e){if(e.code==='ERR_SCRIPT_EXECUTION_TIMEOUT')throw Error(`unbounded oracle input ${name} ${JSON.stringify(encoded)}`);answer={thrown:e.message};}rows.push({name,label,args:encoded,...answer});};
const scalars=[undefined,null,false,true,0,-0,1,-1,2.5,NaN,Infinity,-Infinity,'',' ','1','-1','bad',[],[1],[1,2],new Error('#REF!'),new Date(1704067200000)];
for(const name of names){add(name,[],'omitted');for(const v of scalars)add(name,[v],'scalar');}
for(const name of ['BESSELI','BESSELJ','BESSELK','BESSELY']){
 for(const x of [-20,-8,-3.75,-2,-1,-0,0,Number.MIN_VALUE,.125,1,2,3.75,8,20,100,710,Infinity,-Infinity])for(const n of [-3,-1,-.5,0,.5,1,1.5,2,3,8,20,' ',null,'x'])add(name,[x,n],'bessel-grid');
 for(const boundary of [2,3.75,8]){const h=BigInt('0x'+bits(boundary));for(const d of [-1n,1n]){const b=Buffer.alloc(8);b.writeBigUInt64BE(h+d);for(const n of [0,1,2])add(name,[b.readDoubleBE(),n],'branch-neighbour');}}
}
for(const name of names.filter(n=>/^(BIN|DEC|HEX|OCT)2/.test(n))){
 const inputs=[0,1,10,101,511,512,-512,-513,536870911,536870912,549755813887,549755813888,'0','0000000000','1111111111','1000000000','0111111111','7777777777','4000000000','ffffffffff','8000000000','ffffffff00','FFFFFFFFFF','1f','1.5',1.5,' 10',[101],['1111111111']];
 for(const value of inputs)for(const places of [undefined,0,2,10,11,-1,3.5,'4','bad',null,true,Infinity,new Error('#N/A')])add(name,[value,places],'base-grid');
}
for(const name of names.filter(n=>n.startsWith('BIT'))){for(const x of [0,1,7,2**31,2**32-1,2**32,2**40+5,2**48-1,2**48,-1,1.5,' ','x'])for(const y of name.endsWith('SHIFT')?[-54,-53,-33,-32,-1,-.5,0,.5,1,31,32,33,53,54,' ',NaN]:[0,1,3,2**31,2**32+3,2**48-1,-1,1.5,' ',NaN])add(name,[x,y],'bit-grid');}
for(const name of ['DELTA','GESTEP','ERF'])for(const x of [-2,-1,-.5,0,.5,1,2,8,' ','2',Infinity,-Infinity])for(const y of [undefined,-1,0,1,'1','x',new Error('#REF!')])add(name,[x,y],'pair');
for(const value of [-8,-2,-1,-0,.125,1,2,8,26,Infinity,-Infinity,'0','1','2','-1',' ','',null,false,true,[],[1],[2]])add('ERFC',[value],'erfc-coercion');
const complex=['0','-0','0i','-0i','i','+i','-i','1i','2i','j','-j','3j','1','-1','1+i','1-i','-2+3j','2-3i','1+2i','1.5+2.25i','0.5-0.75j','1e-3+2i','1e3','1e+3','0x10','Infinity','Infinityi','NaN','1+2k','1+2I','1++2i',' 2 ','','😀'];
for(const name of names.filter(n=>n.startsWith('IM')))for(const value of complex)add(name,[value],'complex-unary');
for(const name of ['IMDIV','IMSUB','IMPRODUCT','IMSUM'])for(const x of ['0','i','1+2i','-2+3j','2i',1,0,'bad'])for(const y of ['0','0i','j','3-4i','1+2j',2,'bad'])add(name,[x,y],'complex-pair');
for(const name of ['IMPRODUCT','IMSUM'])for(const args of [[['1+i','2+3i']],['i','j','1-i'],[['i','j'],['1','2']],['0','0'],[new Error('#REF!')]])add(name,args,'complex-variadic');
for(const value of ['0','i','-1','1+i','-2+3j','0i',1])for(const power of [-2,-1,0,.5,1,2,2.5,'2',' ',NaN,Infinity])add('IMPOWER',[value,power],'complex-power');
for(const real of [-2,-0,0,1,2.5,' ',NaN,'x',new Error('#REF!')])for(const imaginary of [-1,-0,0,1,2.5,' ',NaN,'x',new Error('#N/A')])for(const suffix of [undefined,'i','j','k',null])add('COMPLEX',[real,imaginary,suffix],'complex-construction');
// Read the actual literal table, including duplicate aliases and erroneous ratios.
const unitStart=sourceText.indexOf('  const units = [',sourceText.indexOf('function CONVERT'));
const unitEnd=sourceText.indexOf('  ];',unitStart);
const units=vm.runInNewContext(sourceText.slice(unitStart,unitEnd+4)+'\nunits',{},{timeout:1000});
for(const unit of units){const target=units.find(u=>u[3]===unit[3]);for(const symbol of [unit[1],...(unit[2]||[])]){add('CONVERT',[1.25,symbol,target[1]],'unit-table');add('CONVERT',[-3.5,target[1],symbol],'unit-table-reverse');}}
for(const prefix of ['Y','Z','E','P','T','G','M','k','h','e','da','d','c','m','u','n','p','f','a','z','y','Yi','Zi','Ei','Pi','Ti','Gi','Mi','ki'])for(const symbol of ['m','bit','g','ang2','K'])add('CONVERT',[1.125,prefix+symbol,symbol],'prefix');
for(const args of [[1,'C','K'],[1,'F','K'],[1,'Rank','K'],[1,'b','bit'],[1,'h','s'],[1,'e','J'],[1,'?','rad'],[1,'m','s'],[1,'unknown','m'],[1,1,'m'],[1,'m',null],[1,'unknown',true],[NaN,'m','m'],[' ', 'ft','m']])add('CONVERT',args,'unit-quirk');
const unavailable=['ERF.PRECISE','ERFC.PRECISE','ERFPRECISE','ERFCPRECISE'].map(name=>({name,type:typeof name.split('.').reduce((v,k)=>v?.[k],f)}));
if(unavailable.some(v=>v.type!=='undefined'))throw Error('PRECISE aliases changed; inspect actual source');
// Positive infinite order in J/I does not decrement in JS. It is not a returned
// result or a library exception, so record the bounded observation separately.
const nonterminating=[];for(const name of ['BESSELJ','BESSELI']){context.fn=f[name];context.args=[1,Infinity];try{vm.runInContext('fn(...args)',context,{timeout:50});throw Error('expected original nontermination')}catch(e){if(e.code!=='ERR_SCRIPT_EXECUTION_TIMEOUT')throw e;nonterminating.push({name,args:[encode(1),encode(Infinity)],observation:'original exceeded 50ms; no value/exception assertion is fabricated'});}}
const hash=v=>createHash('sha256').update(v).digest('hex');
const sourcePaths=['node_modules/@formulajs/formulajs/lib/esm/index.mjs','node_modules/bessel/bessel.js','node_modules/jstat/dist/jstat.js'];
const sources=[];for(const path of sourcePaths)sources.push({path,sha256:hash(await readFile(resolve(tree,path)))});
const golden={version:1,oracle:{node:process.version,v8:process.versions.v8,formulajs:packageVersion,bessel:besselVersion,zone:'UTC'},names,unavailable,nonterminating,unitCount:units.length,sources,cases:rows};
const bytes=JSON.stringify(golden)+'\n';const out=resolve(root,'native/core/fixtures/office-engineering');
const licenses=[];for(const [source,name]of [['node_modules/@formulajs/formulajs/LICENSE','LICENSE.formulajs'],['node_modules/bessel/LICENSE','LICENSE.bessel'],['node_modules/jstat/LICENSE','LICENSE.jstat']])licenses.push({name,bytes:await readFile(resolve(tree,source))});
const manifest={version:1,recorder:'benchmarks/rust-core/recorders/record-office-engineering.mjs',sources,functions:names.length,cases:rows.length,files:[{path:'golden.json',sha256:hash(bytes),bytes:Buffer.byteLength(bytes)},...licenses.map(l=>({path:l.name,sha256:hash(l.bytes),bytes:l.bytes.length}))]};
if(args.includes('--write')){await mkdir(out,{recursive:true});await writeFile(resolve(out,'golden.json'),bytes);await writeFile(resolve(out,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');for(const license of licenses)await writeFile(resolve(out,license.name),license.bytes);console.log(JSON.stringify({functions:names.length,cases:rows.length,units:units.length,unavailable,sha256:hash(bytes)}));}
else process.stdout.write(bytes);

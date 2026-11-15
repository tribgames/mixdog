// Original formulajs/jStat only. This is separate from the descriptive recorder.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const argv=process.argv.slice(2),root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const tree=resolve(argv.includes('--tree')?argv[argv.indexOf('--tree')+1]:'C:/Project/mixdog');
const sourcePath=resolve(tree,'node_modules/@formulajs/formulajs/lib/esm/index.mjs'),source=await readFile(sourcePath,'utf8');
const f=await import(pathToFileURL(sourcePath));
const packageVersion=JSON.parse(await readFile(resolve(tree,'node_modules/@formulajs/formulajs/package.json'),'utf8')).version;
const jstatVersion=JSON.parse(await readFile(resolve(tree,'node_modules/jstat/package.json'),'utf8')).version;
if(packageVersion!=='4.6.1'||jstatVersion!=='1.9.6')throw Error('wrong original dependency versions');
const families=['BETA','BINOM','CHISQ','CONFIDENCE','EXPON','F','GAMMA','GAMMALN','GAUSS','HYPGEOM','LOGNORM','NEGBINOM','NORM','PHI','POISSON','PROB','T','WEIBULL','Z'];
const canonical=new Map();function collect(v,name,depth){if(typeof v==='function'&&name!=='T')canonical.set(v,name);if(depth&&v&&(typeof v==='function'||typeof v==='object'))for(const key of Object.keys(v))collect(v[key],name+'.'+key,depth-1);}
for(const name of families)collect(f[name],name,4);
const functions=[];function walk(v,name,depth){if(typeof v==='function'&&canonical.has(v))functions.push({name,canonical:canonical.get(v)});if(depth&&v&&(typeof v==='function'||typeof v==='object'))for(const key of Object.keys(v))walk(v[key],name+'.'+key,depth-1);}
for(const name of /export\s*\{([^}]+)\}/.exec(source)[1].split(',').map(s=>s.trim()))walk(f[name],name,4);
functions.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
const bases={
 'BETA.DIST':[.3,2,3,true,0,1],'BETA.INV':[.5,2,3,0,1],'BINOM.DIST':[3,10,.3,true],'BINOM.DIST.RANGE':[10,.3,2,4],'BINOM.INV':[10,.3,.8],
 'CHISQ.DIST':[3,4,true],'CHISQ.DIST.RT':[3,4],'CHISQ.INV':[.8,4],'CHISQ.INV.RT':[.2,4],'CHISQ.TEST':[[[10,20],[20,30]],[[15,15],[15,35]]],
 'CONFIDENCE.NORM':[.05,2,20],'CONFIDENCE.T':[.05,2,20],'EXPON.DIST':[1,2,true],
 'F.DIST':[1.2,5,9,true],'F.DIST.RT':[1.2,5,9],'F.INV':[.8,5,9],'F.INV.RT':[.2,5,9],'F.TEST':[[1,2,3],[2,3,5]],
 'GAMMA':[2.5],'GAMMA.DIST':[3,2,1,true],'GAMMA.INV':[.7,2,1],'GAMMALN':[2.5],'GAMMALN.PRECISE':[2.5],'GAUSS':[1],
 'HYPGEOM.DIST':[3,6,8,20,true],'LOGNORM.DIST':[2,0,1,true],'LOGNORM.INV':[.9,0,1],'NEGBINOM.DIST':[3,4,.3,true],
 'NORM.DIST':[1,0,1,true],'NORM.INV':[.9,0,1],'NORM.S.DIST':[1,true],'NORM.S.INV':[.9],'PHI':[1],
 'POISSON.DIST':[3,2,true],'PROB':[[3,1,2],[.2,.3,.5],1,3],
 'T.DIST':[1,10,1],'T.DIST.2T':[1,10],'T.DIST.RT':[1,10],'T.INV':[.9,10],'T.INV.2T':[.1,10],'T.TEST':[[1,2,3],[2,3,5]],
 'WEIBULL.DIST':[1.5,2,3,true],'Z.TEST':[[1,2,3],2,undefined]
};
const bit=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex')};
const enc=v=>v===undefined?{t:'undefined'}:v===null?{t:'null'}:v instanceof Error?{t:'error',v:v.message}:v instanceof Date?{t:'date',bits:bit(v.getTime())}:Array.isArray(v)?{t:'array',v:v.map(enc)}:typeof v==='number'?{t:'number',bits:bit(v)}:{t:typeof v==='string'?'text':'bool',v};
const clone=v=>Array.isArray(v)?v.map(clone):v instanceof Date?new Date(v):v;
const errors=Object.values(f.utils.errors);const error=s=>errors.find(e=>e.message===s);
const variants=[undefined,null,0,-0,1,-1,.5,2.5,'2','bad',' ',true,false,[1],[[2]],error('#REF!'),error('#NUM!'),NaN,Infinity,-Infinity,new Date(0)];
const cases=[];
function add(name,args,label){const input=args.map(clone),encoded=input.map(enc);const fn=name.split('.').reduce((v,k)=>v[k],f);let outcome;
 try{outcome={value:enc(vm.runInNewContext('invoke()',{invoke:()=>fn(...input)},{timeout:200}))};}
 catch(e){if(e.code==='ERR_SCRIPT_EXECUTION_TIMEOUT')throw Error(`nonterminating reference case ${name} ${label}: ${JSON.stringify(encoded)}`);outcome={threw:e.message};}
 cases.push({name,label,args:encoded,...outcome});}
const skippedBoundedDomain=[];
function unbounded(c,at,v){return v===Infinity&&((c==='BINOM.INV'&&at===0)||(c==='BINOM.DIST.RANGE'&&at===3)||(['NEGBINOM.DIST','POISSON.DIST','HYPGEOM.DIST'].includes(c)&&at===0));}
for(const row of functions){const{name,canonical:c}=row,base=bases[c];if(!base)throw Error('missing corpus '+c);add(name,base,'typical');for(let i=0;i<base.length;i++)add(name,base.slice(0,i),'arity-'+i);add(name,[...base,17],'extra-argument');
 for(let at=0;at<base.length;at++)for(let i=0;i<variants.length;i++){const v=variants[i];if(unbounded(c,at,v)){skippedBoundedDomain.push({name,parameter:at,input:enc(v),reason:'original counter has an infinite upper bound; no production cap is invented'});continue;}const args=base.map(clone);args[at]=v;add(name,args,`argument-${at}-${i}`);}
}
for(const name of ['BETA.DIST','BINOM.DIST','CHISQ.DIST','EXPON.DIST','F.DIST','GAMMA.DIST','HYPGEOM.DIST','LOGNORM.DIST','NEGBINOM.DIST','NORM.DIST','NORM.S.DIST','POISSON.DIST','WEIBULL.DIST']){
 const base=bases[name],at=name==='HYPGEOM.DIST'?4:name==='NORM.S.DIST'?1:base.length===6?3:base.length-1;
 for(const cumulative of [false,true,0,1,2,'false',null,undefined,error('#REF!')]){const args=base.map(clone);args[at]=cumulative;add(name,args,'cumulative-type');}
}
for(const name of ['GAMMA','GAMMALN','GAMMALN.PRECISE'])for(const x of [-10,-3.5,-.5,1e-10,.5,1,2,8,170,171,171.6243769536076,172])add(name,[x],'gamma-boundary');
for(const name of ['BETA.DIST','BETA.INV'])for(const a of [.2,1,2,511,512,1000])for(const b of [.3,1,3,511,512]){const args=bases[name].map(clone);args[1]=a;args[2]=b;add(name,args,'beta-shape-branch');}
for(const name of ['BETA.DIST','CHISQ.DIST','EXPON.DIST','F.DIST','GAMMA.DIST','LOGNORM.DIST','NORM.DIST','WEIBULL.DIST'])for(const x of [-1,0,.5,1,8,Infinity])for(const cumulative of [false,true]){
 const args=bases[name].map(clone);args[0]=x;args[name==='BETA.DIST'?3:args.length-1]=cumulative;add(name,args,'pdf-cdf-support-boundary');
}
for(const alpha of [.2,1,2,511,512,1000])for(const beta of [.3,1,3,511,512])add('BETA.DIST',[.3,alpha,beta,false,0,1],'beta-pdf-shape-branch');
for(const df of [.5,1,2,3,5,-1])for(const x of [0,1,8])add('F.DIST',[x,df,9,false],'f-pdf-degree-branch');
add('CHISQ.DIST',[0,2,false],'chisq-pdf-zero');add('GAMMA.DIST',[0,1,2,false],'gamma-pdf-zero');
add('LOGNORM.DIST',[2,0,-1,false],'lognormal-negative-scale-pdf');
add('WEIBULL.DIST',[-1,.5,2,false],'weibull-negative-fractional-pdf');
for(const name of ['BETA.INV','CHISQ.INV','F.INV','GAMMA.INV','LOGNORM.INV','NORM.INV','NORM.S.INV','T.INV','T.INV.2T'])for(const p of [0,1e-12,.01,.5,.99,1-1e-12,1]){const args=bases[name].map(clone);args[0]=p;add(name,args,'inverse-endpoint');}
for(const name of ['BINOM.DIST','NEGBINOM.DIST','POISSON.DIST'])for(const x of [-1,0,.5,1,10,20,Infinity])for(const c of [false,true]){if(x===Infinity&&c&&name!=='BINOM.DIST')continue;const args=bases[name].map(clone);args[0]=x;args[args.length-1]=c;add(name,args,'count-boundary');}
for(const name of ['CHISQ.TEST','F.TEST','T.TEST'])for(const pair of [[[],[]],[[1],[2]],[[1,2],[3]],[[[1,2],[3]],[[1],[2,3]]],[[null,'2',true],[0,2,1]],[[error('#N/A'),1],[1,2]],[[' ',1],[1,2]]])add(name,pair,'array-shape');
for(const args of [[[2,1,2],[.1,.2,.7],1,2],[[2,1,2],[.1,.2,.7],2,2],[[1,2,3],[.5],2,2],[[1,2,3],[.5],1,3],[[1,2],[.5,.5]],[[1,2],[.5,.5],3,1]])add('PROB',args,'prob-index-quirk');
add('T.INV.2T',[error('#REF!'),0],'bounds-before-error');
add('CHISQ.DIST.RT',[0,error('#REF!')],'falsy-before-error');
add('F.DIST',[1,-2,3,true],'boolean-incomplete-beta');
let timedOut=false;try{vm.runInNewContext('invoke()',{invoke:()=>f.BINOM.INV(Infinity,.3,.8)},{timeout:50});}catch(e){if(e.code==='ERR_SCRIPT_EXECUTION_TIMEOUT')timedOut=true;else throw e;}if(!timedOut)throw Error('BINOM.INV Infinity observation changed');
const nonterminating=[{name:'BINOM.INV',args:[Infinity,.3,.8].map(enc),observation:'original exceeded 50ms VM limit',policy:'not encoded as a normal returned value/error and never replayed unbounded'}];
const hash=b=>createHash('sha256').update(b).digest('hex');const jstatSource=await readFile(resolve(tree,'node_modules/jstat/dist/jstat.js'));
const golden={version:1,oracle:{formulajs:packageVersion,jstat:jstatVersion,node:process.version,v8:process.versions.v8},functions,cases,nonterminating,boundedDomainOmissions:skippedBoundedDomain};
const bytes=JSON.stringify(golden)+'\n';const licenses=[];for(const[p,name]of[['node_modules/@formulajs/formulajs/LICENSE','LICENSE.formulajs'],['node_modules/jstat/LICENSE','LICENSE.jstat']])licenses.push({name,bytes:await readFile(resolve(tree,p))});
const manifest={version:1,set:'office-stats-distributions',recorder:'benchmarks/rust-core/recorders/record-office-stats-distributions.mjs',sourceSha256:hash(source),jstatSha256:hash(jstatSource),functionCount:functions.length,canonicalCount:canonical.size,cases:cases.length,files:[{path:'golden.json',bytes:Buffer.byteLength(bytes),sha256:hash(bytes)},...licenses.map(l=>({path:l.name,bytes:l.bytes.length,sha256:hash(l.bytes)}))]};
if(argv.includes('--write')){const out=resolve(root,'native/core/fixtures/office-stats-distributions');await mkdir(out,{recursive:true});await writeFile(resolve(out,'golden.json'),bytes);await writeFile(resolve(out,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');for(const l of licenses)await writeFile(resolve(out,l.name),l.bytes);console.log(JSON.stringify({functions:functions.length,canonical:canonical.size,cases:cases.length,sha256:hash(bytes)}));}else process.stdout.write(bytes);

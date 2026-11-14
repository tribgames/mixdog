// Bounded oracle recording: installed Node 22.20.0 / V8 12.4.254.21-node.33.
// Inputs stay as hex strings until the call. Storing a signaling NaN in a V8
// double-elements array would quiet it and record the wrong input contract.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const out=resolve(root,'native/core/fixtures/js-math-primitives');
if(process.versions.node!=='22.20.0'||process.versions.v8!=='12.4.254.21-node.33')throw new Error('This recorder requires the pinned Node/V8 oracle; update source provenance before changing it.');
const from=h=>Buffer.from(h,'hex').readDoubleBE();
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
const hex=n=>BigInt.asUintN(64,n).toString(16).padStart(16,'0');
const input=new Set();
const add=n=>input.add(bits(n));
const adjacent=n=>{const b=BigInt('0x'+bits(n));for(let i=-3n;i<=3n;i++){input.add(hex(b+i));input.add(hex((b+i)^0x8000000000000000n));}};
for(const h of ['0000000000000000','8000000000000000','0000000000000001','8000000000000001','000fffffffffffff','0010000000000000','7fefffffffffffff','ffefffffffffffff','7ff0000000000000','fff0000000000000','7ff8000000000000','fff8000000000000','7ff0000000000001','7ff0000000000042','fff0000000000042','7ff8000000000123','fff8000000000123'])input.add(h);
for(const n of [0,Number.MIN_VALUE,Number.MAX_VALUE,1,-1,.5,-.5,.4375,.6875,1.1875,2.4375,.975,Math.PI,Math.PI/2,Math.PI/4,3*Math.PI/4,2**-57,2**-28,2**-27,2**19*Math.PI/2,2**20,2**52,2**53,2**66,1e100,1e300])adjacent(n);
// Exact high-word branch boundaries, including nonzero low words.
for(const hi of [0x3e300000n,0x3e400000n,0x3fd33333n,0x3fe59428n,0x3fe90000n,0x3fe921fbn,0x3fef3333n,0x4002d97cn,0x413921fbn]){
 for(const lo of [0n,1n,0xffffffffn])for(const delta of [-1n,0n,1n]){const b=(hi<<32n)+lo+delta;input.add(hex(b));input.add(hex(b^0x8000000000000000n));}
}
for(let k=1;k<=64;k++)adjacent(k*Math.PI/2);
for(const exponent of [-1074,-1022,-1000,-100,-53,-28,-1,0,1,19,20,50,100,300,700,1000,1023])adjacent(2**exponent);
// Fixed xorshift stream generates inputs only; this is not the production RNG.
let seed=0x6a09e667f3bcc909n;
const next=()=>{seed^=seed<<13n;seed=BigInt.asUintN(64,seed);seed^=seed>>7n;seed^=seed<<17n;seed=BigInt.asUintN(64,seed);return seed;};
for(let i=0;i<2048;i++)input.add(hex(next()));
for(let i=0;i<1024;i++)add(Number(next()>>11n)/2**53*2-1);
const unary=['abs','floor','ceil','sqrt','acos','asin','atan','sin','cos','tan','log'];
const cases=[];
for(const name of unary)for(const h of input){const x=from(h);const answer=Math[name](x);cases.push([name,[h],bits(answer)]);}
const pairs=new Set();
const pair=(a,b)=>pairs.add(a+','+b);
const special=['0000000000000000','8000000000000000','0000000000000001','8000000000000001','3ff0000000000000','bff0000000000000','7fefffffffffffff','ffefffffffffffff','7ff0000000000000','fff0000000000000','7ff8000000000123','fff8000000000123','7ff0000000000042'];
for(const a of special)for(const b of special)pair(a,b);
for(const exponent of [-1022,-100,-61,-60,-59,0,59,60,61,100,1023])for(const ysign of [-1,1])for(const xsign of [-1,1]){pair(bits(ysign*2**exponent),bits(xsign));pair(bits(ysign),bits(xsign*2**exponent));}
for(let i=0;i<2048;i++)pair(hex(next()),hex(next()));
for(const key of pairs){const[a,b]=key.split(',');const y=from(a);const x=from(b);for(const name of ['atan2','min','max'])cases.push([name,[a,b],bits(Math[name](y,x))]);}
let range=true,grid=true;for(let i=0;i<4096;i++){const x=Math.random();range&&=x>=0&&x<1;grid&&=Number.isInteger(x*2**52);}
const fixture={version:1,node:process.versions.node,v8:process.versions.v8,platform:process.platform,arch:process.arch,cases,random:{sampleCount:4096,inRange:range,on52BitGrid:grid,state:'independent-process state is not reproducible'}};
const bytes=JSON.stringify(fixture)+'\n';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=['ieee754.cc','LICENSE.v8','math-random.cc','random-number-generator.h'];
const sources=[];for(const file of files){const data=await readFile(resolve(root,'native/core/crates/mixdog-js/src/math/reference',file));sources.push({file,sha256:hash(data),bytes:data.length});}
const manifest={version:1,oracle:{node:process.versions.node,v8:process.versions.v8,platform:process.platform,arch:process.arch},upstream:'https://github.com/nodejs/node/tree/v22.20.0/deps/v8',recorder:'benchmarks/rust-core/recorders/record-js-math-primitives.mjs',sourceFiles:sources,files:[{path:'golden.json',sha256:hash(bytes),bytes:Buffer.byteLength(bytes)}],caseCount:cases.length,functions:[...unary,'atan2','min','max','random']};
if(process.argv.includes('--write')){await mkdir(out,{recursive:true});await writeFile(resolve(out,'golden.json'),bytes);await writeFile(resolve(out,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({cases:cases.length,sha256:manifest.files[0].sha256,random:fixture.random}));}else process.stdout.write(bytes);

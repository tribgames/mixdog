#!/usr/bin/env node
// Original formulajs 4.6.1 only; all writes are confined to office-math fixtures.
// Enumerate the installed export namespace and function identities, not a hand-picked list.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const at = process.argv.indexOf('--tree');
const tree = at < 0 ? 'C:/Project/mixdog' : process.argv[at + 1];
const source = path.join(tree, 'node_modules/@formulajs/formulajs/lib/esm/index.mjs');
const text = readFileSync(source, 'utf8');
const version = JSON.parse(readFileSync(path.join(tree, 'node_modules/@formulajs/formulajs/package.json'))).version;
if (version !== '4.6.1') throw Error(`expected formulajs 4.6.1, found ${version}`);
const api = await import(pathToFileURL(source));
const resolve = name => name.split('.').reduce((value, part) => value?.[part], api);
const groups = new Map();
for (const match of text.matchAll(/\/\*\*([\s\S]*?)\*\/\s*(?:function\s+(\w+)|([A-Z][A-Z.]+)\s*=)/g)) {
  const category = /Category: (Math and trigonometry|Logical|Information)\b/.exec(match[1])?.[1];
  if (category) groups.set(resolve(match[2] || match[3]), category);
}
groups.set(api.ERROR.TYPE, 'Information');
const functions = [];
function visit(value, name, depth) {
  if (typeof value === 'function' && groups.has(value)) functions.push({ name, category: groups.get(value) });
  if (depth > 0 && value && (typeof value === 'object' || typeof value === 'function')) {
    for (const key of Object.keys(value)) visit(value[key], `${name}.${key}`, depth - 1);
  }
}
// The export list is authoritative: aliases and dotted variants are traversed too.
const exports = /export\s*\{([^}]+)\}/.exec(text)[1].split(',').map(x => x.trim());
for (const name of exports) visit(api[name], name, 3);
functions.sort((a,b) => a.name.localeCompare(b.name, 'en'));
if (new Set(functions.map(f=>f.name)).size !== functions.length) throw Error('duplicate names');
const bits = n => {const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex')};
const encode = v => v === undefined ? {t:'undefined'} : v === null ? {t:'null'} : v instanceof Error ? {t:'error',v:v.message} : v instanceof Date ? {t:'date',bits:bits(v.getTime())} : Array.isArray(v) ? {t:'array',v:v.map(encode)} : typeof v === 'number' ? {t:'number',bits:bits(v)} : typeof v === 'boolean' ? {t:'bool',v} : {t:'text',v};
const errors = Object.values(api.utils.errors);
const common = [[],[0],[-0],[1],[-2],[0.5],[2,3],[2,3,4],[null],[undefined],[true],[false],[''],[' '],['2'],['bad'],[new Date(0)],[new Date(NaN)],[['2']],[[1,2]],[[[1,2],[3,4]]],[[1,'2',true,null]],...errors.map(e=>[e]),[errors[0],errors[1]],[1,errors[1]],[errors[2],1]];
const specific = {
  BASE:[[10,2],[15.5,16],[0.1,2],[35,36,4],[10,1],[10,37],[10,2,3.5],[NaN,2],[Infinity,16]],
  DECIMAL:[['ff',16],['11tail',2],['0x10',16],['0b11',2],['-0',10],['12',2.9]],
  ROUND:[[1.005,2],[-1.005,2],[1e21,2],[1e-7,2],[12.5,-1],[12.5,0.5]],
  ROMAN:[[1999],[0],[-1],[1.5],[4000]],
  ARABIC:[['MCMXCIX'],['iv'],['IIII'],[''],[[]],[['I']]],
  SUM:[[1e16,[-1e16,1]],[[1,2],['3x',false]],['#N/A'],[[errors[0],errors[1]]]],
  SUMIF:[[[1,2,3],'>1'],[['a','b'],'*',[8,9]],[[1,2],'>0',['x','y']],[[1,2],'>0',[1]],[[1,errors[0]],'*']],
  SUMIFS:[[[1,'2',true],[1,2,3],'>1'],[[1,2],[1,2]],[[1,2],[1,2],'*']],
  SUMX2PY2:[[[' '],[1]],[[1],[' ']]],
  SUMPRODUCT:[[[1,2],[3,4]],[[[1,2]],[[3,4]]],[[[1,2]],[]],[[],[]],[[1,2],[3]]],
  MMULT:[[['1'],[[1]]],[['1'],[]],[[[1,2],[3,4]],[[5],[6]]],[[],[]],[[null],[[1]]],[[[1,2],[3]],[[4],[5]]]],
  MUNIT:[[3],['2.9'],['0x2'],[1,2]],
  SERIESSUM:[['bad',1,1,'2'],[2,'bad',1,'2'],[2,1,'bad','2'],[2,1,2,[1,2,3]],[2,1,1,2],[2,1,1,'2'],[2,1,1,[]]],
  AGGREGATE:Array.from({length:20},(_,i)=>[i,6,[1,2,3,4],0.5]),
  SUBTOTAL:[...Array.from({length:12},(_,i)=>[i,[1,2,3,4]]),[107,[1,2,3,4]],[111,[1,2,3,4]]],
  IF:[[true],[false],[true,null],[false,1,undefined],[false,1,2,3]],
  IFS:[[false,1,true,2],[true],[errors[0],2]],
  SWITCH:[[1,1,'a'],[1,2,'b','default'],[null,null,'same'],[errors[0],errors[0],4]],
};
for (const name of ['ROUNDDOWN','ROUNDUP']) specific[name]=specific.ROUND;
const cases=[];
for(const {name} of functions){
  const vectors=[...common,...(specific[name]||[])];
  // Transcendental and information boundaries cannot hang or allocate a large array.
  if(/^(?:A?COS|A?SIN|A?TAN|COT|COTH|CSC|CSCH|SEC|SECH|SIGN|SQRT|SQRTPI|LN|LOG|LOG10|IS\w+|N|TYPE)$/.test(name)) vectors.push([NaN],[Infinity],[-Infinity],[new Date(0)]);
  if (/^(?:SIN|COS|TAN|ASIN|ACOS|ATAN|ACOT)$/.test(name)) vectors.push(...[Math.PI,Math.PI/2,1e20,-1e20,1e-200,Number.MAX_VALUE,-Number.MAX_VALUE].map(n=>[n]));
  const samples = name==='RAND'||name==='RANDBETWEEN' ? [0,0.25,0.5,0.9999999999999999] : [0.5];
  for(const args of vectors) for(const sample of samples){
    const clone=v=>Array.isArray(v)?v.map(clone):v instanceof Date?new Date(v):v;
    const originalArgs=args.map(clone);
    const encodedArgs=originalArgs.map(encode);
    const originalRandom=Math.random;Math.random=()=>sample;
    let outcome;
    try { outcome={value:encode(vm.runInNewContext('call()', {call:()=>resolve(name)(...originalArgs)}, {timeout:1000}))}; }
    catch(e){ if(e.code==='ERR_SCRIPT_EXECUTION_TIMEOUT') throw Error(`nonterminating corpus case ${name}`);outcome={threw:String(e.message)}; }
    finally{Math.random=originalRandom;}
    cases.push({name,args:encodedArgs,sample,...outcome});
  }
}
const dir=fileURLToPath(new URL('../../../native/core/fixtures/office-math/',import.meta.url));
mkdirSync(dir,{recursive:true});
const golden=JSON.stringify({version,functions,cases},null,1)+'\n';
writeFileSync(path.join(dir,'golden.json'),golden);
const hash=s=>createHash('sha256').update(s).digest('hex');
const manifest={set:'office-math',recorder:'benchmarks/rust-core/recorders/record-office-math.mjs',command:'node benchmarks/rust-core/recorders/record-office-math.mjs --tree <original tree>',formulajsVersion:version,sourceSha256:hash(text),fileCount:1,totalBytes:Buffer.byteLength(golden),files:[{path:'golden.json',bytes:Buffer.byteLength(golden),sha256:hash(golden)}]};
writeFileSync(path.join(dir,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`${functions.length} function paths, ${cases.length} bounded cases recorded`);

// Reference only: installed @formulajs/formulajs 4.6.1. No product files are written.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
const args = process.argv.slice(2);
const tree = resolve(args[args.indexOf('--tree') + 1] || 'C:/Project/mixdog');
const require = createRequire(`${tree}/package.json`);
const formula = require('@formulajs/formulajs');
const pkg = JSON.parse(await readFile(`${tree}/node_modules/@formulajs/formulajs/package.json`));
if (pkg.version !== '4.6.1') throw new Error(`Expected formulajs 4.6.1, got ${pkg.version}`);
const names = ["AVEDEV", "AVERAGE", "AVERAGEA", "AVERAGEIF", "AVERAGEIFS", "CORREL", "COUNT", "COUNTA", "COUNTBLANK", "COUNTIF", "COUNTIFS", "COVARIANCE.P", "COVARIANCE.S", "DEVSQ", "FISHER", "FISHERINV", "FORECAST", "FREQUENCY", "GEOMEAN", "GROWTH", "HARMEAN", "INTERCEPT", "KURT", "LARGE", "LINEST", "LOGEST", "MAX", "MAXA", "MAXIFS", "MEDIAN", "MIN", "MINA", "MINIFS", "MODE.MULT", "MODE.SNGL", "PEARSON", "PERCENTILE.EXC", "PERCENTILE.INC", "PERCENTRANK.EXC", "PERCENTRANK.INC", "PERMUT", "PERMUTATIONA", "QUARTILE.EXC", "QUARTILE.INC", "RANK.AVG", "RANK.EQ", "RSQ", "SKEW", "SKEW.P", "SLOPE", "SMALL", "STANDARDIZE", "STDEV.P", "STDEV.S", "STDEVA", "STDEVPA", "STEYX", "TREND", "TRIMMEAN", "VAR.P", "VAR.S", "VARA", "VARPA"];
const U = {$: 'undefined'}, NAN = {$: 'number', v: 'NaN'}, INF = {$: 'number', v: 'Infinity'}, NEG = {$: 'number', v: '-Infinity'}, NZ = {$: 'number', v: '-0'};
const E = message => ({$: 'error', v: message});
const D = {$: 'date', v: 1704067200000};
const error = message => Object.values(formula.utils.errors).find(e => e.message === message);
function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (v.$ === 'undefined') return undefined;
    if (v.$ === 'number') return v.v === '-0' ? -0 : Number(v.v);
    if (v.$ === 'error') return error(v.v);
    if (v.$ === 'date') return new Date(v.v);
  }
  return v;
}
function encode(v) {
  if (v === undefined) return {t:'undefined'};
  if (v === null) return {t:'null'};
  if (v instanceof Error) return {t:'error',v:v.message};
  if (v instanceof Date) return {t:'date',v:v.getTime()};
  if (Array.isArray(v)) return {t:'array',v:Array.from(v,encode)};
  if (typeof v === 'number') { const b = Buffer.alloc(8); b.writeDoubleBE(v); return {t:'number',bits:b.toString('hex')}; }
  return {t:typeof v === 'string' ? 'text' : 'bool',v};
}
const rows = [];
function record(name, argv, label) {
  const fn = name.split('.').reduce((o,k)=>o[k],formula);
  if (typeof fn !== 'function') throw new Error(`Missing ${name}`);
  let expected;
  try { expected = {value:encode(fn(...decode(argv)))}; }
  catch(e) { expected = {threw:String(e.message)}; }
  rows.push({name,label,args:argv,expected});
}
const samples = [[],[1],[1,2,3,4],[1,1,2,2,3],[-2,-1,0,2],[1e16,1,-1e16,3],[0.1,0.2,0.3],[[1,2],[3,4]],
 [true,false,'2','bad',null,U],[E('#N/A'),1,E('#DIV/0!')],[null,U],[NAN,1],[INF,1],[NZ,0],[' '],[D,1],['2.5','0x10'],[undefined]];
// An explicit undefined is represented by U before serializing inputs.
samples[samples.length-1] = [U];
const scalars = [U,null,0,NZ,1,-1,0.5,2.9,'2','bad',' ',true,false,NAN,INF,NEG,E('#N/A'),D];
const unaryList = new Set(['AVEDEV','AVERAGE','AVERAGEA','COUNT','COUNTA','COUNTBLANK','DEVSQ','GEOMEAN','HARMEAN','KURT','MAX','MAXA','MEDIAN','MIN','MINA','MODE.MULT','MODE.SNGL','SKEW','SKEW.P','STDEV.P','STDEV.S','STDEVA','STDEVPA','VAR.P','VAR.S','VARA','VARPA']);
const pairs = new Set(['CORREL','COVARIANCE.P','COVARIANCE.S','INTERCEPT','LINEST','LOGEST','PEARSON','RSQ','SLOPE','STEYX','FREQUENCY']);
for (const name of names) {
  record(name, [], 'missing-all');
  if (unaryList.has(name)) {
    for (const [i,s] of samples.entries()) { record(name,[s],`array-${i}`); record(name,s,`variadic-${i}`); }
    for (const [i,s] of scalars.entries()) record(name,[s],`scalar-${i}`);
  } else if (pairs.has(name)) {
    for (const [i,s] of samples.entries()) { record(name,[s,[1,2,3,4]],`left-${i}`); record(name,[[1,2,3,4],s],`right-${i}`); }
    for (const [i,s] of scalars.entries()) record(name,[s,s],`scalar-${i}`);
  } else if (['COUNTIF','AVERAGEIF'].includes(name)) {
    for (const c of ['*','>1','<=2','<>2','north','n*',true,null,U,E('#VALUE!')]) {
      record(name,[[1,2,3,'north',null],c],`criterion-${JSON.stringify(c)}`);
      if (name==='AVERAGEIF') record(name,[[1,2,3,'north',null],c,[10,null,30]],`average-${JSON.stringify(c)}`);
    }
    record(name,[[],'*'], 'empty'); record(name,[1], 'one-arg');
  } else if (['COUNTIFS','AVERAGEIFS','MAXIFS','MINIFS'].includes(name)) {
    for (const s of samples) {
      record(name,[s,[1,2,3,4],'>1'], 'criteria');
      record(name,[s], 'no-criteria');
      record(name,[s,[1,2],'>0',[true,false,true],true], 'unequal-multiple');
    }
  } else if (['FISHER','FISHERINV'].includes(name)) { for (const s of scalars) record(name,[s], 'scalar'); }
  else if (['PERMUT','PERMUTATIONA'].includes(name)) {
    for (const s of [U,null,0,1,5,5.8,'5','bad',true,E('#NUM!')]) for (const k of [U,0,1,2,2.7,6]) record(name,[s,k], 'permutation');
  } else if (name==='STANDARDIZE') { for (const s of scalars) { record(name,[s,2,3], 'value'); record(name,[2,s,0], 'mean-zero-sd'); } }
  else if (name==='FORECAST') { for (const s of samples) record(name,[2,s,[1,2,3,4]], 'regression'); for(const s of scalars) record(name,[s,[2,4],[1,2]],'x'); }
  else if (name==='GROWTH') { for(const s of samples) { record(name,[s], 'defaults'); record(name,[s,[1,2,3,4],[0,2,5],false], 'zero-intercept'); } }
  else if (name==='TREND') { for(const s of samples) record(name,[s,[1,2,3,4],[0,2,5]], 'trend'); }
  else {
    for(const s of samples) record(name,[s,0.5], 'range');
    for(const s of scalars) { record(name,[[1,2,2,4,8],s], 'parameter'); if(name.startsWith('RANK.') || name.startsWith('PERCENTRANK.')) record(name,[[1,2,2,4,8],2,s], 'third'); }
    if(name.startsWith('RANK.')) { for(const n of [0,1,2,3,8,10]) for(const order of [U,0,1,true,'0']) record(name,[n,[1,2,2,4,8],order],'rank'); }
  }
}
// Direct array-like validation and high but bounded factorial products.
for (const s of scalars) record('LARGE',[s,1],'direct-array-like');
for (const n of [20,170,171,172,200,1000]) for (const k of [0,1,2,20]) record('PERMUT',[n,k],'factorial-products');
// Comparator NaN, undefined and stable duplicate order beyond V8's short-run cutoff.
for(const name of ['MEDIAN','MODE.MULT','MODE.SNGL','PERCENTILE.INC','LARGE','SMALL']) {
  const large = Array.from({length:96},(_,i)=>i%13===0?' ':i%17===0?U:((i*37)%29));
  record(name,[large,0.5],'long-mixed-sort');
}
record('LOGEST',[[1,2],[' ',2]],'second-x-conversion-whitespace');
record('LOGEST',[[1,2],[D,2]],'second-x-conversion-date');
record('PERMUT',[2**54,1],'factorial-decrement-does-not-progress');
const source = await readFile(`${tree}/node_modules/@formulajs/formulajs/lib/esm/index.mjs`);
const jstat = await readFile(`${tree}/node_modules/jstat/dist/jstat.js`);
const golden = {format:1, library:'@formulajs/formulajs', version:pkg.version, node:process.version,
 sourceSha256:createHash('sha256').update(source).digest('hex'), jstatSha256:createHash('sha256').update(jstat).digest('hex'), names, cases:rows};
const serialized = JSON.stringify(golden,null,2)+'\n';
if(args.includes('--out')) { const output=resolve(args[args.indexOf('--out')+1]); await mkdir(dirname(output),{recursive:true}); await writeFile(output,serialized); }
else process.stdout.write(serialized);

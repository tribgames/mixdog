// Oracle: official installed Node 22.20.0 / V8 12.4. Writes only radix-golden.json.
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (process.version !== 'v22.20.0' || !process.versions.v8.startsWith('12.4.')) throw Error(`wrong oracle ${process.version}/${process.versions.v8}`);
const bits = value => {const b=Buffer.alloc(8);b.writeDoubleBE(value);return b.toString('hex')};
const fromBits = value => {const b=Buffer.alloc(8);b.writeBigUInt64BE(value);return b.readDoubleBE()};
const values=[0,-0,NaN,Infinity,-Infinity,Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,-Number.MAX_VALUE,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,2**53,2**54,2**1023,2**-1022,0.1,0.2,0.3,1/3,Math.PI,Math.E,1e-7,1e-6,1e20,1e21,1e22,1.005,15.5,35.99999999999999];
let state=0x72616469786e6f64n;
for(let i=0;i<256;i++){state=BigInt.asUintN(64,state^(state<<13n));state^=state>>7n;state=BigInt.asUintN(64,state^(state<<17n));values.push(fromBits(state));}
// Adjacent representable values around binades catch fractional carry/backtracking.
for(const n of [0.5,1,2,10,16,32,2**53,2**-1022]){const b=BigInt('0x'+bits(n));for(const d of [-1n,0n,1n])values.push(fromBits(b+d));}
const stringify=[];
function stringCase(number,radix){let expected;try{expected={value:number.toString(radix)}}catch(e){expected={error:e.message}}stringify.push({number:bits(number),radix:bits(radix),...expected});}
for(let radix=2;radix<=36;radix++)for(const number of values)stringCase(number,radix);
const oddRadices=[0,-0,NaN,Infinity,-Infinity,1,1.9,2.9,10.9,36.9,37,-2,4294967296,4294967298,4294967332,-4294967294,2147483648,9007199254740991,Number.MAX_VALUE];
for(const radix of oddRadices)for(const number of [0,-0,1.5,NaN,Infinity,-Infinity])stringCase(number,radix);
const parse=[];const chunkWitnesses=[];
function intCase(text,radix){const result=parseInt(text,radix);const row={text,radix:bits(radix),bits:bits(result)};parse.push(row);return row;}
const texts=['',' ','\t\n','\u00a0\ufeff-0tail','+','-','- 1','+\t1','0','-0','+000xyz','0x','-0x','0xg','-0x0junk','0Xff','-0XFFtail','0b11','0o77','010','08','1.9','-0.9','1e21','Infinity','NaN','123tail','１２３','١٢٣','9\u00001','123\u2028tail'];
for(const radix of [...Array.from({length:35},(_,i)=>i+2),...oddRadices])for(const text of texts)intCase(text,radix);
const chars='0123456789abcdefghijklmnopqrstuvwxyz';
for(let radix=2;radix<=36;radix++){
 for(const length of [1,7,16,53,128,512,1200,4096]){
  const text=chars[radix-1].repeat(length);intCase(text,radix);intCase('-'+text+'!',radix);intCase('0'.repeat(333)+text+'tail',radix);
 }
 for(let seed=0;seed<12;seed++){
  let text='1';for(let i=0;i<100;i++)text+=chars[(i*17+seed*13)%radix];
  const row=intCase(text,radix);
  let naive=0;for(const ch of text)naive=naive*radix+chars.indexOf(ch);
  if(radix!==10 && (radix&(radix-1))!==0 && bits(naive)!==row.bits)chunkWitnesses.push({text,radix,bits:row.bits,naive:bits(naive)});
 }
}
for(const radix of [0,10])for(const text of ['1'.repeat(309),'1'.repeat(310),'0'.repeat(5000)+'1',Number.MAX_VALUE.toFixed(0),'9007199254740993','9007199254740995'])intCase(text,radix);
for(const radix of [2,4,8,16,32])for(const length of [52,53,54,1023,1024,1025]){intCase('1'+'0'.repeat(length)+'1',radix);intCase('1'+'0'.repeat(length)+'10',radix);}
if(chunkWitnesses.length<10)throw Error('corpus must distinguish V8 chunks from per-digit rounding');
const files=['v8-conversions.cc','v8-double.h','v8-builtins-number.cc','v8-number.tq','LICENSE.v8'];
const reference=Object.fromEntries(files.map(name=>[name,createHash('sha256').update(readFileSync(new URL(`reference/${name}`,import.meta.url))).digest('hex')]));
const result={oracle:{node:process.version,v8:process.versions.v8},upstream:'https://github.com/nodejs/node/tree/v22.20.0/deps/v8',reference,stringify,parse,chunkWitnesses};
writeFileSync(new URL('radix-golden.json',import.meta.url),JSON.stringify(result)+'\n');
console.log(`${stringify.length} stringify, ${parse.length} parse, ${chunkWitnesses.length} chunk-rounding witnesses`);

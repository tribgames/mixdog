// Original library/engine only; output stays beside this recorder.
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=process.argv[2]||'C:/Project/mixdog';
process.env.TZ='UTC';
const lib=await import(pathToFileURL(`${root}/node_modules/@formulajs/formulajs/lib/esm/index.mjs`));
const {evaluateFormula}=await import(pathToFileURL(`${root}/src/runtime/office/portable/xlsx-formula-engine.mjs`));
const {xmlEncode}=await import(pathToFileURL(`${root}/src/runtime/office/portable/portable-xml.mjs`));
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const encode=v=>v===undefined?{t:'undefined'}:v===null?{t:'null'}:typeof v==='string'?{t:'text',units:units(v),utf8:Buffer.from(v).toString('hex'),xmlUtf8:Buffer.from(xmlEncode(v)).toString('hex')}:v instanceof Error?{t:'error',value:v.message}:v instanceof Date?{t:'date',milliseconds:v.getTime()}:Array.isArray(v)?{t:'array',items:v.map(encode)}:typeof v==='number'?{t:'number',bits:(()=>{const b=Buffer.alloc(8);b.writeDoubleBE(v);return b.toString('hex')})()}:{t:'bool',value:v};
const raw=units=>({units});
const decode=v=>v&&typeof v==='object'&&!Array.isArray(v)&&v.units?String.fromCharCode(...v.units):Array.isArray(v)?v.map(decode):v;
const formulas=[
 'VALUE("35%")','VALUE("-0")','VALUE("-0%")',
 'LEFT("😀",1)&RIGHT("😀",1)','CODE(LEFT("😀",1))','UNICODE(RIGHT("😀",1))','CHAR(55296)','LEN(CHAR(55296))',
 'CONCAT(CHAR(55296),CHAR(56320))','CONCATENATE(LEFT("😀",1),RIGHT("😀",1))','TEXTJOIN("",FALSE,LEFT("😀",1),RIGHT("😀",1))',
 'REPT(CHAR(55296),2)','REPLACE("ab",2,1,CHAR(55296))','SUBSTITUTE("a|b","|",CHAR(55296))',
 'NUMBERVALUE(CONCAT("1",CHAR(55296),"2"),".",CHAR(55296))','VALUE(CONCAT(CHAR(55296),"1"))',
 'TYPE(CHAR(55296))','ISTEXT(CHAR(55296))','ISNONTEXT(CHAR(55296))','NOT(CHAR(55296))','AND(CHAR(55296),TRUE)',
 'SUM(CONCAT("12",CHAR(55296)))','UPPER(CONCAT("a",CHAR(55296),"ß"))','EXACT(CHAR(55296),CHAR(55296))',
 'YEAR(DATEVALUE(CONCAT(CHAR(55296)," Jan 1, 2024")))',
 'CHAR(55296)<CHAR(55297)','LEFT("😀",1)<"�"','CONCAT(CHAR(55296),"&<>")',
];
const library=[
 ['CONCAT',[[raw([0xd83d]),raw([0xde00])]]],['REPT',[raw([0xd800]),2]],['REPLACE',[raw([97,0xd800,98]),2,1,raw([0xdc00])]],
 ['SUBSTITUTE',[raw([97,0xd800,98]),raw([0xd800]),raw([0xdc00])]],['LEFT',[raw([0xd800,97]),1]],['RIGHT',[raw([97,0xdc00]),1]],
 ['MID',[raw([97,0xd800,98]),2,1]],['LOWER',[raw([65,0xd800,66])]],['PROPER',[raw([97,0xd800,66])]],['TRIM',[raw([32,0xd800,32,32,97,32])]],
 ['CLEAN',[raw([0,0xd800,31,97])]],['SEARCH',[raw([0xd800]),raw([97,0xd800,98])]],['FIND',[raw([0xdc00]),'😀']],
 ['INDEX',[raw([0xd83d,0xde00]),1]],['MATCH',[raw([0xd800]),[raw([0xd800])],0]],
 ['DATEVALUE',[raw([0xd800,...units(' Jan 1, 2024')])]],['DATEVALUE',[raw([...units('Jan 1, 2024 ('),0xd800,41])]],
 ['MATCH',['?',[raw([0xd800])],0]],['VLOOKUP',[raw([0xd801]),[[raw([0xd800]),1],[raw([0xd802]),2]],2,true]],
];
const result={node:process.version,referenceLocale:Intl.DateTimeFormat().resolvedOptions().locale,formulas:formulas.map(formula=>({formula,value:(()=>{const v=evaluateFormula(formula,{sheet:'S',value:()=>null});return typeof v==='string'&&/^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|GETTING_DATA)$/.test(v)?{t:'error',value:v}:encode(v)})()})),library:library.map(([name,args])=>({name,args,value:encode(lib[name](...args.map(decode)))}))};
const thrownInput=String.fromCharCode(0xd800)+'2';try{lib.SERIESSUM(2,1,1,thrownInput)}catch(e){result.exceptionBoundary={messageUnits:units(e.message),jsonBytes:Buffer.from(JSON.stringify({message:e.message})).toString('hex'),utf8Bytes:Buffer.from(e.message).toString('hex')};}
writeFileSync(new URL('utf16-reference.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(`${result.formulas.length} formulas, ${result.library.length} library cases, explicit XML/UTF8 and exception JSON boundaries`);

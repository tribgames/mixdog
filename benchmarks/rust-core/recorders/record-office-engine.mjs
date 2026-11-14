#!/usr/bin/env node
// Golden of the formula engine (crate mixdog-xlsx-formula): what Node's `runtime/office/portable/xlsx-formula-engine.mjs`
// answers to a corpus of formulas (operators, coercions, errors, references, ranges, sheet names, defined names, refusals)
// read against a stub workbook, with the library functions limited to a fixed handful the replay registers on its side
// (SUM, ABS, IF, IFERROR, ISERROR, ERROR.TYPE, NA, CONCATENATE, DATE, DATEVALUE, and COUNTIF, SUMIF, TEXT for the cases
// the engine refuses before it calls them). Also `formulaReferences`, `translateSharedFormula`, `isBlank` and
// `isFormulaError`. Writes native/core/fixtures/office-engine/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-engine.mjs --tree <product tree>
//
// A value is recorded as { t: 'number', bits } (the 16 hex digits of the IEEE double, so every bit is compared),
// { t: 'text', v }, { t: 'error', v } (text the engine reads as an error), { t: 'bool', v }, { t: 'null' } or
// { t: 'undefined' }; a refusal as { unsupported: reason }; an exception as { threw: message }. `trace` is every
// `context.value(sheet, ref)` call in order. A case with a `zone` ran with that time zone, which the replay pins too.
// The output is byte-stable: the corpus is constants.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-engine.mjs';
const tree = resolveTree(parseArgs());
const identity = productIdentity(tree);

// The engine is loaded from a copy whose library import names the handful instead of the whole of formulajs, so a name
// outside it is "not implemented" here exactly as it is in the replay, and the three functions the engine refuses before
// it calls them throw the one message the replay's stand-ins throw. The copy is deleted as soon as it is loaded.
const HANDFUL = ['SUM', 'ABS', 'IF', 'IFERROR', 'ISERROR', 'NA', 'CONCATENATE', 'DATE', 'DATEVALUE'];
const NOT_RECORDED = ['COUNTIF', 'SUMIF', 'TEXT'];
const portable = path.join(tree, 'src', 'runtime', 'office', 'portable');
const runDir = path.join(FIXTURES_ROOT, 'office-engine.run');
rmSync(runDir, { recursive: true, force: true });
mkdirSync(runDir, { recursive: true });
const library = pathToFileURL(path.join(tree, 'node_modules', '@formulajs', 'formulajs', 'lib', 'esm', 'index.mjs')).href;
writeFileSync(
  path.join(runDir, 'recorded-library.mjs'),
  [
    `import * as real from '${library}';`,
    `export const { ${HANDFUL.join(', ')}, utils } = real;`,
    'export const ERROR = { TYPE: real.ERROR.TYPE };',
    "const refused = () => { throw new Error('this function is not part of the recorded library'); };",
    ...NOT_RECORDED.map((name) => `export const ${name} = refused;`),
    '',
  ].join('\n')
);
const original = readFileSync(path.join(portable, 'xlsx-formula-engine.mjs'), 'utf8');
const patched = original
  .replace("from '@formulajs/formulajs'", "from './recorded-library.mjs'")
  .replace("from './portable-cells.mjs'", `from '${pathToFileURL(path.join(portable, 'portable-cells.mjs')).href}'`);
if (patched.split('recorded-library.mjs').length !== 2 || !patched.includes('portable-cells.mjs')) throw new Error('the engine imports changed');
writeFileSync(path.join(runDir, 'xlsx-formula-engine.mjs'), patched);
const engine = await import(pathToFileURL(path.join(runDir, 'xlsx-formula-engine.mjs')).href);
rmSync(runDir, { recursive: true, force: true });
const { UnsupportedFormula, evaluateFormula, formulaReferences, translateSharedFormula, isBlank, isFormulaError } = engine;

const WORKBOOK = {
  sheets: {
    Sheet1: {
      A1: 2, A2: 3, A3: '4', A4: ' 5 ', A5: 'abc', A6: true, A7: null, A8: '', A9: '#N/A', A10: '#DIV/0!',
      B1: 'north', B2: 'South', B3: '가나다', B4: 'ß', B5: 0, B6: 'a*b',
      C1: true, C2: false, C3: 1e300, C4: 0.1, C5: '0x10', C6: '1e3', C7: 'Infinity', C8: '1,5', C9: '2024-01-31', C10: 45322.5,
      D1: 10, D2: 'text', D3: '#VALUE!', D4: '#NAME?', D5: '#NULL!', D6: '#REF!', D7: '#NUM!',
      E1: '#CALC!', E2: '#GETTING_DATA', E3: '#ERROR!', E4: '#n/a', E5: ' #N/A',
    },
    'Raw Data': { A1: 'x', B2: 21, B3: 4, C2: 0.5 },
    데이터: { A1: 7, A2: '값', B1: 1 },
    "It's": { A1: 1, B2: 5, C3: 'z' },
  },
  extents: { Sheet1: { rows: 10, columns: 5 }, 'Raw Data': { rows: 3, columns: 3 } },
  names: {
    TAXRATE: "'Raw Data'!$B$2",
    UPLIFT: '1.5',
    TOTAL: 'SUM(A1:A2)',
    EMPTY: '',
    BADNAME: 'SUM(',
    NAMEREF: 'TAXRATE',
    EQ: '=Sheet1!A1*2',
    RANGENAME: 'A1:A2',
    ERRNAME: '#REF!',
    TEXTNAME: '"a"&"b"',
  },
  // A sheet that is not in the workbook refuses; one that throws is an exception the engine lets escape.
  missingSheet: 'Missing',
  throwingSheet: 'Boom',
};

const upperNames = new Map(Object.entries(WORKBOOK.names));

function contextFor(sheet, trace) {
  return {
    sheet,
    value(target, ref) {
      trace.push(`${target}!${ref}`);
      if (target === WORKBOOK.missingSheet) throw new UnsupportedFormula(`sheet "${target}" is not in this workbook`);
      if (target === WORKBOOK.throwingSheet) throw new Error('boom');
      const cells = WORKBOOK.sheets[target];
      return cells && Object.hasOwn(cells, ref) ? cells[ref] : '';
    },
    extent: (target) => WORKBOOK.extents[target],
    definedName: (name) => upperNames.get(name.toUpperCase()) || '',
  };
}

const bits = (number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(number);
  return buffer.toString('hex');
};

function encode(value) {
  if (value === null) return { t: 'null' };
  if (value === undefined) return { t: 'undefined' };
  if (typeof value === 'number') return { t: 'number', bits: bits(value) };
  if (typeof value === 'string') return isFormulaError(value) ? { t: 'error', v: value } : { t: 'text', v: value };
  if (typeof value === 'boolean') return { t: 'bool', v: value };
  throw new Error(`unexpected result ${String(value)}`);
}

const TRACE_LIMIT = 64;
const ZONES = { 'Asia/Seoul': -540, 'America/Los_Angeles': 480, UTC: 0 };
function useZone(zone) {
  process.env.TZ = zone;
  const offset = new Date(2024, 0, 31).getTimezoneOffset();
  if (offset !== ZONES[zone]) throw new Error(`the time zone ${zone} did not take effect (offset ${offset})`);
}

const attempt = (run) => {
  try {
    return { value: encode(run()) };
  } catch (error) {
    if (error instanceof UnsupportedFormula) return { unsupported: error.reason };
    return { threw: String(error?.message ?? error) };
  }
};

function recordCase(formula, { sheet = 'Sheet1', zone = 'Asia/Seoul' } = {}) {
  useZone(zone);
  const trace = [];
  const outcome = attempt(() => evaluateFormula(formula, contextFor(sheet, trace)));
  return { formula, ...(sheet === 'Sheet1' ? {} : { sheet }), zone, traceCount: trace.length, trace: trace.slice(0, TRACE_LIMIT), ...outcome };
}

const OPERATORS = [
  '=1+2', '=2+3*4', '=(1+2)*3', '=-2^2', '=2^3^2', '=-(2)^2', '=--2', '=+-+-3', '=10%', '=10%%', '=50%*2', '=-10%', '=2^-1', '=2*-3',
  '=1/3', '=7/2', '=1/0', '=0/0', '=-1/0', '=1-1/3', '=0.1+0.2', '=0.1*3', '=1e21+1', '=1e308*10', '=-1e308*10', '=2^1024', '=2^0.5', '=(-8)^(1/3)',
  '=0^0', '=0^-1', '=(-2)^3', '=(-2)^0.5', '=10^15+0.3', '=9007199254740993+0', '=1e-7+0', '=5e-324*1', '=2^53+1', '=100*1.1', '=3*0.1', '=4.35*100',
  '=1.005*1000', '=0.1^3', '=1.1^10', '=2^0.1', '=10^-5', '=3^3.5', '=7^0.25', '=1234.5678*8765.4321', '=1/7', '=22/7', '=1e15/3',
  '=.5+.5', '=1.5e3', '=1E-2', '=007+1', '=1e999', '=-1e999', '=1e999-1e999', '=0*1e999', '=1e999*0+1',
  '=1&2', '="a"&"b"', '=1&"x"&TRUE', '=1/3&""', '=0.1+0.2&""', '=1e21&""', '=1e-7&""', '=-0&""', '=100&""', '=123456789012345680000&""', '=TRUE&FALSE',
  '="a"&"b"&"c"&1', '="""quoted"""', '=""""', '=""&""', '="a""b"&"c"', '="a" & "b"', '=" "&"x"',
  '=1=1', '=1<>1', '=1<2', '=2<=2', '=3>=4', '="a"="A"', '="a"<"B"', '="B"<"a"', '=2<"a"', '="a"<2', '=2<"10"', '="2"<10', '=TRUE>FALSE', '=TRUE=1',
  '=1="1"', '=0=""', '=""=""', '="가"<"나"', '="ß"="SS"', '="ß"="ß"', '="Ä"="ä"', '="\u{e000}"<"\u{10000}"', '=1<>"a"', '=1.0=1', '=1e999=1e999',
  '=TRUE+1', '=FALSE*5', '=TRUE&1', '="3"+4', '=" 3 "+4', '="3x"+4', '=""+1', '="0x10"+0', '="1e3"+0', '="Infinity"+0', '="1,5"+0', '=" "+1', '="-"+1', '=".5"+1', '="5."+1',
  '=1<2<3', '=3>2>1', '=1=1=1', '=2+3&4', '=2&3+4', '=1+2=3', '=1&2=12', '=-"3"', '=+"a"', '="a"%', '="50"%', '=-TRUE', '=--"4"',
];

const ERRORS = [
  '=#N/A', '=#DIV/0!', '=#VALUE!', '=#NAME?', '=#NUM!', '=#NULL!', '=#REF!', '=#GETTING_DATA', '=#ERROR!', '=#CALC!', '=#n/a',
  '=#N/A+1', '=1+#N/A', '=#N/A+#DIV/0!', '=#DIV/0!+#N/A', '=1/0+#N/A', '=#N/A&"x"', '="x"&#N/A', '=#N/A=#N/A', '=1<#N/A', '=#REF!*0', '=-#N/A', '=#N/A%', '=--#DIV/0!',
  '=1+(2/0)+3', '=(1/0)*(1/0)', '=2^(1/0)', '=(1/0)^2', '=1&(1/0)', '=(1/0)&(#N/A)',
  '="#N/A"', '="#N"&"/A"', '="#N/A"+1', '="#VALUE!"&""', '="#CALC!"', '="#CALC!"&"x"', '="#GETTING_DATA"+1', '="#n/a"', '=" #N/A"', '="#N/A "',
  '=Data!#REF!', '=Data!#REF!+1', '=#REF!B2:B4', '=#REF!B2:B4+1', "='Raw Data'!#REF!A1", '=Sheet1!#REF!A1:B2', '=Data!#DIV/0!', '=#REF!1', '=Data!#REF!!',
  '=A9', '=A9+1', '=A10*2', '=D3&"x"', '=D4', '=D5+0', '=D6<1', '=D7', '=E1', '=E1+1', '=E2', '=E2+1', '=E3', '=E4', '=E5', '=E5+1', '=SUM(A9)', '=SUM(A10,1)',
];

const REFERENCES = [
  '=A1', '=a1', '=$A$1', '=A$1+$A2', '=A1+A2', '=A3+1', '=A4+1', '=A5', '=A5+1', '=A6', '=A6+1', '=A7', '=A7+1', '=A8', '=A8+1', '=A7&"x"', '=A8&"x"', '=A7=0', '=A8=0', '=A7=""',
  '=B1="NORTH"', '=B1<B2', '=B3>B1', '=B4="SS"', '=C1+C2', '=C3*10', '=C4*3', '=C5+1', '=C6+1', '=C7+1', '=C8+1', '=C9', '=C10', '=C9+1', '=ZZ9+1', '=ZZZ99', '=XFD1048576', '=A1048577',
  '=A0', '=A0+1', '=AAAA1', '=A99999999', '=A12345678',
  '=Sheet1!A1', '=sheet1!A1', "='Sheet1'!A1", "='Raw Data'!B2*2", "='raw data'!B2", "='Raw Data'!$B$2+'Raw Data'!B3", "='Raw Data'!A1&'Raw Data'!B2", '=데이터!A1+1', '=데이터!A2&"!"', "='데이터'!B1", "='It''s'!A1+'It''s'!B2",
  "='It''s'!C3", '=Nowhere!A1', '=Missing!A1', '=Boom!A1', '=Sheet1!A1+Missing!A1', '=Missing!A1+Boom!A1', '=Boom!A1+Missing!A1', "=''!A1", "='a''b'!A1", "='a!b'!A1", "='a b'!A1", '=_x!A1', '=a.b!A1', '=a1.b!C2', '=1a!A1',
  '=SUM(A1:A2)', '=SUM(A1:B2)', '=SUM(B2:A1)', '=SUM(A1:A1)', '=SUM($A$1:$A$3)', '=SUM(A1:A10)', '=SUM(A1:D1)', '=SUM(Sheet1!A1:A2)', "=SUM('Raw Data'!B2:B3)", "=SUM('Raw Data'!B2:C3)", '=SUM(데이터!A1:B2)',
  "=SUM('It''s'!$a$1:C3)", '=SUM(A1:A2,B2:B3,4)', '=SUM(A1:A2)+SUM(A3:A4)', '=SUM(A1:ZZ1)', '=SUM(A1:A200001)', '=SUM(A1:AAA1)', '=SUM(A1:ZZZ9999999)', '=SUM(A0:B1)', '=SUM(A1:B0)', '=SUM(A1:A0)', '=SUM(A0:A0)',
  '=SUM(A:A)', '=SUM(A:B)', '=SUM(B:A)', '=SUM($A:$A)', '=SUM(Sheet1!A:A)', "=SUM('Raw Data'!B:B)", '=SUM(데이터!A:A)', '=SUM(1:1)', '=SUM(2:3)', '=SUM(3:2)', '=SUM($1:$1)', '=SUM(Sheet1!1:2)', "=SUM('Raw Data'!2:3)", '=SUM(데이터!1:1)',
  '=SUM(Missing!A:A)', '=SUM(AAA:AAA)', '=SUM(1:1048576)', '=SUM(1:99999)', '=SUM(0:0)', '=SUM(A1:B)', '=SUM(A:1)', '=SUM(1:A)',
  '=A1:A2', '=A1:A2+1', '=1+A1:A2', '=-A1:A2', '=A1:A2%', '=A1:A2&"x"', '="x"&A1:A2', '=A1:A2=1', '=1<A1:A2', '=ABS(A1:A2)', '=IF(A1:A2,1,2)', '=IF(1,A1:A2,2)', '=SUM(A1:A2)&A1:A2',
  '=Sheet1!A1:Sheet1!A2', '=A1 A2', '=A1:A2 B1', '=(A1,A2)', '=A1;A2', '=A1:B2:C3', '=A1:', '=:A1', '=A1::A2',
];

const NAMES = [
  '=TaxRate', '=TaxRate*21', '=taxrate*2', '=TAXRATE', '=Uplift*4', '=Total', '=Total+1', '=Empty', '=Empty+1', '=BadName', '=NameRef', '=NameRef*2', '=EQ', '=EQ+1', '=RangeName', '=RangeName+1', '=ErrName', '=ErrName+1', '=TextName', '=TextName&"!"',
  '=Undefined', '=Undefined+1', '=Sheet1', '=a', '=A', '=AB', '=ABC', '=ABCD', '=a.b', '=_x', '=_x1', '=x_1+1', '=TRUE', '=true', '=True', '=FALSE', '=false', '=TRUE()', '=TRUE+TRUE', '=NOT_A_NAME', '=name.with.dots', '=Name1', '=A1B', '=A1 B', '=1A',
];

const CALLS = [
  '=SUM(1,2,3)', '=SUM()', '=SUM(A1:A2)', '=sum(1,2)', '=Sum(1,2)', '=_xlfn.SUM(1,2)', '=_XLFN.SUM(1,2)', '=_xlws.SUM(1,2)', '=_xlfn._xlws.SUM(1,2)', '=_xlws._xlfn.SUM(1,2)', '=_xlfn.sum(1)', '=_xlfn.NOTAFUNCTION(1)', '=_xlfn.(1)',
  '=SUM (1,2)', '=SUM\t(1,2)', '=SUM\n(1)', '=SUM( 1 , 2 )', '=SUM(1,)', '=SUM(,1)', '=SUM(,)', '=SUM(1 2)', '=SUM(1,2', '=SUM(1,2))', '=SUM((1,2))', '=SUM(((1)))', '=SUM(SUM(1,2),SUM(3,4))', '=SUM(SUM(SUM(SUM(1))))',
  '=SUM(1,"2",TRUE,"x")', '=SUM("1",2)', '=SUM(A1:A8)', '=SUM(A3,A4,A5)', '=SUM(A6,C1)', '=SUM(A7)', '=SUM(A1,A9)', '=SUM(A1:A9)', '=SUM(1,#N/A)', '=SUM(#N/A,#DIV/0!)', '=SUM(1/0,2)', '=SUM(1,2/0,#N/A)', '=SUM(A1:A2,#REF!)',
  '=SUM("")', '=SUM(" ")', '=SUM("0x10")', '=SUM("1e3")', '=SUM("1,5")', '=SUM("5%")', '=SUM(".5")', '=SUM(C5,C6,C7,C8)', '=SUM(1e308,1e308)', '=SUM(-1e308,-1e308)', '=SUM(0.1,0.2)', '=SUM(0.1,0.2,0.3)', '=SUM(1e21,1)',
  '=ABS(-3)', '=ABS("-3")', '=ABS("x")', '=ABS(A7)', '=ABS(A8)', '=ABS(TRUE)', '=ABS(A5)', '=ABS(-0)', '=ABS(1/0)', '=ABS(-1e999)', '=ABS()', '=ABS(1,2)', '=ABS(" 5 ")', '=ABS("0x10")',
  '=IF(TRUE,1,2)', '=IF(FALSE,1,2)', '=IF(1,"a","b")', '=IF(0,"a","b")', '=IF("",1,2)', '=IF("a",1,2)', '=IF("false",1,2)', '=IF(A1>1,"big","small")', '=IF(A1=0,0,10/A1)', '=IF(A1<>0,10/A1,0)', '=IF(A1=0,10/A1,0)',
  '=IF(1/0,1,2)', '=IF(TRUE,1/0,2)', '=IF(FALSE,1,1/0)', '=IF(TRUE)', '=IF(FALSE)', '=IF(TRUE,)', '=IF(FALSE,1,)', '=IF()', '=IF(A7,1,2)', '=IF(A8,1,2)', '=IF(A6,1,2)', '=IF(#N/A,1,2)', '=IF(TRUE,#N/A,2)', '=IF(TRUE,A1:A2,2)', '=IF(1,2,3,4)',
  '=IFERROR(1/0,"safe")', '=IFERROR(1,"safe")', '=IFERROR(#N/A,0)', '=IFERROR(A9,"x")', '=IFERROR(A5,"x")', '=IFERROR("a"+1,"bad")', '=IFERROR(1/0)', '=IFERROR(1/0,)', '=IFERROR(1/0,#N/A)', '=IFERROR(1/0,1/0)', '=IFERROR(IFERROR(1/0,#N/A),"z")',
  '=IFERROR(E1,"x")', '=IFERROR(E3,"x")', '=IFERROR(E4,"x")', '=IFERROR(1e999,"inf")', '=IFERROR(0*1e999,"nan")', '=IFERROR(A1:A2,1)',
  '=ISERROR(1/0)', '=ISERROR(1)', '=ISERROR(#N/A)', '=ISERROR("#N/A")', '=ISERROR(A9)', '=ISERROR(A1)', '=ISERROR(1e999)', '=ISERROR(0*1e999)', '=ISERROR(E1)', '=ISERROR("a"+1)', '=ISERROR(#REF!)', '=ISERROR(#NULL!)', '=ISERROR(#NUM!)', '=ISERROR(E2)', '=IFERROR(E2,"x")', '=ERROR.TYPE(E2)', '=ISERROR(E3)', '=ISERROR(F1)', '=STDEV(A1:A2)', '=_xlfn.RANK.EQ(1,A1:A2)', '=NORM.DIST(1,0,1,TRUE)',
  '=ERROR.TYPE(#NULL!)', '=ERROR.TYPE(#DIV/0!)', '=ERROR.TYPE(#VALUE!)', '=ERROR.TYPE(#REF!)', '=ERROR.TYPE(#NAME?)', '=ERROR.TYPE(#NUM!)', '=ERROR.TYPE(#N/A)', '=ERROR.TYPE(1/0)', '=ERROR.TYPE("a"+1)', '=ERROR.TYPE(1)', '=ERROR.TYPE(A9)', '=error.type(A10)', '=ERROR.TYPE()', '=ERROR(1)', '=ERROR.TYPE.X(1)',
  '=NA()', '=NA()+1', '=IFERROR(NA(),0)', '=NA(1)', '=ISERROR(NA())', '=NA', '=NA ()',
  '=CONCATENATE("a","b")', '=CONCATENATE(1,2)', '=CONCATENATE(A1,B1)', '=CONCATENATE(TRUE,FALSE)', '=CONCATENATE(A1:A2)', '=CONCATENATE(A1:B2)', '=CONCATENATE(A7,"x")', '=CONCATENATE()', '=CONCATENATE("a",1/0)', '=CONCATENATE(0.1+0.2,"x")',
  '=CONCATENATE(B1:B3,"-")', '=CONCATENATE(A1,A5,A6)', '=CONCATENATE(1e21,1e-7)', '=CONCATENATE("a",#N/A)', '=CONCATENATE(A9,"x")',
  '=NOTAFUNCTION(1)', '=NOTAFUNCTION()', '=notafunction(1)', '=A1(1)', '=LOG10(100)', '=SUM.X(1)', '=SUM.(1)', '=1(2)', '=ISBLANK(A1)', '=ISBLANK(A7)', '=ISBLANK(A9)', '=isblank(Z1)', '=_xlfn.ISBLANK(A1)', '=ISBLANK()', '=IF(ISBLANK(A1),1,2)', '=1+ISBLANK(A1)',
  '=ROW(A1)', '=COLUMN(A1)', '=OFFSET(A1,1,1)', '=INDIRECT("A1")', '=ADDRESS(1,1)', '=CELL("row",A1)', '=AREAS(A1)', '=FORMULATEXT(A1)', '=row()', '=_xlfn.FORMULATEXT(A1)', '=ROW(Missing!A1)', '=ROW(1/0)', '=ROW(NOTAFUNCTION(1))',
  '=COUNTIF(A1:A2,"n*")', '=COUNTIF(A1:A2,"nor?h")', '=COUNTIF(B1:B2,"*")', '=COUNTIF(B1:B2,"?")', '=COUNTIF(B1:B2,"~*")', '=COUNTIF(B1:B2,"~?x")', '=COUNTIF(B1:B2,"a~*b*")', '=COUNTIF(B6,"a*b")', '=COUNTIF(B1:B2,B6)', '=SUMIF(B1:B1,"nor?h",A1:A1)', '=SUMIF(A1:A2,"*",A1:A2)', '=SUMIF(A1:A2,#NAME?,A1:A2)', '=SUMIF(A1:A2,#N/A,A1:A2)',
  '=COUNTIF(A1:A2,1/0)', '=COUNTIF(A1:A2,#REF!)', '=COUNTIF(A1:A2,#NUM!)', '=COUNTIF(A1:A2,"가*")', '=COUNTIF(A1:A2,"?가")', '=COUNTIF(A1:A2,"*")+1', '=countif(A1:A2,"*")', '=_xlfn.COUNTIF(A1:A2,"*")', '=COUNTIF(A1:A2,B1:B2)', '=COUNTIF("*",A1)',
  '=TEXT(A1,"yyyy-mm-dd")', '=TEXT(A1,"yyyy")', '=TEXT(A1,"mm")', '=TEXT(A1,"DD")', '=TEXT(A1,"hh:mm")', '=TEXT(A1,"ss")', '=TEXT(A1,"0.00")', '=TEXT(A1,"#,##0")', '=TEXT(A1,"0%")', '=TEXT(A1,"0.0E+00")', '=TEXT(A1,"General")', '=TEXT(A1,"@")', '=TEXT(A1,"[$-409]0")',
  '=TEXT(A1,"0 ""days""")', '=TEXT(A1,"""yy""0")', '=TEXT(A1,"\\y0")', '=TEXT(A1,"0\\m")', '=TEXT(A1,"0 \\d \\h")', '=TEXT(A1,"\\")', '=TEXT(A1,"0\\")', '=TEXT(A1,"""y")', '=TEXT(A1,"y""")', '=TEXT(A1,"""a""""y")', '=TEXT(A1,"""a"" y")',
  '=TEXT(A1)', '=TEXT()', '=TEXT(A1,)', '=TEXT(A1,"")', '=TEXT(A1,A5)', '=TEXT(A1,B1)', '=TEXT(A1,B3)', '=TEXT(A1,TRUE)', '=TEXT(A1,FALSE)', '=TEXT(A1,1)', '=TEXT(A1,A1:A2)', '=TEXT(A1,B1:B2)', '=TEXT(A1,#N/A)', '=TEXT(A1,#DIV/0!)', '=TEXT(A1,#REF!)', '=TEXT(A1,#NUM!)', '=TEXT(A1,#NAME?)', '=TEXT(A1,#VALUE!)', '=TEXT(A1,#NULL!)',
  '=TEXT(A1,"ｙ")', '=TEXT(A1,"ſ")', '=TEXT(A1,"K")', '=TEXT(1/0,"yyyy")', '=TEXT(A1,"0")+1', '=TEXT(A1,A7)', '=TEXT(A1,A8)', '=TEXT(A1,A6)',
];

const DATE_CASES = [
  '=DATE(2024,1,31)', '=DATE(2024,5,6)', '=DATE(2024,2,29)', '=DATE(2023,2,29)', '=DATE(2024,13,1)', '=DATE(2024,0,1)', '=DATE(2024,1,0)', '=DATE(2024,1,32)', '=DATE(1900,1,1)', '=DATE(1900,2,28)', '=DATE(1900,3,1)', '=DATE(1899,12,31)',
  '=DATE(1970,1,1)', '=DATE(2024,3,10)', '=DATE(2024,11,3)', '=DATE(2024,3,31)', '=DATE(2024,10,27)', '=DATE(9999,12,31)', '=DATE(10000,1,1)', '=DATE(2024.9,1.9,1.9)', '=DATE("2024","1","31")', '=DATE(A1,A2,1)', '=DATE(2024,1)', '=DATE()',
  '=DATE(-1,1,1)', '=DATE(2024,-6,1)', '=DATE(2024,1,-400)', '=DATE("x",1,1)', '=DATE(1/0,1,1)', '=DATE(TRUE,1,1)', '=DATE(A7,1,1)', '=DATE(1e10,1,1)', '=DATE(2024,1,1)+1', '=DATE(2024,1,1)&""', '=DATE(2024,1,1)=45292', '=DATE(2024,1,31)-DATE(2024,1,1)',
  '=DATEVALUE("2024-01-31")', '=DATEVALUE("January 31, 2024")', '=DATEVALUE("2024-01-31T12:00:00")', '=DATEVALUE("1/31/2024")', 
  '=DATEVALUE("x")', '=DATEVALUE("")', '=DATEVALUE(5)', '=DATEVALUE(A9)', '=DATEVALUE(C9)', '=DATEVALUE(C10)', '=DATEVALUE(TRUE)', '=DATEVALUE("1900-01-01")', '=DATEVALUE("1900-03-01")', '=DATEVALUE("1899-12-30")', '=DATEVALUE("1970-01-01")', '=DATEVALUE("9999-12-31")',
  '=DATEVALUE("2024-03-10")', '=DATEVALUE("2024-11-03")', '=DATEVALUE("Mon, 06 May 2024 10:00:00 GMT")', '=DATEVALUE("2024-01-31T00:00:00Z")', '=DATEVALUE("2024-01-31T00:00:00+09:00")', '=DATEVALUE()', '=DATEVALUE(1/0)', '=DATEVALUE("2024-01-31")+1',
];

const FAILURES = [
  '', '=', '=  ', '=\t\n', '= ', '==1', '=1=', '=(', '=)', '=()', '=(1', '=1)', '=((1)', '=1+', '=+', '=*1', '=1**2', '=1//2', '=1 2', '=1 +', '=1,2', '=,', '=1;2', '=1+@', '=1+$', '={1}', '=1{', '=[1]', '=[Book1]Sheet1!A1', '=SUM([Book1]Sheet1!A1)', '=Table1[Col]', '=Table1[[#This Row],[Col]]',
  '=[', '=]', '=][', '=1]', '=[1', '=A1[', '="["', '="]"', '="[x]"', '=1+"[x]"', '=\'[Book1]S\'!A1', '=!A1', '=A1!', '=A1!B1', '=\'a\'', '=\'', '="unterminated', '="a""', '="a"""', '="a""b', '="a" "b"', '=""""""', '=\\', '=?', '=#', '=#GETTING_DATA', '=#N/A!', '=#na', '=%', '=1%%%%%', '=%1', '=1%2',
  '=1.', '=1..2', '=.', '=.e5', '=1e', '=1e+', '=1e5e5', '=0x10', '=1_000', '=1,000', '=$1', '=$A', '=A$', '=$$A1', '=A1$', '=1$', '=AAAA', '=A1A1', '=A:B:C', '=A:1', '=1:A', '=:', '=::', '=1:', '=:1', '=A1:B2:', '=<', '=>', '=<>', '=1<>', '=<1', '=1<<2', '=1><2', '=1=>2', '=1=<2', '=!', '=~1', '=`1`', '=\u{00a0}1+1\u{00a0}', '=\u{2003}2\u{3000}', '=1\u{feff}+1', '=\u{200b}1',
  '=가', '=가+1', '=가(1)', '=1+나', '=Ä+1', '=ä', '=_', '=_1', '=__', '=.5.5', '=5.5.', '=1 e5', '=1.e5', '=a b', '=SUM(1)(2)', '=SUM(1)SUM(2)', '=(1)(2)', '=(1)2', '=1(2)', '=SUM(', '=SUM(1,', '=SUM(,', '=SUM(1,2,3', '=SUM(()', '=((((', '=))))', '=SUM(1)2',
];

const DEPTH = [
  `=${'('.repeat(100)}1${')'.repeat(100)}`, `=${'-'.repeat(1000)}1`, `=${'+'.repeat(1000)}1`, `=${vecJoin(2000, '1', '+')}`, `=${vecJoin(2000, '1', '&')}`, `=${vecJoin(1000, '2', '^')}`, `=${'SUM('.repeat(50)}1${')'.repeat(50)}`, `=1${'%'.repeat(1000)}`,
];

function vecJoin(count, item, separator) {
  return Array.from({ length: count }, () => item).join(separator);
}

const cases = [];
for (const group of [OPERATORS, ERRORS, REFERENCES, NAMES, CALLS, FAILURES, DEPTH]) for (const formula of group) cases.push(recordCase(formula));
for (const formula of DATE_CASES) for (const zone of Object.keys(ZONES)) cases.push(recordCase(formula, { zone }));
// A formula evaluated from another sheet reads its unqualified references there.
for (const formula of ['=A1', '=A1+B2', '=SUM(A1:B2)', '=SUM(A:A)', '=Sheet1!A1+A1', "='Raw Data'!B2+B2", '=TaxRate', '=SUM(1:2)']) {
  for (const sheet of ["Raw Data", '데이터', "It's", 'Nowhere']) cases.push(recordCase(formula, { sheet }));
}
useZone('Asia/Seoul');

const referenceFormulas = [
  'A1+B2', 'SUM(A1:B2)', 'SUM($A$1:B$2)+Data!C3', "'Raw Data'!B2*'It''s'!A1", 'SUM(A:A,B:B)', 'SUM(1:3)', '"A1"&A1', 'A1 B2', 'A1:B2 C3:D4', 'SUM(데이터!A1)', '가!A1+1', '"x"&가!A1+B2', 'Data!#REF!+A1', '#REF!B2:B4+C1', '#REF!+A1', '#N/A+A1',
  'ROW(A1)+COLUMN(B1)', '_xlfn.SUM(A1)', 'Sheet1!$A:$A+Sheet1!1:1', "'a'!A1", "'a''b'!A1:B2", 'LOG10(A1)', 'LOG10 (A1)', 'A1(B1)', 'IF(A1>1,B1,C1)', 'A1B2', 'A1.5', 'AB', 'AB:CD', '1:2', '$1:$2', '$A:$B', 'A$1:$B2', 'Sheet 1!A1', '', ' ', '@', 'A1+@', '=A1', '==A1',
  '1+1', '"abc"', '"a""A1"', 'TRUE', 'SUM(', 'A1:', '[x]A1', 'ＡＢ1', 'ZZZ9999999+A0', 'XFD1048576+A1048577', 'a1+b2+c3', "'x'!a1:b2",
].map((formula) => {
  const result = (() => {
    try {
      return { references: formulaReferences(formula) };
    } catch (error) {
      if (error instanceof UnsupportedFormula) return { unsupported: error.reason };
      return { threw: String(error?.message ?? error) };
    }
  })();
  return { formula, ...result };
});

const translations = [];
const translationFormulas = [
  '=A1*$C$1', 'A1+B2', 'SUM(A1:B2)', 'SUM($A$1:B$2)', 'Data!C3+\'Raw Data\'!D4', 'SUM(A:A)', 'SUM(2:3)', 'SUM($A:$A)', 'SUM(A$1:$A1)', '"A1"&A1', 'A1 B2', 'Data!#REF!+A1', '#REF!B2:B4', 'A1+A$1+$A1+$A$1', 'ZZZ9999999+A0',
  'SUM(A:B)+SUM(1:3)', 'XFD1+A1', 'a1+B1', '$a$1+a$1', '', 'A1+@', 'SUM(', '가!A1+B2', "'Sheet 1'!A1", '=1+1', '$007+A007', 'A$0+A0', 'AAA1', 'SUM($1:$1)',
];
const deltas = [[0, 0], [1, 0], [0, 1], [2, 3], [-1, 0], [0, -1], [5, -2], [-5, 5], [100, 100], [1048570, 0], [0, 16000], [1, 1]];
for (const formula of translationFormulas) {
  for (const [rowDelta, columnDelta] of deltas) {
    const result = (() => {
      try {
        return { value: translateSharedFormula(formula, rowDelta, columnDelta) };
      } catch (error) {
        if (error instanceof UnsupportedFormula) return { unsupported: error.reason };
        return { threw: String(error?.message ?? error) };
      }
    })();
    translations.push({ formula, rowDelta, columnDelta, ...result });
  }
}

const predicates = [null, undefined, '', ' ', 0, false, 'a', true, '#N/A', '#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!', '#NULL!', '#GETTING_DATA', '#ERROR!', '#CALC!', '#n/a', '#N/A ', ' #N/A', 'N/A', '#REF', '#REF!1'].map((value) => ({
  input: value === undefined ? { t: 'undefined' } : value === null ? { t: 'null' } : { t: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : 'text', v: value },
  isBlank: isBlank(value),
  isFormulaError: isFormulaError(value),
}));

const out = { workbook: WORKBOOK, tzOffsets: ZONES, cases, references: referenceFormulas, translations, predicates };

const fixtures = path.join(FIXTURES_ROOT, 'office-engine');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 1)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-engine', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes, ${cases.length} cases`);

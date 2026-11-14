// Pinned Node Date.toString oracle. Locale-specific name probes use Intl only
// on stable current metazones/fixed-offset zones, where its LONG field and
// TimeZone::getDisplayName agree. Actual Date strings always use the OS locale.
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const dataPath=resolve(root,'native/core/crates/mixdog-js/src/date_string/data/icu77-date-names.json.gz');
const compressed=await readFile(dataPath);const data=JSON.parse(gunzipSync(compressed));
if(process.versions.node!=='22.20.0'||process.versions.icu!=='77.1'||process.versions.tz!=='2025b')throw Error('Pinned Node22.20/ICU77.1/tz2025b is required');
const defaultLocale=new Intl.DateTimeFormat().resolvedOptions().locale;
const referenceNow=Math.floor(Date.now()/1000);
const dates=[];
const timeValues=[0,-1,Date.parse('1900-01-01T00:00:00Z'),Date.parse('2024-01-15T12:00:00Z'),Date.parse('2024-07-15T12:00:00Z'),Date.parse('2040-07-15T12:00:00Z')];
for(const zone of Object.keys(data.zoneNames)){
 process.env.TZ=zone;
 for(const time of timeValues)dates.push({zone,time,value:new Date(time).toString()});
}
for(const zone of ['UTC','America/New_York','Europe/Dublin','Australia/Lord_Howe','Africa/Casablanca','America/Coyhaique','Asia/Seoul']){
 process.env.TZ=zone;
 for(const time of [-8.64e15,8.64e15,Date.parse('-000001-07-01T00:00:00Z'),Date.parse('0000-01-01T00:00:00Z'),Date.parse('+010000-01-01T00:00:00Z'),Date.parse('2024-03-10T06:59:59Z'),Date.parse('2024-03-10T07:00:00Z'),Date.parse('2024-11-03T05:59:59Z'),Date.parse('2024-11-03T06:00:00Z'),Date.parse('2024-03-10T02:00:00Z'),Date.parse('2024-04-14T02:00:00Z'),Date.parse('2150-07-15T12:00:00Z'),2147483647000,2147483647001,-.5,.5]){
  dates.push({zone,time:Number.isNaN(time)?'NaN':time,value:new Date(time).toString()});
 }
 for(const time of [NaN,Infinity,-Infinity,8.64e15+1,-8.64e15-1])dates.push({zone,time:String(time),value:new Date(time).toString()});
}
const probes=[['UTC','2026-01-15',false],['America/New_York','2026-01-15',false],['America/New_York','2026-07-15',true],['Europe/Dublin','2026-01-15',false],['Europe/Dublin','2026-07-15',true],['Australia/Lord_Howe','2026-01-15',true],['Australia/Lord_Howe','2026-07-15',false],['Etc/GMT+3','2026-01-15',false],['Etc/GMT-5','2026-01-15',false]];
const names=[];const unsupportedLocales=[];
for(const locale of [...Object.keys(data.locales), 'ar-EG-u-nu-latn','en-US-u-nu-arab','fa-u-nu-latn','bn-u-nu-beng']){
 let oracleLocale=locale;let seen=new Set();while(data.locales[oracleLocale]?.a){if(seen.has(oracleLocale))throw Error('locale alias cycle');seen.add(oracleLocale);oracleLocale=data.locales[oracleLocale].a;}
 oracleLocale=oracleLocale.replaceAll('_','-');
 try{if(!Intl.DateTimeFormat.supportedLocalesOf([oracleLocale]).length){unsupportedLocales.push({locale,oracleLocale,reason:'not supported by Intl locale negotiation'});continue}}
 catch(e){unsupportedLocales.push({locale,oracleLocale,reason:e.message});continue}
 for(const [zone,day,daylight]of probes){
  const formatter=new Intl.DateTimeFormat(oracleLocale,{timeZone:zone,timeZoneName:'long',year:'numeric'});
  const value=formatter.formatToParts(new Date(`${day}T12:00:00Z`)).find(p=>p.type==='timeZoneName').value;
  names.push({locale,oracleLocale,zone,daylight,value});
 }
}
const golden={version:1,oracle:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,cldr:process.versions.cldr,tz:process.versions.tz,defaultLocale},referenceNow,dataSha256:createHash('sha256').update(compressed).digest('hex'),dates,names,unsupportedLocales};
const bytes=JSON.stringify(golden)+'\n';const out=resolve(root,'native/core/fixtures/js-date-string');
if(process.argv.includes('--write')){await mkdir(out,{recursive:true});await writeFile(resolve(out,'golden.json'),bytes);const references=[];for(const name of (await readdir(resolve(out,'reference'))).sort()){const ref=await readFile(resolve(out,'reference',name));references.push({path:'reference/'+name,sha256:createHash('sha256').update(ref).digest('hex'),bytes:ref.length});}const manifest={version:1,recorder:'benchmarks/rust-core/recorders/record-js-date-string.mjs',oracle:golden.oracle,dates:dates.length,names:names.length,zoneCount:Object.keys(data.zoneNames).length,localeResourceCount:Object.keys(data.locales).length,unsupportedIntlLocaleCount:unsupportedLocales.length,dataSha256:golden.dataSha256,files:[{path:'golden.json',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:Buffer.byteLength(bytes)},...references]};await writeFile(resolve(out,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({dates:dates.length,names:names.length,sha256:manifest.files[0].sha256,defaultLocale,dataSha256:golden.dataSha256}));}
else process.stdout.write(bytes);

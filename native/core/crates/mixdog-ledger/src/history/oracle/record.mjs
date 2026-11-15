// Run with Node 22.20.0. Only isolated files and an in-memory original ledger are used.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
const here = fileURLToPath(new URL('.', import.meta.url));
const source = resolve(process.argv[2] || 'C:/Project/mixdog');
const scratch = await mkdtemp(join(here, 'isolated-'));
process.env.MIXDOG_DATA_DIR = join(scratch, 'catalog');
process.env.MIXDOG_HOME = join(scratch, 'home');
process.env.MIXDOG_USAGE_LEDGER_PATH = ':memory:';
process.env.TZ = 'UTC';
await mkdir(process.env.MIXDOG_DATA_DIR, {recursive:true});
let fetches = 0;
globalThis.fetch = () => { fetches++; throw new Error('Network forbidden in history oracle'); };
const prices = [];
globalThis.__historyOraclePrices = prices;
registerHooks({load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith('/runtime/shared/llm/cost.mjs')) {
    let text = String(result.source);
    if (!text.includes('export function priceUsage(args)')) throw new Error('Original pricing hook signature changed');
    text = text.replace('export function priceUsage(args)', 'function originalPriceUsage(args)');
    text += `\nexport function priceUsage(args) { const result = originalPriceUsage(args); globalThis.__historyOraclePrices.push({args:structuredClone(args),result:structuredClone(result)}); return result; }\n`;
    return {...result,source:text};
  }
  return result;
}});
const original = rel => import(pathToFileURL(join(source, rel)).href);
const { UsageLedger, makeUsageRecord } = await original('src/runtime/shared/llm/usage-ledger.mjs');
const { createUsageStatsApi } = await original('src/session-runtime/usage-stats-api.mjs');
const { importUsageHistory } = await original('src/runtime/shared/llm/usage-ledger-import.mjs');
const catalog={"gpt-4o":{litellm_provider:"openai",mode:"chat",input_cost_per_token:0.0000025,output_cost_per_token:0.00001,cache_read_input_token_cost:0.00000125,input_cost_per_token_above_128k_tokens:0.000005,output_cost_per_token_above_128k_tokens:0.00002},"claude-3-5-sonnet-20241022":{litellm_provider:"anthropic",mode:"chat",input_cost_per_token:0.000003,output_cost_per_token:0.000015,cache_read_input_token_cost:0.0000003,cache_creation_input_token_cost:0.00000375}};
await writeFile(join(process.env.MIXDOG_DATA_DIR,'litellm-catalog.json'),JSON.stringify({fetchedAt:1790000000000,data:catalog}));
const {warmCatalogFromDisk}=await original('src/runtime/shared/llm/model-catalog.mjs');
await warmCatalogFromDisk();
const now = 1790000000000;
Date.now = () => now;
const row = (extra={}) => ({kind:'usage_raw',ts:1788000000000,provider:'openai',model:'gpt-4o',input_tokens:100,output_tokens:7,cached_tokens:30,...extra});
const jsonl = rows => rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
const legacy = JSON.stringify({days:{'2025-01-02':{restored:true,models:{flat:{provider:'openai',model:'gpt-4o',turns:2,input:100,output:10},tier:{provider:'openai',model:'gpt-4o',turns:2,input:200000,output:10},local:{provider:'mixdog-local',model:'local',turns:2,input:20,output:3},unknown:{provider:'missing-provider',model:'missing-model',turns:1,input:5,output:1}},conversation:{}}}});
const scenarios = [
 {id:'trace-torn-and-database',files:{'history/agent-trace.jsonl':jsonl([row(),{kind:'other'},row({input_tokens:null}),row({provider:'anthropic',model:'claude-3-5-sonnet-20241022',input_tokens:10,cache_write_tokens:5,cached_tokens:3,payload:{raw_usage:{cache_creation:{ephemeral_1h_input_tokens:2}}}})])+'{torn\n'},trace:[row({ts:'1788000001000',payload:{uncached_input_tokens:11},response_id:'reply'})]},
 {id:'gateway-jsonl-primitives',files:{'gateway-usage.local.jsonl':jsonl([1,'x',false,{ts:1788000000000,provider:'openai',model:'gpt-4o',inputTokens:10,outputTokens:2,costUsd:0.25}])}},
 {id:'gateway-json-primitive-events',files:{'gateway-usage.local.json':JSON.stringify({events:[42,false,'abc']})}},
 {id:'gateway-null-throws',files:{'gateway-usage.local.jsonl':'null\n'}},
 {id:'gateway-empty-jsonl-supersedes-json',files:{'gateway-usage.local.jsonl':'','gateway-usage.local.json':'invalid'}},
 {id:'legacy-corrupt-gateway-suppresses-rollup',files:{'gateway-usage.local.json':'invalid','usage-rollup.local.json':legacy}},
 {id:'legacy-restored-local-and-unknown',files:{'usage-rollup.local.json':legacy}},
 {id:'legacy-wrong-shape',files:{'usage-rollup.local.json':'{"days":null}'}},
 ...[{ts:'invalid'},{ts:0},{provider:42},{model:true}].map((extra,i)=>({id:'invalid-row-'+i,files:{'history/agent-trace.jsonl':jsonl([row(extra)])}})),
 {id:'later-file-error-keeps-earlier-file',files:{'history/agent-trace.jsonl':jsonl([row()]),'history/agent-trace.jsonl.1':jsonl([row({ts:'invalid'})])}},
 {id:'trace-read-error-keeps-files',files:{'history/agent-trace.jsonl':jsonl([row()])},traceError:'Original trace unavailable'},
 {id:'same-file-error-rolls-back-whole-batch',files:{'history/agent-trace.jsonl':jsonl([row(),row({ts:'invalid'})])}},
 {id:'gateway-error-keeps-files-and-database',files:{'history/agent-trace.jsonl':jsonl([row()]),'gateway-usage.local.jsonl':'null\n'},trace:[row({ts:1788000000001})]},
 {id:'cutover-and-repeat',liveSince:1788000000001,repeat:true,files:{'history/agent-trace.jsonl':jsonl([row(),row({ts:1788000000001})])}},
];
const output=[];
try {
 for (const spec of scenarios) {
  const dir=join(scratch,spec.id); await mkdir(dir,{recursive:true});
  for(const [name,text] of Object.entries(spec.files)){ const path=join(dir,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,text); }
  const ledger=new UsageLedger(':memory:'); if(spec.liveSince)ledger.set('liveSince',spec.liveSince);
  const normalize=x=>JSON.parse(JSON.stringify(x).replaceAll(JSON.stringify(dir).slice(1,-1),'$DATA').replaceAll(dir.replaceAll('\\','/'),'$DATA'));
  const warnings=[];const stderr=process.stderr.write;
  process.stderr.write=function(text,...rest){warnings.push(String(text));return true;};
  prices.length=0;
  let result=null,error=null,again=null;
  try { result=await importUsageHistory(ledger,dir,{now,readTrace:async()=>{if(spec.traceError)throw new Error(spec.traceError);return spec.trace||[];}}); if(spec.repeat)again=await importUsageHistory(ledger,dir,{now,readTrace:async()=>[]}); }
  catch(e){error={name:e.name,message:e.message};}
  finally{process.stderr.write=stderr;}
  const receipt=ledger.get('importReceipt');
  output.push(normalize({id:spec.id,input:spec,result,error,again,warnings,pricingCalls:[...prices],events:ledger.db.prepare('SELECT hex(id) AS id,ts,day, input,output,cache_read,cache_write,cost_usd,duration_ms FROM usage_events ORDER BY ts,id').all(),routes:ledger.db.prepare('SELECT signature FROM usage_routes ORDER BY signature').all().map(r=>r.signature),legacy:ledger.db.prepare('SELECT day,document FROM legacy_days ORDER BY day').all().map(r=>({...r,document:JSON.parse(r.document)})),through:ledger.get('importedThrough'),receipt:receipt?JSON.parse(receipt):null}));
  ledger.close();
 }
 const apiCases=[];
 {
  const ledger=new UsageLedger(':memory:');
  let entered,release;
  const began=new Promise(r=>entered=r), held=new Promise(r=>release=r);
  let attempts=0;
  const originalError=new Error('Original trace unavailable');
  const api=createUsageStatsApi({ledger:()=>ledger,importHistory:async()=>{attempts++;entered();await held;throw originalError;}});
  const first=api.getUsageStats().catch(e=>e);await began;
  const second=api.getUsageStats().catch(e=>e);
  await Promise.resolve();await Promise.resolve();release();
  const results=await Promise.all([first,second]);
  const attemptsBeforeRetry=attempts;
  const retry=await api.getUsageStats().catch(e=>e);
  apiCases.push({id:'concurrent-import-error-and-later-retry',attemptsBeforeRetry,attemptsAfterRetry:attempts,sameErrorObject:results[0]===results[1],messages:results.map(e=>e.message),retry:retry.message});
  ledger.close();
 }
 {
  const ledger=new UsageLedger(':memory:');
  const live=makeUsageRecord({ts:1788000000001,provider:'mixdog-local',model:'local',inputTokens:3,outputTokens:1,origin:'live',responseId:'stable-live'});
  const queued=ledger.recordQueued(live);
  let observedCutover=null;
  const api=createUsageStatsApi({ledger:()=>ledger,importHistory:async store=>{observedCutover=store.get('liveSince');return importUsageHistory(store,join(scratch,'queued-empty'),{now,readTrace:async()=>[]});}});
  const stats=await api.getUsageStats();await queued;
  apiCases.push({id:'queued-live-before-statistics',live,observedCutover,totals:stats.totals,coverage:stats.coverage});
  ledger.close();
 }
 if(fetches)throw new Error('Unexpected network attempt');
 const sources={};for(const rel of ['src/runtime/shared/llm/usage-ledger-import.mjs','src/runtime/shared/llm/usage-ledger.mjs','src/runtime/shared/llm/cost.mjs','src/session-runtime/usage-stats-api.mjs'])sources[rel]=createHash('sha256').update(await readFile(join(source,rel))).digest('hex');
 await writeFile(join(here,'original.json'),JSON.stringify({node:process.version,timezone:process.env.TZ,now,sources,catalog,fetches,apiCases,cases:output},null,2)+'\n');
 console.log(`Recorded ${output.length} original cases; no network or trace database access.`);
} finally {await rm(scratch,{recursive:true,force:true});}

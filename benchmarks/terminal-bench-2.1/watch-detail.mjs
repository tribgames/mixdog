import fs from "node:fs"; import path from "node:path";
// usage: node watch-detail.mjs [dirPrefix] [opus|sol] [baseline.json]
const prefix=process.argv[2]||"jobs-full-opus5-clean-";
const mixR=(process.argv[3]||"opus")==="sol"?{in:5,cr:0.5,cw:6.25,out:30,family:"openai"}:{in:5,cr:0.5,cw:10,out:25,family:"anthropic"};
const ccR={in:5,cr:0.5,cw:10,out:25};
const jd=fs.readdirSync(".").filter(n=>n.startsWith(prefix)).sort().pop();
if(!jd){console.log("no jobs dir yet for prefix "+prefix);process.exit(0)}
const sub=fs.readdirSync(jd).filter(n=>/\d{4}-/.test(n)).sort().pop();
if(!sub){console.log("no run subdir yet in "+jd);process.exit(0)}
const base=path.join(jd,sub);
const bp=process.argv[4]||"cc-baseline.json";
const cb=fs.existsSync(bp)?JSON.parse(fs.readFileSync(bp,"utf8")):{};
const cost=(u,R)=>(u.unc*R.in+u.cr*R.cr+u.cw*R.cw+u.out*R.out)/1e6;
// Official list prices. haiku = explorer lane: 5-min cache (1.25x write).
// Lead lanes (opus/fable): 1h cache (2x write). GPT-5.6 writes 1.25x input
// (oauth mirror reports no cache_write_tokens — openai costs are lower bounds).
// family: openai usage inputTokens = uncached+cached; anthropic = uncached.
const RATES={haiku:{in:1,cr:0.1,cw:1.25,out:5,family:"anthropic"},luna:{in:0.2,cr:0.02,cw:0.25,out:1.2,family:"openai"},terra:{in:2,cr:0.2,cw:2.5,out:12,family:"openai"},sol:{in:5,cr:0.5,cw:6.25,out:30,family:"openai"},opus:{in:5,cr:0.5,cw:10,out:25,family:"anthropic"},fable:{in:5,cr:0.5,cw:10,out:25,family:"anthropic"}};
const rateFor=(m)=>{m=String(m||"").toLowerCase();for(const k of Object.keys(RATES))if(m.includes(k))return RATES[k];return mixR};
const uncFor=(R,inp,cached)=>R.family==="openai"?Math.max((inp||0)-(cached||0),0):(inp||0);
let agg={t:0,cr:0,c:0},cagg={t:0,cr:0,c:0},n=0,pass=0,done=0,inflight=[],fails=[];
let finSum=0,finN=0;
const rowsOut=[],slower=[],costlier=[],ctxWorse=[],strong=[],par=[],weak=[];
console.log("== "+jd);
for(const tr of fs.readdirSync(base).sort()){
 if(!fs.statSync(path.join(base,tr)).isDirectory())continue;
 const rp=path.join(base,tr,"result.json");
 const task=tr.split("__")[0];
 if(!fs.existsSync(rp)){inflight.push(task);continue}
 let r;try{r=JSON.parse(fs.readFileSync(rp,"utf8"))}catch{continue}
 done++;
 const rew=r.verifier_result&&r.verifier_result.rewards?r.verifier_result.rewards.reward:null;
 if(Number(rew)>=1)pass++;else fails.push(task);
 let mu=null,muC=null,t=null,turns="?";
 try{
  const ud=JSON.parse(fs.readFileSync(path.join(base,tr,"agent","usage.json"),"utf8"));
  const u=ud.totals;
  mu={unc:uncFor(mixR,u.inputTokens,u.cacheTokens),cr:u.cacheTokens,cw:u.cacheWriteTokens,out:u.outputTokens};
  if(Array.isArray(ud.sessions)&&ud.sessions.length)mu.cr=ud.sessions.filter(x=>x.agentRole!=="explorer").reduce((s,x)=>s+(x.cacheTokens||0),0);
  muC=Array.isArray(ud.sessions)&&ud.sessions.length?ud.sessions.reduce((s,x)=>{const R=rateFor((x.models||[])[0]);return s+cost({unc:uncFor(R,x.inputTokens,x.cacheTokens),cr:x.cacheTokens||0,cw:x.cacheWriteTokens||0,out:x.outputTokens||0},R)},0):cost(mu,mixR);
  const st=JSON.parse(fs.readFileSync(path.join(base,tr,"agent","session-transcript.json"),"utf8"));
  turns=st.lastIterationIndex||"?";
  mu.fin=Number(st.lastContextTokens)||null;
  const ag=r.agent_execution||r.agent;if(ag&&ag.started_at&&ag.finished_at)t=Math.round((new Date(ag.finished_at)-new Date(ag.started_at))/1000);
 }catch{}
 const c=cb[task];
 let line=(Number(rew)>=1?"PASS ":"FAIL ")+task.padEnd(34);
 if(mu&&mu.fin){finSum+=mu.fin;finN++;}
 if(mu)line+=" mix "+String(t).padStart(4)+"s/"+String(turns).padStart(2)+"t $"+muC.toFixed(2)+(mu.fin?" fin"+Math.round(mu.fin/1e3)+"K":"");
 if(c){line+="  cc "+String(c.t).padStart(4)+"s/"+String(c.calls).padStart(2)+"c $"+cost(c,ccR).toFixed(2)+" r="+c.reward;
  if(mu&&t!=null){n++;agg.t+=t;agg.cr+=mu.cr;agg.c+=muC;cagg.t+=c.t;cagg.cr+=c.cr;cagg.c+=cost(c,ccR);
   if(t>c.t)slower.push(task+" +"+(t-c.t)+"s");
   if(muC>cost(c,ccR))costlier.push(task+" +$"+(muC-cost(c,ccR)).toFixed(2));
   if(mu.cr>c.cr)ctxWorse.push(task+" +"+Math.round((mu.cr-c.cr)/1e3)+"K");
  }
  const mp=Number(rew)>=1,cp=Number(c.reward)>=1;
  if(mp&&!cp)strong.push(task+" (PASS vs cc FAIL)");
  else if(!mp&&cp)weak.push(task+" (FAIL vs cc PASS)");
  else if(!mp&&!cp)par.push(task+" (both FAIL)");
  else if(mu&&t!=null&&cost(c,ccR)>0&&c.t>0){
   const dt=(t-c.t)/c.t,dc=(muC-cost(c,ccR))/cost(c,ccR);
   const tag=task+" (t"+(dt>=0?"+":"")+Math.round(dt*100)+"% $"+(dc>=0?"+":"")+Math.round(dc*100)+"%)";
   if(dt<-0.1&&dc<-0.1)strong.push(tag);
   else if(dt>0.1&&dc>0.1)weak.push(tag);
   else par.push(tag);
  } else par.push(task+" (no data)");
 }
 rowsOut.push(line);
}
console.log(rowsOut.join("\n"));
console.log("=== done="+done+" PASS="+pass+" FAIL="+(done-pass)+(fails.length?" ["+fails.join(",")+"]":"")+" inflight="+inflight.length+" ["+inflight.join(",")+"]");
if(n)console.log("=== agg("+n+"): time "+agg.t+"s vs "+cagg.t+"s ("+Math.round(100*(agg.t-cagg.t)/cagg.t)+"%) | ctx "+Math.round(agg.cr/1e3)+"K vs "+Math.round(cagg.cr/1e3)+"K ("+Math.round(100*(agg.cr-cagg.cr)/cagg.cr)+"%) | cost $"+agg.c.toFixed(2)+" vs $"+cagg.c.toFixed(2)+" ("+Math.round(100*(agg.c-cagg.c)/cagg.c)+"%)");
if(finN)console.log("=== final-ctx avg "+Math.round(finSum/finN/1e3)+"K over "+finN+" tasks (mix lead, no cc baseline)");
if(slower.length)console.log("=== slower-than-cc: "+slower.join(", "));
if(costlier.length)console.log("=== costlier-than-cc: "+costlier.join(", "));
if(ctxWorse.length)console.log("=== ctx-worse-than-cc: "+ctxWorse.join(", "));
console.log("=== 강세("+strong.length+"): "+strong.join(", "));
console.log("=== 동급("+par.length+"): "+par.join(", "));
console.log("=== 약세("+weak.length+"): "+weak.join(", "));

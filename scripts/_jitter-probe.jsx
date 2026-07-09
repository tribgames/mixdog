import React from 'react';
import { Box, renderToString } from 'ink';
import { ToolExecution } from '../src/tui/components/ToolExecution.jsx';
import { estimateTranscriptItemRowsCached } from '../src/tui/app/transcript-window.mjs';
const COLUMNS=80;
function renderRows(item){
  const node=React.createElement(Box,{flexDirection:'column',flexShrink:0,width:COLUMNS},
    React.createElement(ToolExecution,{name:item.name,args:item.args,result:item.result,rawResult:item.rawResult,isError:item.isError,errorCount:item.errorCount,expanded:!!item.expanded,columns:COLUMNS,attached:false,count:item.count,completedCount:item.completedCount,startedAt:item.startedAt,completedAt:item.completedAt,aggregate:item.aggregate,categories:item.categories,doneCategories:item.doneCategories,headerFinalized:item.headerFinalized,deferredDisplayReady:item.deferredDisplayReady}));
  const out=renderToString(node,{columns:COLUMNS});
  return out===''?0:out.split('\n').length;
}
const now=Date.now();
const F=[
 ['read pending',{name:'read',args:{path:'a.js'},result:null,count:1,completedCount:0,startedAt:now-2000,deferredDisplayReady:true,headerFinalized:false}],
 ['read settled',{name:'read',args:{path:'a.js'},result:'Read 40 lines',count:1,completedCount:1,startedAt:now-2000,completedAt:now,deferredDisplayReady:true,headerFinalized:true}],
 ['grep settled 0',{name:'grep',args:{pattern:'foo'},result:'No matches',count:1,completedCount:1,startedAt:now-1000,completedAt:now,headerFinalized:true}],
 ['shell pending',{name:'shell',args:{command:'ls'},result:null,count:1,completedCount:0,startedAt:now-2000,deferredDisplayReady:true}],
 ['shell settled',{name:'shell',args:{command:'ls'},result:'file1\nfile2',count:1,completedCount:1,startedAt:now-2000,completedAt:now,headerFinalized:true}],
 ['shell settled empty',{name:'shell',args:{command:'ls'},result:'',count:1,completedCount:1,startedAt:now,completedAt:now,headerFinalized:true}],
 ['agent pending',{name:'agent',args:{action:'spawn'},result:null,count:1,completedCount:0,startedAt:now-2000,deferredDisplayReady:true}],
 ['agent settled resp',{name:'agent',args:{action:'response',status:'completed'},result:'Agent reply body here',count:1,completedCount:1,startedAt:now,completedAt:now,headerFinalized:true}],
 ['skill settled',{name:'Skill',args:{name:'setup'},result:'loaded body\nmore',count:1,completedCount:1,startedAt:now,completedAt:now,headerFinalized:true}],
 ['code_graph settled',{name:'code_graph',args:{mode:'search',symbols:'x'},result:'3 results',count:1,completedCount:1,startedAt:now,completedAt:now,headerFinalized:true}],
 ['aggregate pending',{name:'read',args:{categoryOrder:['read']},aggregate:true,result:null,count:3,completedCount:0,startedAt:now-2000,categories:{read:{count:3}},deferredDisplayReady:true}],
 ['aggregate settled',{name:'read',args:{categoryOrder:['read']},aggregate:true,result:'Read 3 files',count:3,completedCount:3,startedAt:now-2000,completedAt:now,categories:{read:{count:3}},doneCategories:{read:{count:3}},headerFinalized:true}],
];
let bad=0;
for(const [label,item] of F){
  const est=estimateTranscriptItemRowsCached({kind:'tool',...item},COLUMNS,false);
  const ren=renderRows(item);
  const m=est===ren?'ok  ':'DIFF';
  if(est!==ren)bad++;
  console.log(`${m} est=${est} render=${ren}  ${label}`);
}
console.log('mismatches:',bad);

import React from 'react';
import { Box, renderToString } from 'ink';
import { ToolExecution } from '../src/tui/components/ToolExecution.jsx';
import { estimateTranscriptItemRowsCached } from '../src/tui/app/transcript-window.mjs';
import { shouldSuppressFullyFailedToolItem } from '../src/tui/transcript-tool-failures.mjs';
function renderRows(item,COLUMNS){
  const node=React.createElement(Box,{flexDirection:'column',flexShrink:0,width:COLUMNS},
    React.createElement(ToolExecution,{name:item.name,args:item.args,result:item.result,rawResult:item.rawResult,isError:item.isError,errorCount:item.errorCount,expanded:!!item.expanded,columns:COLUMNS,attached:false,count:item.count,completedCount:item.completedCount,startedAt:item.startedAt,completedAt:item.completedAt,aggregate:item.aggregate,categories:item.categories,doneCategories:item.doneCategories,headerFinalized:item.headerFinalized,deferredDisplayReady:item.deferredDisplayReady}));
  const out=renderToString(node,{columns:COLUMNS});
  return out===''?0:out.split('\n').length;
}
const now=Date.now();
const names=['read','grep','glob','shell','code_graph','explore','search','web_fetch','agent','Skill','view_image','recall','list','fetch','load_tool'];
const results=['ok','No matches','line1\nline2','line1\nline2\nline3','done · 3 items','Failed', 'Read 40 lines'];
const cases=[];
let id=0;
for(const name of names) for(const result of results) for(const completed of [0,1]) for(const isError of [false,true]){
  cases.push({name,args:{path:'a/b/c.js',pattern:'foo',command:'ls -la',mode:'search',symbols:'X',action:'response',status: completed?'completed':'',name:'setup'},result: completed?result:null,count:1,completedCount:completed,isError,expanded:false,startedAt:now-2000,completedAt:completed?now:0,headerFinalized:completed===1,deferredDisplayReady:true,rawResult:null,__id:id++});
}
const COLS=[60,80,100,120];
let bad=0,total=0;
for(const COLUMNS of COLS) for(const it of cases){
  const full={kind:'tool',...it};
  if(shouldSuppressFullyFailedToolItem(full)) continue; // real app renders nothing
  total++;
  const est=estimateTranscriptItemRowsCached(full,COLUMNS,false);
  let ren; try{ren=renderRows(it,COLUMNS);}catch(e){ren='ERR:'+e.message;}
  if(est!==ren){bad++; if(bad<=60) console.log(`DIFF est=${est} ren=${ren}  ${it.name}|res=${JSON.stringify(it.result)}|c=${it.completedCount}|e=${it.isError}|col=${COLUMNS}`);}
}
console.log('total',total,'mismatches',bad);

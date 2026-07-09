import React from 'react';
import { Box, renderToString } from 'ink';
import { ToolExecution } from '../src/tui/components/ToolExecution.jsx';
import { estimateTranscriptItemRowsCached } from '../src/tui/app/transcript-window.mjs';
function renderRows(item,COLUMNS){
  const node=React.createElement(Box,{flexDirection:'column',flexShrink:0,width:COLUMNS},
    React.createElement(ToolExecution,{name:item.name,args:item.args,result:item.result,rawResult:item.rawResult,isError:item.isError,errorCount:item.errorCount,expanded:!!item.expanded,columns:COLUMNS,attached:false,count:item.count,completedCount:item.completedCount,startedAt:item.startedAt,completedAt:item.completedAt,aggregate:item.aggregate,categories:item.categories,doneCategories:item.doneCategories,headerFinalized:item.headerFinalized,deferredDisplayReady:item.deferredDisplayReady}));
  const out=renderToString(node,{columns:COLUMNS});
  return out===''?0:out.split('\n').length;
}
const now=Date.now();
const longLine='x'.repeat(200);
const items=[];
const names=['read','grep','glob','shell','code_graph','explore','search','web_fetch','agent','Skill','view_image','recall','remember','task','list'];
const results=[null,'','ok','No matches','line1\nline2','line1\nline2\nline3',longLine, longLine+'\n'+longLine, '[status: cancelled]\nbody', 'Error: boom'];
let id=0;
for(const name of names){
 for(const result of results){
  for(const completed of [0,1]){
   for(const isError of [false,true]){
    for(const expanded of [false,true]){
     items.push({name,args:{path:'a/b/c.js',pattern:'foo',command:'ls -la',mode:'search',symbols:'X',action:'spawn',status: completed?'completed':'',name:'setup'},result,count:1,completedCount:completed,isError,expanded,startedAt:now-2000,completedAt:completed?now:0,headerFinalized:completed===1,deferredDisplayReady:true,rawResult: expanded?(result||'raw body\nl2'):null,__id:id++});
    }
   }
  }
 }
}
const COLS=[40,60,80,100,120];
let bad=0,total=0;
const seen=new Set();
for(const COLUMNS of COLS){
 for(const it of items){
  total++;
  const est=estimateTranscriptItemRowsCached({kind:'tool',...it},COLUMNS,false);
  let ren; try{ren=renderRows(it,COLUMNS);}catch(e){ren='ERR:'+e.message;}
  if(est!==ren){bad++;
   const key=`${it.name}|res=${JSON.stringify(it.result)}|c=${it.completedCount}|e=${it.isError}|x=${it.expanded}|col=${COLUMNS}`;
   if(bad<=40) console.log(`DIFF est=${est} ren=${ren}  ${key}`);
  }
 }
}
console.log('total',total,'mismatches',bad);

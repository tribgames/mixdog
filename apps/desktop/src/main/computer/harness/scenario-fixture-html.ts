export const fixtureHtml = `<!doctype html>
<meta charset="utf-8">
<title>Mixdog Scenario Renderer</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f5f7fb}
canvas{display:block;width:100%;height:100%;outline:none}
#sink{position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0}
</style>
<canvas id="surface" tabindex="0" aria-label="scenario renderer surface"></canvas>
<textarea id="sink" aria-hidden="true"></textarea>
<script>
const canvas=document.querySelector('#surface');
const sink=document.querySelector('#sink');
const context=canvas.getContext('2d');
let clickCount=0;
let typed='';
let pointerMoves=0;
let doubleClicks=0;
let dragStart=null;
let dragDistance=0;
let wheelDelta=0;
let keyDowns=0;
const send={x:70,y:105,width:300,height:72};
const input={x:70,y:210,width:500,height:72};
const popup={x:70,y:315,width:360,height:72};
function inside(point,box){return point.x>=box.x&&point.x<=box.x+box.width&&point.y>=box.y&&point.y<=box.y+box.height}
function draw(){
 const ratio=devicePixelRatio||1;
 context.setTransform(ratio,0,0,ratio,0,0);
 context.fillStyle='#f5f7fb';context.fillRect(0,0,innerWidth,innerHeight);
 context.fillStyle='#16213a';context.font='700 34px Arial';context.fillText('SCENARIO RENDERER',70,65);
 context.fillStyle='#1769e0';context.fillRect(send.x,send.y,send.width,send.height);
 context.fillStyle='#fff';context.font='700 30px Arial';context.fillText('SEND SIGNAL',105,151);
 context.fillStyle='#fff';context.fillRect(input.x,input.y,input.width,input.height);
 context.strokeStyle='#1769e0';context.lineWidth=4;context.strokeRect(input.x,input.y,input.width,input.height);
 context.fillStyle='#16213a';context.font='700 28px Arial';context.fillText('TYPE HERE',105,256);
 context.fillStyle='#7b2cbf';context.fillRect(popup.x,popup.y,popup.width,popup.height);
 context.fillStyle='#fff';context.fillText('OPEN POPUP',105,361);
 context.fillStyle='#16213a';context.font='700 32px Arial';
 context.fillText('CLICKED '+clickCount,70,455);
 context.fillText('TYPED '+(typed||'EMPTY'),70,510);
}
function resize(){const ratio=devicePixelRatio||1;canvas.width=Math.round(innerWidth*ratio);canvas.height=Math.round(innerHeight*ratio);draw()}
canvas.addEventListener('pointerdown',(event)=>{
 const point={x:event.offsetX,y:event.offsetY};
 dragStart=point;
 if(inside(point,send))clickCount+=1;
 if(inside(point,input))setTimeout(()=>sink.focus(),0);
 if(inside(point,popup)){
   const body='<meta charset="utf-8"><title>Mixdog Scenario Popup</title><body style="font:32px Arial;background:white">POPUP READY<script>addEventListener("keydown",event=>{if(event.key==="Escape")close()})<\\/script><\\/body>';
   window.open('data:text/html,'+encodeURIComponent(body),'mixdog-scenario-popup','width=420,height=260');
 }
 draw();
});
canvas.addEventListener('pointerup',(event)=>{
 if(!dragStart)return;
 dragDistance+=Math.hypot(event.offsetX-dragStart.x,event.offsetY-dragStart.y);
 dragStart=null;
});
canvas.addEventListener('pointermove',()=>{pointerMoves+=1});
canvas.addEventListener('dblclick',(event)=>{
 if(inside({x:event.offsetX,y:event.offsetY},send))doubleClicks+=1;
});
canvas.addEventListener('wheel',(event)=>{wheelDelta+=event.deltaY;event.preventDefault()},{passive:false});
addEventListener('keydown',()=>{keyDowns+=1});
sink.addEventListener('input',()=>{typed=sink.value.toUpperCase();draw()});
globalThis.mixdogMotorState=()=>({clickCount,pointerMoves,doubleClicks,dragDistance,wheelDelta,keyDowns});
addEventListener('resize',resize);resize();
</script>`;

export const koreanFixtureHtml = `<!doctype html>
<meta charset="utf-8"><title>Mixdog Korean OCR Fixture</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#eef7ff}canvas{width:100%;height:100%;display:block}</style>
<canvas id="surface" aria-label="한국어 OCR 캔버스"></canvas>
<script>
const canvas=document.querySelector('#surface');const context=canvas.getContext('2d');let count=0;
const button={x:80,y:120,width:330,height:90};
function draw(){const ratio=devicePixelRatio||1;canvas.width=Math.round(innerWidth*ratio);canvas.height=Math.round(innerHeight*ratio);context.setTransform(ratio,0,0,ratio,0,0);context.fillStyle='#eef7ff';context.fillRect(0,0,innerWidth,innerHeight);context.fillStyle='#12345b';context.font='700 40px "Malgun Gothic"';context.fillText('한국어 작업 화면',80,70);context.fillStyle='#0b74de';context.fillRect(button.x,button.y,button.width,button.height);context.fillStyle='white';context.fillText('보내기',165,180);context.fillStyle='#12345b';context.fillText('클릭 '+count+'회',80,300)}
canvas.addEventListener('pointerdown',(event)=>{if(event.offsetX>=button.x&&event.offsetX<=button.x+button.width&&event.offsetY>=button.y&&event.offsetY<=button.y+button.height){count+=1;draw()}});
addEventListener('resize',draw);draw();
</script>`;

export const clutterFixtureHtml = `<!doctype html>
<meta charset="utf-8"><title>Mixdog OCR Clutter Fixture</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}canvas{width:100%;height:100%;display:block}</style>
<canvas id="surface" aria-label="OCR clutter canvas"></canvas>
<script>
const canvas=document.querySelector('#surface');const context=canvas.getContext('2d');
function draw(){const ratio=devicePixelRatio||1;canvas.width=Math.round(innerWidth*ratio);canvas.height=Math.round(innerHeight*ratio);context.setTransform(ratio,0,0,ratio,0,0);context.fillStyle='white';context.fillRect(0,0,innerWidth,innerHeight);context.fillStyle='#172554';context.font='700 20px Arial';for(let row=0;row<8;row+=1){for(let col=0;col<8;col+=1){context.fillText('ITEM'+String(row*8+col).padStart(2,'0'),20+col*95,35+row*55)}}context.fillStyle='#c2410c';context.font='700 30px Arial';context.fillText('TARGET ACTION',270,500)}
addEventListener('resize',draw);draw();
</script>`;

export const blackFixtureHtml =
  '<!doctype html><meta charset="utf-8"><title>Mixdog Black Frame Fixture</title><body style="margin:0;background:#000;width:100vw;height:100vh"><button style="position:absolute;left:20px;top:20px;color:black;background:black;border:0">Accessible</button>';
export const whiteFixtureHtml =
  '<!doctype html><meta charset="utf-8"><title>Mixdog White Frame Fixture</title><body style="margin:0;background:#fff;width:100vw;height:100vh"><button style="position:absolute;left:20px;top:20px;color:white;background:white;border:0">Accessible</button>';
export const denseFixtureHtml = `<!doctype html>
<meta charset="utf-8"><title>Mixdog Dense Accessibility Fixture</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#f8fafc;color:#172554;font:16px Arial}
main{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:6px;padding:16px}
button{height:44px;border:1px solid #93c5fd;border-radius:5px;background:#eff6ff;color:#1e3a8a}
</style>
<main>${Array.from(
  { length: 400 },
  (_, index) => `<button>Dense Control ${String(index + 1).padStart(3, '0')}</button>`
).join('')}</main>
<script>document.querySelector('button').addEventListener('click',()=>{document.title='Mixdog Dense Activated'})</script>`;

export function externalFixtureProgram(statePath: string, userDataPath: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>Mixdog External Electron Fixture</title>
  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f0fff4}canvas{width:100%;height:100%;display:block}textarea{position:fixed;left:-10000px;opacity:0}</style>
  <canvas id="surface"></canvas><textarea id="sink"></textarea><script>
  const canvas=document.querySelector('#surface');const sink=document.querySelector('#sink');const c=canvas.getContext('2d');const box={x:70,y:120,width:500,height:90};
  function draw(){const r=devicePixelRatio||1;canvas.width=Math.round(innerWidth*r);canvas.height=Math.round(innerHeight*r);c.setTransform(r,0,0,r,0,0);c.fillStyle='#f0fff4';c.fillRect(0,0,innerWidth,innerHeight);c.fillStyle='#14532d';c.font='700 34px Arial';c.fillText('EXTERNAL ELECTRON',70,70);c.fillStyle='white';c.fillRect(box.x,box.y,box.width,box.height);c.strokeStyle='#16a34a';c.lineWidth=4;c.strokeRect(box.x,box.y,box.width,box.height);c.fillStyle='#14532d';c.fillText('TYPE EXTERNAL',105,177);c.fillText('VALUE '+(sink.value||'EMPTY'),70,300)}
  canvas.addEventListener('pointerdown',(e)=>{if(e.offsetX>=box.x&&e.offsetX<=box.x+box.width&&e.offsetY>=box.y&&e.offsetY<=box.y+box.height)setTimeout(()=>sink.focus(),0)});sink.addEventListener('input',draw);addEventListener('resize',draw);draw();
  </script>`;
  return `import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
app.setPath('userData', ${JSON.stringify(userDataPath)});
writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ phase: 'entry' }));
void app.whenReady().then(async () => {
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ phase: 'ready' }));
  const window = new BrowserWindow({ width: 760, height: 430, show: true, title: 'Mixdog External Electron Fixture', webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  await window.loadURL(${JSON.stringify(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)});
  window.show();
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ phase: 'window' }));
  setInterval(async () => {
    if (window.isDestroyed()) return;
    const state = await window.webContents.executeJavaScript("({active:document.activeElement?.id||'',value:document.querySelector('#sink')?.value||''})").catch(() => ({}));
    writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  }, 100);
}).catch((error) => {
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ phase: 'error', error: error?.stack || String(error) }));
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
`;
}

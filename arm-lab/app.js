import {beginLog,logSample,endLog} from './archive.js';
import {sites} from './bank.js';
import {mean,quantile,amplitudes,features,train,classify,config} from './model.js';
const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const dualNote='Records A3 RAW and A5 RECT on the second arm plus A4 ENV on the first. Choose the arm being trained in the Arm menu. Use isolated USB for on-body recording.';
const bleService='e0730c50-b64d-48f3-a0ac-3d0657c85430';
const bleSample='e0730c51-b64d-48f3-a0ac-3d0657c85430';
let bleDevice, bleCharacteristic;
function onBleSample(event){
 const data=event.target.value;
 if(data.byteLength===10)ingest(data.getUint32(0,true),data.getUint16(8,true),data.getUint32(4,true));
}
function onBleLost(){void stop('Bluetooth disconnected. Connect again to resume.')}
const sources={
 ble:{max:4095,note:'Power the ESP32 from a standalone battery. ENV goes to GPIO2. Choose Connect device in desktop Chrome, then Forearm-EMG. Your Mac can stay on its usual Wi-Fi.'},
 dualEnv:{max:1023,note:dualNote},dualRaw:{max:1023,note:dualNote},
 esp:{max:4095,note:'Use the battery-powered ESP32 with ENV on GPIO2. Join Forearm-EMG Wi-Fi on this Mac. The local server reads /sample.'},
 uno:{max:1023,note:'ENV to A4, 115200 baud. Use Chrome or Edge, close Arduino Serial Monitor, and use a suitable USB isolator for on-body recording. A power bank alone only supplies power.'},
 raw:{max:1023,note:'Use the supplied FirmwareRaw sketch, RAW pin to A4, and 500000 baud. Disconnect electrodes before programming or rewiring. Use isolated USB for on-body acquisition.'}
};
for(const [id,v] of Object.entries(sites)) $('site').add(new Option(v.name,id));
const empty=()=>({schema:'arm-lab/1',id:crypto.randomUUID(),created:new Date().toISOString(),site:$('site').value,arm:$('arm').value,source:$('source').value,cal:{},plan:[],trials:[],model:null});
let session=empty(),token=0,task=0,connected=false,busy=false,opening=false,port,reader,buffer=[],seq=0,lastReceived=0;
const site=()=>sites[session.site],dual=()=>['dualEnv','dualRaw'].includes(session.source),raw=()=>session.source==='raw'||session.source==='dualRaw';
const labels=()=>[{id:'rest',name:'Rest',cue:'Support your arm and let your hand relax.'},...site().moves];
const name=id=>labels().find(m=>m.id===id)?.name||'Uncertain';
const info=m=>{$('info').textContent=m};
const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('arm-lab-local',1);req.onupgradeneeded=()=>req.result.createObjectStore('sessions');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
function store(){const tr=db.transaction('sessions','readwrite');tr.objectStore('sessions').put(session,'current');tr.onerror=()=>info('Local save failed. Export your session before leaving.')}
const saved=await new Promise(resolve=>{const q=db.transaction('sessions').objectStore('sessions').get('current');q.onsuccess=()=>resolve(q.result);q.onerror=()=>resolve(null)});
if(saved?.schema==='arm-lab/1'){session=saved;for(const id of ['site','arm','source'])$(id).value=session[id]}
function show(){
 const locked=connected||opening||!!session.cal.rest;
 for(const id of ['site','arm'])$(id).disabled=opening||busy||!!session.cal.rest;
 $('source').disabled=locked;
 $('hookup').textContent=sources[session.source].note;
 $('placement').textContent=site().placement;
 $('bank').replaceChildren(...labels().map(m=>Object.assign(document.createElement('li'),{textContent:m.name})));
 $('connect').hidden=connected;$('connect').disabled=opening;$('disconnect').hidden=!connected;
 $('go').disabled=!connected||busy||session.plan.length>0&&session.trials.length===session.plan.length;
 $('cancel').hidden=!busy;$('new').disabled=busy||opening;$('export').disabled=!session.cal.rest;
 const next=session.plan[session.trials.length];
 let title,desc,action;
 if(!session.cal.rest){title='Rest calibration';desc='Support the arm and relax your hand. Record a quiet baseline.';action='Record rest'}
 else if(!session.cal.active){title='Comfortable activation';desc=site().reference+' Hold through the capture.';action='Record reference'}
 else if(next){const m=labels().find(x=>x.id===next.label);title=m.name;desc=m.cue;action='Start repetition'}
 else {title='Free movement';desc='Try either recorded movement, then relax. Watch the live prediction below.';action='Session complete'}
 if(!busy){$('cue').textContent=title;$('instruction').textContent=desc;$('stage').textContent=next?next.split.toUpperCase()+' · TRIAL '+(session.trials.length+1)+' / '+session.plan.length:'GUIDED RECORDING'}
 $('go').textContent=action;
 $('log').replaceChildren(...session.trials.slice().reverse().map((t,i)=>Object.assign(document.createElement('div'),{className:'entry',textContent:[session.trials.length-i,name(t.label),t.split,t.prediction?'Detected '+name(t.prediction):'Labeled example'].join(' · ')})));
 if(!session.trials.length)$('log').textContent='No trials recorded.';
 const held=session.trials.filter(t=>t.split==='test');
 $('score').textContent=held.length?held.filter(t=>t.prediction===t.label).length+' / '+held.length+' held-out cues matched (uncertain counts as a miss).':'Four training rounds precede two held-out rounds.';
}
for(const id of ['source','arm','site'])$(id).onchange=()=>{session=empty();store();show()};
function ingest(i,v,ms,channels=[]){
 if(!Number.isFinite(v)||v<0||v>sources[session.source].max)return;
 const arrival=performance.now();lastReceived=arrival;logSample(arrival,i,v,ms,channels);buffer.push([i,v,ms,arrival,...channels]);
 if(buffer.length>16000)buffer.splice(0,4000);
}
async function stop(msg='Disconnected'){
 endLog();token++;task++;connected=false;opening=false;busy=false;
 if(bleCharacteristic)bleCharacteristic.removeEventListener('characteristicvaluechanged',onBleSample);
 if(bleDevice){
  bleDevice.removeEventListener('gattserverdisconnected',onBleLost);
  if(bleDevice.gatt.connected)bleDevice.gatt.disconnect();
 }
 bleDevice=null;bleCharacteristic=null;
 const r=reader,p=port;reader=null;port=null;
 if(r){try{await r.cancel()}catch{}try{r.releaseLock()}catch{}}
 if(p){try{await p.close()}catch{}}
 buffer=[];$('value').textContent='—';$('prediction').textContent='Awaiting signal';$('rate').textContent='';
 $('connection').textContent=msg;show();
}
async function connect(){
 beginLog({source:session.source,site:session.site,arm:session.arm,sessionId:session.id});
 const generation=++token;opening=true;buffer=[];seq=0;show();$('connection').textContent='Connecting…';
 try{
  if(session.source==='ble'){
   if(!navigator.bluetooth)throw Error('Open Arm Lab in desktop Chrome to use Bluetooth.');
   bleDevice=await navigator.bluetooth.requestDevice({filters:[{services:[bleService]}]});
   bleDevice.addEventListener('gattserverdisconnected',onBleLost);
   const server=await bleDevice.gatt.connect();
   const service=await server.getPrimaryService(bleService);
   bleCharacteristic=await service.getCharacteristic(bleSample);
   bleCharacteristic.addEventListener('characteristicvaluechanged',onBleSample);
   await bleCharacteristic.startNotifications();
   if(token!==generation)return;
   connected=true;opening=false;info('');show();
  }else if(session.source==='esp'){
   const poll=async()=>{const r=await fetch('/device/sample',{cache:'no-store',signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('Join Forearm-EMG on the Mac and check board power.');const v=await r.text();if(!/^\d{1,4}$/.test(v))throw Error('Unexpected sample format');if(token===generation)ingest(seq++,Number(v),performance.now())};
   await poll();connected=true;opening=false;show();$('connection').textContent='ESP32 connected';
   while(token===generation){await sleep(25);if(token===generation)await poll()}
  }else{
   if(!navigator.serial)throw Error('Open this local page in Chrome or Edge for Web Serial.');
   port=await navigator.serial.requestPort();await port.open({baudRate:(dual()||raw())?500000:115200,bufferSize:65536});
   reader=port.readable.getReader();connected=true;opening=false;show();$('connection').textContent='Port open · waiting for samples';
   let partial='';const decoder=new TextDecoder();
   while(token===generation){
    const {value,done}=await reader.read();if(done)break;
    partial+=decoder.decode(value,{stream:true});const lines=partial.split('\n');partial=lines.pop().slice(-128);
    for(const line of lines){
     if(dual()){
      const match=/^(\d+),(\d+),(\d+),(\d+)$/.exec(line.trim());
      if(!match)continue;
      const [n,...adc]=match.slice(1).map(Number);
      if(adc.every(v=>v<=1023))ingest(n,adc[raw()?0:1],n*.8,adc);
      continue;
     }
     const m=(raw()? /^(\d+),(\d+)$/:/^Envelope:(\d+)$/).exec(line.trim());if(!m)continue;
     const n=raw()?Number(m[1]):seq++;ingest(n,Number(m[raw()?2:1]),n*(raw()?.5:10))}
   }
   if(token===generation)await stop('Port closed');
  }
 }catch(e){if(generation===token)await stop(e.message)}
}
$('connect').onclick=connect;$('disconnect').onclick=()=>stop();
function normalized(rows){
 const c=session.cal;return amplitudes(rows,raw(),c.center).map(x=>(x-c.baseline)/c.span);
}
function quality(rows,ms){
 const min=dual()?1170:raw()?1900:session.source==='uno'?88:session.source==='ble'?35:6;
 if(rows.length<Math.ceil(ms/1000*min)||rows.at(-1)[2]-rows[0][2]<ms*.78)throw Error('Too little data. Check signal source and connection, then retry.');
 if(rows.some((r,i)=>i&&(r[0]!==rows[i-1][0]+1||r[2]-rows[i-1][2]>250)))throw Error('Sample gap. Repeat this capture.');
 if(rows.filter(r=>r[1]>=sources[session.source].max-1||(raw()&&r[1]<=1)).length>rows.length*.1)throw Error('Signal clipped. Check gain and electrode contact, then retry.');
}
function plan(){
 const rounds=[];for(let i=0;i<6;i++){const ids=labels().map(m=>m.id);
  for(let j=ids.length-1;j>0;j--){const k=Math.floor(Math.random()*(j+1));[ids[j],ids[k]]=[ids[k],ids[j]]}
  rounds.push(...ids.map(label=>({split:i<4?'train':'test',label})))}
 return rounds;
}
async function capture(){
 const key=++task;busy=true;show();info('');const t=session.plan[session.trials.length];
 const cue=$('cue').textContent;const instruction=$('instruction').textContent;
 try{
  for(const [title,detail,ms] of [['Relax','Rest before the next cue.',1400],[cue,instruction,900]]){
   $('cue').textContent=title;$('instruction').textContent=detail;await sleep(ms);if(task!==key)return;
  }
  $('stage').textContent='RECORDING · HOLD';const start=performance.now();const ms=t?config.windowMs:2200;
  await sleep(ms);if(task!==key)return;
  const rows=buffer.filter(r=>r[3]>=start && r[3]<=start+ms).map(([i,v,ms,arrival,...channels])=>[i,v,ms,...channels]);
  quality(rows,ms);
  if(!session.cal.rest){
   const center=raw()?quantile(rows.map(r=>r[1]),.5):0;const a=amplitudes(rows,raw(),center);
   session.cal={rest:rows,center,baseline:quantile(a,.5),noise:quantile(a,.95)-quantile(a,.05)};
  }else if(!session.cal.active){
   const span=quantile(amplitudes(rows,raw(),session.cal.center),.5)-session.cal.baseline;
   if(span<Math.max(2,session.cal.noise*1.5))throw Error('Reference overlaps the resting baseline. Check placement and try a comfortable activation again.');
   Object.assign(session.cal,{active:rows,span});session.plan=plan();
  }else{
   const n=normalized(rows),f=features(n);const pred=t.split==='test'?classify(f,session.model):null;
   session.trials.push({...t,id:crypto.randomUUID(),captured:new Date().toISOString(),rows,normalized:n,f,prediction:pred});
   if(t.split==='train'&&session.plan[session.trials.length]?.split==='test')session.model=train(session.trials.filter(x=>x.split==='train'));
  }
  store();info('Saved. Relax your arm.');
 }catch(e){info(e.message)}finally{if(key===task){busy=false;show()}}
}
$('go').onclick=capture;$('cancel').onclick=()=>{task++;busy=false;info('Capture discarded.');show()};
$('new').onclick=async()=>{if(session.cal.rest&&!confirm('Start a new session? Export this one first to keep a copy.'))return;await stop();session=empty();store();info('');show()};
$('export').onclick=()=>{
 const metadata={adcMax:sources[session.source].max,output:raw()?'RAW':'ENV',rowFields:['sequence','ADC_count','stream_time_ms'],clock:session.source==='ble'?'device sequence and uptime ms, nominal 50 Hz':raw()?'device sequence at 2000 Hz':session.source==='uno'?'inferred 100 Hz sample clock':'host poll time; sequence counts HTTP responses',formula:'(amplitude - baseline) / span; unclipped',amplitude:raw()?'RMS in consecutive 100-sample blocks after subtracting resting ADC median':'ADC count',pipeline:config,bank:site(),trialLabel:'operator cue; verify actual execution independently',features:config.featureNames,modelType:'standardized nearest centroid with distance and ambiguity rejection'};
 if(dual()){
  metadata.rowFields.push('A3_second_RAW','A4_first_ENV','A5_second_RECT');
  metadata.clock='device frame sequence at 1250 Hz; sequential ADC conversions';
  metadata.trainingChannel=raw()?'A3_second_RAW':'A4_first_ENV';
 }
 const url=URL.createObjectURL(new Blob([JSON.stringify({...session,metadata})],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download='arm-lab-'+session.site+'-'+session.id+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
};
const canvas=$('trace'),ctx=canvas.getContext('2d');
setInterval(()=>{
 if(!connected)return;const now=performance.now();const recent=buffer.filter(r=>r[3]>now-1200);
 const fresh=recent.length&&now-lastReceived<400;
 $('connection').textContent=fresh?'Receiving · '+sourcesLabel():(session.source==='ble'?'Waiting for Bluetooth notifications':'Waiting for samples · check port, sketch and baud');
 $('value').textContent=fresh?recent.at(-1)[1]:'—';
 $('rate').textContent=Math.round(recent.length/1.2)+' readings/s';
 if(fresh && session.source==='ble'){const values=recent.map(r=>r[1]);$('rate').textContent+=' · range '+Math.min(...values)+'–'+Math.max(...values)+' · '+Math.round(100*values.filter(v=>v===4095).length/values.length)+'% at ceiling'}
 if(dual()&&fresh){
  const r=recent.at(-1);
  $('units').textContent='A3 RAW '+r[4]+' · A4 ENV '+r[5]+' · A5 RECT '+r[6];
 }else $('units').textContent='ADC counts';
 ctx.clearRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#d5e4d8';
 for(let i=1;i<=3;i++){ctx.beginPath();ctx.moveTo(0,i*30);ctx.lineTo(760,i*30);ctx.stroke()}
 if(!fresh){$('prediction').textContent='No fresh signal';return}
 ctx.beginPath();ctx.strokeStyle='#19765b';ctx.lineWidth=2;
 const stride=Math.max(1,Math.floor(recent.length/760));
 for(let i=0;i<recent.length;i+=stride){const x=760*i/Math.max(1,recent.length-1),y=116-112*recent[i][1]/sources[session.source].max;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y)}ctx.stroke();
 if(session.model){try{quality(recent,config.windowMs);$('prediction').textContent=name(classify(features(normalized(recent)),session.model))}catch{$('prediction').textContent='Insufficient signal'}}
 else $('prediction').textContent='Awaiting training';
},180);
function sourcesLabel(){return {ble:'ESP32 Bluetooth',dualEnv:'two arms · first ENV',dualRaw:'two arms · second RAW',uno:'Uno ENV',raw:'Uno RAW',esp:'ESP32 ENV'}[session.source]}
show();

import {BinarySwitch,median,settings} from './switch.js';
import {beginLog,logSample,endLog} from './archive.js';
const el=id=>document.getElementById(id);

function arm(side){
 const $=id=>el(side+id);
 let detector,capture,refs={},current,lastGrade,correct=0,total=0,armed=false,restSince=null;
 function disableGrade(value){$('yes').disabled=$('no').disabled=value}
function resetCalibration(){
 detector=null;capture=null;refs={};
 $('restRef').disabled=$('flexRef').disabled=true;
 $('cal').textContent='Capture rest and flex to calibrate this connection.';
}
function calibrate(pose){
 if(capture || !current || performance.now()-current.now>400)return;
 stopWheels();detector=null;disableGrade(true);capture={pose,samples:[],start:performance.now()};
 $('cal').textContent='Hold '+pose+' steady for two seconds…';
}
$('restRef').onclick=()=>calibrate('rest');
$('flexRef').onclick=()=>calibrate('flex');
function updateCalibration(packet){
 $('restRef').disabled=$('flexRef').disabled=!!capture;
 if(!capture)return;
 const {samples,pose,start}=capture;
 samples.push(packet);
 if(performance.now()-start<2000)return;
 capture=null;
 if(samples.length<80 || samples.some((s,i)=>i && s.seq!==samples[i-1].seq+1)){
  $('cal').textContent='Sample gap. Capture '+pose+' again.';return;
 }
 const v=samples.map(p=>p.adc).sort((a,b)=>a-b);
 refs[pose]={low:v[Math.floor(v.length*.1)],mid:median(v),high:v[Math.floor(v.length*.9)]};
 if(!refs.rest || !refs.flex){$('cal').textContent=pose+' saved. Capture the other pose.';return}
 const {rest,flex}=refs;
 const ranges='Rest '+rest.low+'–'+rest.high+' · flex '+flex.low+'–'+flex.high+' (middle 80%).';
 if(rest.high>=flex.low){
  $('cal').textContent=ranges+' No clear gap. Hold each pose steady and recapture.';return;
 }
 // Place both switch thresholds inside the measured gap between the reference bands.
 const gap=settings(rest.high,flex.low);
 const profile={...gap,rest:rest.mid,flex:flex.mid};
 detector=new BinarySwitch(profile);correct=total=0;$('graded').textContent='';
 logSample(packet.now,packet.seq,packet.adc,packet.device_ms,['calibration',side,refs.rest,refs.flex,profile]);
 $('cal').textContent=ranges+' FLEX at or above '+Math.ceil(profile.on)+' · REST at or below '+Math.floor(profile.off)+(flex.high===4095?' · flex reached the ADC ceiling':'');
}
for(const id of ['yes','no'])$(id).onclick=()=>{
 if(!current || performance.now()-current.now>400 || current.seq===lastGrade)return;
 const {seq,adc,device_ms,active}=current;
 const right=id==='yes';lastGrade=seq;correct+=Number(right);total++;
 logSample(performance.now(),seq,adc,device_ms,['feedback',side,active,right?active:!active]);
 $('graded').textContent='Saved · '+correct+' of '+total+' marks correct this connection';disableGrade(true);
};

 function disarm(){armed=false;$('wheel').textContent='Enable '+side+' wheel'}
 function stale(){disarm();capture=null;current=null;restSince=null;detector?.reset();disableGrade(true);
  $('wheel').disabled=$('restRef').disabled=$('flexRef').disabled=true;$('prediction').textContent='Waiting for samples'}
 function reset(){stale();resetCalibration();lastGrade=null;correct=total=0;$('graded').textContent=$('signal').textContent=''}
 function update(packet){
  updateCalibration(packet);
  const active=detector?detector.update(packet):null;
  current={...packet,active};
  if(active===false && packet.adc<=detector.profile.off)restSince??=packet.now;
  else restSince=null;
  $('wheel').disabled=!armed && !(drive && restSince!==null && packet.now-restSince>=300);
  $('signal').textContent='ENV '+packet.adc;
  $('prediction').textContent=active===null?'Awaiting calibration':active?'FLEX':'REST';
  disableGrade(active===null);return active;
 }
 $('wheel').onclick=()=>{if(armed)disarm();else if(!$('wheel').disabled && current && performance.now()-current.now<150){armed=true;$('wheel').textContent='Disable '+side+' wheel'}send()};
 reset();
 return {update,reset,disarm,stale,get moving(){return armed && current?.active}};
}
const left=arm('left'),right=arm('right');
const uuid=s=>'e0730c'+s+'-b64d-48f3-a0ac-3d0657c85430';
let device,ch,drive,dual=false,last=-Infinity,prev,writing=false;
// Use one monotonic clock for sample arrivals and acknowledged wheel writes.
let clip, recording=false, origin, previousMask=null;
function elapsed(){return Math.round(performance.now()-origin)}
el('gameStart').onclick=()=>{
 if(!dual || !drive || performance.now()-last>=150)return;
 origin=performance.now();previousMask=null;recording=true;
 clip={format:'arm-lab-game-v1',started:new Date().toISOString(),duration_ms:0,
  samples:[],commands:[]};
 el('gameStart').disabled=true;el('gameEnd').disabled=false;el('gameSave').disabled=true;
 el('gameStatus').textContent='Recording both biceps and wheel commands…';
};
function finishGame(){
 if(!recording)return;
 recording=false;clip.duration_ms=elapsed();
 el('gameEnd').disabled=true;el('gameSave').disabled=false;
 el('gameStatus').textContent='Ready to download · '+clip.samples.length+' samples';
}
el('gameEnd').onclick=finishGame;
el('gameSave').onclick=()=>{
 const url=URL.createObjectURL(new Blob([JSON.stringify(clip)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='arm-lab-game-'+clip.started.replaceAll(':','-')+'.json';a.click();
 setTimeout(()=>URL.revokeObjectURL(url),5000);
};
function stopWheels(){left.disarm();right.disarm();send()}
async function send(){
 if(!drive||writing)return;
 writing=true;
 try{const mask=!document.hidden && performance.now()-last<150?(Number(!!left.moving)|Number(!!right.moving)<<1):0;
 await drive.writeValueWithResponse(Uint8Array.of(mask));
 if(recording && previousMask!==mask){
   clip.commands.push({t_ms:elapsed(),left_forward:!!(mask&1),right_forward:!!(mask&2)});
   previousMask=mask;
  }
  if(drive)el('command').textContent="Wheel command · "+["Stop","Turn right","Turn left","Forward"][mask]}
 catch{device?.gatt.disconnect()}finally{writing=false}
}
function clear(){
 finishGame();el('gameStart').disabled=true;
 ch?.removeEventListener('characteristicvaluechanged',receive);device?.removeEventListener('gattserverdisconnected',clear);
 ch=drive=null;dual=false;last=-Infinity;prev=undefined;
 left.reset();right.reset();endLog();el('connect').disabled=false;el('stop').disabled=true;el('command').textContent="Wheel command · Stop";el('link').textContent='Disconnected';
}
function receive(e){
 const v=e.target.value;if(v.byteLength!==(dual?12:10))return;
 const now=performance.now(),seq=v.getUint32(0,true),device_ms=v.getUint32(4,true);
 if(prev!==undefined && (seq!==prev+1||now-last>150)){left.stale();right.stale()}
 prev=seq;last=now;
 const adc=v.getUint16(8,true),r=dual?v.getUint16(10,true):null;
 const a=left.update({now,seq,device_ms,adc}),b=dual?right.update({now,seq,device_ms,adc:r}):null;
 if(recording)clip.samples.push({t_ms:elapsed(),seq,device_ms,left_env:adc,right_env:r,left_flex:a,right_flex:b});
 el('gameStart').disabled=recording || !dual || !drive;
 logSample(now,seq,adc,device_ms,['sample',a,r,b]);
}
el('connect').onclick=async()=>{
 el('connect').disabled=true;
 try{
 device=await navigator.bluetooth.requestDevice({filters:[{services:[uuid('50')]}]});
 device.addEventListener('gattserverdisconnected',clear);
 const svc=await (await device.gatt.connect()).getPrimaryService(uuid('50'));
 try{ch=await svc.getCharacteristic(uuid('53'));dual=true}catch{ch=await svc.getCharacteristic(uuid('51'))}
 try{drive=await svc.getCharacteristic(uuid('52'))}catch{drive=null}
 beginLog({source:'Biceps free flex',extraFields:'sample: left prediction, right ADC, right prediction; calibration and feedback include side'});
 ch.addEventListener('characteristicvaluechanged',receive);await ch.startNotifications();
 el('stop').disabled=false;
 el('link').textContent=dual?'Reading left and right biceps together. Calibrate each arm, then enable both wheels.':'Left connected. Right bicep requires the two-arm firmware.';
 }catch(e){device?.gatt?.disconnect();clear();el('link').textContent=e.message}
};
el('stop').onclick=()=>device?.gatt.disconnect();
document.addEventListener('visibilitychange',()=>{if(document.hidden){finishGame();stopWheels()}});
setInterval(()=>{if(prev!==undefined && performance.now()-last>=150){finishGame();el('gameStart').disabled=true;left.stale();right.stale();prev=undefined}send()},80);

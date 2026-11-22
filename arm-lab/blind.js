import {BinarySwitch,median,settings} from './switch.js';
import {beginLog,logSample,endLog} from './archive.js';
const $=id=>document.getElementById(id);
let drive=null,armed=false,sending=false;
let detector=null, capture=null, refs={};
function resetCalibration(){
 detector=null;capture=null;refs={};
 $('restRef').disabled=$('flexRef').disabled=true;
 $('cal').textContent='Capture rest and flex to calibrate this connection.';
}
function calibrate(pose){
 if(capture || !current || performance.now()-current.now>400)return;
 disarm();detector=null;disableGrade(true);capture={pose,samples:[],start:performance.now()};
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
 logSample(packet.now,packet.seq,packet.adc,packet.device_ms,['calibration',refs.rest,refs.flex,profile]);
 $('cal').textContent=ranges+' FLEX at or above '+Math.ceil(profile.on)+' · REST at or below '+Math.floor(profile.off)+(flex.high===4095?' · flex reached the ADC ceiling':'');
}
const service='e0730c50-b64d-48f3-a0ac-3d0657c85430';
let device,ch,current,lastGrade,correct=0,total=0;
function disableGrade(disabled){$('yes').disabled=disabled;$('no').disabled=disabled}
function clear(){
 disarm();drive=null;endLog();resetCalibration();current=null;lastGrade=null;disableGrade(true);
 $('connect').disabled=false;$('stop').disabled=true;$('prediction').textContent='Waiting for sensor';
 if(ch)ch.removeEventListener('characteristicvaluechanged',receive);
 device?.removeEventListener('gattserverdisconnected',clear);ch=null;
}
function receive(e){
 const v=e.target.value;if(v.byteLength!==10)return;
 const now=performance.now(), seq=v.getUint32(0,true),device_ms=v.getUint32(4,true),adc=v.getUint16(8,true);
 updateCalibration({now,seq,adc,device_ms});
 const active=detector?detector.update({seq,device_ms,adc}):null;current={now,seq,device_ms,adc,active};
 logSample(now,seq,adc,device_ms,['sample',active]);
 $('prediction').textContent=active===null?'Awaiting calibration':active?'FLEX':'REST';$('signal').textContent='ENV '+adc+' / 4095';disableGrade(active===null);
}
$('connect').onclick=async()=>{
 $('connect').disabled=true;
 try{
  device=await navigator.bluetooth.requestDevice({filters:[{services:[service]}]});
  device.addEventListener('gattserverdisconnected',clear);
  const server=await device.gatt.connect(),svc=await server.getPrimaryService(service);
  ch=await svc.getCharacteristic('e0730c51-b64d-48f3-a0ac-3d0657c85430');
  try{drive=await svc.getCharacteristic('e0730c52-b64d-48f3-a0ac-3d0657c85430')}catch{drive=null}
  correct=total=0;$('graded').textContent='';
  resetCalibration();beginLog({source:'Biceps free flex',extraFields:'sample rows: sample, predictedFlex; feedback rows: feedback, predictedFlex, actualFlex. Feedback repeats the graded sequence.'});
  ch.addEventListener('characteristicvaluechanged',receive);await ch.startNotifications();$('stop').disabled=false;
 }catch(e){device?.gatt?.disconnect();clear();$('signal').textContent=e.message}
};
$('stop').onclick=()=>device?.gatt.disconnect();
for(const id of ['yes','no'])$(id).onclick=()=>{
 if(!current || performance.now()-current.now>400 || current.seq===lastGrade)return;
 const {seq,adc,device_ms,active}=current;
 const right=id==='yes';lastGrade=seq;correct+=Number(right);total++;
 logSample(performance.now(),seq,adc,device_ms,['feedback',active,right?active:!active]);
 $('graded').textContent='Saved · '+correct+' of '+total+' marks correct this connection';disableGrade(true);
};
setInterval(()=>{if(current && performance.now()-current.now>400){current=null;capture=null;detector?.reset();disableGrade(true);$('prediction').textContent='Waiting for fresh samples'}},150);

function disarm(){armed=false;$('wheel').textContent='Enable left wheel'}
$('wheel').onclick=()=>{
 if(armed){disarm();return}
 if(drive && detector && current?.active===false && performance.now()-current.now<150){armed=true;$('wheel').textContent='Disable left wheel'}
};
document.addEventListener('visibilitychange',()=>{if(document.hidden)disarm()});
setInterval(async()=>{
 const fresh=current && performance.now()-current.now<150;
 if(!fresh || !detector || document.hidden)disarm();
 $('wheel').disabled=!armed && !(drive && fresh && detector && current.active===false);
 if(!drive || sending || !armed)return;
 sending=true;
 try{await drive.writeValueWithResponse(Uint8Array.of(current.active?1:0))}
 catch{disarm()}finally{sending=false}
},80);

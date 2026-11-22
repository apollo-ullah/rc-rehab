import {BinarySwitch,settings} from './switch.js';
import {beginLog,logSample,endLog} from './archive.js';
const el=id=>document.getElementById(id);
const buttons=[...document.querySelectorAll('[data-ref]')];
const uuid=s=>'e0730c'+s+'-b64d-48f3-a0ac-3d0657c85430';
let device,drive,samples,refs={},filters,cap,armed=false,writing=false,last=-Infinity,mask=0,seq;
let manualMask=0,manualUntil=0;
const manualButtons=[...document.querySelectorAll('[data-drive]')];
for(const button of manualButtons)button.onclick=()=>{
 if(!drive||document.hidden)return;
 if(cap){cap=null;el("status").textContent="Calibration cancelled for manual test."}
 disarm();manualMask=Number(button.dataset.drive);manualUntil=performance.now()+500;
};
el('manualStop').onclick=()=>disarm();
function disarm(){manualMask=0;manualUntil=0;disableFlex()}
function disableFlex(){armed=false;el('arm').textContent='Enable wheels'}
function clean(){
 disarm();drive=null;cap=null;refs={};filters=null;last=-Infinity;seq=undefined;mask=0;
 samples?.removeEventListener('characteristicvaluechanged',receive);samples=null;
 device?.removeEventListener('gattserverdisconnected',clean);endLog();
 el('connect').disabled=false;el('disconnect').disabled=true;el('signal').textContent='Disconnected';el('state').textContent='Waiting for calibration';
}
function band(values){values.sort((a,b)=>a-b);return [values[Math.floor(values.length*.1)],values[Math.floor(values.length*.9)]]}
function calibrate(vals,time){
 cap.rows.push(vals);
 if(time-cap.start<2000)return;
 const {key,rows}=cap;cap=null;
 if(rows.length<80){el('status').textContent='Too few samples. Repeat that capture.';return}
 refs[key]=[0,1].map(i=>band(rows.map(row=>row[i])));
 if(!refs.rest||!refs.left||!refs.right){el('status').textContent='Saved '+key+'. Capture the remaining poses.';return}
 const profiles=[];
 for(const [i,side] of ['left','right'].entries()){
  const high=refs.rest[i][1],low=refs[side][i][0];
  if(high>=low){el('status').textContent=side+' references overlap. Recapture rest and that flex.';return}
  profiles.push(settings(high,low));
 }
 filters=profiles.map(p=>new BinarySwitch(p));el('status').textContent='Calibrated. Check both turns and straight on screen before enabling wheels.';
}
for(const b of buttons)b.onclick=()=>{disarm();filters=null;mask=0;cap={key:b.dataset.ref,rows:[],start:performance.now()};el('status').textContent='Hold '+cap.key+' for two seconds…'};
function receive(event){
 const d=event.target.value;if(d.byteLength!==12)return;
 const now=performance.now(),n=d.getUint32(0,true),ms=d.getUint32(4,true),v=[d.getUint16(8,true),d.getUint16(10,true)];
 if(seq!==undefined && (n!==seq+1||now-last>200)){disableFlex();if(cap){cap=null;el('status').textContent='Stream gap. Repeat capture.'}}
 last=now;seq=n;if(cap)calibrate(v,now);
 mask=filters?filters.reduce((bits,f,i)=>bits|(Number(f.update({adc:v[i],seq:n,device_ms:ms}))<<i),0):0;
 el('signal').textContent='Left '+v[0]+' · Right '+v[1];
 el('state').textContent=filters?['REST','Left wheels · turn right','Right wheels · turn left','Both wheels · straight'][mask]:'Waiting for calibration';
 logSample(now,n,v[0],ms,[v[1],mask,armed]);
}
el('connect').onclick=async()=>{
 el('connect').disabled=true;
 try{
 device=await navigator.bluetooth.requestDevice({filters:[{services:[uuid('50')]}]});device.addEventListener('gattserverdisconnected',clean);
 const server=await device.gatt.connect(),svc=await server.getPrimaryService(uuid('50'));
 drive=await svc.getCharacteristic(uuid('52'));
 el('disconnect').disabled=false;
 try{samples=await svc.getCharacteristic(uuid('53'));
 beginLog({source:'Two-arm drive',extraFields:['right_adc','wheel_mask','enabled']});
 samples.addEventListener('characteristicvaluechanged',receive);await samples.startNotifications();
 }catch{el('status').textContent='Manual wheel test ready. Sensor stream unavailable.'}
 }catch(e){device?.gatt?.disconnect();clean();el('status').textContent=e.message}
};
el('disconnect').onclick=()=>device?.gatt.disconnect();
el('arm').onclick=()=>{if(armed)disarm();else if(filters && mask===0 && performance.now()-last<150){armed=true;el('arm').textContent='Disable wheels'}};
document.addEventListener('visibilitychange',()=>{if(document.hidden)disarm()});
setInterval(async()=>{
 const fresh=drive && performance.now()-last<150;
 if(!fresh)disableFlex();
 if(document.hidden)disarm();
 if(!fresh && drive)el('state').textContent='Waiting for fresh samples';
 buttons.forEach(b=>b.disabled=!fresh||!!cap);
 if(performance.now()>=manualUntil)manualMask=0;
 manualButtons.forEach(b=>b.disabled=!drive||document.hidden);
 el('arm').disabled=!!manualMask||!armed && !(fresh && filters && mask===0);
 if(!drive||writing)return;
 writing=true;try{await drive.writeValueWithResponse(Uint8Array.of(manualMask || (armed?mask:0)))}catch{disarm()}finally{writing=false}
},80);

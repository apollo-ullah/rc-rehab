import {createStages,credit} from './elbow-protocol.js';
import {beginLog,logSample,endLog,saveWebcamTrial} from './archive.js';
import {FilesetResolver, HandLandmarker, PoseLandmarker} from './hand-assets/vision.mjs';
const el=id=>document.getElementById(id);
const video=el('video');
const service='e0730c50-b64d-48f3-a0ac-3d0657c85430';
let device, stream, model, frameCallback, lastPacket=-Infinity, lastFrame=-Infinity;
let recent=[], refs={}, run, finished, timer;
const elbow=()=>el('mode').value==='elbow';
let stageIndex=0,previousPacket=null;
function setupLabels(){
 el('start').textContent=elbow()?'Start guided elbow trial':'Start 30-second trial';
 el('sideLabel').hidden=!elbow();
 el('setupTip').textContent=elbow()?'Show the sensor arm side-on with your shoulder, elbow and wrist in view. Keep your upper arm still and hand loose. Three comfortable five-second holds, then a quiet ten-second rest. Video stays on this Mac.':'Angle the camera so it can see your fingers curl. Keep one hand in view. Video stays on this Mac.';
 el('rest').textContent=elbow()?'Capture lowered arm':'Capture relaxed hand';
 el('fist').textContent=elbow()?'Capture bent elbow':'Capture gentle fist';
 el('pose').textContent='';
}
el('mode').onchange=setupLabels;
setupLabels();
function controls(){
 const calibrated=refs.rest!==undefined && refs.fist>refs.rest+0.08;
 el('start').disabled=!!run || !stream || !calibrated || performance.now()-lastPacket>600 || performance.now()-lastFrame>500;
 for(const id of ['rest','fist']) el(id).disabled=!!run || !stream || performance.now()-lastFrame>500;
 el('off').disabled=!stream;
}
el('ble').onclick=async()=>{
 el('ble').disabled=true;
 try {
  device=await navigator.bluetooth.requestDevice({filters:[{services:[service]}]});
  device.addEventListener('gattserverdisconnected',()=>{endLog();lastPacket=-Infinity;el('signal').textContent='Sensor disconnected';el('ble').disabled=false;});
  const server=await device.gatt.connect();
  const svc=await server.getPrimaryService(service);
  const ch=await svc.getCharacteristic('e0730c51-b64d-48f3-a0ac-3d0657c85430');
  beginLog({source:'webcam BLE ENV'});
  ch.addEventListener('characteristicvaluechanged',e=>{
   const d=e.target.value;if(d.byteLength!==10)return;
   lastPacket=performance.now();const adc=d.getUint16(8,true);
   logSample(lastPacket,d.getUint32(0,true),adc,d.getUint32(4,true));
   el('signal').textContent='ENV · '+adc+' / 4095';
   if(run && lastPacket<run.start+run.limit_ms){
    const sample={ms:lastPacket-run.start,seq:d.getUint32(0,true),device_ms:d.getUint32(4,true),adc};
    run.samples.push(sample);
    if(run.stages){
     const stage=run.stages[stageIndex], frame=run.frames.at(-1);
     const valid=frame && sample.ms>=frame.ms && sample.ms-frame.ms<=150 && frame.state===stage.pose && adc>0 && adc<4095;
     const packet={...sample,valid:Boolean(valid)};
     credit(stage,packet,previousPacket);previousPacket=packet;
     if(stage.earned_ms>=stage.target_ms){
      stage.end_ms=sample.ms;stageIndex++;previousPacket=null;
      if(stageIndex===run.stages.length){finish('Guided trial complete');return}
      run.stages[stageIndex].start_ms=sample.ms;
      run.cues.push({ms:sample.ms,action:run.stages[stageIndex].pose});
     }
    }
   }
  });await ch.startNotifications();
 }catch(e){device?.gatt?.disconnect();el('signal').textContent=e.message;el('ble').disabled=false;}
};
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)}
function median(values){return values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)]}
function frame(now){
 const result=model.detectForVideo(video,now);
 const detected=result.worldLandmarks[0];
 let angle=null,quality=null;
 let score=null,curl=null,state='unknown';
 if(elbow() && detected){
  const indices=el('side').value==='left'?[11,13,15]:[12,14,16];
  const joints=indices.map(i=>result.landmarks[0][i]);
  quality=Math.min(...joints.map(p=>p.visibility??0));
  if(quality>=0.6 && joints.every(p=>p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1)){
   const [a,b,c]=joints;
   const ux=(a.x-b.x)*video.videoWidth, uy=(a.y-b.y)*video.videoHeight;
   const vx=(c.x-b.x)*video.videoWidth, vy=(c.y-b.y)*video.videoHeight;
   const lengths=Math.hypot(ux,uy)*Math.hypot(vx,vy);
   if(lengths>1){
    angle=Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/lengths)))*180/Math.PI;
    score=(180-angle)/180;
   }
  }
 }else if(detected){
  const bends=[5,9,13,17].map(i=>{
   let path=0;for(let j=i;j<i+3;j++)path+=distance(detected[j],detected[j+1]);
   return 1-distance(detected[i],detected[i+3])/Math.max(path,1e-6);
  });
  score=median(bends);
 }
 if(score!==null){
  lastFrame=now;recent.push({now,score});
  if(refs.fist>refs.rest+0.08){
   curl=Math.min(1,Math.max(0,(score-refs.rest)/(refs.fist-refs.rest)));
   state=curl<=0.25?'relaxed':curl>=0.75?(elbow()?'bent':'closed'):'transition';
   if(elbow() && state==='transition'){
    const earlier=recent.find(f=>now-f.now<=200 && now-f.now>=80);
    if(earlier && Math.abs(score-earlier.score)>0.015)state=score>earlier.score?'bending':'lowering';
   }
  }
 }else recent=[];
 recent=recent.filter(f=>now-f.now<650);
 el('pose').textContent=score===null?'Tracking unknown · check camera framing':elbow()?Math.round(angle)+'° elbow angle · '+(curl===null?'ready to calibrate':state):(curl===null?'Hand visible':state+' · curl '+curl.toFixed(2));
 if(run && now>=run.start && now<run.start+run.limit_ms)run.frames.push({ms:now-run.start,score,curl,state,...(elbow()?{angle_deg:angle,visibility:quality}:{})});
 frameCallback=video.requestVideoFrameCallback(frame);
}
function stopCamera(){
 if(frameCallback)video.cancelVideoFrameCallback(frameCallback);
 stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;recent=[];refs={};lastFrame=-Infinity;
 el('refs').textContent='';model?.close();model=null;el('mode').disabled=false;el('side').disabled=false;el('cam').disabled=false;el('status').textContent='Camera off';controls();
}
el('off').onclick=()=>{if(run)finish('Stopped early');stopCamera()};
el('cam').onclick=async()=>{
 el('mode').disabled=true;el('side').disabled=true;el('cam').disabled=true;el('status').textContent='Opening camera…';
 try{
  stream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480},audio:false});
  video.srcObject=stream;await video.play();
  model=await (elbow()?PoseLandmarker:HandLandmarker).createFromOptions(await FilesetResolver.forVisionTasks('./hand-assets'),{baseOptions:{modelAssetPath:elbow()?'./hand-assets/pose.task':'./hand-assets/hand.task'},runningMode:'VIDEO',...(elbow()?{numPoses:1}:{numHands:1})});
  frameCallback=video.requestVideoFrameCallback(frame);el('status').textContent='Camera active · hold each pose still before capturing it';
 }catch(e){stopCamera();el('status').textContent=e.message}
};
for(const id of ['rest','fist'])el(id).onclick=()=>{
 if(recent.length<3 || performance.now()-lastFrame>300){el('refs').textContent='Hold still in view, then capture again.';return}
 refs[id]=median(recent.map(f=>f.score));
 el('refs').textContent=Object.keys(refs).length===1?'Captured. Hold the other pose and capture it.':refs.fist>refs.rest+0.08?'Both poses calibrated.':'Poses overlap. Adjust camera angle and recapture.';
 controls();
};
function draw(r){
 const ctx=el('plot').getContext('2d');ctx.clearRect(0,0,780,170);
 for(const [rows,field,max,color,gap] of [[r.samples,'adc',4095,'#19765c',160],[r.frames,'curl',1,'#8846ad',250]]){
  ctx.strokeStyle=color;ctx.beginPath();let prev=-Infinity;
  for(const row of rows){if(row[field]==null){prev=-Infinity;continue}
   const x=row.ms/(r.duration_ms || r.limit_ms)*780,y=165-row[field]/max*160;
   if(row.ms-prev>gap)ctx.moveTo(x,y);else ctx.lineTo(x,y);prev=row.ms;
  }ctx.stroke();
 }
}
function finish(reason){
 clearInterval(timer);finished=run;run=null;const r=finished;r.duration_ms=Math.min(r.limit_ms,performance.now()-r.start);r.outcome=reason;el('endTrial').hidden=true;
 void saveWebcamTrial(r);
 draw(r);const groups=elbow()?{relaxed:[],bent:[]}:{relaxed:[],closed:[]};let i=0;
 for(const s of r.samples){
  while(i+1<r.frames.length && r.frames[i+1].ms<=s.ms)i++;
  const f=r.frames[i];if(f && s.ms>=f.ms && s.ms-f.ms<=150 && groups[f.state])groups[f.state].push(s.adc);
 }
 const unknown=r.frames.filter(f=>f.state==='unknown').length;
 el('cue').textContent=reason;el('result').textContent=r.samples.length+' ENV samples · '+r.frames.length+' camera frames ('+unknown+' unknown). '+Object.entries(groups).map(([k,v])=>k+' median ENV '+(v.length?median(v):'unavailable')+' ('+v.length+' samples)').join(' · ')+'. Clipped samples: '+r.samples.filter(s=>s.adc===4095).length+'.';
 el('save').disabled=false;controls();
}
el('start').onclick=()=>{
 if(run)return;
 const cues=[{ms:0,action:elbow()?'Lower your arm and relax':'Relax'}];let ms=2500;
 while(!elbow() && ms<27000){cues.push({ms,action:elbow()?'Bend your elbow and hold':'Gently close your fist'});ms+=1800;cues.push({ms,action:elbow()?'Lower your arm and relax':'Relax'});ms+=2200+Math.floor(Math.random()*1800)}
 stageIndex=0;previousPacket=null;
 run={limit_ms:elbow()?90000:30000,schema:'arm-lab-webcam/1',movement:el('mode').value,arm:elbow()?el('side').value:null,created:new Date().toISOString(),start:performance.now(),calibration:{...refs},cues,samples:[],frames:[]};el('result').textContent='';el('save').disabled=true;controls();
 if(elbow()){run.stages=createStages();run.stages[0].start_ms=0;run.cues=[{ms:0,action:'relaxed'}]}
 el('endTrial').hidden=false;
 const tick=()=>{const t=performance.now()-run.start;if(t>=run.limit_ms){finish(run.stages?'Time limit · partial trial saved':'Trial complete');return}
 if(run.stages){
  const stage=run.stages[stageIndex], current=run.frames.at(-1);
  const action=stage.pose==='bent'?'Bend comfortably and hold':'Lower your arm and rest';
  el('cue').textContent=action+' · '+((stage.target_ms-stage.earned_ms)/1000).toFixed(1)+' s';
  let feedback='Counting confirmed pose';
  if(performance.now()-lastPacket>400)feedback='Waiting for Bluetooth samples';
  else if(!current || t-current.ms>150 || current.state==='unknown')feedback='Show shoulder, elbow and wrist side-on';
  else if(current.state!==stage.pose)feedback='Waiting for the calibrated '+stage.pose+' pose';
  else if(!previousPacket?.valid)feedback='Waiting for an in-range ENV reading';
  el('result').textContent='Step '+(stageIndex+1)+' of '+run.stages.length+' · '+feedback+(stage.purpose==='quiet check'?' · continuous rest check':'');
  draw(run);return;
 }
 el('cue').textContent=cues.filter(c=>c.ms<=t).at(-1).action+' · '+Math.ceil((30000-t)/1000)+' s';draw(run)};
 tick();timer=setInterval(tick,100);
};
el('save').onclick=()=>{
 const url=URL.createObjectURL(new Blob([JSON.stringify(finished)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=(finished.movement==='elbow'?'biceps-webcam-':'forearm-webcam-')+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
setInterval(controls,250);

el('endTrial').onclick=()=>{if(run)finish('Stopped early · partial trial saved')};

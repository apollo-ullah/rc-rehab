// Each connection gets a separate log. Sample and trial data stay in this browser.
const dbReady=new Promise((resolve,reject)=>{
 const req=indexedDB.open('arm-lab-recordings',1);
 req.onupgradeneeded=()=>{
  req.result.createObjectStore('runs',{keyPath:'id'});
  req.result.createObjectStore('chunks',{keyPath:['id','part']});
 };
 req.onsuccess=()=>resolve(req.result);
 req.onerror=()=>reject(req.error);
});
dbReady.catch(()=>{});
const status=document.querySelector('#archiveStatus');
const picker=document.querySelector('#archiveRuns');
let active, writing=false;
const queue=[];
function flush(){
 if(active?.rows.length){
  queue.push({meta:active.meta,part:active.part++,rows:active.rows});
  active.rows=[];
 }
 if(!writing && queue.length)void commit();
}
async function commit(){
 writing=true;
 try{
  const db=await dbReady;
  while(queue.length){
   const chunk=queue[0];
   await new Promise((resolve,reject)=>{
    const tx=db.transaction(['runs','chunks'],'readwrite');
    tx.objectStore('runs').put(chunk.meta);
    tx.objectStore('chunks').put({id:chunk.meta.id,part:chunk.part,rows:chunk.rows});
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
   });
   queue.shift();
   status.textContent='Saved locally through '+new Date(chunk.meta.timeOrigin+chunk.rows.at(-1)[0]).toLocaleTimeString();
   if(chunk.part===0)await list();
  }
 }catch(e){status.textContent='Local save failed · '+e.message+' · keep this tab open to retry';}
 finally{writing=false}
}
export function beginLog(details){
 flush();
 active={meta:{...details,id:crypto.randomUUID(),started:new Date().toISOString(),timeOrigin:performance.timeOrigin,fields:['arrival_ms','sequence','adc','stream_ms','extra_channels…']},part:0,rows:[]};
}
export function logSample(time,seq,adc,ms,extras=[]){
 if(!active)return;
 active.rows.push([time,seq,adc,ms,...extras]);
 if(active.rows.length>=100)flush();
}
export function endLog(){flush();active=null}
async function list(){
 const db=await dbReady;
 const runs=await new Promise((resolve,reject)=>{const q=db.transaction('runs').objectStore('runs').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
 const previous=picker.value;
 picker.replaceChildren(...runs.sort((a,b)=>b.started.localeCompare(a.started)).map(r=>new Option(new Date(r.started).toLocaleString()+' · '+r.source,r.id)));
 if(previous && runs.some(r=>r.id===previous))picker.value=previous;
}
document.querySelector('#archiveExport').onclick=async()=>{
 flush();while(writing)await new Promise(r=>setTimeout(r,30));
 if(queue.length){status.textContent='Still waiting to save · retry export';return}
 const id=picker.value;if(!id)return;
 const db=await dbReady,tx=db.transaction(['runs','chunks']);
 const get=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
 const [run,chunks]=await Promise.all([get(tx.objectStore('runs').get(id)),get(tx.objectStore('chunks').getAll(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER])))]);
 const url=URL.createObjectURL(new Blob([JSON.stringify({...run,rows:chunks.flatMap(c=>c.rows)})],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='arm-lab-live-'+id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
};
setInterval(flush,500);
document.addEventListener('visibilitychange',()=>{if(document.hidden)flush()});
window.addEventListener('pagehide',flush);
list().catch(e=>status.textContent='Local storage unavailable · '+e.message);
export async function saveWebcamTrial(trial){
 try{
  const db=await dbReady;
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('runs','readwrite');
   tx.objectStore('runs').put({...trial,id:crypto.randomUUID(),started:trial.created,source:'Webcam labeled trial'});
   tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });
  await list();
 }catch(e){status.textContent='Trial save failed · use Export trial JSON before leaving: '+e.message}
}

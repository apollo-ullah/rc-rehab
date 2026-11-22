// Timing is earned by consecutive, usable ENV packets with a matching camera pose.
export function createStages(){
 return [
  ['relaxed',4,'reference'],['bent',5,'reference'],['relaxed',3,'reference'],
  ['bent',5,'check'],['relaxed',3,'check'],['bent',5,'check'],['relaxed',10,'quiet check']
 ].map(([pose,seconds,purpose])=>({pose,target_ms:seconds*1000,purpose,earned_ms:0}));
}
export function credit(stage,current,previous){
 if(!previous)return;
 const gap=current.device_ms-previous.device_ms;
 if(!current.valid || !previous.valid || current.seq!==previous.seq+1 || gap<=0 || gap>100 || current.ms-previous.ms>150){
  if(stage.purpose==='quiet check')stage.earned_ms=0;
  return;
 }
 stage.earned_ms=Math.min(stage.target_ms,stage.earned_ms+gap);
}

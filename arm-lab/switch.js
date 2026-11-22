export function median(values){
 const sorted=[...values].sort((a,b)=>a-b);
 const mid=Math.floor(sorted.length/2);
 return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}
export function settings(rest,flex){
 return {rest,flex,on:rest+0.65*(flex-rest),off:rest+0.35*(flex-rest)};
}
export class BinarySwitch{
 constructor(profile){this.profile=profile;this.reset()}
 reset(){this.active=false;this.window=[];this.since=null;this.last=null}
 update(sample){
  if(this.last && (sample.seq!==this.last.seq+1 || sample.device_ms-this.last.device_ms>150 || sample.device_ms<=this.last.device_ms))this.reset();
  this.last=sample;this.window.push(sample.adc);if(this.window.length>5)this.window.shift();
  const level=median(this.window);
  const change=this.active?level<=this.profile.off:level>=this.profile.on;
  if(!change)this.since=null;
  else{
   this.since??=sample.device_ms;
   if(sample.device_ms-this.since>=300){this.active=!this.active;this.since=null}
  }
  return this.active;
 }
}

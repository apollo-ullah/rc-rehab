export const quantile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a[Math.floor((a.length-1)*p)]};
export const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
export const config={windowMs:1200,rawBlock:100,featureNames:['mean','rms','p90','sd'],margin:0.18};
export function amplitudes(rows,raw,center){
  const v=rows.map(r=>r[1]);
  if(!raw)return v;
  const blocks=[];
  for(let i=0;i+config.rawBlock<=v.length;i+=config.rawBlock){
    blocks.push(Math.sqrt(mean(v.slice(i,i+config.rawBlock).map(x=>(x-center)**2))));
  }
  return blocks;
}
export function features(a){
  const m=mean(a);
  return [m,Math.sqrt(mean(a.map(x=>x*x))),quantile(a,.9),Math.sqrt(mean(a.map(x=>(x-m)**2)))];
}
const distance=(a,b,scales)=>Math.sqrt(mean(a.map((x,i)=>((x-b[i])/scales[i])**2)));
export function train(trials){
  const groups=Object.groupBy(trials,t=>t.label);
  const centers=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v[0].f.map((_,i)=>mean(v.map(t=>t.f[i])))]));
  const scales=trials[0].f.map((_,i)=>Math.max(.06,Math.sqrt(mean(trials.map(t=>(t.f[i]-centers[t.label][i])**2)))));
  const radii=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,Math.max(1.3,1.6*Math.max(...v.map(t=>distance(t.f,centers[k],scales))))]));
  return {centers,scales,radii,margin:config.margin};
}
export function classify(f,model){
  const d=Object.entries(model.centers).map(([k,c])=>[k,distance(f,c,model.scales)]).sort((a,b)=>a[1]-b[1]);
  const [label,best]=d[0];
  return best<=model.radii[label] && (d[1][1]-best)/Math.max(.001,d[1][1])>=model.margin?label:'uncertain';
}

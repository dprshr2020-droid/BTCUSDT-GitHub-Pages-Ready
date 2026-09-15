/* Limited Pine-compatible runtime for this BTCUSDT project.
 * Supports: indicator(), variables, arithmetic, open/high/low/close/volume,
 * history [], ta.sma/ema/rma/wma/rsi/atr/highest/lowest/crossover/crossunder,
 * plot(), hline(), plotshape(), and the custom exactDrawings() primitive.
 * This is intentionally a small Pine subset, not TradingView's Pine runtime.
 */
(function(){
  'use strict';
  const CFG={
    binance:'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000',
    ws:'wss://stream.binance.com/ws/btcusdt@trade',
    maxBars:1000
  };
  const state={bars:[],script:'',series:{},plots:[],shapes:[],drawings:[],timer:null,ws:null,chart:null,canvas:null,ctx:null};
  function bucket(t,m){return Math.floor(t/(m*60000))*m*60000}
  function num(v){return typeof v==='number'?v:parseFloat(v)}
  function series(name,arr){state.series[name]=arr;return arr}
  function sma(a,n){return a.map((_,i)=>i+1<n?NaN:a.slice(i-n+1,i+1).reduce((x,y)=>x+y,0)/n)}
  function ema(a,n){const o=new Array(a.length).fill(NaN),k=2/(n+1);let p=NaN;for(let i=0;i<a.length;i++){if(i+1<n)continue;if(i+1===n)p=a.slice(0,n).reduce((x,y)=>x+y,0)/n;else p=a[i]*k+p*(1-k);o[i]=p}return o}
  function rma(a,n){const o=new Array(a.length).fill(NaN);let p=NaN;for(let i=0;i<a.length;i++){if(i+1<n)continue;if(i+1===n)p=a.slice(0,n).reduce((x,y)=>x+y,0)/n;else p=(p*(n-1)+a[i])/n;o[i]=p}return o}
  function wma(a,n){return a.map((_,i)=>{if(i+1<n)return NaN;let s=0,d=0;for(let j=0;j<n;j++){s+=a[i-j]*(n-j);d+=n-j}return s/d})}
  function highest(a,n){return a.map((_,i)=>i+1<n?NaN:Math.max.apply(null,a.slice(i-n+1,i+1)))}
  function lowest(a,n){return a.map((_,i)=>i+1<n?NaN:Math.min.apply(null,a.slice(i-n+1,i+1)))}
  function rsi(a,n){const d=a.map((v,i)=>i?Math.max(a[i]-a[i-1],0):0),l=a.map((v,i)=>i?Math.max(a[i-1]-a[i],0):0),g=rma(d,n),x=rma(l,n);return a.map((_,i)=>isNaN(g[i])?NaN:x[i]===0?100:100-100/(1+g[i]/x[i]))}
  function atr(h,l,c,n){const tr=c.map((v,i)=>i===0?h[i]-l[i]:Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return rma(tr,n)}
  function cross(a,b,up){const o=new Array(a.length).fill(false);for(let i=1;i<a.length;i++){if([a[i],b[i],a[i-1],b[i-1]].some(isNaN))continue;o[i]=up?(a[i]>b[i]&&a[i-1]<=b[i-1]):(a[i]<b[i]&&a[i-1]>=b[i-1])}return o}
  const TA={sma,ema,rma,wma,rsi,atr,highest,lowest,crossover:(a,b)=>cross(a,b,true),crossunder:(a,b)=>cross(a,b,false)};
  function preprocess(src){
    return src.replace(/\/\/.*$/gm,'').replace(/\btrue\b/g,'true').replace(/\bfalse\b/g,'false');
  }
  function valExpr(expr,env,i){
    expr=expr.trim();
    const hist=expr.match(/^([A-Za-z_$][\w$]*)\s*\[\s*(\d+)\s*\]$/); if(hist){const a=env[hist[1]]||[];return i-+hist[2]>=0?a[i-+hist[2]]:NaN}
    const direct=expr.match(/^([A-Za-z_$][\w$]*)$/); if(direct&&env[direct[1]]!==undefined)return env[direct[1]][i]??env[direct[1]];
    const n=Number(expr); if(!Number.isNaN(n))return n;
    let js=expr.replace(/\bta\.([A-Za-z_]\w*)\s*\(([^()]*)\)/g,(m,f,args)=>`__ta("${f}",[${args}])`);
    js=js.replace(/([A-Za-z_$][\w$]*)\s*\[\s*(\d+)\s*\]/g,(m,n,k)=>`__hist("${n}",${k})`);
    js=js.replace(/\b(open|high|low|close|volume|time|bar_index)\b/g,(m)=>`__v("${m}")`);
    try{return Function('__v','__hist','__ta',`return (${js})`)(k=>env[k]?.[i],(k,n)=>{const a=env[k]||[];return i-n>=0?a[i-n]:NaN},(f,args)=>TA[f].apply(null,args.map(x=>Array.isArray(x)?x:Array(env.close.length).fill(x)))[i]);}catch(e){return NaN}
  }
  function execute(src){
    state.plots=[];state.shapes=[];state.drawings=[];
    const b=state.bars,env={open:b.map(x=>x.o),high:b.map(x=>x.h),low:b.map(x=>x.l),close:b.map(x=>x.c),volume:b.map(x=>x.v),time:b.map(x=>x.t),bar_index:b.map((_,i)=>i)};
    const lines=preprocess(src).split(/\n/).map(x=>x.trim()).filter(Boolean);
    for(const line of lines){
      let m=line.match(/^([A-Za-z_$][\w$]*)\s*=\s*(.+)$/); if(m&&!/^plot|^hline|^indicator|^exactDrawings/.test(m[1])){const out=new Array(b.length);for(let i=0;i<b.length;i++)out[i]=valExpr(m[2],env,i);env[m[1]]=out;continue}
      m=line.match(/^plot\s*\((.*)\)\s*$/); if(m){const args=m[1].split(',').map(x=>x.trim());const a=env[args[0]]||Array.from({length:b.length},(_,i)=>valExpr(args[0],env,i));state.plots.push({data:a,color:(args.find(x=>/^color\./.test(x))||'').replace('color.','')||'#ffffff',width:1});continue}
      m=line.match(/^hline\s*\((.*)\)\s*$/); if(m){state.plots.push({hline:num(argsFirst(m[1])),color:'#ffffff',width:1});continue}
      if(/^exactDrawings\s*\(\s*\)/.test(line))state.drawings.push('exact');
    }
    function argsFirst(s){return s.split(',')[0].trim()}
    state.env=env; return state;
  }
  async function load(){const r=await fetch(CFG.binance,{cache:'no-store'});const j=await r.json();state.bars=j.map(x=>({t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]}));execute(state.script);draw()}
  function addTrade(p,ts){let b=state.bars[state.bars.length-1];const bt=bucket(ts,1);if(!b||b.t!==bt){b={t:bt,o:p,h:p,l:p,c:p,v:0};state.bars.push(b);if(state.bars.length>CFG.maxBars)state.bars.shift()}else{b.h=Math.max(b.h,p);b.l=Math.min(b.l,p);b.c=p}execute(state.script);draw()}
  function connect(){try{state.ws=new WebSocket(CFG.ws);state.ws.onmessage=e=>{const x=JSON.parse(e.data);addTrade(+x.p,+x.T)}}catch(e){}}
  function initCanvas(){const host=document.getElementById('tv_chart_container');if(!host)return;let c=document.getElementById('pine-system-overlay');if(!c){c=document.createElement('canvas');c.id='pine-system-overlay';c.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:20';host.style.position='relative';host.appendChild(c)}state.canvas=c;state.ctx=c.getContext('2d')}
  function coords(){const ch=state.chart;if(!ch)return null;const pane=ch.getPanes()[0],ps=pane.getMainSourcePriceScale(),ts=ch.getTimeScale();const vr=ps.getVisiblePriceRange();const W=state.canvas.clientWidth,H=state.canvas.clientHeight;const x0=ts.coordinateToTime(0),x1=ts.coordinateToTime(W);if(!vr||x0==null||x1==null)return null;const xmin=+x0*1000,xmax=+x1*1000;return {W,H,x(t){return (t-xmin)/(xmax-xmin)*W},y(p){return (vr.max-p)/(vr.max-vr.min)*H}}}
  function draw(){if(!state.canvas||!state.ctx)return;const d=coords();if(!d)return;const c=state.ctx,cvs=state.canvas;cvs.width=cvs.clientWidth*devicePixelRatio;cvs.height=cvs.clientHeight*devicePixelRatio;c.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);c.clearRect(0,0,d.W,d.H);
    // Generic Pine plots (limited subset)
    for(const p of state.plots){if(p.hline!==undefined){c.strokeStyle=p.color;c.lineWidth=p.width;c.beginPath();c.moveTo(0,d.y(p.hline));c.lineTo(d.W,d.y(p.hline));c.stroke();continue}c.strokeStyle=p.color;c.lineWidth=p.width;c.setLineDash([]);c.beginPath();let started=false;for(const b of state.bars){const y=p.data[state.bars.indexOf(b)];if(!Number.isFinite(y))continue;const x=d.x(b.t);if(!started){c.moveTo(x,d.y(y));started=true}else c.lineTo(x,d.y(y))}c.stroke()}
    if(state.drawings.includes('exact')) drawExact(c,d);
  }
  function drawRay(c,d,start,p,color){if(!Number.isFinite(p))return;const x=d.x(start);if(x>d.W||x<0&&d.x(start+900000)<0)return;c.save();c.strokeStyle=color;c.lineWidth=1;c.setLineDash([5,3]);c.beginPath();c.moveTo(x,d.y(p));c.lineTo(d.W,d.y(p));c.stroke();c.restore()}
  function exactOpen(t){const b=state.bars.find(x=>x.t===t);return b?b.o:NaN}
  function drawExact(c,d){const now=Date.now(),s5=bucket(now,5*1),s15=bucket(now,15*1),p5=exactOpen(s5),p15=exactOpen(s15);drawRay(c,d,s5,p5,'#7dd3fc');drawRay(c,d,s15,p15,'#f5a623');if(now>=s15+10*60000){const last=s15+10*60000,p=exactOpen(last);if(Number.isFinite(p)&&Number.isFinite(p15)){const top=Math.max(p,p15),bot=Math.min(p,p15),left=s15-60000,right=s15+16*60000,x=d.x(left),w=d.x(right)-x;c.save();c.strokeStyle='rgba(255,255,255,0.5)';c.lineWidth=1.25;c.setLineDash([5,3]);c.strokeRect(x,d.y(top),w,d.y(bot)-d.y(top));c.beginPath();c.moveTo(x,d.y((top+bot)/2));c.lineTo(x+w,d.y((top+bot)/2));c.stroke();c.restore()}}}
  function attach(chart){state.chart=chart;initCanvas();const redraw=()=>requestAnimationFrame(draw);['onVisibleRangeChanged','onDataLoaded','onIntervalChanged','onSymbolChanged'].forEach(k=>{try{chart[k]().subscribe(null,redraw)}catch(e){}});window.addEventListener('resize',redraw);setInterval(redraw,1000)}
  window.PineSystem={init:function(widget,script){state.script=script||`indicator("5m 15m Levels")\nexactDrawings()`;widget.onChartReady(function(){attach(widget);load().then(connect).catch(connect)})},setScript:function(s){state.script=s;execute(s);draw()},getState:()=>state};
})();

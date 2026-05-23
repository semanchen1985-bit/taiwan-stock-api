"use strict";
// ═══════════════════════════════════════════════════════════
// 台股AI分析後端  server.js  production-final
// Node.js 18+  |  Express 4
// ═══════════════════════════════════════════════════════════
const express     = require("express");
const compression = require("compression");
const helmet      = require("helmet");
const crypto      = require("crypto");
const app         = express();

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy:false, crossOriginEmbedderPolicy:false }));
app.use(compression());
app.use(express.json({ limit:"50kb" })); // analyze-ai 傳資料過來需要大一點

// ── 環境 ────────────────────────────────────────────────
const PORT     = process.env.PORT     || 3001;
const AK       = () => process.env.ANTHROPIC_API_KEY || "";
const FT       = () => process.env.FINMIND_TOKEN     || "";
const ADMIN_TK = process.env.ADMIN_TOKEN             || "";
const EXT_ORIG = (process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);

// ── LOGGER ──────────────────────────────────────────────
const log = {
  _w: (lvl,msg,m={}) => (lvl==="ERROR"?console.error:console.log)(
    JSON.stringify({ts:new Date().toISOString(),lvl,msg,pid:process.pid,
      mem:Math.round(process.memoryUsage().heapUsed/1024/1024),...m})),
  info:  (msg,m) => log._w("INFO", msg,m),
  warn:  (msg,m) => log._w("WARN", msg,m),
  error: (msg,m) => log._w("ERROR",msg,m),
};

// ── REQUEST MIDDLEWARE ───────────────────────────────────
app.use((req,res,next)=>{
  req.id=crypto.randomUUID().slice(0,8); req.t0=Date.now();
  res.on("finish",()=>{ if(req.path==="/health")return;
    log.info("req",{id:req.id,m:req.method,p:req.path,s:res.statusCode,ms:Date.now()-req.t0,ip:req.ip}); });
  next();
});

// ── CORS ────────────────────────────────────────────────
app.use((req,res,next)=>{
  const o=req.headers.origin||"";
  const ok=!o||o.includes("localhost")||o.includes("127.0.0.1")||
    o.endsWith(".netlify.app")||o.endsWith(".github.io")||EXT_ORIG.some(x=>o.includes(x));
  if(ok){res.header("Access-Control-Allow-Origin",o||"*");
    res.header("Access-Control-Allow-Headers","Content-Type, X-Admin-Token");
    res.header("Access-Control-Allow-Methods","GET, POST, OPTIONS");}
  if(req.method==="OPTIONS")return res.sendStatus(200);
  next();
});

// ── OVERLOAD SHEDDING ───────────────────────────────────
const MAX_IF=20; let _if=0;
app.use((req,res,next)=>{
  if(req.path==="/health")return next();
  if(_if>=MAX_IF)return res.status(503).json({error:"伺服器繁忙，請稍後再試"});
  _if++; const d=()=>{_if=Math.max(0,_if-1);};
  res.on("finish",d); res.on("close",d); next();
});

// ── CACHE ────────────────────────────────────────────────
const CACHE=new Map(); const CACHE_MAX=500;
const TTL={chart:10*60e3,history:10*60e3,chip:30*60e3,margin:30*60e3,
  fundamentals:6*3600e3,revenue:12*3600e3,scan:5*60e3,stocklist:24*3600e3,
  indicator:8*60e3,score:8*60e3,aitext:30*60e3};

const stableP=p=>Math.round(parseFloat(p||0)*10)/10;

function cacheGet(key){
  const e=CACHE.get(key); if(!e)return{fresh:null,stale:null};
  const age=Date.now()-e.ts;
  if(age<=e.ttl)return{fresh:e.data,stale:null};
  if(age<=e.ttl*3)return{fresh:null,stale:e.data};
  CACHE.delete(key); return{fresh:null,stale:null};
}
function cacheSet(key,data,ttl){
  CACHE.delete(key); CACHE.set(key,{data,ts:Date.now(),ttl});
  if(CACHE.size>CACHE_MAX)CACHE.delete(CACHE.keys().next().value);
}
setInterval(()=>{
  const now=Date.now(); let p=0;
  for(const[k,e]of CACHE)if(now-e.ts>e.ttl*3){CACHE.delete(k);p++;}
  const mb=process.memoryUsage().heapUsed/1024/1024;
  if(mb>280&&CACHE.size>50){let r=0,t=Math.floor(CACHE.size*.5);
    for(const k of CACHE.keys()){if(r>=t)break;CACHE.delete(k);r++;}
    log.warn("mem_prune",{mb:Math.round(mb),rm:r});}
},30000);

// ── IN-FLIGHT DEDUPE ────────────────────────────────────
const IN_FLIGHT=new Map();
function dedupe(key,fn){
  if(IN_FLIGHT.has(key))return IN_FLIGHT.get(key);
  const p=fn().then(v=>{IN_FLIGHT.delete(key);return v;}).catch(e=>{IN_FLIGHT.delete(key);throw e;});
  IN_FLIGHT.set(key,p); return p;
}
function swrFetch(key,ttlN,fn){
  const{fresh,stale}=cacheGet(key);
  if(fresh!==null)return Promise.resolve(fresh);
  if(stale!==null){
    setImmediate(()=>dedupe(`bg:${key}`,()=>fn().then(d=>{if(d!=null)cacheSet(key,d,TTL[ttlN]);return d;}).catch(()=>null)));
    return Promise.resolve(stale);
  }
  return dedupe(key,()=>fn().then(d=>{if(d!=null)cacheSet(key,d,TTL[ttlN]);return d;}));
}

// ── RATE LIMITER ─────────────────────────────────────────
const RATE=new Map(); const RMAX=1500;
function rateLimit(ip,max,win){
  const now=Date.now(),reqs=(RATE.get(ip)||[]).filter(t=>now-t<win);
  reqs.push(now); RATE.delete(ip); RATE.set(ip,reqs);
  if(RATE.size>RMAX)RATE.delete(RATE.keys().next().value);
  return reqs.length>max;
}
setInterval(()=>{const now=Date.now();for(const[k,v]of RATE)if(!v.length||now-v.at(-1)>120e3)RATE.delete(k);},5*60e3);

// ── CIRCUIT BREAKER ──────────────────────────────────────
const CB=new Map();
function cbKey(url){try{return new URL(url).hostname;}catch{return url.slice(0,40);}}
function cbAllow(url){
  const k=cbKey(url),s=CB.get(k); if(!s)return true;
  const now=Date.now();
  if(now<s.openUntil){if(!s.probeAt||now-s.probeAt>5e3){s.probeAt=now;return true;}return false;}
  CB.delete(k); return true;
}
function cbFail(url){
  const k=cbKey(url),now=Date.now();
  const s=CB.get(k)||{fails:[],openUntil:0,openCount:0};
  s.fails=s.fails.filter(t=>now-t<60e3); s.fails.push(now);
  if(s.fails.length>=5){s.openCount++;s.openUntil=now+Math.min(30e3*Math.pow(2,s.openCount-1),300e3)+Math.random()*5e3;}
  CB.set(k,s);
}
function cbOk(url){CB.delete(cbKey(url));}

// ── FETCH RETRY ──────────────────────────────────────────
const RETRY_S=new Set([429,500,502,503,504]);
const RETRY_E=["ECONNRESET","ECONNREFUSED","ETIMEDOUT","socket hang up","fetch failed"];
async function fetchRetry(url,opts={},ms=8000,maxR=2){
  if(!cbAllow(url))throw new Error(`cb:${cbKey(url)}`);
  let lastErr;
  for(let i=0;i<=maxR;i++){
    if(i>0)await new Promise(r=>setTimeout(r,Math.min(800*Math.pow(2,i-1)+Math.random()*400,6e3)));
    if(i>0&&!cbAllow(url))throw new Error(`cb:${cbKey(url)}`);
    const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),ms);
    try{
      const r=await fetch(url,{...opts,signal:ctrl.signal}); clearTimeout(t);
      if(RETRY_S.has(r.status)&&i<maxR){if(r.status===429)await new Promise(r=>setTimeout(r,3e3));continue;}
      cbOk(url); return r;
    }catch(e){clearTimeout(t);lastErr=e;if(!RETRY_E.some(s=>(e.message||"").includes(s))&&e.name!=="AbortError")break;}
  }
  if(lastErr?.name==="AbortError")throw new Error(`fetch_timeout:${cbKey(url)}`);
  cbFail(url); throw lastErr||new Error("fetch_failed");
}

// ── ADAPTIVE CONCURRENCY ─────────────────────────────────
const AC={cur:5,min:2,max:8,streak:0,lastFail:0};
function acAdj(ok,ms){
  if(!ok){AC.cur=Math.max(AC.min,AC.cur-1);AC.streak=0;AC.lastFail=Date.now();}
  else if(Date.now()-AC.lastFail>30e3)if(++AC.streak>=3&&ms<4e3)AC.cur=Math.min(AC.max,AC.cur+1);
}
async function runLimited(tasks,lim){
  const limit=lim??AC.cur,res=new Array(tasks.length).fill(null);
  let idx=0,fails=0,sumMs=0,cnt=0;
  const w=async()=>{while(idx<tasks.length){const i=idx++,t0=Date.now();
    try{res[i]=await tasks[i]();sumMs+=Date.now()-t0;cnt++;}catch{res[i]=null;fails++;}}};
  await Promise.all(Array.from({length:Math.min(limit,tasks.length)},w));
  acAdj(fails===0,cnt>0?sumMs/cnt:0); return res;
}

const YH="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BUILTIN_STOCK_LIST = [
  // 半導體
  {code:"2330",name:"台積電",type:"stock"},{code:"2303",name:"聯電",type:"stock"},
  {code:"2454",name:"聯發科",type:"stock"},{code:"2379",name:"瑞昱",type:"stock"},
  {code:"3711",name:"日月光投控",type:"stock"},{code:"2408",name:"南亞科",type:"stock"},
  {code:"2344",name:"華邦電",type:"stock"},{code:"3034",name:"聯詠",type:"stock"},
  // 電子
  {code:"2317",name:"鴻海",type:"stock"},{code:"2382",name:"廣達",type:"stock"},
  {code:"2357",name:"華碩",type:"stock"},{code:"2308",name:"台達電",type:"stock"},
  {code:"2356",name:"英業達",type:"stock"},{code:"3008",name:"大立光",type:"stock"},
  {code:"2301",name:"光寶科",type:"stock"},{code:"2327",name:"國巨",type:"stock"},
  // 金融
  {code:"2881",name:"富邦金",type:"stock"},{code:"2882",name:"國泰金",type:"stock"},
  {code:"2891",name:"中信金",type:"stock"},{code:"2886",name:"兆豐金",type:"stock"},
  {code:"2884",name:"玉山金",type:"stock"},{code:"2885",name:"元大金",type:"stock"},
  // 航運
  {code:"2603",name:"長榮",type:"stock"},{code:"2615",name:"萬海",type:"stock"},
  {code:"2609",name:"陽明",type:"stock"},
  // 電信/其他
  {code:"2412",name:"中華電",type:"stock"},{code:"3045",name:"台灣大",type:"stock"},
  {code:"4904",name:"遠傳",type:"stock"},
  // ETF
  {code:"0050",name:"元大台灣50",type:"etf"},{code:"0056",name:"元大高股息",type:"etf"},
  {code:"00878",name:"國泰永續高股息",type:"etf"},{code:"00919",name:"群益台灣精選高息",type:"etf"},
  {code:"006208",name:"富邦台50",type:"etf"},{code:"00929",name:"復華台灣科技優息",type:"etf"},
];


const SCAN_STOCKS = [
  {code:"2330",name:"台積電"},{code:"2317",name:"鴻海"},{code:"2454",name:"聯發科"},
  {code:"2382",name:"廣達"},{code:"2308",name:"台達電"},{code:"2881",name:"富邦金"},
  {code:"2882",name:"國泰金"},{code:"2886",name:"兆豐金"},{code:"2891",name:"中信金"},
  {code:"2412",name:"中華電"},{code:"3711",name:"日月光"},{code:"2303",name:"聯電"},
  {code:"2002",name:"中鋼"},{code:"1301",name:"台塑"},{code:"1303",name:"南亞"},
  {code:"2207",name:"和泰車"},{code:"2357",name:"華碩"},{code:"2379",name:"瑞昱"},
  {code:"3008",name:"大立光"},{code:"2395",name:"研華"},{code:"6505",name:"台塑化"},
  {code:"2603",name:"長榮"},{code:"2615",name:"萬海"},{code:"2609",name:"陽明"},
  {code:"2408",name:"南亞科"},{code:"3034",name:"聯詠"},{code:"2376",name:"技嘉"},
  {code:"00878",name:"國泰永續"},{code:"0050",name:"元大台灣50"},{code:"00919",name:"群益高息成長"},
];


// ── MARKET SNAPSHOT ──────────────────────────────────────
const SNAP_KEY="snap:market";
async function refreshSnapshot(){
  try{
    const tasks=SCAN_STOCKS.map(s=>()=>fetchYahooChart(s.code).catch(()=>null));
    const res=await runLimited(tasks);
    const snap={};
    res.forEach((r,i)=>{if(r?.stock?.price>0)snap[SCAN_STOCKS[i].code]=r;});
    if(Object.keys(snap).length>0){cacheSet(SNAP_KEY,snap,5*60e3);log.info("snap_ok",{n:Object.keys(snap).length});}
    return snap;
  }catch(e){log.error("snap_fail",{msg:e.message});return null;}
}
function getSnapshot(){
  const{fresh,stale}=cacheGet(SNAP_KEY);
  if(fresh)return fresh;
  if(stale){setImmediate(()=>dedupe("bg:snap",refreshSnapshot));return stale;}
  return null;
}

// ── STOCK LIST ───────────────────────────────────────────
let _sL=null,_sLts=0;
async function getStockList(){
  if(_sL&&Date.now()-_sLts<TTL.stocklist)return _sL;
  const tok=FT();
  if(tok){try{
    const r=await fetchRetry(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&token=${tok}`,{headers:{"User-Agent":"Mozilla/5.0"}},10e3,1);
    const raw=(await r.json())?.data||[];
    // 去重（同代號只保留中文名稱）+ 加 industry_category
    // 先整理：同代號保留有中文名的那筆
    const codeMap=new Map();
    raw.filter(s=>s.stock_id&&s.stock_name).forEach(s=>{
      const existing=codeMap.get(s.stock_id);
      const hasChinese=/[\u4e00-\u9fff]/.test(s.stock_name);
      if(!existing || hasChinese){
        codeMap.set(s.stock_id,{
          code: s.stock_id,
          name: s.stock_name,
          type: s.type||"",
          industry: s.industry_category||"",
        });
      }
    });
    const list=[...codeMap.values()];
    if(list?.length>100){_sL=list;_sLts=Date.now();return list;}
  }catch(e){}}
  if(!_sL)_sL=BUILTIN_STOCK_LIST;
  return _sL;
}

// ── YAHOO FINANCE ────────────────────────────────────────
async function fetchYahooChart(code){
  return swrFetch(`chart:${code}`,"chart",async()=>{
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${code}.TW?interval=1d&range=6mo`;
    const r=await fetchRetry(url,{headers:{"User-Agent":YH,"Accept":"application/json"}},8e3,2);
    const res=(await r.json())?.chart?.result?.[0];
    if(!res)throw new Error("no_result");
    const meta=res.meta||{},ts=res.timestamp||[],q=res.indicators?.quote?.[0]||{};
    const hist=ts.map((t,i)=>({date:new Date(t*1e3).toISOString().split("T")[0],
      open:+(q.open?.[i]||q.close?.[i]||0).toFixed(2),high:+(q.high?.[i]||q.close?.[i]||0).toFixed(2),
      low:+(q.low?.[i]||q.close?.[i]||0).toFixed(2),close:+(q.close?.[i]||0).toFixed(2),
      volume:Math.round((q.volume?.[i]||0)/1e3)})).filter(d=>d.close>0);
    if(!hist.length)throw new Error("empty_hist");
    const price=meta.regularMarketPrice||hist.at(-1).close;
    const prev=hist.at(-2)?.close||meta.chartPreviousClose||price;
    const change=+(price-prev).toFixed(2);
    const s=SCAN_STOCKS.find(s=>s.code===code);
    return{stock:{code,name:s?.name||meta.shortName||code,price,change,
      changePct:(prev>0?(change/prev)*100:0).toFixed(2)+"%",
      volume:Math.round((meta.regularMarketVolume||0)/1e3)},hist};
  });
}

async function getQuote(code){
  try{const r=await fetchYahooChart(code);if(r?.stock?.price>0)return r.stock;}catch(e){}
  try{
    const r=await fetchRetry(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${code}.TW`,{headers:{"User-Agent":YH,"Accept":"application/json"}},6e3,1);
    const q=(await r.json())?.quoteResponse?.result?.[0];
    if(q?.regularMarketPrice){
      const price=q.regularMarketPrice,prev=q.regularMarketPreviousClose||price,ch=+(q.regularMarketChange||0).toFixed(2);
      return{code,name:q.shortName||code,price,prev,change:ch,changePct:+((q.regularMarketChangePercent||0)).toFixed(2),
        open:q.regularMarketOpen||price,high:q.regularMarketDayHigh||price,low:q.regularMarketDayLow||price,
        volume:Math.round((q.regularMarketVolume||0)/1e3),market:"上市",time:""};
    }
  }catch(e){}
  try{
    for(const mkt of["tse","otc"]){
      const r=await fetchRetry(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${mkt}_${code}.tw&json=1&delay=0`,{headers:{"Referer":"https://mis.twse.com.tw/","User-Agent":"Mozilla/5.0"}},5e3,1);
      const item=(await r.json())?.msgArray?.[0];
      if(!item||!item.z||item.z==="-")continue;
      const price=parseFloat(item.z),prev=parseFloat(item.y)||price,ch=+(price-prev).toFixed(2);
      return{code,name:item.n||code,price,prev,change:ch,changePct:prev>0?+((ch/prev)*100).toFixed(2):0,
        open:parseFloat(item.o)||0,high:parseFloat(item.h)||0,low:parseFloat(item.l)||0,
        volume:parseInt((item.v||"0").replace(/,/g,""))||0,market:mkt==="tse"?"上市":"上櫃",time:item.t||""};
    }
  }catch(e){}
  return null;
}

async function getHistory(code,days=400){
  try{
    const range=days<=120?"6mo":days<=250?"1y":"2y";
    const r=await fetchRetry(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.TW?interval=1d&range=${range}`,{headers:{"User-Agent":YH,"Accept":"application/json"}},10e3,2);
    const res=(await r.json())?.chart?.result?.[0];if(!res)throw new Error();
    const ts=res.timestamp||[],q=res.indicators?.quote?.[0]||{};
    const hist=ts.map((t,i)=>({date:new Date(t*1e3).toISOString().split("T")[0],
      open:+(q.open?.[i]||q.close?.[i]||0).toFixed(2),high:+(q.high?.[i]||q.close?.[i]||0).toFixed(2),
      low:+(q.low?.[i]||q.close?.[i]||0).toFixed(2),close:+(q.close?.[i]||0).toFixed(2),
      volume:Math.round((q.volume?.[i]||0)/1e3)})).filter(d=>d.close>0);
    if(hist.length>10)return hist;
  }catch(e){}
  try{
    const tok=FT(),end=new Date().toISOString().split("T")[0],start=new Date(Date.now()-days*864e5).toISOString().split("T")[0];
    const r=await fetchRetry(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${start}&end_date=${end}&token=${tok}`,{headers:{"User-Agent":"Mozilla/5.0"}},10e3,1);
    return(await r.json())?.data?.map(row=>({date:row.date,open:parseFloat(row.open),high:parseFloat(row.max),low:parseFloat(row.min),close:parseFloat(row.close),volume:Math.round(parseInt(row.Trading_Volume)/1e3)}))||[];
  }catch(e){}
  return[];
}
async function getHistoryCached(code,days=400){
  return swrFetch(`history:${code}:${days}`,"history",()=>getHistory(code,days));
}

// ── FINMIND ──────────────────────────────────────────────
function fmEp(pref,ttl,fn){return(code)=>swrFetch(`${pref}:${code}`,ttl,()=>fn(code));}

const getChip=fmEp("chip","chip",async code=>{
  const tok=FT(),end=new Date().toISOString().split("T")[0],start=new Date(Date.now()-30*864e5).toISOString().split("T")[0];
  const r=await fetchRetry(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${code}&start_date=${start}&end_date=${end}&token=${tok}`,{headers:{"User-Agent":"Mozilla/5.0"}},8e3,1);
  const rows=(await r.json())?.data||[];if(!rows.length)return null;
  const sum=(keys,arr)=>arr.reduce((s,r)=>keys.some(k=>(r.name||"").includes(k))?s+((r.buy||0)-(r.sell||0)):s,0);
  const dates=[...new Set(rows.map(r=>r.date))].sort();
  const latest=rows.filter(r=>r.date===dates.at(-1)),recent=rows.filter(r=>r.date>=dates.slice(-5)[0]);
  const consec=keys=>{let d=0;for(const dt of[...dates].reverse()){if(sum(keys,rows.filter(r=>r.date===dt))>0)d++;else break;}return d;};
  return{date:dates.at(-1),foreign5:sum(["外資","Foreign"],recent),foreign1:sum(["外資","Foreign"],latest),
    site5:sum(["投信"],recent),site1:sum(["投信"],latest),dealer5:sum(["自營"],recent),dealer1:sum(["自營"],latest),
    foreignDays:consec(["外資","Foreign"]),siteDays:consec(["投信"])};
});
const getMargin=fmEp("margin","margin",async code=>{
  const tok=FT(),end=new Date().toISOString().split("T")[0],start=new Date(Date.now()-30*864e5).toISOString().split("T")[0];
  const r=await fetchRetry(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${code}&start_date=${start}&end_date=${end}&token=${tok}`,{headers:{"User-Agent":"Mozilla/5.0"}},8e3,1);
  const rows=(await r.json())?.data||[];if(rows.length<2)return null;
  const cur=rows.at(-1),prev=rows.at(-2);
  return{date:cur.date,marginBal:cur.MarginPurchaseTodayBalance||0,marginChange:(cur.MarginPurchaseTodayBalance||0)-(prev.MarginPurchaseTodayBalance||0),shortBal:cur.ShortSaleTodayBalance||0,shortChange:(cur.ShortSaleTodayBalance||0)-(prev.ShortSaleTodayBalance||0)};
});
const getFundamentals=fmEp("fundamentals","fundamentals",async code=>{
  const tok=FT(),end=new Date().toISOString().split("T")[0],start=new Date(Date.now()-30*864e5).toISOString().split("T")[0];
  const r=await fetchRetry(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPER&data_id=${code}&start_date=${start}&end_date=${end}&token=${tok}`,{headers:{"User-Agent":"Mozilla/5.0"}},8e3,1);
  const rows=(await r.json())?.data||[];if(!rows.length)return null;
  const l=rows.at(-1);return{date:l.date,pe:parseFloat(l.PER)||null,pb:parseFloat(l.PBR)||null};
});
const getRevenue=fmEp("rev","revenue",async code=>{
  const tok=FT(),end=new Date().toISOString().split("T")[0],start=new Date(Date.now()-90*864e5).toISOString().split("T")[0];
  const r=await fetchRetry(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${code}&start_date=${start}&end_date=${end}&token=${tok}`,{headers:{"User-Agent":"Mozilla/5.0"}},8e3,1);
  const rows=(await r.json())?.data||[];if(!rows.length)return null;
  const l=rows.at(-1),p=rows.find(r=>r.date<l.date);
  const rev=parseFloat(l.revenue)||0,prevRev=parseFloat(p?.revenue)||rev;
  return{date:l.date,revenue:rev,yoy:prevRev>0?(rev-prevRev)/prevRev*100:0};
});

function calcIndicators(history, currentPrice) {
  const closes = [...history.map(h => h.close)];
  if (currentPrice > 0) closes.push(currentPrice);
  const n = closes.length;
  if (n < 5) return { ma5:null,ma10:null,ma20:null,ma60:null,rsi:null,k:null,d:null,macd:null,macdHist:null,maTrend:"資料不足",volTrend:"—",bull:0,bear:0,direction:"資料不足" };

  const ma = (p) => n >= p ? +(closes.slice(-p).reduce((s,v)=>s+v,0)/p).toFixed(2) : null;
  const ma5=ma(5), ma10=ma(10), ma20=ma(20), ma60=ma(60), ma120=ma(120), ma240=ma(240);

  let rsi = null;
  if (n >= 15) {
    let g=0,l=0;
    for (let i=n-14;i<n;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l+=Math.abs(d);}
    rsi = l===0 ? 100 : +(100-100/(1+g/l)).toFixed(1);
  }

  let k=null, d2=null;
  if (n >= 9) {
    const c9=closes.slice(-9), hi=Math.max(...c9), lo=Math.min(...c9);
    const rsv = hi===lo ? 50 : ((closes.at(-1)-lo)/(hi-lo))*100;
    k = +(rsv/3+50*2/3).toFixed(1);
    d2 = +(k/3+50*2/3).toFixed(1);
  }

  let macd=null, macdSig=null, macdHist=null;
  if (n >= 26) {
    const ema = (arr, p) => { const kk=2/(p+1); let e=arr.slice(0,p).reduce((s,v)=>s+v,0)/p; for(let i=p;i<arr.length;i++) e=arr[i]*kk+e*(1-kk); return e; };
    macd = +(ema(closes,12)-ema(closes,26)).toFixed(2);
    macdSig = +(macd*0.2+macd*0.8*0.96).toFixed(2);
    macdHist = +(macd-macdSig).toFixed(2);
  }

  let bollU=null, bollM=null, bollL=null;
  if (n >= 20) {
    const s=closes.slice(-20), m=s.reduce((x,v)=>x+v,0)/20;
    const sd=Math.sqrt(s.reduce((x,v)=>x+Math.pow(v-m,2),0)/20);
    bollU=+(m+2*sd).toFixed(1); bollM=+m.toFixed(1); bollL=+(m-2*sd).toFixed(1);
  }

  const mv=[ma5,ma10,ma20,ma60].filter(v=>v);
  let maTrend="均線糾結";
  if (mv.length>=3) {
    const desc=[...mv].sort((a,b)=>b-a), asc=[...mv].sort((a,b)=>a-b);
    if (JSON.stringify(mv)===JSON.stringify(desc)) maTrend="多頭排列";
    else if (JSON.stringify(mv)===JSON.stringify(asc)) maTrend="空頭排列";
  }

  const vols=history.slice(-6,-1).map(h=>h.volume);
  const avgVol=vols.length?vols.reduce((s,v)=>s+v,0)/vols.length:0;
  const todayVol=history.at(-1)?.volume||0;
  let volTrend="正常";
  if(avgVol>0){const r=todayVol/avgVol;if(r>1.8)volTrend="爆量";else if(r>1.2)volTrend="量增";else if(r<0.5)volTrend="量縮";else if(r<0.8)volTrend="量減";}

  const p = currentPrice||closes.at(-1);
  const sup1=ma20?+(ma20*0.98).toFixed(1):+(p*0.96).toFixed(1);
  const sup2=ma60?+(ma60*0.97).toFixed(1):+(p*0.92).toFixed(1);
  const res1=bollU||+(p*1.05).toFixed(1);
  const res2=+(p*1.10).toFixed(1);
  const stop=+(sup1*0.97).toFixed(1);

  let bull=0, bear=0;
  if(maTrend==="多頭排列")bull+=3;else if(maTrend==="空頭排列")bear+=3;
  if(ma20&&p>ma20)bull+=2;else if(ma20&&p<ma20)bear+=2;
  if(ma60&&p>ma60)bull+=2;else if(ma60&&p<ma60)bear+=2;
  if(rsi&&rsi>50)bull++;else bear++;
  if(k&&d2&&k>d2)bull++;else bear++;
  if(macd&&macd>0)bull++;else bear++;
  if(macdHist&&macdHist>0)bull++;else bear++;

  // ── 週K最高最低（近13週=一季）─────────────────────────
  let weekHigh = null, weekLow = null;
  if (history.length >= 5) {
    const w13 = history.slice(-65);
    weekHigh = w13.reduce((mx,h) => Math.max(mx, h.high||h.close), -Infinity);
    weekLow  = w13.reduce((mn,h) => Math.min(mn, h.low||h.close),  Infinity);
  }
  // ── 52週高低（近252個交易日）────────────────────────────
  let high52w = null, low52w = null;
  if (history.length >= 50) {
    const y = history.slice(-252);
    high52w = y.reduce((mx,h) => Math.max(mx, h.high||h.close), -Infinity);
    low52w  = y.reduce((mn,h) => Math.min(mn, h.low||h.close),  Infinity);
  }
  // ── 年線方向（MA240 vs MA200）───────────────────────────
  const ma200 = n>=200 ? +(closes.slice(-200).reduce((s,v)=>s+v,0)/200).toFixed(2) : null;
  const ma240dir = ma240&&ma200 ? (ma240 > ma200 ? "下降（扣抵偏高）" : "上升（扣抵偏低）") : null;
  const distFrom240 = ma240&&p ? ((p-ma240)/ma240*100).toFixed(1)+"%" : null;

  return {
    ma5,ma10,ma20,ma60,ma120,ma200,ma240,
    rsi,k,d:d2,macd,macdSig,macdHist,
    bollU,bollM,bollL,
    maTrend,volTrend,
    sup1,sup2,res1,res2,stop,
    bull,bear,
    direction: bull>bear+2?"偏多":bear>bull+2?"偏空":"中性震盪",
    high52w, low52w,
    weekHigh, weekLow,
    ma240dir, distFrom240,
  };
}

// ════════════════════════════════════════════════════════════
// 熱門選股評分系統（100 分滿分）
// ════════════════════════════════════════════════════════════






function calcStockScore(ind, chip, margin, fundamentals, revenue, history, price) {
  let score = 0;
  const detail = {};   // 各面向細項得分

  // ── 基本面 20 分 ────────────────────────────────────────
  let fundScore = 0;

  // 月營收年增率 > 10% +5
  if (revenue?.yoy != null) {
    if (revenue.yoy > 10) { fundScore += 5; detail.rev_yoy = "+5 月營收年增率>" + revenue.yoy + "%"; }
    else detail.rev_yoy = "0 月營收年增率" + revenue.yoy + "%";
  } else { detail.rev_yoy = "0 月營收資料不足"; }

  // EPS 年增率 > 10% +5（用 PE 倒推：若 PE 下降但股價上漲，暗示 EPS 增長）
  // FinMind 沒有直接 EPS 年增率，用 PE 近期趨勢判斷（保守估計）
  if (fundamentals?.pe != null && fundamentals.pe > 0 && fundamentals.pe < 40) {
    // PE 合理且不過高，暗示 EPS 增長中
    fundScore += 5; detail.eps_growth = "+5 PE合理(" + fundamentals.pe + ")";
  } else { detail.eps_growth = "0 PE過高或無資料"; }

  // ROE > 10% +5（用 PB/PE 估算：PB=ROE×PE）
  if (fundamentals?.pb != null && fundamentals?.pe != null && fundamentals.pb > 0 && fundamentals.pe > 0) {
    const estROE = (fundamentals.pb / fundamentals.pe * 100);
    if (estROE > 10) { fundScore += 5; detail.roe = "+5 估算ROE>" + estROE.toFixed(1) + "%"; }
    else detail.roe = "0 估算ROE=" + estROE.toFixed(1) + "%";
  } else { detail.roe = "0 基本面資料不足"; }

  // 毛利率穩定或上升（月營收連續兩月正增長作為代理指標）+5
  if (revenue?.yoy != null && revenue.yoy > 0) {
    fundScore += 5; detail.margin_stable = "+5 營收增長（代理毛利率）";
  } else { detail.margin_stable = "0 營收未增長"; }

  score += Math.min(fundScore, 20);
  detail._fund = Math.min(fundScore, 20);

  // ── 技術面 25 分 ────────────────────────────────────────
  let techScore = 0;
  const p = price || ind.ma20;

  // 股價站上 20 日線 +5
  if (ind.ma20 && p > ind.ma20) { techScore += 5; detail.above_ma20 = "+5 站上MA20"; }
  else detail.above_ma20 = "0 未站上MA20";

  // 20 日線向上：用 MA20 > MA60 * 0.99 作為代理（近期上揚）
  if (ind.ma20 && ind.ma60 && ind.ma20 > ind.ma60) { techScore += 5; detail.ma20_up = "+5 MA20>MA60（向上）"; }
  else detail.ma20_up = "0 MA20未向上";

  // 60 日線向上：MA60 > MA120
  if (ind.ma60 && ind.ma120 && ind.ma60 > ind.ma120) { techScore += 5; detail.ma60_up = "+5 MA60>MA120（向上）"; }
  else detail.ma60_up = "0 MA60未向上";

  // 均線多頭排列 +5
  if (ind.maTrend === "多頭排列") { techScore += 5; detail.ma_bull = "+5 多頭排列"; }
  else detail.ma_bull = "0 非多頭排列(" + ind.maTrend + ")";

  // 突破前高或平台整理：股價近 5% 內接近或超過 20 日最高
  const high20 = history?.length >= 20 ? history.slice(-20).reduce((mx,h)=>Math.max(mx,h.high||h.close),-Infinity) : null;
  if (high20 && p >= high20 * 0.98) { techScore += 5; detail.breakout = "+5 近20日高點附近突破"; }
  else detail.breakout = "0 未突破前高";

  score += Math.min(techScore, 25);
  detail._tech = Math.min(techScore, 25);

  // ── 量價關係 15 分 ────────────────────────────────────────
  let volScore = 0;
  const todayVol = history?.at(-1)?.volume || 0;
  const prev5Vols = history?.slice(-6, -1).map(h => h.volume) || [];
  const avg5Vol = prev5Vols.length ? prev5Vols.reduce((s,v)=>s+v,0)/prev5Vols.length : 0;
  const todayChange = history?.length >= 2
    ? history.at(-1).close - history.at(-2).close : 0;

  // 上漲放量 +5
  if (todayChange > 0 && avg5Vol > 0 && todayVol > avg5Vol * 1.2) {
    volScore += 5; detail.up_vol = "+5 上漲放量";
  } else detail.up_vol = "0 未上漲放量";

  // 回檔量縮 +5（近3日下跌但量縮）
  const last3Change = history?.length >= 4
    ? history.at(-1).close - history.at(-4).close : null;
  const last3VolAvg = history?.length >= 4
    ? history.slice(-3).reduce((s,h)=>s+(h.volume||0),0)/3 : 0;
  if (last3Change != null && last3Change < 0 && last3VolAvg < avg5Vol * 0.85) {
    volScore += 5; detail.down_vol = "+5 回檔量縮";
  } else detail.down_vol = "0 無量縮回檔";

  // 成交量大於 5 日均量 +5
  if (avg5Vol > 0 && todayVol > avg5Vol) { volScore += 5; detail.vol_above_avg = "+5 量>5日均量"; }
  else detail.vol_above_avg = "0 量<5日均量";

  score += Math.min(volScore, 15);
  detail._vol = Math.min(volScore, 15);

  // ── 籌碼面 20 分 ────────────────────────────────────────
  let chipScore = 0;

  // 外資連買 3 日以上 +5
  if (chip?.foreignDays >= 3) { chipScore += 5; detail.foreign_buy = "+5 外資連買" + chip.foreignDays + "日"; }
  else if (chip?.foreign5 > 0) { chipScore += 2; detail.foreign_buy = "+2 外資近5日買超"; }
  else detail.foreign_buy = "0 外資未連買3日";

  // 投信連買 3 日以上 +5
  if (chip?.siteDays >= 3) { chipScore += 5; detail.site_buy = "+5 投信連買" + chip.siteDays + "日"; }
  else if (chip?.site5 > 0) { chipScore += 2; detail.site_buy = "+2 投信近5日買超"; }
  else detail.site_buy = "0 投信未連買";

  // 主力買超集中（外資+投信合計近5日大量買超）+5
  const totalInst5 = (chip?.foreign5 || 0) + (chip?.site5 || 0);
  if (totalInst5 > 5000) { chipScore += 5; detail.inst_total = "+5 法人合計買超>" + (totalInst5/1000).toFixed(0) + "千股"; }
  else if (totalInst5 > 0) { chipScore += 2; detail.inst_total = "+2 法人小幅買超"; }
  else detail.inst_total = "0 法人未買超";

  // 大戶持股增加（近5日外資持續買超作為代理）+5
  if (chip?.foreign5 > 10000 && chip?.foreignDays >= 2) { chipScore += 5; detail.big_player = "+5 大戶持股增加（外資買超）"; }
  else detail.big_player = "0 大戶持股未明顯增加";

  score += Math.min(chipScore, 20);
  detail._chip = Math.min(chipScore, 20);

  // ── 融資融券 10 分 ────────────────────────────────────────
  let marginScore = 0;

  // 股價上漲但融資沒有暴增（健康上漲）+5
  if (margin?.marginChange != null && todayChange > 0) {
    const marginGrowth = margin.marginBal > 0 ? margin.marginChange / margin.marginBal : 0;
    if (marginGrowth < 0.05) { // 融資增幅 < 5%
      marginScore += 5; detail.margin_health = "+5 上漲融資未暴增";
    } else detail.margin_health = "0 融資增幅過高(" + (marginGrowth*100).toFixed(1) + "%)";
  } else if (margin == null) { detail.margin_health = "0 融資資料不足"; }
  else detail.margin_health = "0 股價未上漲";

  // 融資下降但股價不跌 +5
  if (margin?.marginChange != null && margin.marginChange < 0 && todayChange >= 0) {
    marginScore += 5; detail.margin_decrease = "+5 融資下降股價未跌（去槓桿健康）";
  } else detail.margin_decrease = "0 條件未達";

  score += Math.min(marginScore, 10);
  detail._margin = Math.min(marginScore, 10);

  // ── 題材面 10 分 ────────────────────────────────────────
  // 無法即時判斷，用 Claude AI 判斷（傳回 0，由前端 AI 補充）
  // 保守預設：若近期強勢（接近52週高）且有量，給 5 分
  let themeScore = 0;
  if (ind.high52w && p >= ind.high52w * 0.85) { themeScore += 5; detail.theme_main = "+5 近52週高（強勢題材代理）"; }
  else detail.theme_main = "0 未接近52週高";
  // 題材有訂單支撐：月營收正增長作為代理 +5
  if (revenue?.yoy != null && revenue.yoy > 0) { themeScore += 5; detail.theme_support = "+5 月營收正增長（訂單支撐代理）"; }
  else detail.theme_support = "0 月營收未正增長";

  score += Math.min(themeScore, 10);
  detail._theme = Math.min(themeScore, 10);

  // ── 分級判定 ─────────────────────────────────────────────
  let grade, gradeColor;
  if (score >= 80)      { grade = "強勢觀察 🔥"; gradeColor = "#ef4444"; }
  else if (score >= 65) { grade = "可試單 👀";   gradeColor = "#f59e0b"; }
  else if (score >= 50) { grade = "等待整理 ⏳";  gradeColor = "#6b7280"; }
  else                  { grade = "不建議 ❌";    gradeColor = "#374151"; }

  // 最終 NaN / 越界保護
  const safeScore = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
  return { score: safeScore, grade, gradeColor, detail };
}






// ── 動能評分（0~100）────────────────────────────────────
function calcMomentumScore(ind, chip, hist, stock) {
  let score = 0;
  const price    = stock.price  || 0;
  const changePct = parseFloat(stock.changePct) || 0;
  const vol      = stock.volume || 0;

  // 1. 今日漲幅（max 20分）
  if (changePct >= 7)       score += 20;
  else if (changePct >= 5)  score += 16;
  else if (changePct >= 3)  score += 12;
  else if (changePct >= 1)  score += 6;
  else if (changePct > 0)   score += 2;

  // 2. 成交量放大（max 15分）
  const vol5avg = hist.length >= 5
    ? hist.slice(-6,-1).reduce((s,h)=>s+(h.volume||0),0)/5 : 0;
  if (vol5avg > 0) {
    const volRatio = vol / vol5avg;
    if (volRatio >= 3)     score += 15;
    else if (volRatio >= 2) score += 12;
    else if (volRatio >= 1.5) score += 8;
    else if (volRatio >= 1.2) score += 4;
  }

  // 3. 均線多頭排列 MA5>MA10>MA20（max 15分）
  if (ind.ma5 && ind.ma10 && ind.ma20) {
    if (ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20) score += 15;
    else if (ind.ma5 > ind.ma20)                    score += 7;
  }
  // 股價站上 MA20（bonus 5分）
  if (ind.ma20 && price > ind.ma20) score += 5;

  // 4. RSI（max 15分）
  if (ind.rsi >= 70)      score += 10; // 強勢但注意過熱
  else if (ind.rsi >= 60) score += 15; // 最佳動能區
  else if (ind.rsi >= 55) score += 10;
  else if (ind.rsi >= 50) score += 5;

  // 5. MACD 柱狀體翻正（max 10分）
  if (ind.macdHist > 0)   score += 10;
  else if (ind.macd > 0)  score += 5;

  // 6. 突破近20日高點（max 10分）
  const high20 = hist.length >= 20
    ? hist.slice(-20).reduce((mx,h)=>Math.max(mx,h.high||h.close),-Infinity) : 0;
  if (high20 > 0 && price >= high20 * 0.99) score += 10;

  // 7. 法人籌碼（max 10分）
  if (chip) {
    if (chip.foreignDays >= 3)  score += 5;
    else if (chip.foreignDays >= 1) score += 2;
    if (chip.siteDays >= 3)     score += 5;
    else if (chip.siteDays >= 1)    score += 2;
  }

  // 強勢動能加分：同時滿足多條件
  const isStrong = changePct >= 3
    && vol5avg > 0 && vol/vol5avg >= 1.5
    && ind.ma20 && price > ind.ma20
    && (ind.rsi||0) >= 55
    && (ind.macdHist||0) > 0;
  if (isStrong) score += 5; // bonus

  return Math.min(100, Math.round(score));
}

// ── 動能標籤 ────────────────────────────────────────────
function getMomentumTags(ind, chip, hist, stock) {
  const tags   = [];
  const price  = stock.price || 0;
  const chgPct = parseFloat(stock.changePct) || 0;
  const vol    = stock.volume || 0;
  const vol5avg = hist.length >= 5
    ? hist.slice(-6,-1).reduce((s,h)=>s+(h.volume||0),0)/5 : 0;

  if (chgPct >= 3)  tags.push({text:"漲幅強勢",cls:"bull"});
  if (vol5avg > 0 && vol/vol5avg >= 2) tags.push({text:"爆量",cls:"hot"});
  else if (vol5avg > 0 && vol/vol5avg >= 1.5) tags.push({text:"放量",cls:"bull"});

  const high20 = hist.length >= 20
    ? hist.slice(-20).reduce((mx,h)=>Math.max(mx,h.high||h.close),-Infinity) : 0;
  if (high20 > 0 && price >= high20 * 0.99) tags.push({text:"突破高點",cls:"hot"});

  if (ind.ma5 && ind.ma10 && ind.ma20 && ind.ma5>ind.ma10 && ind.ma10>ind.ma20)
    tags.push({text:"多頭排列",cls:"bull"});

  if ((ind.rsi||0) >= 70) tags.push({text:"RSI過熱",cls:"warn"});
  else if ((ind.rsi||0) >= 60) tags.push({text:"RSI強勢",cls:"bull"});

  if (chip?.foreignDays >= 3) tags.push({text:"外資連買",cls:"bull"});
  if (chip?.siteDays    >= 3) tags.push({text:"投信連買",cls:"bull"});

  return tags;
}

function getIndCached(code,hist,price){
  const key=`ind:${code}:${hist.length}:${stableP(price)}`;
  const{fresh}=cacheGet(key);if(fresh)return fresh;
  const ind=calcIndicators(hist,price);cacheSet(key,ind,TTL.indicator);return ind;
}
function getScoreCached(code,ind,chip,margin,fund,rev,hist,price){
  const key=`sc:${code}:${hist.length}:${stableP(price)}:${chip?.date||0}:${margin?.date||0}`;
  const{fresh}=cacheGet(key);if(fresh)return fresh;
  const s=calcStockScore(ind,chip,margin,fund,rev,hist,price);cacheSet(key,s,TTL.score);return s;
}

// ════════════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════════════
app.get("/health",(req,res)=>res.json({
  ok:true,version:"final",cache:CACHE.size,inflight:IN_FLIGHT.size,
  concurrency:AC.cur,overload:_if,uptime:Math.floor(process.uptime())+"s",
  memory:Math.round(process.memoryUsage().heapUsed/1024/1024)+"MB",
}));

app.get("/search",async(req,res)=>{
  const q=(req.query.q||"").trim().replace(/[^\w\u4e00-\u9fff]/g,"").slice(0,10);
  if(!q)return res.json([]);
  try{
    const list=await getStockList();
    const seen=new Set();
    const unique=list.filter(s=>{if(seen.has(s.code))return false;seen.add(s.code);return true;});
    return res.json(unique.filter(s=>s.code.startsWith(q)||s.name.includes(q))
      .sort((a,b)=>{if(a.code===q)return -1;if(b.code===q)return 1;
        if(a.code.startsWith(q)&&!b.code.startsWith(q))return -1;
        if(!a.code.startsWith(q)&&b.code.startsWith(q))return 1;
        return a.code.localeCompare(b.code);}).slice(0,10));
  }catch(e){res.json([]);}
});

// ── /scan ────────────────────────────────────────────────
let _lastScanTs=0;
app.get("/scan",async(req,res)=>{
  const mode     = req.query.mode     || "volume";
  const limit    = Math.min(parseInt(req.query.limit||20), 100);
  const universe = req.query.universe || "custom"; // custom|large|all
  const key = `scan:${mode}:${limit}:${universe}`;
  const{fresh,stale}=cacheGet(key);
  if(fresh)return res.json({...fresh,cached:true});
  // momentum+all 模式可能很慢，有 stale 直接回傳並背景更新
  if(stale){
    setImmediate(()=>_runScan(mode,limit,key,universe).catch(()=>{}));
    return res.json({...stale,cached:true,stale:true});
  }
  const ip=req.ip||"unknown";
  if(rateLimit(ip,5,60000))return res.status(429).json({error:"請求過於頻繁，請稍後再試"});
  _lastScanTs=Date.now();
  try{res.json(await _runScan(mode,limit,key,universe));}
  catch(e){log.error("scan_err",{msg:e.message});
    if(stale)return res.json({...stale,cached:true,stale:true});
    res.status(503).json({error:"掃描失敗："+e.message});}
});


// ════════════════════════════════════════════════════════
// 族群對應表（fallback，FinMind 沒有時使用）
// ════════════════════════════════════════════════════════
const SECTOR_MAP = {
  "半導體": ["2330","2303","2454","2379","2344","3034","3711","2408","2337","3533","2449","6770","3443","2351"],
  "電子組裝": ["2317","2382","2356","2354","2352","3231","2362","2365","4938","3702","2357","2353"],
  "伺服器/AI": ["2382","3231","6669","6789","3017","2345","5483","6235","3006","2353"],
  "網通": ["2345","4904","3044","6443","6415","3149","4977","5285","8299","3706","3025","3041","6695","3704","3311"],
  "PCB": ["3037","2349","8046","3706","6183","3028","6269","2445","3189","3094"],
  "面板": ["2409","3481","5483","3673","6185","6443"],
  "光電/LED": ["2448","3014","2393","3703","2455","6244","3035","2340","6168","2426","3015","2489"],
  "金融": ["2881","2882","2891","2886","2884","2885","2892","2888","2887","2890","5880","2883","2889"],
  "航運": ["2603","2615","2609","2610","2612","2606","2608","2614","2616","2618"],
  "鋼鐵": ["2002","2006","2007","2008","2015","9910","2023","2025"],
  "汽車/電動車": ["2201","2207","1537","1590","6208","2208","1598","2231"],
  "生技醫療": ["4763","6547","1786","4174","6202","4188","6547","3719","4194","4155"],
  "電信": ["2412","3045","4904","4977"],
  "電子零件": ["2327","2385","6116","2399","3189","6269","2492","2475","2321","3528","2488","6282","2483","2484"],
  "高股息ETF": ["0050","0056","00878","00919","006208","00929","00713","00692"],
  "電源/被動": ["2308","2474","2492","3045","6121","2425","2327","1736"],
  "橡塑膠": ["1476","1477","1301","1303","1304","1308","2102","2103"],
  "食品": ["1201","1203","1210","1213","1215","1216","1218","1219","1220"],
  "紡織": ["1402","1434","1440","1441","1444","1445","1446","1449"],
  "建築/營建": ["2395","2534","2535","2536","2537","2538","2543","5522"],
};

// FinMind industry_category → 我們的族群名稱
const FM_SECTOR_ALIAS = {
  "半導體": "半導體", "IC設計": "半導體", "晶圓代工": "半導體",
  "電腦及週邊設備": "電子組裝", "電子零組件": "電子零件",
  "光電業": "光電/LED", "通信網路業": "網通",
  "金融業": "金融", "銀行業": "金融", "保險業": "金融", "證券業": "金融",
  "航運業": "航運", "鋼鐵工業": "鋼鐵", "汽車工業": "汽車/電動車",
  "生技醫療業": "生技醫療", "食品工業": "食品", "紡織纖維": "紡織",
  "建材營造": "建築/營建", "橡膠工業": "橡塑膠",
};

// 取得股票所屬族群（優先 FinMind，否則用 fallback）
function getSector(code, fmCategory) {
  // type 欄位（twse/otc）不是族群，要忽略
  if (fmCategory && fmCategory !== "twse" && fmCategory !== "otc" && fmCategory.length > 3) {
    const alias = FM_SECTOR_ALIAS[fmCategory];
    if (alias) return alias;
    return fmCategory;
  }
  for (const [sec, codes] of Object.entries(SECTOR_MAP)) {
    if (codes.includes(code)) return sec;
  }
  return "其他";
}

// ── 族群熱度計算（0~100）──────────────────────────────
function calcSectorHeat(stocks) {
  const n = stocks.length;
  if (!n) return 0;
  let score = 0;

  // 1. 族群平均漲幅（25分）
  const avgChg = stocks.reduce((s,st)=>s+(parseFloat(st.changePct)||0),0)/n;
  if (avgChg >= 3)       score += 25;
  else if (avgChg >= 2)  score += 20;
  else if (avgChg >= 1)  score += 14;
  else if (avgChg >= 0)  score += 7;
  else if (avgChg >= -1) score += 2;

  // 2. 上漲家數比例（20分）
  const upCount = stocks.filter(s=>(parseFloat(s.changePct)||0)>0).length;
  const upRatio = upCount / n;
  if (upRatio >= 0.8)       score += 20;
  else if (upRatio >= 0.6)  score += 15;
  else if (upRatio >= 0.4)  score += 8;
  else if (upRatio >= 0.2)  score += 3;

  // 3. 族群成交金額（20分）—— 相對分，由外部正規化
  // 暫用成交量總和代替
  const totalVol = stocks.reduce((s,st)=>s+(st.volume||0),0);
  const avgVol   = totalVol / n;
  if (avgVol >= 5000)      score += 20;
  else if (avgVol >= 2000) score += 15;
  else if (avgVol >= 500)  score += 8;
  else if (avgVol >= 100)  score += 3;

  // 4. 爆量比例（15分）
  const hotCount = stocks.filter(s=>s._volRatio && s._volRatio >= 1.5).length;
  const hotRatio = hotCount / n;
  if (hotRatio >= 0.5)      score += 15;
  else if (hotRatio >= 0.3) score += 10;
  else if (hotRatio >= 0.1) score += 5;

  // 5. 族群內動能股數量（10分）
  const momCount = stocks.filter(s=>(s.momentumScore||0) >= 60).length;
  if (momCount >= 5)       score += 10;
  else if (momCount >= 3)  score += 7;
  else if (momCount >= 1)  score += 3;

  // 6. 法人買超（10分）
  const instCount = stocks.filter(s=>s._chip&&((s._chip.foreign1>0)||(s._chip.site1>0))).length;
  const instRatio = instCount / n;
  if (instRatio >= 0.5)      score += 10;
  else if (instRatio >= 0.3) score += 6;
  else if (instRatio >= 0.1) score += 2;

  return Math.min(100, Math.round(score));
}

// ── 族群標籤 ──────────────────────────────────────────
function getSectorTags(sectorData, sectorRank, totalSectors) {
  const tags = [];
  if (sectorData.sectorHeat >= 80) tags.push({text:"🔥 主流族群",cls:"hot"});
  if (sectorRank < 5)              tags.push({text:"💰 資金集中",cls:"hot"});
  if (sectorData.hotRatio >= 0.3)  tags.push({text:"🚀 族群爆量",cls:"bull"});
  if (sectorData.upRatio  >= 0.6)  tags.push({text:"📈 多數轉強",cls:"bull"});
  if (sectorData.instRatio >= 0.3) tags.push({text:"🏦 法人布局",cls:"bull"});
  return tags;
}


// ════════════════════════════════════════════════════════
// 動能全市場掃描（大池子專用）
// ════════════════════════════════════════════════════════
async function _runMomentumScan(poolCodes, limit, cacheKey) {
  const t0 = Date.now();
  log.info("momentum_scan_start", { pool: poolCodes.length, limit });

  // 取中文名稱對照表
  let momNameMap = {};
  try {
    const fmList = await getStockList();
    fmList.forEach(s => { if (s.name && /[\u4e00-\u9fff]/.test(s.name)) momNameMap[s.code] = s.name; });
  } catch(e) {}

  const BATCH = 50;
  const results = [];

  for (let i = 0; i < poolCodes.length; i += BATCH) {
    // deadline 保護：超過 50s 就停止，回傳目前結果
    if (Date.now() - t0 > 50000) {
      log.warn("momentum_scan_timeout", { scanned: i, total: poolCodes.length });
      break;
    }

    const batch = poolCodes.slice(i, i + BATCH);
    const tasks = batch.map(code => async () => {
      try {
        const r = await fetchYahooChart(code);
        if (!r?.stock?.price) return null;
        const hist = r.hist || [];
        const ind  = calcIndicators(hist, r.stock.price);
        // 快速過濾：只保留有上漲且成交量正常的
        const chg = parseFloat(r.stock.changePct) || 0;
        if (chg < -5) return null; // 大跌的跳過
        const chip = cacheGet(`chip:${code}`).fresh || cacheGet(`chip:${code}`).stale;
        const ms   = calcMomentumScore(ind, chip, hist, r.stock);
        const mt   = getMomentumTags(ind, chip, hist, r.stock);
        return { ...r.stock,
          name: momNameMap[code] || r.stock.name,
          momentumScore: ms, momentumTags: mt,
          ind, rsi: ind.rsi, maTrend: ind.maTrend };
      } catch(e) { return null; }
    });

    const batchResults = await runLimited(tasks, 5);
    batchResults.forEach(s => { if (s && s.momentumScore >= 20) results.push(s); });
  }

  // 排序取前 limit 名
  results.sort((a, b) => b.momentumScore - a.momentumScore);
  const top = results.slice(0, limit);

  // 加 Claude AI 建議（只針對 top N，不超時）
  let final = top;
  if (AK() && top.length > 0) {
    try {
      const prompt = `你是台股職業交易員，根據以下${top.length}支動能股評分資料，每支給出一句話操作建議（15字內），格式：代號|建議\n\n${
        top.map(s=>`${s.code} ${s.name} 動能分數${s.momentumScore} 漲幅${s.changePct} RSI${Math.round(s.rsi||0)}`).join("\n")
      }`;
      const aiRes = await fetchRetry("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":AK(),"anthropic-version":"2023-06-01"},
        body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:600,
          messages:[{role:"user",content:prompt}]}),
      }, 12000, 1);
      const txt = (await aiRes.json()).content?.[0]?.text || "";
      const map = {};
      txt.split("\n").forEach(l => { const [c,...r]=l.split("|"); if(c&&r.length) map[c.trim()]=r.join("|").trim(); });
      final = top.map(s => ({ ...s, suggestion: map[s.code] || "動能強勢，注意追高風險" }));
    } catch(e) {
      final = top.map(s => ({ ...s, suggestion: "動能強勢，注意追高風險" }));
    }
  } else {
    final = top.map(s => ({ ...s, suggestion: "動能強勢，注意追高風險" }));
  }

  log.info("momentum_scan_done", { found: results.length, top: top.length, ms: Date.now()-t0 });

  const resp = { mode:"momentum", universe: "large", stocks: final,
    time: new Date().toISOString(), _v:"momentum" };
  cacheSet(cacheKey, resp, TTL.scan);
  return resp;
}


// ════════════════════════════════════════════════════════
// 鎖漲停策略
// ════════════════════════════════════════════════════════
function getLimitUpPrice(prevClose) {
  if (!prevClose || prevClose <= 0) return 0;
  const raw = prevClose * 1.1;
  // 台股 tick size 簡化版
  if (raw < 10)       return Math.round(raw * 100) / 100;
  if (raw < 50)       return Math.round(raw * 10) / 10;
  if (raw < 100)      return Math.round(raw * 4) / 4; // 0.25
  if (raw < 500)      return Math.round(raw * 2) / 2; // 0.5
  if (raw < 1000)     return Math.round(raw);
  return Math.round(raw / 5) * 5;
}

function calcLimitUpScore(stock, hist, chip, margin) {
  let score = 0;
  const price    = stock.price  || 0;
  const changePct = parseFloat(stock.changePct) || 0;
  const vol      = stock.volume || 0;

  // 1. 漲幅接近漲停（25分）
  if (changePct >= 9.5)     score += 25;
  else if (changePct >= 8)  score += 18;
  else if (changePct >= 6)  score += 10;
  else if (changePct >= 4)  score += 4;

  // 2. 爆量（20分）
  const vol5avg = hist.length >= 5
    ? hist.slice(-6,-1).reduce((s,h)=>s+(h.volume||0),0)/5 : 0;
  const volRatio = vol5avg > 0 ? vol / vol5avg : 0;
  if (volRatio >= 2)        score += 20;
  else if (volRatio >= 1.5) score += 12;
  else if (volRatio >= 1.2) score += 6;

  // 3. 突破型態（15分）
  const high20 = hist.length >= 20
    ? hist.slice(-20).reduce((mx,h)=>Math.max(mx,h.high||h.close),-Infinity) : 0;
  const high60 = hist.length >= 60
    ? hist.slice(-60).reduce((mx,h)=>Math.max(mx,h.high||h.close),-Infinity) : 0;
  if (high60 > 0 && price >= high60 * 0.99)      score += 15;
  else if (high20 > 0 && price >= high20 * 0.99)  score += 10;

  // 4. 多頭排列（10分）
  const closes = hist.map(h=>h.close);
  const ma = n => closes.length>=n ? closes.slice(-n).reduce((s,v)=>s+v,0)/n : null;
  const ma5=ma(5),ma10=ma(10),ma20=ma(20);
  if (ma5&&ma10&&ma20&&ma5>ma10&&ma10>ma20&&price>ma20) score += 10;
  else if (ma20&&price>ma20) score += 4;

  // 5. 法人買超（10分）
  if (chip) {
    if ((chip.site1>0)||(chip.siteDays>=2)) score += 6;
    if (chip.foreign1>0)                    score += 4;
  }

  // 6. 籌碼集中（10分）—— 融資沒有暴增
  if (margin) {
    const marginChange = margin.marginChange || 0;
    const marginBal    = margin.marginBal    || 1;
    const marginRatio  = Math.abs(marginChange) / marginBal;
    if (changePct >= 3 && marginRatio < 0.02) score += 10; // 漲但融資沒暴增
    else if (marginRatio >= 0.05) score -= 5;              // 融資暴增扣分
  } else if (changePct >= 3) {
    score += 5; // 無融資資料時，漲幅強就給一半分
  }

  // 7. 鎖單強度（暫無五檔資料，給 0）
  // score += 0;

  return Math.min(100, Math.max(0, Math.round(score)));
}

function getLimitUpTags(stock, hist, chip, margin, score) {
  const tags   = [];
  const chgPct = parseFloat(stock.changePct) || 0;
  const vol    = stock.volume || 0;
  const vol5avg = hist.length >= 5
    ? hist.slice(-6,-1).reduce((s,h)=>s+(h.volume||0),0)/5 : 0;
  const volRatio = vol5avg > 0 ? vol/vol5avg : 0;

  if (chgPct >= 9.5) tags.push({text:"🔒 鎖漲停", cls:"hot"});
  if (chgPct >= 8 && volRatio >= 1.5) tags.push({text:"🚀 快攻漲停", cls:"hot"});
  if (score >= 80) tags.push({text:"🔥 強勢候選", cls:"hot"});
  if (volRatio >= 2) tags.push({text:"💰 爆量攻擊", cls:"bull"});
  if (chip && ((chip.site1>0)||(chip.foreign1>0))) tags.push({text:"🏦 法人點火", cls:"bull"});
  // 追高風險（需要 ind.rsi，這裡用漲幅簡化）
  if (chgPct >= 8 && chgPct < 9.5) tags.push({text:"⚠️ 追高風險", cls:"warn"});
  return tags;
}

function getLimitUpSuggest(stock, score) {
  const chgPct = parseFloat(stock.changePct) || 0;
  if (chgPct >= 9.5) return "已接近漲停，注意是否開板與成交量變化";
  if (chgPct >= 8)   return "攻擊力強，觀察是否帶量突破並封住漲停";
  if (score >= 80)   return "動能強，留意是否挑戰漲停價";
  return "漲幅已大，避免無停損追高";
}

async function _runLimitUpScan(poolCodes, limit, cacheKey) {
  const t0 = Date.now();
  log.info("limitup_scan_start", { pool: poolCodes.length });

  // 取中文名稱對照
  let nameMap = {};
  try {
    const fmList = await getStockList();
    fmList.forEach(s=>{ if(s.name&&/[\u4e00-\u9fff]/.test(s.name)) nameMap[s.code]=s.name; });
  } catch(e) {}

  const BATCH = 50;
  const results = [];

  for (let i = 0; i < poolCodes.length; i += BATCH) {
    if (Date.now() - t0 > 50000) { log.warn("limitup_timeout",{scanned:i}); break; }
    const batch = poolCodes.slice(i, i + BATCH);
    const tasks = batch.map(code => async () => {
      try {
        const r = await fetchYahooChart(code);
        if (!r?.stock?.price) return null;
        const chgPct = parseFloat(r.stock.changePct) || 0;
        if (chgPct < 3) return null; // 漲幅 < 3% 直接跳過
        const hist   = r.hist || [];
        const chip   = cacheGet(`chip:${code}`).fresh   || cacheGet(`chip:${code}`).stale;
        const margin = cacheGet(`margin:${code}`).fresh || cacheGet(`margin:${code}`).stale;
        const lscore = calcLimitUpScore(r.stock, hist, chip, margin);
        if (lscore < 10) return null; // 太低分跳過
        const tags    = getLimitUpTags(r.stock, hist, chip, margin, lscore);
        const suggest = getLimitUpSuggest(r.stock, lscore);
        const prevClose = r.hist?.at(-2)?.close || r.stock.price;
        const limitUpPrice = getLimitUpPrice(prevClose);
        const vol5avg = hist.length >= 5
          ? hist.slice(-6,-1).reduce((s,h)=>s+(h.volume||0),0)/5 : 0;
        const volRatio = vol5avg > 0 ? +(r.stock.volume/vol5avg).toFixed(2) : 0;
        return {
          ...r.stock,
          name: nameMap[code] || r.stock.name,
          prevClose,
          limitUpPrice,
          distanceToLimitUp: limitUpPrice > 0
            ? +((limitUpPrice - r.stock.price)/r.stock.price*100).toFixed(2) : 0,
          limitUpScore: lscore,
          volumeRatio: volRatio,
          tags, suggest,
        };
      } catch(e) { return null; }
    });
    const batchRes = await runLimited(tasks, 5);
    batchRes.forEach(s => { if(s) results.push(s); });
  }

  // 排序：limitUpScore → 漲幅 → volRatio
  results.sort((a,b) =>
    b.limitUpScore - a.limitUpScore ||
    parseFloat(b.changePct) - parseFloat(a.changePct) ||
    b.volumeRatio - a.volumeRatio
  );
  const top = results.slice(0, limit);

  log.info("limitup_scan_done", { found: results.length, top: top.length, ms: Date.now()-t0 });

  const resp = { mode:"limitup", stocks:top, time:new Date().toISOString(), _v:"limitup" };
  cacheSet(cacheKey, resp, TTL.scan);
  return resp;
}


// ════════════════════════════════════════════════════════
// 族群熱度掃描
// ════════════════════════════════════════════════════════
async function _runSectorScan(poolCodes, limit, cacheKey) {
  const t0 = Date.now();
  log.info("sector_scan_start", { pool: poolCodes.length });

  // 1. 批次抓 Yahoo chart（concurrency=5）
  const BATCH = 50;
  const allStocks = [];

  // 同時取 FinMind 股票清單（含 industry_category）
  let fmCategoryMap = {}, fmNameMap = {};
  try {
    const fmList = await getStockList();
    fmList.forEach(s => {
      if (s.industry) fmCategoryMap[s.code] = s.industry;
      // 保留中文名稱對應
      if (s.name && /[\u4e00-\u9fff]/.test(s.name)) fmNameMap[s.code] = s.name;
    });
  } catch(e) {}

  for (let i = 0; i < poolCodes.length; i += BATCH) {
    if (Date.now() - t0 > 50000) {
      log.warn("sector_scan_timeout", { scanned: i });
      break;
    }
    const batch = poolCodes.slice(i, i + BATCH);
    const tasks = batch.map(code => async () => {
      try {
        const r = await fetchYahooChart(code);
        if (!r?.stock?.price) return null;
        const hist = r.hist || [];
        const ind  = calcIndicators(hist, r.stock.price);
        const chip = cacheGet(`chip:${code}`).fresh || cacheGet(`chip:${code}`).stale;
        const ms   = calcMomentumScore(ind, chip, hist, r.stock);
        const mt   = getMomentumTags(ind, chip, hist, r.stock);

        // 計算成交量倍數
        const vol5avg = hist.length >= 5
          ? hist.slice(-6,-1).reduce((s,h)=>s+(h.volume||0),0)/5 : 0;
        const volRatio = vol5avg > 0 ? r.stock.volume / vol5avg : 0;

        // 取得族群
        const fmCat = fmCategoryMap[code];
        const sector = getSector(code, fmCat);

        return {
          ...r.stock,
          name: fmNameMap[code] || r.stock.name, // 優先用中文名
          momentumScore: ms,
          momentumTags: mt,
          sector,
          _volRatio: volRatio,
          _chip: chip,
          rsi: ind.rsi,
          maTrend: ind.maTrend,
        };
      } catch(e) { return null; }
    });

    const results = await runLimited(tasks, 5);
    results.forEach(s => { if (s) allStocks.push(s); });
  }

  log.info("sector_scan_fetched", { stocks: allStocks.length, ms: Date.now()-t0 });

  // 2. 依族群分組
  const sectorGroups = {};
  allStocks.forEach(s => {
    if (!sectorGroups[s.sector]) sectorGroups[s.sector] = [];
    sectorGroups[s.sector].push(s);
  });

  // 3. 計算每族群熱度
  const sectorList = [];
  for (const [sector, stocks] of Object.entries(sectorGroups)) {
    if (stocks.length < 1) continue; // 空族群跳過
    const n = stocks.length;
    const avgChg     = stocks.reduce((s,st)=>s+(parseFloat(st.changePct)||0),0)/n;
    const upCount    = stocks.filter(s=>(parseFloat(s.changePct)||0)>0).length;
    const upRatio    = upCount/n;
    const hotCount   = stocks.filter(s=>s._volRatio>=1.5).length;
    const hotRatio   = hotCount/n;
    const instCount  = stocks.filter(s=>s._chip&&((s._chip.foreign1>0)||(s._chip.site1>0))).length;
    const instRatio  = instCount/n;
    const totalVol   = stocks.reduce((s,st)=>s+(st.volume||0),0);
    const sectorHeat = calcSectorHeat(stocks);

    // 族群內強勢股（按 momentumScore 排序取前 5）
    const leaders = [...stocks]
      .sort((a,b)=>b.momentumScore-a.momentumScore)
      .slice(0,5)
      .map(s=>({code:s.code,name:s.name,price:s.price,
        changePct:s.changePct,momentumScore:s.momentumScore,
        momentumTags:s.momentumTags}));

    sectorList.push({
      sector, sectorHeat, avgChangePct: +avgChg.toFixed(2),
      upRatio: +upRatio.toFixed(2), hotRatio: +hotRatio.toFixed(2),
      instRatio: +instRatio.toFixed(2), totalVol, stockCount: n, leaders,
    });
  }

  // 4. 族群按熱度排序
  sectorList.sort((a,b)=>b.sectorHeat-a.sectorHeat);
  const topSectors = sectorList.slice(0,10).map((sd,i)=>({
    ...sd, tags: getSectorTags(sd, i, sectorList.length),
  }));

  // 5. 全市場前 50 強股（按 momentumScore）
  const top50 = [...allStocks]
    .sort((a,b)=>b.momentumScore-a.momentumScore)
    .slice(0, limit)
    .map(s=>({
      code:s.code, name:s.name, price:s.price,
      changePct:s.changePct, momentumScore:s.momentumScore,
      momentumTags:s.momentumTags, sector:s.sector,
    }));

  // 6. Claude AI 族群分析（optional）
  let aiComment = "";
  if (AK() && topSectors.length > 0) {
    try {
      const prompt = `你是台股職業交易員，以下是今日台股族群熱度排行，請用2句話點評目前市場主流族群與操作重點：\n${
        topSectors.slice(0,5).map(s=>`${s.sector} 熱度${s.sectorHeat}分 平均漲幅${s.avgChangePct}% 上漲比例${Math.round(s.upRatio*100)}%`).join("\n")
      }`;
      const aiRes = await fetchRetry("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":AK(),"anthropic-version":"2023-06-01"},
        body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:200,
          messages:[{role:"user",content:prompt}]}),
      }, 10000, 1);
      aiComment = (await aiRes.json()).content?.[0]?.text || "";
    } catch(e) {}
  }

  log.info("sector_scan_done", { sectors: topSectors.length, top50: top50.length, ms: Date.now()-t0 });

  const resp = {
    mode:"sector", stocks: top50, sectors: topSectors,
    aiComment, time: new Date().toISOString(), _v:"sector",
  };
  cacheSet(cacheKey, resp, TTL.scan);
  return resp;
}

async function _runScan(mode,limit,cacheKey,universe="custom"){
  const dl=Date.now()+55000;const tick=()=>{if(Date.now()>dl)throw new Error("scan_timeout");};

  // ── 根據 universe 決定股票池 ────────────────────────
  let poolCodes=[];
  if(universe==="all"||universe==="large"){
    try{
      const all=await getStockList();
      const _seenPool=new Set();
      poolCodes=all.map(s=>s.code).filter(c=>{
        if(!/^\d+$/.test(c))return false;
        if(_seenPool.has(c))return false;
        _seenPool.add(c);
        const n=parseInt(c);
        if(universe==="large")return c.length===4&&n>=1000&&n<=9999;
        return c.length<=5;
      });
      log.info("scan_pool",{universe,total:poolCodes.length});
    }catch(e){
      log.warn("scan_pool_err",{msg:e.message});
      poolCodes=SCAN_STOCKS.map(s=>s.code);
    }
  }else{
    poolCodes=SCAN_STOCKS.map(s=>s.code);
  }

  // limitup → 鎖漲停掃描（固定用 large 池）
  if(mode==="limitup"){
    let luPool=poolCodes;
    if(luPool.length<100){
      try{
        const all=await getStockList();
        const seen=new Set();
        luPool=all.map(s=>s.code).filter(c=>{
          if(!/^\d{4}$/.test(c)||seen.has(c))return false;
          seen.add(c);return parseInt(c)>=1000&&parseInt(c)<=9999;
        });
      }catch(e){}
    }
    return await _runLimitUpScan(luPool,limit,cacheKey);
  }
  // sector → 族群熱度掃描（固定用 large 池）
  if(mode==="sector"){
    // 如果目前 poolCodes 太少（custom），強制改用 large
    let sectorPool = poolCodes;
    if(sectorPool.length < 100){
      try{
        const all=await getStockList();
        const seenSector=new Set();
        sectorPool=all.map(s=>s.code).filter(c=>{
          if(!/^\d{4}$/.test(c)||seenSector.has(c))return false;
          seenSector.add(c);
          return parseInt(c)>=1000&&parseInt(c)<=9999;
        });
        log.info("sector_force_large",{pool:sectorPool.length});
      }catch(e){ sectorPool=poolCodes; }
    }
    return await _runSectorScan(sectorPool,limit,cacheKey);
  }
  // momentum + 大池子 → 走專用流程
  if(mode==="momentum"&&universe!=="custom"){
    return await _runMomentumScan(poolCodes,limit,cacheKey);
  }

  const snap=getSnapshot();
  let priceMap=new Map(),sparkMap=new Map();
  if(universe==="custom"&&snap&&Object.keys(snap).length>=limit){
    Object.values(snap).forEach(r=>{if(r?.stock?.price>0){priceMap.set(r.stock.code,r.stock);if(r.hist?.length)sparkMap.set(r.stock.code,r.hist);}});
  }else{
    tick();
    const tasks=SCAN_STOCKS.map(s=>()=>fetchYahooChart(s.code).catch(()=>null));
    const charts=await runLimited(tasks);
    charts.forEach((r,i)=>{if(!r)return;if(r.stock?.price>0)priceMap.set(r.stock.code,r.stock);if(r.hist?.length)sparkMap.set(SCAN_STOCKS[i].code,r.hist);});
    const miss=SCAN_STOCKS.filter(s=>!priceMap.has(s.code)).map(s=>s.code);
    if(miss.length){try{
      const r=await fetchRetry(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(miss.map(c=>c+".TW").join(","))}`,{headers:{"User-Agent":YH,"Accept":"application/json"}},8e3,1);
      (await r.json())?.quoteResponse?.result?.forEach(q=>{const code=q.symbol?.replace(".TW",""),price=q.regularMarketPrice;if(!price||!code)return;const prev=q.regularMarketPreviousClose||price;priceMap.set(code,{code,name:SCAN_STOCKS.find(s=>s.code===code)?.name||q.shortName||code,price,change:+(q.regularMarketChange||0).toFixed(2),changePct:((q.regularMarketChangePercent||0)).toFixed(2)+"%",volume:Math.round((q.regularMarketVolume||0)/1e3)});});
    }catch(e){}}
  }
  let stocks=SCAN_STOCKS.map(s=>priceMap.get(s.code)).filter(s=>s?.price>0);
  if(!stocks.length)throw new Error("no_price_data");
  stocks.sort((a,b)=>mode==="change"?parseFloat(b.changePct)-parseFloat(a.changePct):mode==="momentum"?parseFloat(b.changePct)-parseFloat(a.changePct):b.volume-a.volume);
  stocks=stocks.slice(0,limit);tick();
  const results=stocks.map(stock=>{
    try{
      const hist=sparkMap.get(stock.code)||[];
      const chip=(cacheGet(`chip:${stock.code}`).fresh||cacheGet(`chip:${stock.code}`).stale);
      const margin=(cacheGet(`margin:${stock.code}`).fresh||cacheGet(`margin:${stock.code}`).stale);
      const fund=(cacheGet(`fundamentals:${stock.code}`).fresh||cacheGet(`fundamentals:${stock.code}`).stale);
      const rev=(cacheGet(`rev:${stock.code}`).fresh||cacheGet(`rev:${stock.code}`).stale);
      const ind=getIndCached(stock.code,hist,stock.price);
      const sc=getScoreCached(stock.code,ind,chip,margin,fund,rev,hist,stock.price);
      const ms=calcMomentumScore(ind,chip,hist,stock);
        const mt=getMomentumTags(ind,chip,hist,stock);
        const sector=getSector(stock.code,null);
        return{...stock,direction:ind.direction||"—",bull:ind.bull||0,bear:ind.bear||0,rsi:ind.rsi,
        maTrend:ind.maTrend||"—",macd:ind.macd,macdHist:ind.macdHist,volTrend:ind.volTrend||"—",
        score:sc.score,grade:sc.grade,gradeColor:sc.gradeColor,scoreDetail:sc.detail,
        fundScore:sc.detail._fund||0,techScore:sc.detail._tech||0,volScore:sc.detail._vol||0,
        chipScore:sc.detail._chip||0,marginScore:sc.detail._margin||0,themeScore:sc.detail._theme||0,
        momentumScore:ms,momentumTags:mt,sector};
    }catch(e){return{...stock,direction:"—",bull:0,bear:0,score:0,grade:"資料不足",gradeColor:"#374151"};}
  });
  if(mode==="momentum"){
    results.sort((a,b)=>b.momentumScore-a.momentumScore);
  }else{
    results.sort((a,b)=>b.score-a.score);
  }
  tick();
  let final=results;
  if(AK()){try{
        const prompt = `你是台股職業交易員，根據以下${limit}支熱門股評分資料，每支給出一句話操作建議（15字內），格式：代號|建議

${
      results.map(s => 
        `${s.code} ${s.name}：${s.score}分/${s.grade} 價${s.price} ${s.changePct} RSI${s.rsi||"—"} ${s.maTrend} 法人${s.chipScore}分 技術${s.techScore}分`
      ).join("\n")
    }

請逐行輸出，格式：代號|一句話建議（要符合評分等級，強勢股說強勢，不建議股說風險）`;
    const aiRes=await fetchRetry("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":AK(),"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:600,messages:[{role:"user",content:prompt}]})},
    15e3,1);
    const txt=(await aiRes.json()).content?.[0]?.text||"";
    const map={};txt.split("\n").forEach(l=>{const[c,...r]=l.split("|");if(c&&r.length)map[c.trim()]=r.join("|").trim();});
    final=results.map(s=>({...s,suggestion:map[s.code]||s.grade||"觀察中"}));
  }catch(e){final=results.map(s=>({...s,suggestion:s.grade||"觀察中"}));}}
  else{final=results.map(s=>({...s,suggestion:s.grade||"觀察中"}));}
  const resp={mode,stocks:final,time:new Date().toISOString(),_v:"final"};
  cacheSet(cacheKey,resp,TTL.scan);
  setImmediate(async()=>{for(const s of final.slice(0,8)){try{await Promise.allSettled([getChip(s.code),getMargin(s.code),getFundamentals(s.code),getRevenue(s.code)]);await new Promise(r=>setTimeout(r,700));}catch(e){}}});
  return resp;
}

// ── /analyze（快速回傳資料）────────────────────────────
app.post("/analyze",async(req,res)=>{
  const ip=req.ip||"unknown";
  if(rateLimit(ip,20,60000))return res.status(429).json({error:"請求過於頻繁"});
  const{code:raw}=req.body;
  if(!raw)return res.status(400).json({error:"Missing code"});
  const code=String(raw).replace(/[^A-Za-z0-9]/g,"").slice(0,6).toUpperCase();
  if(!code)return res.status(400).json({error:"Invalid code"});
  try{
    const[qR,hR]=await Promise.allSettled([getQuote(code),getHistoryCached(code)]);
    const q=qR.status==="fulfilled"?qR.value:null;
    const hist=hR.status==="fulfilled"?(hR.value||[]):[];
    if(!q)return res.status(404).json({error:`找不到股票 ${code}`});
    const price=q.price;
    const[cR,mR,fR,rR]=await Promise.allSettled([getChip(code),getMargin(code),getFundamentals(code),getRevenue(code)]);
    const chip=cR.status==="fulfilled"?cR.value:null;
    const margin=mR.status==="fulfilled"?mR.value:null;
    const fund=fR.status==="fulfilled"?fR.value:null;
    const rev=rR.status==="fulfilled"?rR.value:null;
    const ind=getIndCached(code,hist,price);
    const scored=getScoreCached(code,ind,chip,margin,fund,rev,hist,price);
    // 檢查是否有快取的 AI 文字（少於 500 字不算有效）
    const{fresh:cachedAI}=cacheGet(`aitext:${code}`);
    const validCache = cachedAI && cachedAI.length >= 500 ? cachedAI : null;
    res.json({quote:q,indicators:ind,chip,margin,fundamentals:fund,revenue:rev,scored,
      text:validCache,aiReady:!!AK(),history:hist.slice(-30)});
  }catch(e){
    log.error("analyze_err",{id:req.id,code,msg:e.message});
    res.status(500).json({error:e.message||"分析失敗"});
  }
});

// ── /analyze-ai（Claude，可以慢）────────────────────────
app.post("/analyze-ai",async(req,res)=>{
  const ip=req.ip||"unknown";
  if(rateLimit(ip,10,60000))return res.status(429).json({error:"請求過於頻繁"});
  if(!AK())return res.json({text:"（未設定 AI API Key）"});
  const{code:raw,quote:q,indicators:ind,chip,margin,fundamentals:fund,revenue:rev,history:histArr}=req.body;
  if(!raw||!q)return res.status(400).json({error:"Missing data"});
  const code=String(raw).replace(/[^A-Za-z0-9]/g,"").slice(0,6).toUpperCase();
  // 先回傳快取（少於 500 字的快取視為無效，強制重新生成）
  const{fresh:cachedAI}=cacheGet(`aitext:${code}`);
  if(cachedAI && cachedAI.length >= 500) return res.json({text:cachedAI,cached:true});
  const history=Array.isArray(histArr)?histArr:[];
  const price=q.price||0;
  const fundamentals=fund;  // prompt 相容
  const revenue=rev;        // prompt 相容
  try{
        const prompt = `你是台灣頂級職業交易員與機構級台股研究員，
熟悉台股主力籌碼、法人邏輯、AI供應鏈、產業循環、
技術分析、總經分析、波段交易與短線情緒。

請根據以下真實資料，以台灣職業交易員口吻，使用繁體中文，
輸出一份專業且具實戰性的台股完整分析報告。

禁止：空泛內容、教科書式解釋、模糊結論、過度保守、AI官腔。
禁止：在段落之間加入 === 或 --- 分隔線、禁止段落前後有超過1行空行。
請直接像真正交易員一樣分析。

--------------------------------------------------
【股票資訊】
股票代號：${code}
股票名稱：${q.name}
市場：${q.market}

--------------------------------------------------
【即時行情（TWSE 真實資料）】
股價：${q.price} 元
漲跌：${q.change>=0?"+":""}${q.change}（${q.changePct}%）
開盤：${q.open}　最高：${q.high}　最低：${q.low}　昨收：${q.prev}
成交量：${q.volume.toLocaleString()} 張

--------------------------------------------------
【技術指標（真實計算，共 ${history.length} 筆資料）】
MA5：${ind.ma5||"—"}　MA10：${ind.ma10||"—"}　MA20：${ind.ma20||"—"}
MA60：${ind.ma60||"—"}　MA120：${ind.ma120||"—"}　MA200：${ind.ma200||"—"}　MA240（年線）：${ind.ma240||"—"}
股價與年線(MA240)距離：${ind.distFrom240||"資料不足"}
年線方向：${ind.ma240dir||"資料不足"}
52週最高：${ind.high52w||"—"}　52週最低：${ind.low52w||"—"}
近13週高：${ind.weekHigh||"—"}　近13週低：${ind.weekLow||"—"}
RSI(14)：${ind.rsi||"—"}
K值：${ind.k||"—"}　D值：${ind.d||"—"}
MACD：${ind.macd||"—"}　Signal：${ind.macdSig||"—"}　柱狀體：${ind.macdHist||"—"}
布林上軌：${ind.bollU||"—"}　中軌：${ind.bollM||"—"}　下軌：${ind.bollL||"—"}
均線排列：${ind.maTrend}
量態：${ind.volTrend}
多空評分：多${ind.bull}分 / 空${ind.bear}分 → ${ind.direction}

--------------------------------------------------
【支撐壓力（計算值）】
第一壓力：${ind.res1}　第二壓力：${ind.res2}
第一支撐：${ind.sup1}　第二支撐：${ind.sup2}　關鍵停損：${ind.stop}

--------------------------------------------------
【三大法人（FinMind 真實資料，最新公布日：${chip?.date||"尚未公布"}）】
${chip ? `外資近5日：${chip.foreign5>0?"+":""}${chip.foreign5.toLocaleString()} 股　最新日：${chip.foreign1>0?"+":""}${chip.foreign1.toLocaleString()} 股
投信近5日：${chip.site5>0?"+":""}${chip.site5.toLocaleString()} 股　今日：${chip.site1>0?"+":""}${chip.site1.toLocaleString()} 股
自營商近5日：${chip.dealer5>0?"+":""}${chip.dealer5.toLocaleString()} 股　今日：${chip.dealer1>0?"+":""}${chip.dealer1.toLocaleString()} 股` : "三大法人資料暫無"}

--------------------------------------------------
【融資融券（FinMind 真實資料）】
${margin ? `資料日期：${margin.date}
融資餘額：${margin.marginBal > 0 ? margin.marginBal.toLocaleString()+"張" : "0張（注意：可能是該股無融資資格、或資料尚未更新）"}
融資變化：${margin.marginChange>=0?"+":""}${margin.marginChange.toLocaleString()} 張
融券餘額：${margin.shortBal > 0 ? margin.shortBal.toLocaleString()+"張" : "0張（注意：可能是該股無融券資格、或資料尚未更新）"}
融券變化：${margin.shortChange>=0?"+":""}${margin.shortChange.toLocaleString()} 張
券資比：${margin.marginBal > 0 ? (margin.shortBal/margin.marginBal*100).toFixed(1)+"%" : "無法計算（融資為0）"}
⚠ 注意：若融資融券為0，可能原因：1.該股為全額交割股或無法信用交易 2.資料尚未公布（收盤後5~6點才更新）` : "融資融券：查無資料（可能尚未公布或非信用交易股）"}

--------------------------------------------------
【基本面（FinMind 真實資料）】
${fundamentals ? `本益比(PE)：${fundamentals.pe}　股價淨值比(PB)：${fundamentals.pb}　殖利率：${fundamentals.div}%` : "基本面資料暫無"}
${revenue ? `最新月營收：${(revenue.revenue/1000).toFixed(0)} 千萬　年增率：${revenue.yoy!=null?revenue.yoy+"%":"—"}` : "月營收資料暫無"}

--------------------------------------------------

請務必完整輸出以下所有段落，每段都要有實質內容，不得省略或簡化：

=== 行情總覽
（今日股價強弱、量能、市場情緒、買賣壓分析）

=== 技術分析
（MA5~MA240均線排列、年線方向、MACD、KD、RSI、布林通道、量價關係）

=== 短線分析
（1~5日操作：是否過熱、主力動向、短線風險）

=== 中線分析
（1~8週：波段方向、法人布局、中線空間）

=== 長線分析
（3~12個月：產業趨勢、成長性、長線投資價值）

=== 長線趨勢分析
（年線方向、長線牛熊位置、機構趨勢判定）
判定：強勢多頭/多頭/中性/偏空/空頭

=== 籌碼分析
（外資/投信/自營商態度、連買連賣天數、籌碼集中度、是否有主力控盤或出貨跡象）

=== 籌碼屬性分析
判定：外資主導/投信作帳/主力短炒/法人波段布局/散戶追價，並說明原因

=== 法人分析
（外資態度、投信態度、自營商態度、是否連續買超、是否有轉賣訊號）

=== 融資融券分析
（融資是否過熱、券資比、是否有軋空或斷頭風險）

=== 基本面分析
（PE/PB合理性、營收成長性、是否高估或低估）

=== 產業分析
（是否為市場主流族群、是否受惠AI、未來成長空間）

=== 市場風格判定
（目前市場風格：AI主流/傳產輪動/高股息，此股是否符合主流）

=== 位階分析
（是否高檔、距離52週高低點、是否適合追價）

=== 風險分析
（技術風險：高/中/低、籌碼風險：高/中/低、基本面風險：高/中/低、總經風險：高/中/低）

=== 支撐壓力
第一壓力：${ind.res1}　第二壓力：${ind.res2}
第一支撐：${ind.sup1}　第二支撐：${ind.sup2}　關鍵停損：${ind.stop}

=== 操作策略
【短線策略】進場區、停損位、是否適合追價
【波段策略】布局方式、停利區
【長線策略】是否適合長抱、合理估值

=== 綜合分析
（綜合所有面向，直接說出核心看法與關鍵邏輯，300字以上）

=== 最終裁定
判定：強烈看多/偏多/中立/偏空/強烈看空
短線勝率：（0~100）　中線勝率：（0~100）　長線勝率：（0~100）
現在是否值得買進：是/否/等待
最佳策略：
最大風險：
最值得關注的關鍵訊號：`;
    const aiR=await fetchRetry("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":AK(),"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:8000,messages:[{role:"user",content:prompt}]})},
    120e3,0); // 2 分鐘 timeout，付費版不限制
    const fullText=(await aiR.json()).content?.[0]?.text||"";
    log.info("analyze_ai_done",{code,chars:fullText.length});
    if(fullText.length>100)cacheSet(`aitext:${code}`,fullText,TTL.aitext);
    res.json({text:fullText});
  }catch(e){
    log.error("analyze_ai_err",{code,msg:e.message});
    res.json({text:"（AI 報告暫時無法產生，請稍後再試）"});
  }
});

app.get("/cache-stats",(req,res)=>res.json({
  cache:CACHE.size,inflight:IN_FLIGHT.size,rate:RATE.size,concurrency:AC.cur,overload:_if,
  uptime:Math.floor(process.uptime())+"s",memory:Math.round(process.memoryUsage().heapUsed/1024/1024)+"MB",
}));
app.post("/cache-clear",(req,res)=>{
  const t=req.headers["x-admin-token"]||req.body?.token;
  if(!ADMIN_TK||t!==ADMIN_TK)return res.status(401).json({error:"Unauthorized"});
  const n=CACHE.size;CACHE.clear();IN_FLIGHT.clear();res.json({ok:true,cleared:n});
});

// ── Background ───────────────────────────────────────────
let _bgR=false;
setInterval(async()=>{
  if(Date.now()-_lastScanTs>5*60e3||_bgR)return;
  _bgR=true;try{await _runScan("volume",10,"scan:volume:10").catch(()=>{});}finally{_bgR=false;}
},2.5*60e3);
setTimeout(()=>refreshSnapshot().catch(()=>{}),10e3);

// ── Process ──────────────────────────────────────────────
process.on("unhandledRejection",r=>log.error("unhandledRejection",{r:String(r?.message||r)}));
process.on("uncaughtException",e=>{log.error("uncaughtException",{msg:e.message});setTimeout(()=>process.exit(1),1500);});
const server=app.listen(PORT,()=>log.info("started",{port:PORT,node:process.version}));
["SIGTERM","SIGINT"].forEach(sig=>process.on(sig,()=>{
  log.info("shutdown",{signal:sig});
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),10e3);
}));

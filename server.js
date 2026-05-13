const express = require("express");
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

async function getQuote(code) {
  try {
    for (const [market, ex] of [["上市","tse"],["上櫃","otc"]]) {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${code}.tw&json=1&delay=0&_=${Date.now()}`;
      const r = await fetch(url, { headers: { "Referer": "https://mis.twse.com.tw/", "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      const q = data?.msgArray?.[0];
      if (!q?.n) continue;
      const price = parseFloat(q.z || q.b || q.c || 0);
      const prev  = parseFloat(q.y || 0);
      return { code, name: q.n, market, price, prev,
        change: price&&prev ? +(price-prev).toFixed(2) : 0,
        changePct: price&&prev ? ((price-prev)/prev*100).toFixed(2) : "0.00",
        open: parseFloat(q.o||0), high: parseFloat(q.h||0),
        low: parseFloat(q.l||0), volume: parseInt(q.v||0) };
    }
  } catch(e) {}
  return null;
}

async function getHistory(code) {
  const rows = [];
  const today = new Date();
  for (let i=3; i>=0; i--) {
    const d = new Date(today); d.setMonth(d.getMonth()-i);
    const ym = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}01`;
    try {
      const r = await fetch(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ym}&stockNo=${code}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      for (const row of data?.data||[]) {
        try { rows.push({ date:row[0], volume:parseInt(row[2].replace(/,/g,"")), open:parseFloat(row[3].replace(/,/g,"")), high:parseFloat(row[4].replace(/,/g,"")), low:parseFloat(row[5].replace(/,/g,"")), close:parseFloat(row[6].replace(/,/g,"")) }); } catch {}
      }
    } catch {}
  }
  return rows;
}

async function getChip(code) {
  try {
    const r = await fetch(`https://www.twse.com.tw/fund/TWT38U?response=json&stockNo=${code}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const rows = data?.data||[];
    if (!rows.length) return null;
    const recent = rows.slice(-5);
    const sum = (idx) => recent.reduce((s,r)=>s+parseInt(r[idx]?.replace(/,/g,"").replace("+","")||0),0);
    const latest = rows.at(-1);
    return { date:latest[0],
      foreign5:sum(4), foreign1:parseInt(latest[4]?.replace(/,/g,"").replace("+","")||0),
      site5:sum(7),    site1:   parseInt(latest[7]?.replace(/,/g,"").replace("+","")||0),
      dealer5:sum(9),  dealer1: parseInt(latest[9]?.replace(/,/g,"").replace("+","")||0) };
  } catch {}
  return null;
}

async function getMargin(code) {
  try {
    const r = await fetch(`https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&stockNo=${code}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const rows = data?.data||[];
    if (rows.length<2) return null;
    const cur=rows.at(-1), prev=rows.at(-2);
    return {
      marginBal: parseInt(cur[3]?.replace(/,/g,"")||0),
      marginChange: parseInt(cur[3]?.replace(/,/g,"")||0)-parseInt(prev[3]?.replace(/,/g,"")||0),
      shortBal: parseInt(cur[8]?.replace(/,/g,"")||0),
      shortChange: parseInt(cur[8]?.replace(/,/g,"")||0)-parseInt(prev[8]?.replace(/,/g,"")||0)
    };
  } catch {}
  return null;
}

function calcIndicators(history, currentPrice) {
  const closes = [...history.map(h=>h.close)];
  if (currentPrice>0) closes.push(currentPrice);
  const n = closes.length;
  if (n<5) return {};
  const ma = (p) => n>=p ? +(closes.slice(-p).reduce((s,v)=>s+v,0)/p).toFixed(2) : null;
  const ma5=ma(5),ma10=ma(10),ma20=ma(20),ma60=ma(60),ma120=ma(120);
  let rsi=null;
  if (n>=15) { let g=0,l=0; for(let i=n-14;i<n;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l+=Math.abs(d);} rsi=l===0?100:+(100-100/(1+g/l)).toFixed(1); }
  let k=null,d2=null;
  if (n>=9) { const c9=closes.slice(-9),hi=Math.max(...c9),lo=Math.min(...c9); const rsv=hi===lo?50:((closes.at(-1)-lo)/(hi-lo))*100; k=+(rsv/3+50*2/3).toFixed(1); d2=+(k/3+50*2/3).toFixed(1); }
  let macd=null,macdSig=null,macdHist=null;
  if (n>=26) { const ema=(arr,p)=>{const kk=2/(p+1);let e=arr.slice(0,p).reduce((s,v)=>s+v,0)/p;for(let i=p;i<arr.length;i++)e=arr[i]*kk+e*(1-kk);return e;}; macd=+(ema(closes,12)-ema(closes,26)).toFixed(2); macdSig=+(macd*0.2+macd*0.8*0.96).toFixed(2); macdHist=+(macd-macdSig).toFixed(2); }
  let bollU=null,bollM=null,bollL=null;
  if (n>=20) { const s=closes.slice(-20),m=s.reduce((x,v)=>x+v,0)/20,sd=Math.sqrt(s.reduce((x,v)=>x+Math.pow(v-m,2),0)/20); bollU=+(m+2*sd).toFixed(1);bollM=+m.toFixed(1);bollL=+(m-2*sd).toFixed(1); }
  const mv=[ma5,ma10,ma20,ma60].filter(v=>v);
  let maTrend="均線糾結";
  if (mv.length>=3) { const desc=[...mv].sort((a,b)=>b-a),asc=[...mv].sort((a,b)=>a-b); if(JSON.stringify(mv)===JSON.stringify(desc))maTrend="多頭排列";else if(JSON.stringify(mv)===JSON.stringify(asc))maTrend="空頭排列"; }
  const vols=history.slice(-6,-1).map(h=>h.volume); const avgVol=vols.length?vols.reduce((s,v)=>s+v,0)/vols.length:0; const todayVol=history.at(-1)?.volume||0;
  let volTrend="正常"; if(avgVol>0){const r=todayVol/avgVol;if(r>1.8)volTrend="爆量";else if(r>1.2)volTrend="量增";else if(r<0.5)volTrend="量縮";else if(r<0.8)volTrend="量減";}
  const p=currentPrice||closes.at(-1);
  const sup1=ma20?+(ma20*0.98).toFixed(1):+(p*0.96).toFixed(1);
  const sup2=ma60?+(ma60*0.97).toFixed(1):+(p*0.92).toFixed(1);
  const res1=bollU||+(p*1.05).toFixed(1); const res2=+(p*1.10).toFixed(1); const stop=+(sup1*0.97).toFixed(1);
  let bull=0,bear=0;
  if(maTrend==="多頭排列")bull+=3;else if(maTrend==="空頭排列")bear+=3;
  if(ma20&&p>ma20)bull+=2;else if(ma20&&p<ma20)bear+=2;
  if(ma60&&p>ma60)bull+=2;else if(ma60&&p<ma60)bear+=2;
  if(rsi&&rsi>50)bull++;else bear++;
  if(k&&d2&&k>d2)bull++;else bear++;
  if(macd&&macd>0)bull++;else bear++;
  if(macdHist&&macdHist>0)bull++;else bear++;
  return { ma5,ma10,ma20,ma60,ma120,rsi,k,d:d2,macd,macdSig,macdHist,bollU,bollM,bollL,maTrend,volTrend,sup1,sup2,res1,res2,stop,bull,bear,direction:bull>bear+2?"偏多":bear>bull+2?"偏空":"中性震盪" };
}

app.post("/analyze", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing code" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "API key not configured" });

  try {
    const [quote, history, chip, margin] = await Promise.all([getQuote(code),getHistory(code),getChip(code),getMargin(code)]);
    if (!quote && !history.length) return res.status(404).json({ error: `查無股票代號 ${code}` });
    const price = quote?.price || history.at(-1)?.close || 0;
    const ind = calcIndicators(history, price);
    const q = quote || { code, name:code, price, prev:0, change:0, changePct:"0", open:0, high:0, low:0, volume:0, market:"上市" };

    const prompt = `你是資深台股職業交易員，根據以下TWSE真實資料分析 ${code} ${q.name}，用繁體中文、台灣交易員口吻輸出完整報告：

【即時行情】股價：${q.price}元 漲跌：${q.change>0?"+":""}${q.change}（${q.changePct}%）開：${q.open} 高：${q.high} 低：${q.low} 量：${q.volume.toLocaleString()}張

【技術指標】MA5:${ind.ma5||"—"} MA10:${ind.ma10||"—"} MA20:${ind.ma20||"—"} MA60:${ind.ma60||"—"} MA120:${ind.ma120||"—"}
RSI:${ind.rsi||"—"} K:${ind.k||"—"} D:${ind.d||"—"} MACD:${ind.macd||"—"} 柱:${ind.macdHist||"—"}
布林 上:${ind.bollU||"—"} 中:${ind.bollM||"—"} 下:${ind.bollL||"—"}
均線:${ind.maTrend} 量態:${ind.volTrend} 方向:${ind.direction}（多${ind.bull}/空${ind.bear}）

【支撐壓力】壓力:${ind.res1}/${ind.res2} 支撐:${ind.sup1}/${ind.sup2} 停損:${ind.stop}

【三大法人】${chip?`外資近5日:${chip.foreign5>0?"+":""}${chip.foreign5.toLocaleString()}張 投信:${chip.site5>0?"+":""}${chip.site5.toLocaleString()}張 自營:${chip.dealer5>0?"+":""}${chip.dealer5.toLocaleString()}張`:"暫無資料"}

【融資融券】${margin?`融資:${margin.marginBal.toLocaleString()}張(${margin.marginChange>0?"+":""}${margin.marginChange.toLocaleString()}) 融券:${margin.shortBal.toLocaleString()}張(${margin.shortChange>0?"+":""}${margin.shortChange.toLocaleString()})`:"暫無資料"}

請輸出：
=== 行情總覽
=== 技術分析
=== 籌碼分析
=== 基本面
=== 產業分析
=== 風險分析
=== 支撐壓力
=== 操作策略
=== AI綜合分析
=== 最終裁定`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:6000, messages:[{role:"user",content:prompt}] })
    });

    if (!response.ok) { const err=await response.text(); return res.status(response.status).json({error:err}); }
    const data = await response.json();
    const fullText = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
    res.json({ text:fullText, quote:q, indicators:ind, chip, margin });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`台股AI後端啟動 port ${PORT}`));

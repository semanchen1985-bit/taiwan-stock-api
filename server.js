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

// ── TWSE 即時報價 ─────────────────────────────────────────
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
      return {
        code, name: q.n, market, price, prev,
        change: price&&prev ? +(price-prev).toFixed(2) : 0,
        changePct: price&&prev ? ((price-prev)/prev*100).toFixed(2) : "0.00",
        open: parseFloat(q.o||0), high: parseFloat(q.h||0),
        low: parseFloat(q.l||0), volume: parseInt(q.v||0)
      };
    }
  } catch(e) {}
  return null;
}

// ── FinMind 歷史日K ───────────────────────────────────────
async function getHistory(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const end = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - 200*24*60*60*1000).toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    return (data?.data || []).map(d => ({
      date: d.date,
      open: parseFloat(d.open),
      high: parseFloat(d.max),
      low:  parseFloat(d.min),
      close: parseFloat(d.close),
      volume: parseInt(d.Trading_Volume / 1000) // 轉換成張
    }));
  } catch(e) {}
  return [];
}

// ── FinMind 三大法人 ──────────────────────────────────────
async function getChip(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const start = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const rows = data?.data || [];
    if (!rows.length) return null;

    // 取最近5個交易日
    const dates = [...new Set(rows.map(r => r.date))].sort().slice(-5);
    const recent = rows.filter(r => dates.includes(r.date));
    const latest = rows.filter(r => r.date === dates.at(-1));

    const sumNet = (name, arr) => arr.filter(r => r.name === name).reduce((s, r) => s + (parseInt(r.buy) - parseInt(r.sell)), 0);

    return {
      date: dates.at(-1),
      foreign5: sumNet("外陸資買賣超股數(不含外資自營商)", recent),
      foreign1: sumNet("外陸資買賣超股數(不含外資自營商)", latest),
      site5:    sumNet("投信買賣超股數", recent),
      site1:    sumNet("投信買賣超股數", latest),
      dealer5:  sumNet("自營商買賣超股數", recent),
      dealer1:  sumNet("自營商買賣超股數", latest),
    };
  } catch(e) {}
  return null;
}

// ── FinMind 融資融券 ──────────────────────────────────────
async function getMargin(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const start = new Date(Date.now() - 10*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const rows = data?.data || [];
    if (rows.length < 2) return null;
    const cur = rows.at(-1), prev = rows.at(-2);
    return {
      marginBal:    parseInt(cur.MarginPurchaseBalance || 0),
      marginChange: parseInt(cur.MarginPurchaseBalance || 0) - parseInt(prev.MarginPurchaseBalance || 0),
      shortBal:     parseInt(cur.ShortSaleBalance || 0),
      shortChange:  parseInt(cur.ShortSaleBalance || 0) - parseInt(prev.ShortSaleBalance || 0),
    };
  } catch(e) {}
  return null;
}

// ── FinMind 基本面（PE/PB）────────────────────────────────
async function getFundamentals(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const start = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPER&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const rows = data?.data || [];
    if (!rows.length) return null;
    const latest = rows.at(-1);
    return {
      pe:  parseFloat(latest.PER || 0),
      pb:  parseFloat(latest.PBR || 0),
      div: parseFloat(latest.dividend_yield || 0),
    };
  } catch(e) {}
  return null;
}

// ── FinMind 月營收 ────────────────────────────────────────
async function getRevenue(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const start = new Date(Date.now() - 365*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const rows = data?.data || [];
    if (!rows.length) return null;
    const latest = rows.at(-1);
    const prev   = rows.at(-13) || rows[0];
    const yoy = prev?.revenue ? ((latest.revenue - prev.revenue) / prev.revenue * 100).toFixed(1) : null;
    return {
      date:    latest.date,
      revenue: parseInt(latest.revenue || 0),
      yoy:     yoy ? parseFloat(yoy) : null,
    };
  } catch(e) {}
  return null;
}

// ── 技術指標計算 ──────────────────────────────────────────
function calcIndicators(history, currentPrice) {
  const closes = [...history.map(h => h.close)];
  if (currentPrice > 0) closes.push(currentPrice);
  const n = closes.length;
  if (n < 5) return {};

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

  return {
    ma5,ma10,ma20,ma60,ma120,ma240,
    rsi,k,d:d2,macd,macdSig,macdHist,
    bollU,bollM,bollL,
    maTrend,volTrend,
    sup1,sup2,res1,res2,stop,
    bull,bear,
    direction: bull>bear+2?"偏多":bear>bull+2?"偏空":"中性震盪"
  };
}

// ── 主分析 API ────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing code" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "API key not configured" });

  try {
    // 並行抓所有資料
    const [quote, history, chip, margin, fundamentals, revenue] = await Promise.all([
      getQuote(code),
      getHistory(code),
      getChip(code),
      getMargin(code),
      getFundamentals(code),
      getRevenue(code),
    ]);

    if (!quote && !history.length) {
      return res.status(404).json({ error: `查無股票代號 ${code}` });
    }

    const price = quote?.price || history.at(-1)?.close || 0;
    const ind = calcIndicators(history, price);
    const q = quote || { code, name:code, price, prev:0, change:0, changePct:"0", open:0, high:0, low:0, volume:0, market:"上市" };

    const prompt = `你是資深台股職業交易員，根據以下真實資料分析 ${code} ${q.name}，用繁體中文、台灣交易員口吻輸出完整報告：

【即時行情（TWSE）】
股票：${q.name}（${code}）${q.market}
股價：${q.price}元　漲跌：${q.change>=0?"+":""}${q.change}（${q.changePct}%）
開：${q.open}　高：${q.high}　低：${q.low}　昨收：${q.prev}　量：${q.volume.toLocaleString()}張

【技術指標（真實計算，共${history.length}筆資料）】
MA5:${ind.ma5||"—"} MA10:${ind.ma10||"—"} MA20:${ind.ma20||"—"} MA60:${ind.ma60||"—"} MA120:${ind.ma120||"—"} MA240:${ind.ma240||"—"}
RSI(14):${ind.rsi||"—"} K:${ind.k||"—"} D:${ind.d||"—"}
MACD:${ind.macd||"—"} Signal:${ind.macdSig||"—"} 柱狀:${ind.macdHist||"—"}
布林 上:${ind.bollU||"—"} 中:${ind.bollM||"—"} 下:${ind.bollL||"—"}
均線排列:${ind.maTrend} 量態:${ind.volTrend}
多空評分：多${ind.bull}分/空${ind.bear}分 → ${ind.direction}

【支撐壓力】
壓力1:${ind.res1} 壓力2:${ind.res2} 支撐1:${ind.sup1} 支撐2:${ind.sup2} 停損:${ind.stop}

【三大法人（FinMind真實資料）】
${chip ? `外資近5日:${chip.foreign5>0?"+":""}${chip.foreign5.toLocaleString()}股 今日:${chip.foreign1>0?"+":""}${chip.foreign1.toLocaleString()}股
投信近5日:${chip.site5>0?"+":""}${chip.site5.toLocaleString()}股 今日:${chip.site1>0?"+":""}${chip.site1.toLocaleString()}股
自營商近5日:${chip.dealer5>0?"+":""}${chip.dealer5.toLocaleString()}股 今日:${chip.dealer1>0?"+":""}${chip.dealer1.toLocaleString()}股` : "三大法人資料暫無"}

【融資融券（FinMind真實資料）】
${margin ? `融資餘額:${margin.marginBal.toLocaleString()}張 變化:${margin.marginChange>=0?"+":""}${margin.marginChange.toLocaleString()}張
融券餘額:${margin.shortBal.toLocaleString()}張 變化:${margin.shortChange>=0?"+":""}${margin.shortChange.toLocaleString()}張` : "融資融券資料暫無"}

【基本面（FinMind真實資料）】
${fundamentals ? `本益比(PE):${fundamentals.pe} 股價淨值比(PB):${fundamentals.pb} 殖利率:${fundamentals.div}%` : "基本面資料暫無"}
${revenue ? `最新月營收:${(revenue.revenue/1000).toFixed(0)}千萬 年增率:${revenue.yoy!=null?revenue.yoy+"%":"—"}` : "月營收資料暫無"}

請嚴格按照以下格式輸出，每個段落標題格式必須完全一致：

=== 行情總覽
（整理今日行情重點，股票基本介紹）

=== 技術分析
（詳細解讀所有技術指標，說明目前多空態勢）

=== 籌碼分析
（解讀三大法人動向、融資融券狀況，判斷主力意圖）

=== 基本面
（PE、PB、殖利率、EPS、ROE、毛利率、月營收年增率解讀）

=== 產業分析
（產業現況、競爭優勢、未來催化劑）

=== 風險分析
（逐項評估：過熱、爆量長黑、法人倒貨、融資過高、估值過高、接近壓力、技術轉弱、財報風險，每項標明高/中/低）

=== 支撐壓力
第一壓力：${ind.res1}（原因）
第二壓力：${ind.res2}（原因）
第一支撐：${ind.sup1}（原因）
第二支撐：${ind.sup2}（原因）
建議停損：${ind.stop}

=== 操作策略
短線策略（1-5日）：
波段策略（2-4週）：
長線策略（數月以上）：
建議進場點：
停損點：${ind.stop}
第一目標：${ind.res1}
第二目標：${ind.res2}

=== AI綜合分析
（400字以上，職業交易員口吻，深度分析多空格局、操作邏輯、關鍵催化劑）

=== 最終裁定
整體方向：${ind.direction}
多空評分：多${ind.bull}分/空${ind.bear}分（滿分10分）
進場建議：
停損點：${ind.stop}
第一目標：${ind.res1}
第二目標：${ind.res2}
風險等級：
一句話總結：`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 6000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const fullText = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    res.json({
      text: fullText,
      quote: q,
      indicators: ind,
      chip,
      margin,
      fundamentals,
      revenue,
    });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`台股AI後端啟動 port ${PORT}`));

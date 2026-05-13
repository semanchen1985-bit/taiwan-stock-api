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

// ── 股票搜尋 API（即時查 TWSE + FinMind）────────────────
let stockCache = null;
let stockCacheTime = 0;

async function getStockList() {
  // 快取 24 小時
  if (stockCache && Date.now() - stockCacheTime < 24*60*60*1000) {
    return stockCache;
  }
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const r = await fetch(
      `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&token=${token}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const data = await r.json();
    const list = (data?.data || [])
      .filter(s => s.stock_id && s.stock_name)
      .map(s => ({ code: s.stock_id, name: s.stock_name, type: s.type || "" }));
    if (list.length > 0) {
      stockCache = list;
      stockCacheTime = Date.now();
      console.log(`股票清單快取：${list.length} 筆`);
    }
    return list;
  } catch(e) {
    return stockCache || [];
  }
}

app.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const list = await getStockList();
    const results = list
      .filter(s => s.code.startsWith(q) || s.name.includes(q))
      .sort((a, b) => {
        // 代號完全匹配優先
        if (a.code === q) return -1;
        if (b.code === q) return 1;
        // 代號開頭匹配其次
        if (a.code.startsWith(q) && !b.code.startsWith(q)) return -1;
        if (!a.code.startsWith(q) && b.code.startsWith(q)) return 1;
        return a.code.localeCompare(b.code);
      })
      .slice(0, 10);
    res.json(results);
  } catch(e) {
    res.json([]);
  }
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
    const start = new Date(Date.now() - 400*24*60*60*1000).toISOString().split("T")[0];
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
    console.log(`三大法人 ${code}: 筆數=${rows.length}, msg=${data?.msg||"ok"}`);
    if (rows.length > 0) console.log("name欄位範例:", [...new Set(rows.slice(0,6).map(r=>r.name))]);
    if (!rows.length) return null;

    // 取最近有資料的5個交易日（自動回退，不限今日）
    const dates = [...new Set(rows.map(r => r.date))].sort().slice(-5);
    const recent = rows.filter(r => dates.includes(r.date));
    const latestDate = dates.at(-1);
    const latest = rows.filter(r => r.date === latestDate);
    console.log(`三大法人最新日期: ${latestDate}（共${dates.length}個交易日）`);

    // 計算買賣超（buy - sell）
    // FinMind name 欄位是英文
    // Foreign_Investor, Foreign_Dealer_Self = 外資
    // Investment_Trust = 投信
    // Dealer_self, Dealer_Hedging = 自營商
    const sumNet = (keywords, arr) => arr
      .filter(r => keywords.some(k => r.name && r.name.includes(k)))
      .reduce((s, r) => s + (parseInt(r.buy||0) - parseInt(r.sell||0)), 0);

    return {
      date: dates.at(-1),
      foreign5: sumNet(["Foreign_Investor", "Foreign_Dealer_Self"], recent),
      foreign1: sumNet(["Foreign_Investor", "Foreign_Dealer_Self"], latest),
      site5:    sumNet(["Investment_Trust"], recent),
      site1:    sumNet(["Investment_Trust"], latest),
      dealer5:  sumNet(["Dealer_self", "Dealer_Hedging"], recent),
      dealer1:  sumNet(["Dealer_self", "Dealer_Hedging"], latest),
    };
  } catch(e) { console.error("chip error:", e); }
  return null;
}

// ── FinMind 融資融券 ──────────────────────────────────────
async function getMargin(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    // 抓30天確保有資料（自動回退到最新公布日）
    const start = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const rows = data?.data || [];
    if (rows.length < 2) return null;
    // 取最新有資料的日期（自動回退）
    const latestDate = rows.at(-1).date;
    console.log(`融資融券最新日期: ${latestDate}, 融資:${rows.at(-1).MarginPurchaseTodayBalance}, 融券:${rows.at(-1).ShortSaleTodayBalance}`);
    const cur  = rows.at(-1);
    const prev = rows.at(-2) || cur;
    // FinMind v4 欄位名稱
    // 正確欄位名稱（從 log 確認）
    const marginBal  = parseInt(cur.MarginPurchaseTodayBalance     || cur.MarginPurchaseYesterdayBalance || 0);
    const marginPrev = parseInt(cur.MarginPurchaseYesterdayBalance || 0);
    const shortBal   = parseInt(cur.ShortSaleTodayBalance          || cur.ShortSaleYesterdayBalance     || 0);
    const shortPrev  = parseInt(cur.ShortSaleYesterdayBalance      || 0);
    return {
      date: cur.date,
      marginBal,
      marginChange: marginBal - marginPrev,
      shortBal,
      shortChange:  shortBal - shortPrev,
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

  // ── 週K最高最低（近13週=一季）─────────────────────────
  let weekHigh = null, weekLow = null;
  if (history.length >= 5) {
    const w13 = history.slice(-65);
    weekHigh = Math.max(...w13.map(h=>h.high||h.close));
    weekLow  = Math.min(...w13.map(h=>h.low||h.close));
  }
  // ── 52週高低（近252個交易日）────────────────────────────
  let high52w = null, low52w = null;
  if (history.length >= 50) {
    const y = history.slice(-252);
    high52w = Math.max(...y.map(h=>h.high||h.close));
    low52w  = Math.min(...y.map(h=>h.low||h.close));
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

// ── 主分析 API ────────────────────────────────────────────
// ── 熱門股掃描 API ───────────────────────────────────────
app.get("/scan", async (req, res) => {
  const mode = req.query.mode || "volume";
  const limit = Math.min(parseInt(req.query.limit || 20), 30);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "API key not configured" });

  try {
    const token = process.env.FINMIND_TOKEN || "";
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now()-2*24*60*60*1000).toISOString().split("T")[0];

    // 用 FinMind 抓最近交易日所有股票價格
    const priceUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&start_date=${yesterday}&end_date=${today}&token=${token}`;
    const r = await fetch(priceUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const rows = data?.data || [];

    if (!rows.length) {
      return res.json({ error: "無法取得資料，請稍後再試" });
    }

    // 取最新交易日
    const latestDate = rows.map(r=>r.date).sort().at(-1);
    let stocks = rows
      .filter(r => r.date === latestDate && r.stock_id && r.stock_id.match(/^\d{4}$/) && parseFloat(r.close) > 0)
      .map(r => ({
        code: r.stock_id,
        name: r.stock_id,
        price: parseFloat(r.close),
        changePct: r.spread && r.open ? ((parseFloat(r.spread)/parseFloat(r.open))*100).toFixed(2)+"%" : "0%",
        volume: parseInt(r.Trading_Volume/1000) || 0,
        spread: parseFloat(r.spread) || 0,
      }));

    // 排序
    if (mode === "change") {
      stocks.sort((a,b) => parseFloat(b.changePct) - parseFloat(a.changePct));
    } else {
      stocks.sort((a,b) => b.volume - a.volume);
    }
    stocks = stocks.slice(0, limit);

    // 從 FinMind 股票清單補名稱
    try {
      const infoUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&token=${token}`;
      const ir = await fetch(infoUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const idata = await ir.json();
      const nameMap = {};
      (idata?.data||[]).forEach(s => { nameMap[s.stock_id] = s.stock_name; });
      stocks = stocks.map(s => ({ ...s, name: nameMap[s.code] || s.code }));
    } catch(e) {}

    if (!stocks.length) {
      return res.json({ error: "無排行資料，可能非交易時間" });
    }

    // 批次抓各股技術指標（只抓近期資料，不用 Claude）
    const results = await Promise.all(stocks.map(async (stock) => {
      try {
        const hist = await getHistory(stock.code);
        const ind = calcIndicators(hist, stock.price);
        return {
          ...stock,
          direction: ind.direction || "—",
          bull: ind.bull || 0,
          bear: ind.bear || 0,
          rsi: ind.rsi,
          maTrend: ind.ma_trend || ind.maTrend || "—",
          macd: ind.macd,
          macdHist: ind.macdHist,
          volTrend: ind.volTrend || "—",
          score: ind.bull || 0,
        };
      } catch(e) {
        return { ...stock, direction: "—", bull: 0, bear: 0, score: 0 };
      }
    }));

    // 用 Claude 快速產生一句話結論
    const prompt = `你是台股職業交易員，根據以下${limit}支熱門股資料，每支給出一句話操作建議（15字內），格式：代號|建議

${
      results.map(s => 
        `${s.code} ${s.name}：價${s.price} ${s.changePct} RSI${s.rsi||"—"} ${s.maTrend} ${s.direction}`
      ).join("
")
    }

請逐行輸出，格式：代號|一句話建議`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const aiData = await aiRes.json();
    const aiText = (aiData.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
    
    // 解析 AI 建議
    const suggestions = {};
    aiText.split("
").forEach(line => {
      const parts = line.split("|");
      if (parts.length >= 2) {
        const code = parts[0].trim().replace(/\D/g,"").slice(0,4);
        if (code) suggestions[code] = parts[1].trim();
      }
    });

    // 合併結果
    const final = results.map(s => ({
      ...s,
      suggestion: suggestions[s.code] || "觀察中"
    }));

    res.json({ mode, stocks: final, time: new Date().toISOString() });

  } catch(e) {
    console.error("scan error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/analyze", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing code" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "API key not configured" });

  try {
    // Debug: 確認環境變數
    console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✅有設定" : "❌未設定");
    console.log("FINMIND_TOKEN:", process.env.FINMIND_TOKEN ? "✅有設定" : "❌未設定");
    
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

請務必按照以下固定格式輸出：

=== 行情總覽
（今日股價強弱、量能狀況、市場情緒、是否有異常買盤或賣壓）

=== 技術分析
（MA5~MA240均線排列、200MA年線方向、股價與年線關係、MACD、KD、RSI、布林通道、量價關係、趨勢方向）

=== 短線分析
（1~5日：是否過熱、是否適合短打、是否有主力點火、是否有軋空、短線風險）

=== 中線分析
（1~8週：波段方向、是否主升段、是否法人布局、中線續航力、是否具波段空間）

=== 長線分析
（3~12個月：產業趨勢、AI成長性、EPS成長性、長期競爭力、是否具長線投資價值、是否符合長線趨勢股條件）

=== 長線趨勢分析
（200MA方向、年線扣抵、是否站穩年線、長線牛熊位置、長線資金是否進場、是否符合機構趨勢股條件）
判定：強勢多頭/多頭/中性/偏空/空頭

=== 籌碼分析
（主力、法人、散戶、籌碼集中度、是否有控盤跡象、是否有出貨嫌疑）

=== 籌碼屬性分析
（判定：外資主導/投信作帳/主力短炒/隔日沖/軋空/法人波段布局/散戶追價，說明原因）

=== 法人分析
（外資態度、投信態度、自營商態度、是否有連續買超、是否有轉賣訊號）

=== 融資融券分析
（融資是否過熱、是否散戶過多、是否可能軋空、是否有斷頭風險）

=== 基本面分析
（PE是否過高、PB是否合理、EPS成長性、毛利率趨勢、營收成長性、ROE水準、是否高估或低估）

=== 產業分析
（是否為市場主流族群、是否受惠AI、同族群比較強弱、未來成長空間、是否受惠資本支出循環）

=== 市場風格判定
（目前市場風格：AI主流/傳產輪動/高股息/中小型股/軋空/法人作帳，此股是否符合主流）

=== 位階分析
（是否高檔、是否低基期、距離52週高低點、是否適合追價、是否容易高檔震盪）

=== 風險分析
（技術風險、籌碼風險、法人風險、總經風險、AI泡沫風險、地緣政治風險、高估值風險，每項標明高/中/低）

=== 支撐壓力
第一壓力：${ind.res1}（原因）
第二壓力：${ind.res2}（原因）
第一支撐：${ind.sup1}（原因）
第二支撐：${ind.sup2}（原因）
關鍵停損：${ind.stop}
關鍵突破：（說明）

=== 操作策略
【短線策略】最佳進場區、停損位置、是否適合追價
【波段策略】建議布局方式、建議停利區、是否適合分批布局
【長線策略】是否適合長抱、合理估值區、是否適合定期布局

=== AI綜合分析
（綜合技術面、籌碼面、基本面、產業面、市場情緒、法人邏輯，直接講出核心看法，500字以上，避免模糊答案）

=== 最終裁定
判定：強烈看多/偏多/中立/偏空/強烈看空
短線勝率：（0~100）
中線勝率：（0~100）
長線勝率：（0~100）
現在是否值得買進：是/否/等待
最佳策略：
最大風險：
最值得關注的關鍵訊號：`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const rawText = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    // 徹底清理空行
    const fullText = rawText
      .replace(/\r\n/g, "\n")
      // 只清理純分隔線（不含文字的 === 行），保留段落標題
      .replace(/^={3,}\s*$/gm, "")
      // 段落標題後的多餘空行壓縮成一行
      .replace(/(=== [^\n]+\n)\n+/g, "$1")
      // 表格前的空行清除
      .replace(/\n+(\|)/g, "\n$1")
      // 最多保留兩個空行
      .replace(/\n{3,}/g, "\n\n")
      .trim();

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

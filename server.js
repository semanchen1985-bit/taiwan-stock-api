const express = require("express");
const app = express();

app.set("trust proxy", 1); // Render / Heroku 等 PaaS 都在 proxy 後面，req.ip 才正確
app.use(express.json({ limit: "10kb" })); // 防止 large body attack

// ── 全域 cache（避免重複打 FinMind，Render 免費版友善）────
const CACHE = new Map();
const IN_FLIGHT = new Map(); // 防 cache stampede：同 key 只打一次 API

// ── 簡易 Rate Limiter（不需套件）──────────────────────────
const RATE_STORE = new Map(); // ip -> [timestamps]
function rateLimit(ip, maxReqs = 20, windowMs = 60000) {
  const now = Date.now();
  const reqs = (RATE_STORE.get(ip) || []).filter(t => now - t < windowMs);
  reqs.push(now);
  RATE_STORE.set(ip, reqs);
  // 簡單 LRU-like eviction：不用 spread，直接用 iterator
  if (RATE_STORE.size > 5000) {
    RATE_STORE.delete(RATE_STORE.keys().next().value);
  }
  return reqs.length > maxReqs;
}

// 每 10 分鐘清理過期的 RATE_STORE 條目（避免記憶體慢慢增長）
setInterval(() => {
  const now = Date.now();
  for (const [ip, reqs] of RATE_STORE) {
    if (!reqs.length || now - reqs[reqs.length-1] > 60000) RATE_STORE.delete(ip);
  }
}, 10 * 60 * 1000);

// ── Background 任務 ─────────────────────────────────────────
const PORT_INTERNAL = process.env.PORT || 3001;

// 1. 防 Render 冷啟動（每 14 分鐘 self-ping）
setInterval(() => {
  fetch(`http://localhost:${PORT_INTERNAL}/health`).catch(() => {});
}, 14 * 60 * 1000);

// 2. 定時預熱 scan cache（只在有最近用戶活動時才觸發，避免浪費 FinMind credits）
//    策略：記錄最後一次 scan 請求時間，若 2 分鐘內有人用過，才在 TTL 到期前預熱
let _lastScanActivity = 0;
let _bgScanRunning = false;
setInterval(async () => {
  // 若最近 5 分鐘內沒人使用掃描功能，跳過預熱（節省 FinMind credits）
  if (Date.now() - _lastScanActivity > 5 * 60 * 1000) return;
  if (_bgScanRunning) return;
  _bgScanRunning = true;
  try {
    await fetch(`http://localhost:${PORT_INTERNAL}/scan?mode=volume&limit=20`).catch(() => {});
  } finally {
    _bgScanRunning = false;
  }
}, 2.5 * 60 * 1000);
const CACHE_TTL = {
  history:      10 * 60 * 1000,   // 10 分鐘（K線日內不變）
  chip:         30 * 60 * 1000,   // 30 分鐘（法人數據一天更新一次）
  margin:       30 * 60 * 1000,   // 30 分鐘（融資融券一天更新一次）
  fundamentals:  6 * 60 * 60 * 1000, // 6 小時
  revenue:      12 * 60 * 60 * 1000, // 12 小時（月營收）
  scan:          3 * 60 * 1000,   // 3 分鐘（掃描結果）
};
function getCache(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { CACHE.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttl) {
  // 先刪再插：讓此 key 成為 Map 的最新 entry（維持 insertion-order）
  CACHE.delete(key);
  CACHE.set(key, { data, ts: Date.now(), ttl });
  // FIFO eviction：JS Map 保持 insertion order，第一個就是最舊的 O(1)
  if (CACHE.size > 500) {
    CACHE.delete(CACHE.keys().next().value);
  }
}

// ── fetch with timeout ────────────────────────────────────
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer); return r;
  } catch(e) { clearTimeout(timer); throw e; }
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  // 開發環境 or 明確允許的 origin
  const isAllowed = !origin                                          // server-to-server
    || origin.includes("localhost")
    || origin.includes("127.0.0.1")
    || origin.endsWith(".netlify.app")
    || origin.endsWith(".github.io")
    || ALLOWED_ORIGINS.some(o => origin.includes(o));
  res.header("Access-Control-Allow-Origin", isAllowed ? origin : "");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "2025-v5-chart",   // ← 確認版本用
    time: new Date().toISOString(),
    cache: CACHE.size,
    inFlight: IN_FLIGHT.size,
    uptime: Math.floor(process.uptime()) + "s",
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
  });
});

// 測試各 API 連通性
app.get("/test-apis", async (req, res) => {
  const results = {};

  // 1. Yahoo Finance
  try {
    const r = await fetchWithTimeout(
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=2330.TW",
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" } },
      8000
    );
    const d = await r.json();
    const price = d?.quoteResponse?.result?.[0]?.regularMarketPrice;
    results.yahoo = price ? `✅ 台積電: ${price}` : "⚠ 無資料";
  } catch(e) { results.yahoo = "❌ " + e.message; }

  // 2. TWSE
  try {
    const r = await fetchWithTimeout(
      "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0",
      { headers: { "Referer": "https://mis.twse.com.tw/", "User-Agent": "Mozilla/5.0" } },
      5000
    );
    const d = await r.json();
    const item = d?.msgArray?.[0];
    results.twse = item ? `✅ z=${item.z} y=${item.y}` : "⚠ 無資料";
  } catch(e) { results.twse = "❌ " + e.message; }

  // 3. Yahoo Finance chart（getHistory 用）
  try {
    const r = await fetchWithTimeout(
      "https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?interval=1d&range=1mo",
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" } },
      8000
    );
    const d = await r.json();
    const closes = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    results.yahooChart = closes.length ? `✅ ${closes.length} 筆K線，最新收盤: ${closes.at(-1)?.toFixed(2)}` : `⚠ 無資料`;
  } catch(e) { results.yahooChart = "❌ " + e.message; }

  // 4. FinMind（三大法人/融資用）
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const today = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now()-14*24*60*60*1000).toISOString().split("T")[0];
    const r = await fetchWithTimeout(
      `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=2330&start_date=${start}&end_date=${today}&token=${token}`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      8000
    );
    const d = await r.json();
    const rows = d?.data || [];
    results.finmind = rows.length ? `✅ 三大法人 ${rows.length} 筆，token=${token?"有":"無"}` : `⚠ 無資料 msg=${d?.msg||""} token=${token?"有":"無"}`;
  } catch(e) { results.finmind = "❌ " + e.message; }

  res.json({ time: new Date().toISOString(), apis: results });
});

// ── 股票搜尋 API（即時查 TWSE + FinMind）────────────────
let stockCache = null;
let stockCacheTime = 0;

async function getStockList() {
  // 快取 24 小時
  if (stockCache && Date.now() - stockCacheTime < 24*60*60*1000) {
    return stockCache;
  }
  let _partialResults = [];
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
  // Yahoo Finance v8 chart（包含即時行情 + 最近資料）
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.TW?interval=1d&range=5d`;
    const r = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      }
    }, 8000);
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (meta && meta.regularMarketPrice) {
      const price  = meta.regularMarketPrice;
      const prev   = meta.previousClose || meta.chartPreviousClose || price;
      const change = +(price - prev).toFixed(2);
      const changePct = prev > 0 ? +((change/prev)*100).toFixed(2) : 0;
      return {
        code,
        name:      meta.shortName || meta.longName || code,
        price,
        prev,
        change,
        changePct,
        open:      meta.regularMarketOpen   || price,
        high:      meta.regularMarketDayHigh|| price,
        low:       meta.regularMarketDayLow || price,
        volume:    Math.round((meta.regularMarketVolume || 0) / 1000),
        market:    "上市",
        time:      "",
      };
    }
  } catch(e) {}

  // Fallback: Yahoo v7 quote
  try {
    const r = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${code}.TW`,
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" } },
      6000
    );
    const data = await r.json();
    const q = (data?.quoteResponse?.result || [])[0];
    if (q && q.regularMarketPrice) {
      const price  = q.regularMarketPrice;
      const prev   = q.regularMarketPreviousClose || price;
      const change = +(q.regularMarketChange || 0).toFixed(2);
      const changePct = +((q.regularMarketChangePercent || 0)).toFixed(2);
      return {
        code, name: q.shortName || q.longName || code,
        price, prev, change, changePct,
        open: q.regularMarketOpen || price, high: q.regularMarketDayHigh || price,
        low: q.regularMarketDayLow || price,
        volume: Math.round((q.regularMarketVolume || 0) / 1000),
        market: "上市", time: "",
      };
    }
  } catch(e) {}

  // Fallback: TWSE 即時行情
  try {
    for (const mkt of ["tse", "otc"]) {
      const r = await fetchWithTimeout(
        `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${mkt}_${code}.tw&json=1&delay=0`,
        { headers: { "Referer": "https://mis.twse.com.tw/", "User-Agent": "Mozilla/5.0" } },
        5000
      );
      const data = await r.json();
      const item = (data?.msgArray || [])[0];
      if (!item || !item.z || item.z === "-") continue;
      const price  = parseFloat(item.z) || 0;
      const prev   = parseFloat(item.y) || 0;
      const change = +(price - prev).toFixed(2);
      const changePct = prev > 0 ? +((change/prev)*100).toFixed(2) : 0;
      return {
        code, name: item.n || code, price, prev, change, changePct,
        open: parseFloat(item.o)||0, high: parseFloat(item.h)||0, low: parseFloat(item.l)||0,
        volume: parseInt((item.v||"0").replace(/,/g,""))||0,
        market: mkt === "tse" ? "上市" : "上櫃", time: item.t||"",
      };
    }
  } catch(e) {}
  return null;
}

async function getHistoryCached(code, days = 400) {
  const cacheKey = `history:${code}:${days}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  if (IN_FLIGHT.has(cacheKey)) return IN_FLIGHT.get(cacheKey);
  const promise = getHistory(code, days).then(data => {
    if (data && data.length) setCache(cacheKey, data, CACHE_TTL.history);
    IN_FLIGHT.delete(cacheKey);
    return data;
  }).catch(e => { IN_FLIGHT.delete(cacheKey); throw e; });
  IN_FLIGHT.set(cacheKey, promise);
  return promise;
}

async function getHistory(code, days = 400) {
  // 優先用 Yahoo Finance chart（不需 token，全球可存取）
  try {
    const range = days <= 120 ? "6mo" : days <= 250 ? "1y" : "2y";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.TW?interval=1d&range=${range}`;
    const r = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
      }
    }, 10000);
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("no result");
    const timestamps = result.timestamps || result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const opens   = q.open   || [];
    const highs   = q.high   || [];
    const lows    = q.low    || [];
    const closes  = q.close  || [];
    const volumes = q.volume || [];
    if (!closes.length) throw new Error("no closes");
    return timestamps.map((ts, i) => ({
      date:   new Date(ts * 1000).toISOString().split("T")[0],
      open:   +(opens[i]   || closes[i] || 0).toFixed(2),
      high:   +(highs[i]   || closes[i] || 0).toFixed(2),
      low:    +(lows[i]    || closes[i] || 0).toFixed(2),
      close:  +(closes[i]  || 0).toFixed(2),
      volume: Math.round((volumes[i] || 0) / 1000), // 轉換成張
    })).filter(d => d.close > 0);
  } catch(e) {}

  // Fallback: FinMind（需要 token，但有備用）
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const end   = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - days*24*60*60*1000).toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 10000);
    const data = await r.json();
    return (data?.data || []).map(d => ({
      date:   d.date,
      open:   parseFloat(d.open),
      high:   parseFloat(d.max),
      low:    parseFloat(d.min),
      close:  parseFloat(d.close),
      volume: parseInt(d.Trading_Volume / 1000),
    }));
  } catch(e) {}
  return [];
}

// ── FinMind 三大法人 ──────────────────────────────────────
async function getChip(code) {
  const _ck = `chip:${code}`;
  const _c = getCache(_ck);
  if (_c !== null) return Promise.resolve(_c);
  if (IN_FLIGHT.has(_ck)) return IN_FLIGHT.get(_ck);
  const _p = getChipInner(code).then(d => {
    if (d) setCache(_ck, d, CACHE_TTL.chip);
    IN_FLIGHT.delete(_ck); return d;
  }).catch(e => { IN_FLIGHT.delete(_ck); return null; });
  IN_FLIGHT.set(_ck, _p);
  return _p;
}
async function getChipInner(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const start = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 8000);
    const data = await r.json();
    const rows = data?.data || [];
    if (!rows.length) return null;

    // 取最近有資料的5個交易日（自動回退，不限今日）
    const dates = [...new Set(rows.map(r => r.date))].sort().slice(-5);
    const recent = rows.filter(r => dates.includes(r.date));
    const latestDate = dates.at(-1);
    const latest = rows.filter(r => r.date === latestDate);
    // 計算買賣超（buy - sell）
    // FinMind name 欄位是英文
    // Foreign_Investor, Foreign_Dealer_Self = 外資
    // Investment_Trust = 投信
    // Dealer_self, Dealer_Hedging = 自營商
    const sumNet = (keywords, arr) => arr
      .filter(r => keywords.some(k => r.name && r.name.includes(k)))
      .reduce((s, r) => s + (parseInt(r.buy||0) - parseInt(r.sell||0)), 0);

    // 計算連買天數
    const countConsecBuy = (keywords) => {
      let days = 0;
      for (const d of [...dates].reverse()) {
        const dayRows = rows.filter(r => r.date === d);
        const net = sumNet(keywords, dayRows);
        if (net > 0) days++;
        else break;
      }
      return days;
    };

    return {
      date: dates.at(-1),
      foreign5:    sumNet(["Foreign_Investor", "Foreign_Dealer_Self"], recent),
      foreign1:    sumNet(["Foreign_Investor", "Foreign_Dealer_Self"], latest),
      site5:       sumNet(["Investment_Trust"], recent),
      site1:       sumNet(["Investment_Trust"], latest),
      dealer5:     sumNet(["Dealer_self", "Dealer_Hedging"], recent),
      dealer1:     sumNet(["Dealer_self", "Dealer_Hedging"], latest),
      foreignDays: countConsecBuy(["Foreign_Investor", "Foreign_Dealer_Self"]),
      siteDays:    countConsecBuy(["Investment_Trust"]),
    };
  } catch(e) { console.error("chip error:", e); return null; }
}

// ── FinMind 融資融券 ──────────────────────────────────────
async function getMargin(code) {
  const _ck = `margin:${code}`;
  const _c = getCache(_ck);
  if (_c !== null) return Promise.resolve(_c);
  if (IN_FLIGHT.has(_ck)) return IN_FLIGHT.get(_ck);
  const _p = getMarginInner(code).then(d => {
    if (d) setCache(_ck, d, CACHE_TTL.margin);
    IN_FLIGHT.delete(_ck); return d;
  }).catch(e => { IN_FLIGHT.delete(_ck); return null; });
  IN_FLIGHT.set(_ck, _p);
  return _p;
}
async function getMarginInner(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    // 抓30天確保有資料（自動回退到最新公布日）
    const start = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMarginPurchaseShortSale&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 8000);
    const data = await r.json();
    const rows = data?.data || [];
    if (rows.length < 2) return null;
    // 取最新有資料的日期（自動回退）
    const latestDate = rows.at(-1).date;
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
  const _ck = `fund:${code}`;
  const _c = getCache(_ck);
  if (_c !== null) return Promise.resolve(_c);
  if (IN_FLIGHT.has(_ck)) return IN_FLIGHT.get(_ck);
  const _p = getFundamentalsInner(code).then(d => {
    if (d) setCache(_ck, d, CACHE_TTL.fundamentals);
    IN_FLIGHT.delete(_ck); return d;
  }).catch(e => { IN_FLIGHT.delete(_ck); return null; });
  IN_FLIGHT.set(_ck, _p);
  return _p;
}
async function getFundamentalsInner(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const start = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPER&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 8000);
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
  const _ck = `rev:${code}`;
  const _c = getCache(_ck);
  if (_c !== null) return Promise.resolve(_c);
  if (IN_FLIGHT.has(_ck)) return IN_FLIGHT.get(_ck);
  const _p = getRevenueInner(code).then(d => {
    if (d) setCache(_ck, d, CACHE_TTL.revenue);
    IN_FLIGHT.delete(_ck); return d;
  }).catch(e => { IN_FLIGHT.delete(_ck); return null; });
  IN_FLIGHT.set(_ck, _p);
  return _p;
}
async function getRevenueInner(code) {
  try {
    const token = process.env.FINMIND_TOKEN || "";
    const start = new Date(Date.now() - 365*24*60*60*1000).toISOString().split("T")[0];
    const end = new Date().toISOString().split("T")[0];
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${code}&start_date=${start}&end_date=${end}&token=${token}`;
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 8000);
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

// ── 主分析 API ────────────────────────────────────────────
// ── 熱門股掃描 API ───────────────────────────────────────
// 固定熱門股清單（台股市值前30大 + 常見ETF）
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

app.get("/scan", async (req, res) => {
  const mode = req.query.mode || "volume";
  const limit = Math.min(parseInt(req.query.limit || 20), 20); // 降到 20，保護 Render 免費版

  // 整體掃描 cache（3 分鐘內不重複算）
  const scanCacheKey = `scan:${mode}:${limit}`;
  const scanCached = getCache(scanCacheKey);
  if (scanCached) {
    console.log(`/scan cache hit: ${scanCacheKey}`);
    return res.json({ ...scanCached, cached: true });
  }
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (rateLimit(ip, 5, 60000)) { // scan 每分鐘最多 5 次
    return res.status(429).json({ error: "掃描請求過於頻繁，請稍後再試" });
  }

  // Claude API key 非必要（沒有就跳過 AI 建議）
  const key = process.env.ANTHROPIC_API_KEY;

  // 記錄活動時間（供背景預熱判斷）
  _lastScanActivity = Date.now();
  // Render 免費版 30s timeout 保護
  const scanDeadline = Date.now() + 25000; // 25s 截止
  const checkDeadline = () => { if (Date.now() > scanDeadline) throw new Error("scan timeout"); };

  try {
    const token = process.env.FINMIND_TOKEN || "";
    const today = new Date().toISOString().split("T")[0];
    const weekAgo = new Date(Date.now()-14*24*60*60*1000).toISOString().split("T")[0]; // 14天確保有資料

    // 批次抓熱門股（每批 10 支，避免 FinMind rate limit）
    const batchFetch = async (list, fn) => {
      const results = [];
      for (let i = 0; i < list.length; i += 10) {
        const batch = list.slice(i, i + 10);
        const batchRes = await Promise.allSettled(batch.map(fn));
        batchRes.forEach(r => results.push(r.status === 'fulfilled' ? r.value : null));
        if (i + 10 < list.length) { checkDeadline(); await new Promise(r => setTimeout(r, 200)); } // 批次間隔 300ms
      }
      return results;
    };

    // 並行抓所有熱門股最新價格
    // ── 抓即時/最新股價 ────────────────────────────────────
    // 策略：先試 TWSE 即時行情，失敗或非交易時段 fallback 到 FinMind 歷史資料

    // Yahoo Finance 批次查詢（免費、無需 token、全球都能存取）
    const fetchYahooBatch = async (codes) => {
      // Yahoo Finance 台股代號格式：2330.TW, 00878.TW
      const symbols = codes.map(c => c + ".TW").join(",");
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketChange,regularMarketChangePercent,regularMarketVolume,shortName,longName`;
      try {
        const r = await fetchWithTimeout(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
          }
        }, 10000);
        const data = await r.json();
        const quotes = data?.quoteResponse?.result || [];
        return quotes.map(q => {
          const code = (q.symbol || "").replace(".TW","");
          const price = q.regularMarketPrice || 0;
          if (!price) return null;
          const prev   = q.regularMarketPreviousClose || price;
          const change = +(q.regularMarketChange || 0).toFixed(2);
          const changePct = ((q.regularMarketChangePercent || 0)).toFixed(2);
          const s = SCAN_STOCKS.find(s => s.code === code);
          return {
            code,
            name: s?.name || q.shortName || q.longName || code,
            price,
            change,
            changePct: changePct + "%",
            volume: Math.round((q.regularMarketVolume || 0) / 1000), // 轉張
            isRealtime: true,
          };
        }).filter(Boolean);
      } catch(e) {
        console.error("[Yahoo] error:", e.message);
        return [];
      }
    };

    // TWSE 備用（若 Yahoo 失敗）
    const fetchTWSEBatch = async (codes) => {
      const exch = codes.map(c => `tse_${c}.tw`).join("|");
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0`;
      try {
        const r = await fetchWithTimeout(url, {
          headers: { "Referer": "https://mis.twse.com.tw/", "User-Agent": "Mozilla/5.0" }
        }, 8000);
        const data = await r.json();
        return (data?.msgArray || []).map(item => {
          const price = parseFloat(item.z !== "-" ? item.z : item.y) || 0;
          if (!price) return null;
          const prev = parseFloat(item.y) || price;
          const change = +(price - prev).toFixed(2);
          const changePct = prev > 0 ? ((change/prev)*100).toFixed(2) : "0";
          const s = SCAN_STOCKS.find(s => s.code === item.c);
          return {
            code: item.c,
            name: item.n || s?.name || item.c,
            price, change,
            changePct: changePct + "%",
            volume: parseInt((item.v||"0").replace(/,/g,"")) || 0,
            isRealtime: item.z !== "-",
          };
        }).filter(Boolean);
      } catch(e) {
        console.error("[TWSE] error:", e.message);
        return [];
      }
    };

    // FinMind fallback：抓最近一個交易日收盤價
    const fetchFinMindPrice = async (s) => {
      const cacheKey = `price:${s.code}`;
      const cached = getCache(cacheKey);
      if (cached) return cached;
      try {
        const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${s.code}&start_date=${weekAgo}&end_date=${today}&token=${token}`;
        const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 8000);
        const data = await r.json();
        const rows = (data?.data || []);
        if (!rows.length) return null;
        const latest = rows.at(-1);
        const prev   = rows.at(-2) || latest;
        const price  = parseFloat(latest.close) || 0;
        if (!price) return null;
        const prevP  = parseFloat(prev.close) || price;
        const change = +(price - prevP).toFixed(2);
        const changePct = prevP > 0 ? ((change/prevP)*100).toFixed(2) : "0";
        const result = {
          code: s.code, name: s.name, price, change,
          changePct: changePct + "%",
          volume: parseInt((latest.Trading_Volume||0) / 1000) || 0,
          isRealtime: false,
        };
        setCache(cacheKey, result, 10 * 60 * 1000); // 10 分鐘
        return result;
      } catch(e) { return null; }
    };

    // 股價抓取：Yahoo Finance（主）→ TWSE（備）→ FinMind（最後）
    // Yahoo Finance 批次一次查所有
    const allCodes = SCAN_STOCKS.map(s => s.code);
    let yahooResults = await fetchYahooBatch(allCodes);
    console.log(`[scan] Yahoo: ${yahooResults.length}/${allCodes.length} stocks`);
    const priceMap = new Map(yahooResults.map(s => [s.code, s]));

    // Yahoo 沒抓到的 → 試 TWSE
    const missingTWSE = SCAN_STOCKS.filter(s => !priceMap.has(s.code));
    if (missingTWSE.length > 0) {
      console.log(`[scan] TWSE fallback for ${missingTWSE.length} stocks`);
      const twseResults = await fetchTWSEBatch(missingTWSE.map(s => s.code));
      console.log(`[scan] TWSE got: ${twseResults.length}`);
      twseResults.forEach(s => { if (s) priceMap.set(s.code, s); });
    }

    // 還是沒有的 → FinMind fallback
    const missingFM = SCAN_STOCKS.filter(s => !priceMap.has(s.code));
    if (missingFM.length > 0) {
      console.log(`[scan] FinMind fallback for ${missingFM.length} stocks`);
      const fmResults = await batchFetch(missingFM, fetchFinMindPrice);
      const fmGot = fmResults.filter(Boolean).length;
      console.log(`[scan] FinMind got: ${fmGot}`);
      fmResults.forEach(s => { if (s) priceMap.set(s.code, s); });
    }

    const priceList = SCAN_STOCKS.map(s => priceMap.get(s.code) || null);

    let stocks = priceList.filter(s => s && s.price > 0);
    console.log(`[scan] final stocks: ${stocks.length}`);
    if (!stocks.length) {
      return res.json({ error: "無法取得股價資料，可能是盤後時段或網路問題，請稍後再試" });
    }

    // 排序
    if (mode === "change") {
      stocks.sort((a,b) => parseFloat(b.changePct) - parseFloat(a.changePct));
    } else {
      stocks.sort((a,b) => b.volume - a.volume);
    }
    stocks = stocks.slice(0, limit);

    // 批次抓各股詳細資料（技術+籌碼+融資+基本面+營收）
    checkDeadline(); // 確保還在 25s 內
    const results = await batchFetch(stocks, async (stock) => {
      try {
        // Scan lightweight mode：
        // - history 永遠抓（技術面需要）
        // - chip/margin/fund/rev：cache 有就用，cache miss 就 skip（不打 API）
        //   避免 20 支股票 × 4 API = 80 calls 超過 FinMind rate limit 或 25s deadline
        const skipIfNoCached = (key) => {
          const ck = getCache(key);
          return ck !== null ? Promise.resolve(ck) : Promise.resolve(null);
        };
        const [histR, chipR, marginR, fundR, revR] = await Promise.allSettled([
          getHistoryCached(stock.code, 120), // scan 只需 120 天，夠算 MA60/RSI
          skipIfNoCached(`chip:${stock.code}`),
          skipIfNoCached(`margin:${stock.code}`),
          skipIfNoCached(`fund:${stock.code}`),
          skipIfNoCached(`rev:${stock.code}`),
        ]);
        const hist         = histR.status  === 'fulfilled' ? histR.value  : [];
        const chip         = chipR.status  === 'fulfilled' ? chipR.value  : null;
        const margin       = marginR.status === 'fulfilled' ? marginR.value : null;
        const fundamentals = fundR.status  === 'fulfilled' ? fundR.value  : null;
        const revenue      = revR.status   === 'fulfilled' ? revR.value   : null;
        const ind = calcIndicators(hist, stock.price);
        const scored = calcStockScore(ind, chip, margin, fundamentals, revenue, hist, stock.price);
        return {
          ...stock,
          direction: ind.direction || "—",
          bull: ind.bull || 0,
          bear: ind.bear || 0,
          rsi: ind.rsi,
          maTrend: ind.maTrend || "—",
          macd: ind.macd,
          macdHist: ind.macdHist,
          volTrend: ind.volTrend || "—",
          // 評分系統
          score:       scored.score,
          grade:       scored.grade,
          gradeColor:  scored.gradeColor,
          scoreDetail: scored.detail,
          // 各面向分數
          fundScore:   scored.detail._fund  || 0,
          techScore:   scored.detail._tech  || 0,
          volScore:    scored.detail._vol   || 0,
          chipScore:   scored.detail._chip  || 0,
          marginScore: scored.detail._margin|| 0,
          themeScore:  scored.detail._theme || 0,
        };
      } catch(e) {
        return { ...stock, direction: "—", bull: 0, bear: 0, score: 0, grade: "資料不足", gradeColor: "#374151" };
      }
    });
    
    // 依評分由高到低重新排序
    results.sort((a, b) => b.score - a.score);
    _partialResults = results; // 供 timeout catch 使用

    // 用 Claude 快速產生一句話結論（沒有 key 就跳過）
    if (!key) {
      const final = results.map(s => ({ ...s, suggestion: s.grade || "觀察中" }));
      const respData = { mode, stocks: final, time: new Date().toISOString(), _v: "scoring-v3" };
      setCache(scanCacheKey, respData, CACHE_TTL.scan);
      res.json(respData);
      // 背景預載籌碼
      setImmediate(async () => {
        for (const s of final.slice(0, 10)) {
          try {
            await Promise.allSettled([getChip(s.code), getMargin(s.code), getFundamentals(s.code), getRevenue(s.code)]);
            await new Promise(r => setTimeout(r, 500));
          } catch(e) {}
        }
      });
      return;
    }
    const prompt = `你是台股職業交易員，根據以下${limit}支熱門股評分資料，每支給出一句話操作建議（15字內），格式：代號|建議

${
      results.map(s => 
        `${s.code} ${s.name}：${s.score}分/${s.grade} 價${s.price} ${s.changePct} RSI${s.rsi||"—"} ${s.maTrend} 法人${s.chipScore}分 技術${s.techScore}分`
      ).join("\n")
    }

請逐行輸出，格式：代號|一句話建議（要符合評分等級，強勢股說強勢，不建議股說風險）`;

    const aiRes = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
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
    aiText.split("\n").forEach(line => {
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

    const respData = { mode, stocks: final, time: new Date().toISOString(), _v: "scoring-v3" };
    setCache(scanCacheKey, respData, CACHE_TTL.scan);
    res.json(respData);

    // 背景非同步預載籌碼資料（不阻塞回應）
    // 下次 scan 時 cache 已有籌碼，評分會完整
    setImmediate(async () => {
      for (const s of final.slice(0, 10)) { // 只預載前 10 支
        try {
          await Promise.allSettled([
            getChip(s.code),
            getMargin(s.code),
            getFundamentals(s.code),
            getRevenue(s.code),
          ]);
          await new Promise(r => setTimeout(r, 500)); // 每支間隔 500ms，避免 rate limit
        } catch(e) {}
      }
    });

  } catch(e) {
    console.error("scan error:", e.message);
    if (e.message === 'scan timeout') {
      const partial = (_partialResults || []).filter(s => s && s.score != null);
      if (partial.length > 0) {
        return res.json({ mode, stocks: partial, error: "掃描逾時（部分結果）", time: new Date().toISOString() });
      }
      return res.json({ mode, stocks: [], error: "掃描逾時，請重試（後端冷啟動中）", time: new Date().toISOString() });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post("/analyze", async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (rateLimit(ip, 10, 60000)) { // 每分鐘最多 10 次分析
    return res.status(429).json({ error: "請求過於頻繁，請稍後再試" });
  }
  const { code: rawCode } = req.body;
  if (!rawCode) return res.status(400).json({ error: "Missing code" });
  // 只允許股票代號格式（4-6 碼英數）
  const code = String(rawCode).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
  if (!code) return res.status(400).json({ error: "Invalid code" });
  const key = process.env.ANTHROPIC_API_KEY;

  try {
    // 並行抓所有資料（history 用 cache）
    const [qR, hR, cR, mR, fR, rR] = await Promise.allSettled([
      getQuote(code),
      getHistoryCached(code),
      getChip(code),
      getMargin(code),
      getFundamentals(code),
      getRevenue(code),
    ]);
    const quote        = qR.status === 'fulfilled' ? qR.value : null;
    const history      = hR.status === 'fulfilled' ? (hR.value || []) : [];
    const chip         = cR.status === 'fulfilled' ? cR.value : null;
    const margin       = mR.status === 'fulfilled' ? mR.value : null;
    const fundamentals = fR.status === 'fulfilled' ? fR.value : null;
    const revenue      = rR.status === 'fulfilled' ? rR.value : null;

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

// ── Cache 統計 endpoint（debug 用）───────────────────────
app.get("/cache-stats", (req, res) => {
  // 不回傳 keys（避免洩漏哪些股票代號被查詢）
  res.json({
    cacheSize:    CACHE.size,
    inFlightSize: IN_FLIGHT.size,
    ratestoreSize:RATE_STORE.size,
    uptime:       Math.floor(process.uptime()) + "s",
    memory:       Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
  });
});

// ── 清除 cache endpoint──────────────────────────────────
app.post("/cache-clear", (req, res) => {
  // 需要 admin token 才能清除 cache
  const adminToken = process.env.ADMIN_TOKEN;
  const provided   = req.headers["x-admin-token"] || req.body?.token;
  if (!adminToken || provided !== adminToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const before = CACHE.size;
  CACHE.clear();
  IN_FLIGHT.clear();
  res.json({ ok: true, cleared: before });
});

// ── Process hardening ───────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason?.message || reason);
  // 不崩潰，記錄即可
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
  // uncaughtException 後狀態不確定，給 1s 讓 Render 看到 log 再重啟
  setTimeout(() => process.exit(1), 1000);
});

// Graceful shutdown（Render deploy 時會送 SIGTERM）
const server = app.listen(PORT, () => {
  console.log(`台股AI後端啟動 port ${PORT}`);
  console.log(`Cache TTL: history=${CACHE_TTL.history/1000}s, scan=${CACHE_TTL.scan/1000}s`);
});

function gracefulShutdown(signal) {
  console.log(`[${signal}] Graceful shutdown...`);
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
  // 若 10s 內沒關完，強制結束
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

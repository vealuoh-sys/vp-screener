const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const TG_TOKEN = '8792428538:AAEEVMRVjeR7PytpTeSDGm3morZQ20QGaEw';
const TG_CHAT = '8137954593';

const SCAN_PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','AVAXUSDT','DOGEUSDT','DOTUSDT','MATICUSDT',
  'LINKUSDT','ATOMUSDT','LTCUSDT','UNIUSDT','AAVEUSDT',
  'NEARUSDT','FILUSDT','ARBUSDT','OPUSDT','INJUSDT',
  'SUIUSDT','APTUSDT','TIAUSDT','FETUSDT','RUNEUSDT',
  'STXUSDT','IMXUSDT','SANDUSDT','MANAUSDT','AXSUSDT',
  'FTMUSDT','ALGOUSDT','GALAUSDT','APEUSDT','GMTUSDT',
  'EGLDUSDT','CRVUSDT','MKRUSDT','SNXUSDT','COMPUSDT',
  'YFIUSDT','SUSHIUSDT','GRTUSDT','ENSUSDT','LDOUSDT',
  'DYDXUSDT','GMXUSDT','CAKEUSDT','XLMUSDT','VETUSDT'
];

const TF_MAP = { '1h':'1h','4h':'4h','1d':'1d' };

let scanCache = { signals: [], scanned: 0, ts: null };
let alertedSignals = new Set();

// ── Telegram ──────────────────────────────────────────────────────
function sendTelegram(message) {
  return new Promise((resolve) => {
    const text = encodeURIComponent(message);
    const reqUrl = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT}&text=${text}&parse_mode=HTML`;
    https.get(reqUrl, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve());
    }).on('error', () => resolve());
  });
}

function alertSignal(sig) {
  const key = `${sig.symbol}-${sig.type}-${sig.tf}`;
  if (alertedSignals.has(key)) return;
  alertedSignals.add(key);
  const emoji = sig.type==='VAH'?'🚀':sig.type==='VAL'?'🟢':'🎯';
  const label = sig.type==='VAH'?'VAH BREAK ▲':sig.type==='VAL'?'VAL RECLAIM ▼':'POC REACT ◆';
  const msg = `${emoji} <b>VP SIGNAL</b>\n\n<b>${sig.symbol}</b> — ${label}\n⏱ TF: <b>${sig.tf.toUpperCase()}</b>\n💰 Price: <b>$${sig.price.toFixed(6)}</b>\n\n📊 Levels:\n🔴 VAH: $${sig.vp.vah.toFixed(6)}\n🟡 POC: $${sig.vp.poc.toFixed(6)}\n🟢 VAL: $${sig.vp.val.toFixed(6)}\n💪 Strength: ${sig.strength}%\n\n🌐 vp-screener.up.railway.app`;
  sendTelegram(msg).catch(console.error);
}

// ── Binance fetch — tries multiple endpoints including futures & data CDN ──
function fetchBinance(reqPath) {
  // Priority order: data.binance.com (CDN, least restricted), then spot mirrors
  const endpoints = [
    { hostname: 'data-api.binance.vision', path: reqPath },          // Public data CDN (no geo-block)
    { hostname: 'api.binance.com',          path: reqPath },          // Primary spot
    { hostname: 'api1.binance.com',         path: reqPath },          // Spot mirror 1
    { hostname: 'api2.binance.com',         path: reqPath },          // Spot mirror 2
    { hostname: 'api3.binance.com',         path: reqPath },          // Spot mirror 3
    { hostname: 'api4.binance.com',         path: reqPath },          // Spot mirror 4
  ];

  function tryEndpoint(idx) {
    if (idx >= endpoints.length) return Promise.reject(new Error('All Binance endpoints failed'));
    const ep = endpoints[idx];
    return new Promise((resolve, reject) => {
      const options = {
        hostname: ep.hostname,
        path: ep.path,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VPScreener/1.0)',
          'Accept': 'application/json',
          'Connection': 'keep-alive'
        },
        timeout: 15000
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        // Handle gzip if needed
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              console.log(`[OK-HOST] ${ep.hostname}`);
              resolve(parsed);
            } else if (parsed && parsed.code) {
              // Binance error response
              console.log(`[WARN] ${ep.hostname} error: ${parsed.msg}`);
              tryEndpoint(idx + 1).then(resolve).catch(reject);
            } else {
              tryEndpoint(idx + 1).then(resolve).catch(reject);
            }
          } catch(e) {
            console.log(`[WARN] ${ep.hostname} parse error: ${e.message}`);
            tryEndpoint(idx + 1).then(resolve).catch(reject);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        console.log(`[TIMEOUT] ${ep.hostname}`);
        tryEndpoint(idx + 1).then(resolve).catch(reject);
      });

      req.on('error', (err) => {
        console.log(`[ERR] ${ep.hostname}: ${err.message}`);
        tryEndpoint(idx + 1).then(resolve).catch(reject);
      });

      req.end();
    });
  }

  return tryEndpoint(0);
}

async function fetchKlines(symbol, interval, limit) {
  limit = limit || 100;
  // /api/v3/klines works on data-api.binance.vision too
  const reqPath = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await fetchBinance(reqPath);
  return raw.map(k => ({
    time:    parseInt(k[0]),
    open:    parseFloat(k[1]),
    high:    parseFloat(k[2]),
    low:     parseFloat(k[3]),
    close:   parseFloat(k[4]),
    volume:  parseFloat(k[5]),
    typical: (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3
  }));
}

// ── Volume Profile ────────────────────────────────────────────────
function calcVolumeProfile(candles) {
  if (!candles || candles.length < 10) return null;
  let lo = Infinity, hi = -Infinity;
  candles.forEach(c => {
    if (c.high > hi) hi = c.high;
    if (c.low  < lo) lo = c.low;
  });
  const range = hi - lo;
  if (range === 0) return null;

  const BINS = 24;
  const binSize = range / BINS;
  const vol = new Array(BINS).fill(0);
  candles.forEach(c => {
    const idx = Math.min(Math.floor((c.typical - lo) / binSize), BINS - 1);
    vol[idx] += c.volume;
  });

  let pocIdx = 0;
  vol.forEach((v, i) => { if (v > vol[pocIdx]) pocIdx = i; });
  const poc = lo + (pocIdx + 0.5) * binSize;

  const totalVol = vol.reduce((a, b) => a + b, 0);
  const target = totalVol * 0.70;
  let vaVol = vol[pocIdx], vaLo = pocIdx, vaHi = pocIdx;
  while (vaVol < target) {
    const nextLo = vaLo > 0       ? vol[vaLo - 1] : 0;
    const nextHi = vaHi < BINS-1  ? vol[vaHi + 1] : 0;
    if (nextLo >= nextHi && vaLo > 0) { vaLo--; vaVol += nextLo; }
    else if (vaHi < BINS - 1)         { vaHi++; vaVol += nextHi; }
    else break;
  }
  return {
    poc,
    vah: lo + (vaHi + 1) * binSize,
    val: lo + vaLo * binSize,
    hi, lo
  };
}
// --- RSI Calculation ---
function calcRSI(candles, period = 14) {
  if (candles.length <= period) return new Array(candles.length).fill(50);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    let diff = candles[i].close - candles[i-1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsi = new Array(candles.length).fill(null);
  
  for (let i = period + 1; i < candles.length; i++) {
    let diff = candles[i].close - candles[i-1].close;
    let gain = diff > 0 ? diff : 0;
    let loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsi;
}

// --- Divergence Detection ---
function checkDivergence(candles, rsi) {
  const curr = candles.length - 1;
  const prev = curr - 5; // Look back a few candles for a peak/valley
  
  // Bearish Divergence: Price Higher High, RSI Lower High
  const priceHH = candles[curr].high > candles[prev].high;
  const rsiLH = rsi[curr] < rsi[prev];
  
  // Bullish Divergence: Price Lower Low, RSI Higher Low
  const priceLL = candles[curr].low < candles[prev].low;
  const rsiHL = rsi[curr] > rsi[prev];

  if (priceHH && rsiLH) return 'BEARISH';
  if (priceLL && rsiHL) return 'BULLISH';
  return null;
}

ffunction detectSignals(symbol, candles, tf) {
  const vpCandles = candles.slice(0, -1);
  const vp = calcVolumeProfile(vpCandles);
  if (!vp) return [];
  
  const rsi = calcRSI(candles);
  const div = checkDivergence(candles, rsi);
  const curr = candles.length - 1;
  const cur = candles[curr];
  const prev = candles[curr - 1];
  const price = cur.close;

  // --- NEW: Whale Volume Logic ---
  const last10Vol = candles.slice(-11, -1).reduce((sum, c) => sum + c.volume, 0) / 10;
  const rvol = cur.volume / (last10Vol || 1); 
  const isWhale = rvol > 1.8; // 1.8x more volume than usual = Whale!

  const signals = [];

  // VAH Break
  if (prev.close <= vp.vah && cur.close > vp.vah) {
    let type = (div === 'BEARISH') ? 'WARNING' : 'VAH';
    let strength = (div === 'BEARISH') ? 20 : (isWhale ? 90 : 60);
    signals.push({ symbol, type, price, vp, strength, tf, rvol, whale: isWhale });
  }

  // VAL Reclaim
  if (prev.close < vp.val && cur.close >= vp.val) {
    let type = (div === 'BULLISH') ? 'VAL_DIV' : 'VAL';
    let strength = (div === 'BULLISH' && isWhale) ? 98 : (isWhale ? 85 : 55);
    signals.push({ symbol, type, price, vp, strength, tf, rvol, whale: isWhale });
  }

  // POC React
  if (cur.low <= vp.poc * 1.003 && cur.close > vp.poc) {
    let type = (div === 'POC_DIV' : 'POC');
    let strength = (isWhale) ? 80 : 50;
    signals.push({ symbol, type, price, vp, strength, tf, rvol, whale: isWhale });
  }

  return signals;
}
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function runBackgroundScan() {
  const tfs = Object.keys(TF_MAP);
  const rawSignals = [];
  let scanned = 0;
  const jobs = [];
  for (const sym of SCAN_PAIRS) for (const tf of tfs) jobs.push({ sym, tf });

  console.log(`[SCAN START] ${jobs.length} jobs`);

  const CONCURRENCY = 3; // Lowered to reduce rate-limit risk
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ sym, tf }) => {
      try {
        const candles = await fetchKlines(sym, TF_MAP[tf], 100);
        const sigs = detectSignals(sym, candles, tf);
        sigs.forEach(s => alertSignal(s));
        rawSignals.push(...sigs);
        scanned++;
        console.log(`[OK] ${sym}/${tf}`);
      } catch(e) {
        console.log(`[WARN] ${sym}/${tf}: ${e.message}`);
      }
    }));
    await new Promise(r => setTimeout(r, 500)); // Small delay between batches
  }

  // --- START: The Golden Setup Sorting ---
  const grouped = {};
  rawSignals.forEach(s => {
    if (!grouped[s.symbol]) grouped[s.symbol] = [];
    grouped[s.symbol].push(s);
  });

  const finalSignals = [];
  for (const sym in grouped) {
    const coinSigs = grouped[sym];
    const isGolden = coinSigs.length > 1; // It's Golden if we have 1h AND 4h signals

    coinSigs.forEach(s => {
      if (isGolden) {
        s.confluence = true; 
        s.strength = Math.min(100, s.strength + 15); // Bonus boost!
      }
      finalSignals.push(s);
    });
  }
  // --- END: The Golden Setup Sorting --
  alertedSignals.clear();
  console.log(`[SCAN DONE] ${scanned} scanned, ${allSignals.length} signals`);
  sendTelegram(`📊 <b>Scan Complete</b>\n${scanned} coins scanned\n🔔 ${allSignals.length} signals found!`).catch(()=>{});
}

// ── HTTP Server ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath));
  }

  if (pathname === '/api/scan') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      scanned:  scanCache.scanned,
      signals:  scanCache.signals,
      ts:       scanCache.ts || new Date().toISOString()
    }));
  }

  if (pathname === '/api/candles') {
    const symbol   = (parsed.query.symbol   || 'BTCUSDT').toUpperCase();
    const interval = parsed.query.interval  || '1h';
    try {
      const candles = await fetchKlines(symbol, interval, 100);
      const vp      = calcVolumeProfile(candles);
      
      // --- ADD THESE TWO LINES TO FIX THE FLAT RSI ---
      const rsiValues = calcRSI(candles); 
      candles.forEach((c, i) => c.rsi = rsiValues[i]); 
      // -----------------------------------------------

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, symbol, interval, candles, vp }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, cached: scanCache.scanned, ts: scanCache.ts }));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`VP SCREENER running on ${HOST}:${PORT}`);
  sendTelegram('🟢 <b>VP SCREENER ONLINE</b>\nConnecting via data-api.binance.vision...')
    .catch(()=>{});
  setTimeout(() => runBackgroundScan().catch(console.error), 3000);
  setInterval(() => runBackgroundScan().catch(console.error), 30 * 60 * 1000);
});

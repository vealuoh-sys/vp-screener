const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ── FIX 1: Secrets from environment variables, never hardcoded ────
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT  = process.env.TG_CHAT  || '';

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

let scanCache    = { signals: [], scanned: 0, ts: null };
let alertedSignals = new Set();

// ── FIX 2: Track scan state so /api/trigger-scan works properly ───
let scanInProgress = false;

// ── Telegram ──────────────────────────────────────────────────────
function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT) return Promise.resolve();
  return new Promise((resolve) => {
    const text   = encodeURIComponent(message);
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
  const emoji = sig.type === 'VAH' ? '🚀' : sig.type === 'VAL' || sig.type === 'VAL_DIV' ? '🟢' : sig.type === 'WARNING' ? '⚠️' : '🎯';
  const label = {
    VAH:'VAH BREAK ▲', VAL:'VAL RECLAIM ▼',
    POC:'POC REACT ◆', VAL_DIV:'VAL + BULL DIV 🔥',
    POC_DIV:'POC + BULL DIV 🔥', WARNING:'VAH FAKEOUT ⚠️'
  }[sig.type] || sig.type;
  const msg = `${emoji} <b>VP SIGNAL</b>\n\n<b>${sig.symbol}</b> — ${label}\n⏱ TF: <b>${sig.tf.toUpperCase()}</b>\n💰 Price: <b>$${sig.price.toFixed(6)}</b>\n\n📊 Levels:\n🔴 VAH: $${sig.vp.vah.toFixed(6)}\n🟡 POC: $${sig.vp.poc.toFixed(6)}\n🟢 VAL: $${sig.vp.val.toFixed(6)}\n💪 Strength: ${sig.strength}%`;
  sendTelegram(msg).catch(console.error);
}

// ── Binance fetch — tries multiple endpoints ───────────────────────
function fetchBinance(reqPath) {
  const endpoints = [
    { hostname: 'data-api.binance.vision', path: reqPath },
    { hostname: 'api.binance.com',          path: reqPath },
    { hostname: 'api1.binance.com',         path: reqPath },
    { hostname: 'api2.binance.com',         path: reqPath },
    { hostname: 'api3.binance.com',         path: reqPath },
    { hostname: 'api4.binance.com',         path: reqPath },
  ];

  function tryEndpoint(idx) {
    if (idx >= endpoints.length) return Promise.reject(new Error('All Binance endpoints failed'));
    const ep = endpoints[idx];
    return new Promise((resolve, reject) => {
      const options = {
        hostname: ep.hostname,
        path:     ep.path,
        method:   'GET',
        headers:  {
          'User-Agent': 'Mozilla/5.0 (compatible; VPScreener/1.0)',
          'Accept':     'application/json',
          'Connection': 'keep-alive'
        },
        timeout: 15000
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const raw    = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              console.log(`[OK] ${ep.hostname}`);
              resolve(parsed);
            } else if (parsed && parsed.code) {
              console.log(`[WARN] ${ep.hostname} error: ${parsed.msg}`);
              tryEndpoint(idx + 1).then(resolve).catch(reject);
            } else {
              tryEndpoint(idx + 1).then(resolve).catch(reject);
            }
          } catch(e) {
            console.log(`[WARN] ${ep.hostname} parse: ${e.message}`);
            tryEndpoint(idx + 1).then(resolve).catch(reject);
          }
        });
      });

      req.on('timeout', () => { req.destroy(); tryEndpoint(idx + 1).then(resolve).catch(reject); });
      req.on('error',   ()  => { tryEndpoint(idx + 1).then(resolve).catch(reject); });
      req.end();
    });
  }

  return tryEndpoint(0);
}

async function fetchKlines(symbol, interval, limit = 100) {
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

// ── Volume Profile ─────────────────────────────────────────────────
function calcVolumeProfile(candles) {
  if (!candles || candles.length < 10) return null;
  let lo = Infinity, hi = -Infinity;
  candles.forEach(c => { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; });
  const range = hi - lo;
  if (range === 0) return null;

  const BINS    = 24;
  const binSize = range / BINS;
  const vol     = new Array(BINS).fill(0);
  candles.forEach(c => {
    const idx = Math.min(Math.floor((c.typical - lo) / binSize), BINS - 1);
    vol[idx] += c.volume;
  });

  let pocIdx = 0;
  vol.forEach((v, i) => { if (v > vol[pocIdx]) pocIdx = i; });
  const poc = lo + (pocIdx + 0.5) * binSize;

  const totalVol = vol.reduce((a, b) => a + b, 0);
  const target   = totalVol * 0.70;
  let vaVol = vol[pocIdx], vaLo = pocIdx, vaHi = pocIdx;

  while (vaVol < target) {
    const nextLo = vaLo > 0      ? vol[vaLo - 1] : 0;
    const nextHi = vaHi < BINS-1 ? vol[vaHi + 1] : 0;
    if (nextLo >= nextHi && vaLo > 0) { vaLo--; vaVol += nextLo; }
    else if (vaHi < BINS - 1)         { vaHi++; vaVol += nextHi; }
    else break;
  }
  return { poc, vah: lo + (vaHi + 1) * binSize, val: lo + vaLo * binSize, hi, lo };
}

// ── FIX 3: RSI — proper Wilder smoothing, no nulls ────────────────
function calcRSI(candles, period = 14) {
  const rsi = new Array(candles.length).fill(50);
  if (candles.length <= period) return rsi;

  // Seed: simple average of first `period` changes
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) avgGain += diff;
    else          avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  // Wilder smoothing for the rest
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i]  = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  // Fill the warmup period with the first real value so no nulls reach the chart
  for (let i = 0; i < period; i++) rsi[i] = rsi[period];
  return rsi;
}

// ── FIX 4: Divergence — finds real swing highs/lows ───────────────
function findSwings(candles, lookback = 5) {
  const last = candles.length - 1;
  // Find the most recent swing high before the last candle
  let swingHighIdx = -1, swingLowIdx = -1;
  for (let i = last - 2; i >= Math.max(1, last - 30); i--) {
    if (swingHighIdx === -1 && candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high) {
      swingHighIdx = i;
    }
    if (swingLowIdx === -1 && candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low) {
      swingLowIdx = i;
    }
    if (swingHighIdx !== -1 && swingLowIdx !== -1) break;
  }
  return { swingHighIdx, swingLowIdx };
}

function checkDivergence(candles, rsi) {
  const curr = candles.length - 1;
  const { swingHighIdx, swingLowIdx } = findSwings(candles);

  // Bearish: price makes higher high vs last swing high, RSI makes lower high
  if (swingHighIdx !== -1) {
    const priceHH = candles[curr].high > candles[swingHighIdx].high;
    const rsiLH   = rsi[curr] < rsi[swingHighIdx];
    if (priceHH && rsiLH && rsi[curr] > 55) return 'BEARISH';
  }

  // Bullish: price makes lower low vs last swing low, RSI makes higher low
  if (swingLowIdx !== -1) {
    const priceLL = candles[curr].low < candles[swingLowIdx].low;
    const rsiHL   = rsi[curr] > rsi[swingLowIdx];
    if (priceLL && rsiHL && rsi[curr] < 45) return 'BULLISH';
  }

  return null;
}

function detectSignals(symbol, candles, tf) {
  const vpCandles = candles.slice(0, -1);
  const vp        = calcVolumeProfile(vpCandles);
  if (!vp) return [];

  const rsi  = calcRSI(candles);
  const div  = checkDivergence(candles, rsi);
  const curr = candles.length - 1;
  const cur  = candles[curr];
  const prev = candles[curr - 1];
  const price = cur.close;

  // Volume confirmation: current candle volume vs 20-candle average
  const recentVols = candles.slice(-21, -1).map(c => c.volume);
  const avgVol     = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const volConfirm = cur.volume > avgVol * 1.1;

  const signals = [];

  // 1. VAH BREAK
  if (prev.close <= vp.vah && cur.close > vp.vah) {
    if (div === 'BEARISH') {
      signals.push({ symbol, type:'WARNING', price, vp, strength: 20, tf });
    } else {
      const strength = volConfirm ? 75 : 55;
      signals.push({ symbol, type:'VAH', price, vp, strength, tf });
    }
  }

  // 2. VAL RECLAIM
  if (prev.close < vp.val && cur.close >= vp.val) {
    const base     = volConfirm ? 65 : 50;
    const type     = div === 'BULLISH' ? 'VAL_DIV' : 'VAL';
    const strength = div === 'BULLISH' ? 92 : base;
    signals.push({ symbol, type, price, vp, strength, tf });
  }

  // 3. POC REACT
  if (cur.low <= vp.poc * 1.003 && cur.close > vp.poc) {
    const base     = volConfirm ? 62 : 48;
    const type     = div === 'BULLISH' ? 'POC_DIV' : 'POC';
    const strength = div === 'BULLISH' ? 88 : base;
    signals.push({ symbol, type, price, vp, strength, tf });
  }

  return signals;
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── FIX 2: Scan function returns a Promise so callers can await it ─
async function runBackgroundScan() {
  if (scanInProgress) {
    console.log('[SCAN] Already running, skipping.');
    return;
  }
  scanInProgress = true;

  const tfs        = Object.keys(TF_MAP);
  const allSignals = [];
  let   scanned    = 0;
  const jobs       = [];
  for (const sym of SCAN_PAIRS) for (const tf of tfs) jobs.push({ sym, tf });

  console.log(`[SCAN START] ${jobs.length} jobs`);

  const CONCURRENCY = 3;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ sym, tf }) => {
      try {
        const candles = await fetchKlines(sym, TF_MAP[tf], 100);
        const sigs    = detectSignals(sym, candles, tf);
        sigs.forEach(s => alertSignal(s));
        allSignals.push(...sigs);
        scanned++;
      } catch(e) {
        console.log(`[WARN] ${sym}/${tf}: ${e.message}`);
      }
    }));
    await new Promise(r => setTimeout(r, 500));
  }

  scanCache = { signals: allSignals, scanned, ts: new Date().toISOString() };
  alertedSignals.clear();
  scanInProgress = false;
  console.log(`[SCAN DONE] ${scanned} scanned, ${allSignals.length} signals`);
  sendTelegram(`📊 <b>Scan Complete</b>\n${scanned} coins scanned\n🔔 ${allSignals.length} signals found!`).catch(() => {});
}

// ── Simple in-memory rate limiter ──────────────────────────────────
const ipRequests = new Map();
function isRateLimited(ip) {
  const now   = Date.now();
  const entry = ipRequests.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  ipRequests.set(ip, entry);
  return entry.count > 30; // max 30 /api/candles requests per minute per IP
}
// Clean up every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of ipRequests) { if (now > e.reset) ipRequests.delete(ip); }
}, 5 * 60 * 1000);

// ── HTTP Server ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  // ── Serve index.html ──────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath));
  }

  // ── Return cached scan results ─────────────────────────────────
  if (pathname === '/api/scan') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok:       true,
      scanned:  scanCache.scanned,
      signals:  scanCache.signals,
      ts:       scanCache.ts || new Date().toISOString(),
      scanning: scanInProgress
    }));
  }

  // ── FIX 2: Trigger a fresh scan manually ──────────────────────
  if (pathname === '/api/trigger-scan') {
    if (scanInProgress) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: 'Scan already in progress' }));
    }
    // Fire and forget — client polls /api/scan for results
    runBackgroundScan().catch(console.error);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, message: 'Scan started' }));
  }

  // ── Candle data for chart modal ────────────────────────────────
  if (pathname === '/api/candles') {
    if (isRateLimited(clientIP)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Too many requests' }));
    }
    const symbol   = (parsed.query.symbol   || 'BTCUSDT').toUpperCase();
    const interval = parsed.query.interval  || '1h';
    try {
      const candles   = await fetchKlines(symbol, interval, 100);
      const vp        = calcVolumeProfile(candles);
      const rsiValues = calcRSI(candles);
      candles.forEach((c, i) => c.rsi = rsiValues[i]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, symbol, interval, candles, vp }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // ── Health check ───────────────────────────────────────────────
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, cached: scanCache.scanned, ts: scanCache.ts, scanning: scanInProgress }));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`VP SCREENER running on ${HOST}:${PORT}`);
  if (!TG_TOKEN) console.warn('[WARN] TG_TOKEN not set — Telegram alerts disabled');
  if (!TG_CHAT)  console.warn('[WARN] TG_CHAT not set — Telegram alerts disabled');
  sendTelegram('🟢 <b>VP SCREENER ONLINE</b>').catch(() => {});
  setTimeout(() => runBackgroundScan().catch(console.error), 3000);
  setInterval(() => runBackgroundScan().catch(console.error), 30 * 60 * 1000);
});

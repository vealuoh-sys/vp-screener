const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ── Secrets from environment variables ───────────────────────────────────────
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

const TF_MAP = { '1h':'1h', '4h':'4h', '1d':'1d' };

let scanCache      = { signals: [], scanned: 0, ts: null };
let scanInProgress = false;

// ── FIX #1: alertedSignals now expires by time (10 min TTL) ──────────────────
// Previously it was cleared at the END of every scan, meaning the very next
// scan would re-alert every signal it found. Now each alert has a timestamp
// and is only cleared if it is older than ALERT_TTL_MS.
const ALERT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const alertedSignals = new Map(); // key → timestamp

function pruneAlerts() {
  const now = Date.now();
  for (const [key, ts] of alertedSignals) {
    if (now - ts > ALERT_TTL_MS) alertedSignals.delete(key);
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
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
  pruneAlerts();
  const key = `${sig.symbol}-${sig.type}-${sig.tf}`;
  if (alertedSignals.has(key)) return;
  alertedSignals.set(key, Date.now());

  const emoji = {
    VAH: '🚀', VAH_SPIKE: '🚀🔥',
    VAL: '🟢', VAL_DIV: '🟢🔥', VAL_SPIKE: '🟢💥',
    POC: '🎯', POC_DIV: '🎯🔥', POC_SPIKE: '🎯💥',
    WARNING: '⚠️'
  }[sig.type] || '📊';

  const label = {
    VAH:       'VAH BREAK ▲',
    VAH_SPIKE: 'VAH BREAK + VOL SPIKE 🔥',
    VAL:       'VAL RECLAIM ▼',
    VAL_DIV:   'VAL + BULL DIV 🔥',
    VAL_SPIKE: 'VAL + VOL SPIKE 💥',
    POC:       'POC REACT ◆',
    POC_DIV:   'POC + BULL DIV 🔥',
    POC_SPIKE: 'POC + VOL SPIKE 💥',
    WARNING:   'VAH FAKEOUT ⚠️'
  }[sig.type] || sig.type;

  // FIX #2: include trend info in Telegram alert
  const trendLabel = sig.trend === 'UP'   ? '↑ WITH TREND' :
                     sig.trend === 'DOWN' ? '↓ COUNTER'    : '→ NEUTRAL';
  const volLabel   = sig.volTier === 'SPIKE'     ? '🔥 SPIKE (3x+)' :
                     sig.volTier === 'CONFIRMED'  ? '✅ CONFIRMED (2x)' :
                     sig.volTier === 'STRONG'     ? '👍 STRONG (1.5x)' : '○ NORMAL';

  const msg = [
    `${emoji} <b>VP SIGNAL</b>`,
    ``,
    `<b>${sig.symbol}</b> — ${label}`,
    `⏱ TF: <b>${sig.tf.toUpperCase()}</b>`,
    `💰 Price: <b>$${sig.price.toFixed(6)}</b>`,
    ``,
    `📊 VP Levels:`,
    `🔴 VAH: $${sig.vp.vah.toFixed(6)}`,
    `🟡 POC: $${sig.vp.poc.toFixed(6)}`,
    `🟢 VAL: $${sig.vp.val.toFixed(6)}`,
    ``,
    `📈 Trend:   ${trendLabel}`,
    `📦 Volume:  ${volLabel}`,
    `💪 Strength: ${sig.strength}%`
  ].join('\n');

  sendTelegram(msg).catch(console.error);
}

// ── Binance fetch — tries multiple endpoints ──────────────────────────────────
function fetchBinance(reqPath) {
  const endpoints = [
    { hostname: 'data-api.binance.vision', path: reqPath },
    { hostname: 'api.binance.com',         path: reqPath },
    { hostname: 'api1.binance.com',        path: reqPath },
    { hostname: 'api2.binance.com',        path: reqPath },
    { hostname: 'api3.binance.com',        path: reqPath },
    { hostname: 'api4.binance.com',        path: reqPath },
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

async function fetchKlines(symbol, interval, limit = 120) {
  // FIX: fetch 120 instead of 100 so EMA-50 has enough warm-up candles
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

// ── Volume Profile ────────────────────────────────────────────────────────────
// FIX #11: unified bin count = 36 (was mismatched 24 server / 28 client)
const VP_BINS = 36;

function calcVolumeProfile(candles) {
  if (!candles || candles.length < 10) return null;
  let lo = Infinity, hi = -Infinity;
  candles.forEach(c => {
    if (c.high > hi) hi = c.high;
    if (c.low  < lo) lo = c.low;
  });
  const range = hi - lo;
  if (range === 0) return null;

  const binSize = range / VP_BINS;
  const vol     = new Array(VP_BINS).fill(0);
  candles.forEach(c => {
    const idx = Math.min(Math.floor((c.typical - lo) / binSize), VP_BINS - 1);
    vol[idx] += c.volume;
  });

  let pocIdx = 0;
  vol.forEach((v, i) => { if (v > vol[pocIdx]) pocIdx = i; });
  const poc = lo + (pocIdx + 0.5) * binSize;

  const totalVol = vol.reduce((a, b) => a + b, 0);
  const target   = totalVol * 0.70;
  let vaVol = vol[pocIdx], vaLo = pocIdx, vaHi = pocIdx;

  while (vaVol < target) {
    const nextLo = vaLo > 0         ? vol[vaLo - 1] : 0;
    const nextHi = vaHi < VP_BINS-1 ? vol[vaHi + 1] : 0;
    if (nextLo >= nextHi && vaLo > 0) { vaLo--; vaVol += nextLo; }
    else if (vaHi < VP_BINS - 1)      { vaHi++; vaVol += nextHi; }
    else break;
  }
  return {
    poc, bins: vol, binSize, lo, hi,
    vah: lo + (vaHi + 1) * binSize,
    val: lo + vaLo * binSize
  };
}

// ── RSI (Wilder smoothing) ────────────────────────────────────────────────────
function calcRSI(candles, period = 14) {
  const rsi = new Array(candles.length).fill(50);
  if (candles.length <= period) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i]  = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  for (let i = 0; i < period; i++) rsi[i] = rsi[period];
  return rsi;
}

// ── NEW: EMA calculator ───────────────────────────────────────────────────────
// An EMA (Exponential Moving Average) gives more weight to recent candles.
// EMA20 reacts fast, EMA50 is slower — together they tell us the trend direction.
function calcEMA(candles, period) {
  const ema = new Array(candles.length).fill(0);
  if (candles.length < period) return ema;

  // Seed: simple average of first `period` closes
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  ema[period - 1] = sum / period;

  const k = 2 / (period + 1); // EMA multiplier
  for (let i = period; i < candles.length; i++) {
    ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
  }
  // Fill warm-up with the first valid value so no zeros reach callers
  for (let i = 0; i < period - 1; i++) ema[i] = ema[period - 1];
  return ema;
}

// ── NEW: Trend detection using EMA20 and EMA50 ───────────────────────────────
// Returns: 'UP', 'DOWN', or 'NEUTRAL'
// UP    = price > EMA20 > EMA50  (everything lined up bullishly)
// DOWN  = price < EMA20 < EMA50  (everything lined up bearishly)
// NEUTRAL = mixed / choppy
function detectTrend(candles) {
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const last  = candles.length - 1;
  const price = candles[last].close;
  const e20   = ema20[last];
  const e50   = ema50[last];

  if (price > e20 && e20 > e50) return { trend: 'UP',      ema20: e20, ema50: e50 };
  if (price < e20 && e20 < e50) return { trend: 'DOWN',    ema20: e20, ema50: e50 };
  return                               { trend: 'NEUTRAL',  ema20: e20, ema50: e50 };
}

// ── NEW: Volume spike tier ────────────────────────────────────────────────────
// Compares current candle volume to the 20-candle average and returns a tier.
// SPIKE     = 3x or more  → very unusual, strong conviction move
// CONFIRMED = 2x–3x       → above-average, good confirmation
// STRONG    = 1.5x–2x     → mildly elevated
// NORMAL    = below 1.5x  → no special volume
function classifyVolume(candles) {
  const curr      = candles.length - 1;
  const recentVols = candles.slice(-21, -1).map(c => c.volume);
  const avgVol    = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const curVol    = candles[curr].volume;
  const ratio     = avgVol > 0 ? curVol / avgVol : 1;

  if (ratio >= 3.0) return { volTier: 'SPIKE',     volRatio: ratio };
  if (ratio >= 2.0) return { volTier: 'CONFIRMED', volRatio: ratio };
  if (ratio >= 1.5) return { volTier: 'STRONG',    volRatio: ratio };
  return                   { volTier: 'NORMAL',    volRatio: ratio };
}

// ── Divergence detection ──────────────────────────────────────────────────────
function findSwings(candles) {
  const last = candles.length - 1;
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

  if (swingHighIdx !== -1) {
    const priceHH = candles[curr].high > candles[swingHighIdx].high;
    const rsiLH   = rsi[curr] < rsi[swingHighIdx];
    if (priceHH && rsiLH && rsi[curr] > 55) return 'BEARISH';
  }
  if (swingLowIdx !== -1) {
    const priceLL = candles[curr].low < candles[swingLowIdx].low;
    const rsiHL   = rsi[curr] > rsi[swingLowIdx];
    if (priceLL && rsiHL && rsi[curr] < 45) return 'BULLISH';
  }
  return null;
}

// ── NEW: Strength scoring engine ──────────────────────────────────────────────
// Combines VP signal + trend alignment + volume tier + divergence into one score.
//
// Base score by signal type:
//   VAH break  → 50  (breakout, needs confirmation)
//   VAL reclaim→ 50
//   POC react  → 45
//
// Bonuses:
//   Trend aligned (UP for bullish signals, DOWN for WARNING)  → +20
//   Volume SPIKE     → +20
//   Volume CONFIRMED → +12
//   Volume STRONG    → +6
//   Bullish divergence → +10
//   Bearish divergence (WARNING) → -20
//
// Max possible: 100 (capped)
function scoreSignal(baseType, trend, volTier, div) {
  const bases = { VAH: 50, VAL: 50, POC: 45, WARNING: 10 };
  let score = bases[baseType] || 45;

  // Trend bonus
  const bullishTypes = ['VAH', 'VAL', 'POC'];
  if (bullishTypes.includes(baseType)) {
    if (trend === 'UP')      score += 20;
    else if (trend === 'DOWN') score -= 10; // counter-trend penalty
  }

  // Volume bonus
  if (volTier === 'SPIKE')     score += 20;
  else if (volTier === 'CONFIRMED') score += 12;
  else if (volTier === 'STRONG')    score += 6;

  // Divergence
  if (div === 'BULLISH') score += 10;
  if (div === 'BEARISH') score -= 20;

  return Math.min(100, Math.max(0, score));
}

// ── NEW: Signal type naming with volume spike tiers ───────────────────────────
// When volume is a SPIKE or CONFIRMED, we create a special signal type
// so the frontend can show a distinct badge.
function resolveSignalType(baseType, div, volTier) {
  if (baseType === 'WARNING') return 'WARNING';

  // Divergence takes priority label
  if (div === 'BULLISH') {
    if (baseType === 'VAL') return 'VAL_DIV';
    if (baseType === 'POC') return 'POC_DIV';
  }

  // Volume spike labels
  if (volTier === 'SPIKE' || volTier === 'CONFIRMED') {
    if (baseType === 'VAH') return 'VAH_SPIKE';
    if (baseType === 'VAL') return 'VAL_SPIKE';
    if (baseType === 'POC') return 'POC_SPIKE';
  }

  return baseType;
}

// ── Signal detection ──────────────────────────────────────────────────────────
function detectSignals(symbol, candles, tf) {
  const vpCandles = candles.slice(0, -1);
  const vp = calcVolumeProfile(vpCandles);
  if (!vp) return [];

  const rsi  = calcRSI(candles);
  const div  = checkDivergence(candles, rsi);
  const curr = candles.length - 1;
  const cur  = candles[curr];
  const prev = candles[curr - 1];

  // NEW: get trend and volume tier
  const { trend, ema20, ema50 } = detectTrend(candles);
  const { volTier, volRatio }   = classifyVolume(candles);

  const signals = [];

  // 1. VAH BREAK
  if (prev.close <= vp.vah && cur.close > vp.vah) {
    if (div === 'BEARISH') {
      // Bearish divergence on a VAH break = likely fakeout
      signals.push({
        symbol, price: cur.close, vp, tf,
        type:    'WARNING',
        trend, volTier, volRatio, ema20, ema50,
        strength: scoreSignal('WARNING', trend, volTier, div)
      });
    } else {
      const type     = resolveSignalType('VAH', div, volTier);
      const strength = scoreSignal('VAH', trend, volTier, div);
      signals.push({ symbol, price: cur.close, vp, tf, type, trend, volTier, volRatio, ema20, ema50, strength });
    }
  }

  // 2. VAL RECLAIM
  if (prev.close < vp.val && cur.close >= vp.val) {
    const type     = resolveSignalType('VAL', div, volTier);
    const strength = scoreSignal('VAL', trend, volTier, div);
    signals.push({ symbol, price: cur.close, vp, tf, type, trend, volTier, volRatio, ema20, ema50, strength });
  }

  // 3. POC REACT
  if (cur.low <= vp.poc * 1.003 && cur.close > vp.poc) {
    const type     = resolveSignalType('POC', div, volTier);
    const strength = scoreSignal('POC', trend, volTier, div);
    signals.push({ symbol, price: cur.close, vp, tf, type, trend, volTier, volRatio, ema20, ema50, strength });
  }

  return signals;
}

// ── CORS helper ───────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Background scan ───────────────────────────────────────────────────────────
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
        const candles = await fetchKlines(sym, TF_MAP[tf], 120);
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

  scanCache      = { signals: allSignals, scanned, ts: new Date().toISOString() };
  scanInProgress = false;
  console.log(`[SCAN DONE] ${scanned} scanned, ${allSignals.length} signals`);

  // FIX #2: stat counts include all sub-types (VAL_DIV counts as VAL, etc.)
  const vahCount = allSignals.filter(s => s.type.startsWith('VAH')).length;
  const valCount = allSignals.filter(s => s.type.startsWith('VAL')).length;
  const pocCount = allSignals.filter(s => s.type.startsWith('POC')).length;

  sendTelegram([
    `📊 <b>Scan Complete</b>`,
    `${scanned} coins scanned`,
    `🚀 VAH Breaks:   ${vahCount}`,
    `🟢 VAL Reclaims: ${valCount}`,
    `🎯 POC Reacts:   ${pocCount}`,
    `🔔 Total signals: ${allSignals.length}`
  ].join('\n')).catch(() => {});
}

// ── Rate limiter (covers both /api/candles AND /api/trigger-scan) ─────────────
// FIX #5: trigger-scan was previously unprotected
const ipRequests = new Map();
function isRateLimited(ip, limit = 30) {
  const now   = Date.now();
  const entry = ipRequests.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  ipRequests.set(ip, entry);
  return entry.count > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of ipRequests) { if (now > e.reset) ipRequests.delete(ip); }
}, 5 * 60 * 1000);

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  // ── Serve index.html ────────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath));
  }

  // ── Cached scan results ─────────────────────────────────────────────────────
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

  // ── FIX #7: Trigger a fresh scan + return current cache immediately ─────────
  // Previously the frontend only called /api/scan which reads stale cache.
  // Now the SCAN NOW button calls /api/trigger-scan first, then polls /api/scan.
  if (pathname === '/api/trigger-scan') {
    // FIX #5: rate-limit trigger-scan to 5 calls/min per IP
    if (isRateLimited(clientIP, 5)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: 'Too many scan requests' }));
    }
    if (scanInProgress) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: 'Scan already in progress' }));
    }
    runBackgroundScan().catch(console.error);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, message: 'Scan started' }));
  }

  // ── Candle data for chart modal ─────────────────────────────────────────────
  if (pathname === '/api/candles') {
    if (isRateLimited(clientIP, 30)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Too many requests' }));
    }
    const symbol   = (parsed.query.symbol   || 'BTCUSDT').toUpperCase();
    const interval = parsed.query.interval  || '1h';
    try {
      const candles   = await fetchKlines(symbol, interval, 120);
      const vp        = calcVolumeProfile(candles);
      const rsiValues = calcRSI(candles);
      const ema20     = calcEMA(candles, 20);
      const ema50     = calcEMA(candles, 50);
      const { trend } = detectTrend(candles);
      const { volTier, volRatio } = classifyVolume(candles);

      // Attach per-candle RSI + EMA values so the chart can plot them
      candles.forEach((c, i) => {
        c.rsi  = rsiValues[i];
        c.ema20 = ema20[i];
        c.ema50 = ema50[i];
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true, symbol, interval, candles, vp,
        trend, volTier, volRatio
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // ── Health check ────────────────────────────────────────────────────────────
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      cached: scanCache.scanned,
      ts: scanCache.ts,
      scanning: scanInProgress
    }));
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

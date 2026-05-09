// ═══════════════════════════════════════════════════════════════
//  VP SCREENER — server.js
//  Node.js backend proxy for Binance API
//  Bypasses browser CORS restrictions, serves dashboard HTML
// ═══════════════════════════════════════════════════════════════

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT||3000;

// ── Top Binance USDT pairs to scan ──────────────────────────────
const SCAN_PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','AVAXUSDT','DOGEUSDT','DOTUSDT','MATICUSDT',
  'LINKUSDT','ATOMUSDT','LTCUSDT','UNIUSDT','AAVEUSDT',
  'NEARUSDT','FILUSDT','ARBUSDT','OPUSDT','INJUSDT',
  'SUIUSDT','APTUSDT','SEIUSDT','TIAUSDT','WLDUSDT',
  'FETUSDT','RENDERUSDT','RUNEUSDT','ORDIUSDT','STXUSDT',
  'IMXUSDT','SANDUSDT','MANAUSDT','AXSUSDT','FTMUSDT',
  'EGLDUSDT','ALGOUSDT','GALAUSDT','APEUSDT','GMTUSDT'
];

// ── Binance interval map ─────────────────────────────────────────
const TF_MAP = {
  '30m': '30m',
  '1h':  '1h',
  '4h':  '4h',
  '12h': '12h',
  '1d':  '1d'
};

// ── HTTPS GET helper (returns parsed JSON) ───────────────────────
function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    };
    https.get(reqUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0,100))); }
      });
    }).on('error', reject);
  });
}

// ── Fetch klines from Binance ────────────────────────────────────
async function fetchKlines(symbol, interval, limit = 120) {
  const reqUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await httpsGet(reqUrl);
  if (!Array.isArray(raw)) throw new Error('Bad response for ' + symbol);
  return raw.map(k => ({
    open:    parseFloat(k[1]),
    high:    parseFloat(k[2]),
    low:     parseFloat(k[3]),
    close:   parseFloat(k[4]),
    volume:  parseFloat(k[5]),
    typical: (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3
  }));
}

// ── Volume Profile calculator ────────────────────────────────────
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

  // POC
  let pocIdx = 0;
  vol.forEach((v, i) => { if (v > vol[pocIdx]) pocIdx = i; });
  const poc = lo + (pocIdx + 0.5) * binSize;

  // Value Area (70%)
  const totalVol = vol.reduce((a, b) => a + b, 0);
  const target = totalVol * 0.70;
  let vaVol = vol[pocIdx];
  let vaLo = pocIdx, vaHi = pocIdx;

  while (vaVol < target) {
    const nextLo = vaLo > 0         ? vol[vaLo - 1] : 0;
    const nextHi = vaHi < BINS - 1  ? vol[vaHi + 1] : 0;
    if (nextLo >= nextHi && vaLo > 0) { vaLo--; vaVol += nextLo; }
    else if (vaHi < BINS - 1)         { vaHi++; vaVol += nextHi; }
    else break;
  }

  const vah = lo + (vaHi + 1) * binSize;
  const val = lo + vaLo * binSize;

  return { poc, vah, val, hi, lo };
}

// ── Signal detection (bullish only) ─────────────────────────────
function detectSignals(symbol, candles, tf) {
  const vp = calcVolumeProfile(candles);
  if (!vp) return [];

  const cur  = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = cur.close;
  const signals = [];

  const pct = (a, b) => Math.abs(a - b) / (b || 1) * 100;

  // VAH BREAK — closes above VAH (bullish breakout)
  if (prev.close <= vp.vah && cur.close > vp.vah) {
    const str = Math.min(100, Math.round(55 + pct(price, vp.vah) * 3));
    signals.push({ symbol, type: 'VAH', price, vp, strength: str, tf });
  }

  // VAL RECLAIM — reclaims back above VAL from below (bullish)
  if (prev.close < vp.val && cur.close >= vp.val && cur.close < vp.vah) {
    const str = Math.min(100, Math.round(50 + pct(price, vp.val) * 5));
    signals.push({ symbol, type: 'VAL', price, vp, strength: str, tf });
  }

  // POC REACTION — price bounces off POC from below (bullish)
  if (cur.low <= vp.poc * 1.003 && cur.close > vp.poc && prev.close <= vp.poc * 1.004) {
    const str = Math.min(100, Math.round(48 + pct(price, vp.poc) * 6));
    signals.push({ symbol, type: 'POC', price, vp, strength: str, tf });
  }

  return signals;
}

// ── CORS headers helper ──────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Main scan endpoint ───────────────────────────────────────────
async function handleScan(res) {
  const tfs = Object.keys(TF_MAP);
  const allSignals = [];
  let scanned = 0;
  const errors = [];

  // Process pairs with concurrency limit
  const CONCURRENCY = 6;
  const jobs = [];
  for (const sym of SCAN_PAIRS) {
    for (const tf of tfs) {
      jobs.push({ sym, tf });
    }
  }

  console.log(`[SCAN] Starting — ${SCAN_PAIRS.length} pairs × ${tfs.length} TFs = ${jobs.length} jobs`);

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ sym, tf }) => {
      try {
        const candles = await fetchKlines(sym, TF_MAP[tf], 120);
        const sigs    = detectSignals(sym, candles, tf);
        allSignals.push(...sigs);
        scanned++;
        if (scanned % 20 === 0) console.log(`  … scanned ${scanned}/${jobs.length}`);
      } catch(e) {
        errors.push(`${sym}/${tf}: ${e.message}`);
      }
    }));
    // Throttle between batches to respect Binance rate limits
    await new Promise(r => setTimeout(r, 80));
  }

  console.log(`[SCAN] Done — ${scanned} ok, ${errors.length} errors, ${allSignals.length} signals`);

  const payload = JSON.stringify({
    ok: true,
    scanned,
    signals: allSignals,
    errors: errors.slice(0, 5),
    ts: new Date().toISOString()
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// ── HTTP Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ── Serve dashboard HTML ──
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('index.html not found — make sure it is in the same folder as server.js');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath));
  }

  // ── Scan endpoint ──
  if (pathname === '/api/scan') {
    try {
      await handleScan(res);
    } catch(e) {
      console.error('[SCAN ERROR]', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── Health check ──
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════╗');
  console.log('  ║   VP SCREENER — Server Running         ║');
  console.log(`  ║   http://localhost:${PORT}               ║`);
  console.log('  ║   Press Ctrl+C to stop                 ║');
  console.log('  ╚════════════════════════════════════════╝');
  console.log('');
});

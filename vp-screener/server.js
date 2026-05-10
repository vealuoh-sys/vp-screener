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
  const msg = `${emoji} <b>VP SIGNAL</b>

<b>${sig.symbol}</b> — ${label}
⏱ TF: <b>${sig.tf.toUpperCase()}</b>
💰 Price: <b>$${sig.price.toFixed(6)}</b>

📊 Levels:
🔴 VAH: $${sig.vp.vah.toFixed(6)}
🟡 POC: $${sig.vp.poc.toFixed(6)}
🟢 VAL: $${sig.vp.val.toFixed(6)}
💪 Strength: ${sig.strength}%

🌐 vp-screener.up.railway.app`;
  sendTelegram(msg).catch(console.error);
}

// ── Direct Binance fetch using multiple fallback hosts ────────────
function fetchDirect(reqPath) {
  const hosts = ['api1.binance.com','api2.binance.com','api3.binance.com','api.binance.com'];
  
  function tryHost(idx) {
    if (idx >= hosts.length) return Promise.reject(new Error('All hosts failed'));
    return new Promise((resolve, reject) => {
      const options = {
        hostname: hosts[idx],
        path: reqPath,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        },
        timeout: 12000
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = Buffer.concat(chunks).toString();
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
              resolve(parsed);
            } else {
              tryHost(idx + 1).then(resolve).catch(reject);
            }
          } catch(e) {
            tryHost(idx + 1).then(resolve).catch(reject);
          }
        });
      });
      req.on('timeout', () => { req.destroy(); tryHost(idx + 1).then(resolve).catch(reject); });
      req.on('error', () => tryHost(idx + 1).then(resolve).catch(reject));
      req.end();
    });
  }
  
  return tryHost(0);
}

async function fetchKlines(symbol, interval, limit) {
  limit = limit || 100;
  const reqPath = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await fetchDirect(reqPath);
  return raw.map(k => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    typical: (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3
  }));
}

// ── Volume Profile ────────────────────────────────────────────────
function calcVolumeProfile(candles) {
  if (!candles || candles.length < 10) return null;
  let lo = Infinity, hi = -Infinity;
  candles.forEach(c => {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
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
    const nextLo = vaLo > 0 ? vol[vaLo - 1] : 0;
    const nextHi = vaHi < BINS - 1 ? vol[vaHi + 1] : 0;
    if (nextLo >= nextHi && vaLo > 0) { vaLo--; vaVol += nextLo; }
    else if (vaHi < BINS - 1) { vaHi++; vaVol += nextHi; }
    else break;
  }
  return { poc, vah: lo + (vaHi + 1) * binSize, val: lo + vaLo * binSize, hi, lo };
}

function detectSignals(symbol, candles, tf) {
  const vp = calcVolumeProfile(candles);
  if (!vp) return [];
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = cur.close;
  const signals = [];
  const pct = (a, b) => Math.abs(a - b) / (b || 1) * 100;
  if (prev.close <= vp.vah && cur.close > vp.vah)
    signals.push({ symbol, type: 'VAH', price, vp, strength: Math.min(100, Math.round(55 + pct(price, vp.vah) * 3)), tf });
  if (prev.close < vp.val && cur.close >= vp.val && cur.close < vp.vah)
    signals.push({ symbol, type: 'VAL', price, vp, strength: Math.min(100, Math.round(50 + pct(price, vp.val) * 5)), tf });
  if (cur.low <= vp.poc * 1.003 && cur.close > vp.poc && prev.close <= vp.poc * 1.004)
    signals.push({ symbol, type: 'POC', price, vp, strength: Math.min(100, Math.round(48 + pct(price, vp.poc) * 6)), tf });
  return signals;
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function runBackgroundScan() {
  const tfs = Object.keys(TF_MAP);
  const allSignals = [];
  let scanned = 0;
  const jobs = [];
  for (const sym of SCAN_PAIRS) for (const tf of tfs) jobs.push({ sym, tf });

  console.log(`[SCAN START] ${jobs.length} jobs`);
  const CONCURRENCY = 5;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ sym, tf }) => {
      try {
        const candles = await fetchKlines(sym, TF_MAP[tf], 100);
        const sigs = detectSignals(sym, candles, tf);
        sigs.forEach(s => alertSignal(s));
        allSignals.push(...sigs);
        scanned++;
        console.log(`[OK] ${sym}/${tf}`);
      } catch(e) {
        console.log(`[WARN] ${sym}/${tf}: ${e.message}`);
      }
    }));
    await new Promise(r => setTimeout(r, 300));
  }

  scanCache = { signals: allSignals, scanned, ts: new Date().toISOString() };
  alertedSignals.clear();
  console.log(`[SCAN DONE] ${scanned} scanned, ${allSignals.length} signals`);
  sendTelegram(`📊 <b>Scan Complete</b>\n${scanned} coins scanned\n🔔 ${allSignals.length} signals found!`).catch(()=>{});
}

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath));
  }

  if (pathname === '/api/scan') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, scanned: scanCache.scanned, signals: scanCache.signals, ts: scanCache.ts || new Date().toISOString() }));
    return;
  }

  if (pathname === '/api/candles') {
    const symbol = (parsed.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = parsed.query.interval || '1h';
    try {
      const candles = await fetchKlines(symbol, interval, 100);
      const vp = calcVolumeProfile(candles);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, symbol, interval, candles, vp }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, cached: scanCache.scanned }));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`VP SCREENER running on ${HOST}:${PORT}`);
  sendTelegram('🟢 <b>VP SCREENER ONLINE</b>\nDirect Binance connection. Scanning 50 coins...').catch(()=>{});
  setTimeout(() => runBackgroundScan().catch(console.error), 3000);
  setInterval(() => runBackgroundScan().catch(console.error), 30 * 60 * 1000);
});

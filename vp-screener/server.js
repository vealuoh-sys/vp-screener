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
  'DYDXUSDT','GMXUSDT','CAKEUSDT','XLMUSDT','VETUSDT',
  'HBARUSDT','ICPUSDT','ETCUSDT','XMRUSDT','BCHUSDT',
  'ZECUSDT','NEOUSDT','ZILUSDT','ANKRUSDT','CHZUSDT',
  'MINAUSDT','FLOWUSDT','ROSEUSDT','KSMUSDT','ZRXUSDT',
  'BATUSDT','NMRUSDT','BLURUSDT','MAGICUSDT','WOOUSDT',
  'CROUSDT','QNTUSDT','RENDERUSDT','OCEANUSDT','FXSUSDT',
  'CVXUSDT','RENUSDT','BANDUSDT','RSRUSDT','ALPHAUSDT',
  'BNTUSDT','MLNUSDT','LRCUSDT','STORJUSDT','TRUUSDT',
  'CELOUSDT','SKLUSDT','FETUSDT','AGLDUSDT','API3USDT',
  'IOTAUSDT','ONTUSDT','WAVESUSDT','RVNUSDT','SCUSDT',
  'DGBUSDT','XEMUSDT','LSKUSDT','ARKUSDT','IOSTUSDT'
];

const TF_MAP = {
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '12h': '12h',
  '1d': '1d'
};

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
      res.on('end', () => { console.log('[TG]', d.slice(0,60)); resolve(); });
    }).on('error', (e) => { console.log('[TG ERR]', e.message); resolve(); });
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

// ── Fetch via allorigins proxy (bypasses Binance IP block) ────────
function fetchViaProxy(binanceUrl) {
  return new Promise((resolve, reject) => {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(binanceUrl)}`;
    const req = https.get(proxyUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { const d=JSON.parse(data); resolve(d.contents ? JSON.parse(d.contents) : d); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function fetchKlines(symbol, interval, limit) {
  limit = limit || 100;
  const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await fetchViaProxy(binanceUrl);
  if (!Array.isArray(raw)) throw new Error('Bad response');
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

// ── Background scan ───────────────────────────────────────────────
async function runBackgroundScan() {
  const tfs = Object.keys(TF_MAP);
  const allSignals = [];
  let scanned = 0;
  const jobs = [];
  for (const sym of SCAN_PAIRS) for (const tf of tfs) jobs.push({ sym, tf });

  console.log(`[SCAN START] ${jobs.length} jobs`);
  const CONCURRENCY = 8;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ sym, tf }) => {
      try {
        const candles = await fetchKlines(sym, TF_MAP[tf], 100);
        const sigs = detectSignals(sym, candles, tf);
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
  console.log(`[SCAN DONE] ${scanned} scanned, ${allSignals.length} signals`);

  if (allSignals.length === 0) {
    sendTelegram('📊 <b>Scan Complete</b>\n' + scanned + ' coins scanned\nNo signals found right now.').catch(()=>{});
  } else {
    sendTelegram(`📊 <b>Scan Complete</b>\n${scanned} coins scanned\n🔔 ${allSignals.length} signals found!`).catch(()=>{});
  }
}

// ── Server ────────────────────────────────────────────────────────
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
    res.end(JSON.stringify({
      ok: true,
      scanned: scanCache.scanned,
      signals: scanCache.signals,
      ts: scanCache.ts || new Date().toISOString()
    }));
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
  sendTelegram('🟢 <b>VP SCREENER ONLINE</b>\nServer started! Scanning 100 coins on 5 timeframes...\n⏳ Results in ~2 minutes').catch(()=>{});
  setTimeout(() => runBackgroundScan().catch(console.error), 3000);
  setInterval(() => runBackgroundScan().catch(console.error), 30 * 60 * 1000);
});

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const SCAN_PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','AVAXUSDT','DOGEUSDT','DOTUSDT','MATICUSDT',
  'LINKUSDT','ATOMUSDT','LTCUSDT','UNIUSDT','AAVEUSDT',
  'NEARUSDT','FILUSDT','ARBUSDT','OPUSDT','INJUSDT',
  'SUIUSDT','APTUSDT','SEIUSDT','TIAUSDT','WLDUSDT',
  'FETUSDT','RENDERUSDT','RUNEUSDT','ORDIUSDT','STXUSDT',
  'IMXUSDT','SANDUSDT','MANAUSDT','AXSUSDT','FTMUSDT',
  'EGLDUSDT','ALGOUSDT','GALAUSDT','APEUSDT','GMTUSDT',
  'ACHUSDT','ACMUSDT','ACTUSDT','ACXUSDT','ADAUSDT',
  'AEVOUSDT','AGLDUSDT','AIUSDT','AKTUSDT','ALICEUSDT',
  'ALPHAUSDT','ALTUSDT','ANKRUSDT','ANTUSDT','API3USDT',
  'ARUSDT','ARKMUSDT','ARPAUSDT','ASTRUSDT','ATAUSDT',
  'AUCTIONUSDT','AUDIOUSDT','BADGERUSDT','BAKEUSDT','BALUSDT',
  'BANDUSDT','BATUSDT','BBUSDT','BCHUSDT','BELUSDT',
  'BLURUSDT','BOMEUSDT','BONKUSDT','BSWUSDT','CAKEUSDT',
  'CELOUSDT','CELRUSDT','CFXUSDT','CHRUSDT','CHZUSDT',
  'COMPUSDT','COTIUSDT','CRVUSDT','CTSIUSDT','CYBERUSDT',
  'DARUSDT','DASHUSDT','DENTUSDT','DEXEUSDT','DGBUSDT',
  'DODOUSDT','DYDXUSDT','EDUUSDT','ENAUSDT','ENJUSDT',
  'ENSUSDT','ETCUSDT','ETHFIUSDT','FIDAUSDT','FLMUSDT',
  'FLOWUSDT','FLUXUSDT','FRONTUSDT','FXSUSDT','GLMUSDT',
  'GMXUSDT','HBARUSDT','HIFIUSDT','HOOKUSDT','HOTUSDT',
  'ICPUSDT','ICXUSDT','IDUSDT','ILVUSDT','IOSTUSDT',
  'IOTAUSDT','JASMYUSDT','JOEUSDT','JTOUSDT','JUPUSDT',
  'KASUSDT','KAVAUSDT','KNCUSDT','LDOUSDT','LEVERUSDT',
  'LINAUSDT','LQTYUSDT','LRCUSDT','MAGICUSDT','MASKUSDT',
  'MEMEUSDT','MINAUSDT','MOVRUSDT','MTLUSDT','NEOUSDT',
  'NKNUSDT','OCEANUSDT','OGNUSDT','OMGUSDT','ONEUSDT'
];

const TF_MAP = {
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '12h': '12h',
  '1d': '1d'
};

function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    https.get(reqUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function fetchKlines(symbol, interval, limit = 120) {
  const reqUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await httpsGet(reqUrl);
  if (!Array.isArray(raw)) throw new Error('Bad response');
  return raw.map(k => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    typical: (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3
  }));
}

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
  let vaVol = vol[pocIdx];
  let vaLo = pocIdx, vaHi = pocIdx;
  while (vaVol < target) {
    const nextLo = vaLo > 0 ? vol[vaLo - 1] : 0;
    const nextHi = vaHi < BINS - 1 ? vol[vaHi + 1] : 0;
    if (nextLo >= nextHi && vaLo > 0) { vaLo--; vaVol += nextLo; }
    else if (vaHi < BINS - 1) { vaHi++; vaVol += nextHi; }
    else break;
  }
  const vah = lo + (vaHi + 1) * binSize;
  const val = lo + vaLo * binSize;
  return { poc, vah, val, hi, lo };
}

function detectSignals(symbol, candles, tf) {
  const vp = calcVolumeProfile(candles);
  if (!vp) return [];
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = cur.close;
  const signals = [];
  const pct = (a, b) => Math.abs(a - b) / (b || 1) * 100;
  if (prev.close <= vp.vah && cur.close > vp.vah) {
    signals.push({ symbol, type: 'VAH', price, vp, strength: Math.min(100, Math.round(55 + pct(price, vp.vah) * 3)), tf });
  }
  if (prev.close < vp.val && cur.close >= vp.val && cur.close < vp.vah) {
    signals.push({ symbol, type: 'VAL', price, vp, strength: Math.min(100, Math.round(50 + pct(price, vp.val) * 5)), tf });
  }
  if (cur.low <= vp.poc * 1.003 && cur.close > vp.poc && prev.close <= vp.poc * 1.004) {
    signals.push({ symbol, type: 'POC', price, vp, strength: Math.min(100, Math.round(48 + pct(price, vp.poc) * 6)), tf });
  }
  return signals;
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function handleScan(res) {
  const tfs = Object.keys(TF_MAP);
  const allSignals = [];
  let scanned = 0;
  const jobs = [];
  for (const sym of SCAN_PAIRS) {
    for (const tf of tfs) {
      jobs.push({ sym, tf });
    }
  }
  const CONCURRENCY = 5;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ sym, tf }) => {
      try {
        const candles = await fetchKlines(sym, TF_MAP[tf], 120);
        const sigs = detectSignals(sym, candles, tf);
        allSignals.push(...sigs);
        scanned++;
      } catch(e) {}
    }));
    await new Promise(r => setTimeout(r, 100));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, scanned, signals: allSignals, ts: new Date().toISOString() }));
}

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const pathname = req.url.split('?')[0];

  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404); return res.end('index.html not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath));
  }

  if (pathname === '/api/scan') {
    try { await handleScan(res); }
    catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`VP SCREENER running on ${HOST}:${PORT}`);
});

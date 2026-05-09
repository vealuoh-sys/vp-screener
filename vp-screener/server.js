const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Top coins to scan by CoinGecko ID mapped to symbol
const COINS = [
  {id:'bitcoin',sym:'BTCUSDT'},{id:'ethereum',sym:'ETHUSDT'},
  {id:'binancecoin',sym:'BNBUSDT'},{id:'solana',sym:'SOLUSDT'},
  {id:'ripple',sym:'XRPUSDT'},{id:'cardano',sym:'ADAUSDT'},
  {id:'avalanche-2',sym:'AVAXUSDT'},{id:'dogecoin',sym:'DOGEUSDT'},
  {id:'polkadot',sym:'DOTUSDT'},{id:'chainlink',sym:'LINKUSDT'},
  {id:'cosmos',sym:'ATOMUSDT'},{id:'litecoin',sym:'LTCUSDT'},
  {id:'uniswap',sym:'UNIUSDT'},{id:'aave',sym:'AAVEUSDT'},
  {id:'near',sym:'NEARUSDT'},{id:'arbitrum',sym:'ARBUSDT'},
  {id:'optimism',sym:'OPUSDT'},{id:'injective-protocol',sym:'INJUSDT'},
  {id:'sui',sym:'SUIUSDT'},{id:'aptos',sym:'APTUSDT'},
  {id:'fetch-ai',sym:'FETUSDT'},{id:'thorchain',sym:'RUNEUSDT'},
  {id:'immutable-x',sym:'IMXUSDT'},{id:'the-sandbox',sym:'SANDUSDT'},
  {id:'decentraland',sym:'MANAUSDT'},{id:'axie-infinity',sym:'AXSUSDT'},
  {id:'fantom',sym:'FTMUSDT'},{id:'algorand',sym:'ALGOUSDT'},
  {id:'gala',sym:'GALAUSDT'},{id:'stepn',sym:'GMTUSDT'}
];

const TF_MAP = {
  '1h': { days: 2, interval: 'hourly' },
  '4h': { days: 7, interval: 'hourly' },
  '1d': { days: 30, interval: 'daily' }
};

let scanCache = { signals: [], scanned: 0, ts: null };

function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    };
    const req = https.get(reqUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function fetchOHLC(coinId, days) {
  // CoinGecko OHLC endpoint - free, no API key needed
  const reqUrl = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
  const raw = await httpsGet(reqUrl);
  if (!Array.isArray(raw) || raw.length < 10) throw new Error('Bad data');
  return raw.map(k => ({
    time: k[0],
    open: k[1],
    high: k[2],
    low: k[3],
    close: k[4],
    volume: 0,
    typical: (k[2] + k[3] + k[4]) / 3
  }));
}

async function fetchVolume(coinId) {
  // Get market data for volume
  const reqUrl = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=7&interval=daily`;
  const raw = await httpsGet(reqUrl);
  return raw.total_volumes || [];
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
  candles.forEach((c, i) => {
    const idx = Math.min(Math.floor((c.typical - lo) / binSize), BINS - 1);
    vol[idx] += (i + 1); // use position as proxy for volume weight
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
  const allSignals = [];
  let scanned = 0;

  // CoinGecko free tier: max 10-30 req/min, so scan one by one with delay
  for (const coin of COINS) {
    for (const [tf, cfg] of Object.entries(TF_MAP)) {
      try {
        const candles = await fetchOHLC(coin.id, cfg.days);
        allSignals.push(...detectSignals(coin.sym, candles, tf));
        scanned++;
      } catch(e) {
        console.log(`[WARN] ${coin.id}/${tf}: ${e.message}`);
      }
      // Rate limit: wait 2 seconds between requests for free tier
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  scanCache = { signals: allSignals, scanned, ts: new Date().toISOString() };
  console.log(`[SCAN] ${scanned} scanned, ${allSignals.length} signals`);
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
    res.end(JSON.stringify({
      ok: true,
      scanned: scanCache.scanned,
      signals: scanCache.signals,
      ts: scanCache.ts || new Date().toISOString()
    }));
    return;
  }

  if (pathname === '/api/candles') {
    const coinId = parsed.query.coinid || 'bitcoin';
    const days = parseInt(parsed.query.days) || 7;
    try {
      const candles = await fetchOHLC(coinId, days);
      const vp = calcVolumeProfile(candles);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, candles, vp }));
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
  // Start scan after 5 seconds
  setTimeout(() => runBackgroundScan().catch(console.error), 5000);
  // Repeat every 15 minutes (CoinGecko rate limits)
  setInterval(() => runBackgroundScan().catch(console.error), 15 * 60 * 1000);
});

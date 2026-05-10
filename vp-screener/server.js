const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const TD_KEY = 'ab77d587bb6d4d6082a53394420848d3';
const TG_TOKEN = '8792428538:AAEEVMRVjeR7PytpTeSDG m3morZQ20QGaEw'.replace(' ','');
const TG_CHAT = '8137954593';

const SCAN_PAIRS = [
  'BTC/USD','ETH/USD','BNB/USD','SOL/USD','XRP/USD',
  'ADA/USD','AVAX/USD','DOGE/USD','DOT/USD','MATIC/USD',
  'LINK/USD','ATOM/USD','LTC/USD','UNI/USD','AAVE/USD',
  'NEAR/USD','FIL/USD','ARB/USD','OP/USD','INJ/USD',
  'SUI/USD','APT/USD','TIA/USD','FET/USD','RUNE/USD',
  'STX/USD','IMX/USD','SAND/USD','MANA/USD','AXS/USD',
  'FTM/USD','ALGO/USD','GALA/USD','APE/USD','GMT/USD',
  'EGLD/USD','CRV/USD','MKR/USD','SNX/USD','COMP/USD',
  'YFI/USD','SUSHI/USD','GRT/USD','ENS/USD','LDO/USD',
  'RPL/USD','BAL/USD','DYDX/USD','GMX/USD','CAKE/USD',
  'XLM/USD','VET/USD','HBAR/USD','ICP/USD','ETC/USD',
  'XMR/USD','BCH/USD','ZEC/USD','DASH/USD','NEO/USD',
  'ZIL/USD','ANKR/USD','CHZ/USD','MINA/USD','FLOW/USD',
  'ROSE/USD','KSM/USD','ZRX/USD','BAT/USD','NMR/USD',
  'BLUR/USD','MAGIC/USD','SSV/USD','WOO/USD','CRO/USD',
  'OKB/USD','HT/USD','KCS/USD','LEO/USD','QNT/USD',
  'RNDR/USD','OCEAN/USD','FXS/USD','CVX/USD','PERP/USD',
  'REN/USD','GNO/USD','BAND/USD','RSR/USD','ORN/USD',
  'ALPHA/USD','BADGER/USD','BNT/USD','MLN/USD','POND/USD'
];

const TF_MAP = {
  '1h': '1h',
  '4h': '4h'
};

let scanCache = { signals: [], scanned: 0, ts: null };
let lastAlertedSignals = new Set();

// ── Telegram alert ────────────────────────────────────────────────
function sendTelegram(message) {
  return new Promise((resolve) => {
    const text = encodeURIComponent(message);
    const reqUrl = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT}&text=${text}&parse_mode=HTML`;
    https.get(reqUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('[TG]', data.substring(0, 80));
        resolve();
      });
    }).on('error', (e) => {
      console.log('[TG ERROR]', e.message);
      resolve();
    });
  });
}

function alertSignal(signal) {
  const key = `${signal.symbol}-${signal.type}-${signal.tf}`;
  if (lastAlertedSignals.has(key)) return; // don't repeat same signal
  lastAlertedSignals.add(key);

  const emoji = signal.type === 'VAH' ? '🚀' : signal.type === 'VAL' ? '🟢' : '🎯';
  const label = signal.type === 'VAH' ? 'VAH BREAK ▲' : signal.type === 'VAL' ? 'VAL RECLAIM ▼' : 'POC REACT ◆';

  const msg = `${emoji} <b>VP SIGNAL ALERT</b>

<b>${signal.symbol}</b> — ${label}
⏱ Timeframe: <b>${signal.tf.toUpperCase()}</b>
💰 Price: <b>$${signal.price.toFixed(6)}</b>

📊 VP Levels:
🔴 VAH: $${signal.vp.vah.toFixed(6)}
🟡 POC: $${signal.vp.poc.toFixed(6)}
🟢 VAL: $${signal.vp.val.toFixed(6)}

💪 Strength: ${signal.strength}%
🌐 vp-screener.up.railway.app`;

  sendTelegram(msg).catch(console.error);
}

// ── HTTP helper ───────────────────────────────────────────────────
function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    const req = https.get(reqUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function fetchKlines(symbol, interval, limit) {
  limit = limit || 60;
  const reqUrl = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${limit}&apikey=${TD_KEY}&format=JSON`;
  const raw = await httpsGet(reqUrl);
  if (!raw || !raw.values || !Array.isArray(raw.values))
    throw new Error(raw && raw.message ? raw.message : 'Bad response');
  return raw.values.reverse().map(k => ({
    time: new Date(k.datetime).getTime(),
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
    volume: parseFloat(k.volume || 0),
    typical: (parseFloat(k.high) + parseFloat(k.low) + parseFloat(k.close)) / 3
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
    vol[idx] += (c.volume > 0 ? c.volume : 1);
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
  const sym = symbol.replace('/','') + 'T';
  if (prev.close <= vp.vah && cur.close > vp.vah)
    signals.push({ symbol: sym, type: 'VAH', price, vp, strength: Math.min(100, Math.round(55 + pct(price, vp.vah) * 3)), tf });
  if (prev.close < vp.val && cur.close >= vp.val && cur.close < vp.vah)
    signals.push({ symbol: sym, type: 'VAL', price, vp, strength: Math.min(100, Math.round(50 + pct(price, vp.val) * 5)), tf });
  if (cur.low <= vp.poc * 1.003 && cur.close > vp.poc && prev.close <= vp.poc * 1.004)
    signals.push({ symbol: sym, type: 'POC', price, vp, strength: Math.min(100, Math.round(48 + pct(price, vp.poc) * 6)), tf });
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

  for (const sym of SCAN_PAIRS) {
    for (const tf of Object.keys(TF_MAP)) {
      try {
        const candles = await fetchKlines(sym, TF_MAP[tf], 60);
        const sigs = detectSignals(sym, candles, tf);
        sigs.forEach(s => alertSignal(s)); // send Telegram alert
        allSignals.push(...sigs);
        scanned++;
        console.log(`[OK] ${sym}/${tf}`);
      } catch(e) {
        console.log(`[WARN] ${sym}/${tf}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  scanCache = { signals: allSignals, scanned, ts: new Date().toISOString() };
  console.log(`[SCAN DONE] ${scanned} scanned, ${allSignals.length} signals`);

  // Clear alerted signals after each full scan so new ones can alert again
  lastAlertedSignals.clear();
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
    const symbol = parsed.query.symbol || 'BTC/USD';
    const interval = parsed.query.interval || '1h';
    const tdInterval = TF_MAP[interval] || '1h';
    try {
      const candles = await fetchKlines(symbol, tdInterval, 100);
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
  // Send startup message
  sendTelegram('🟢 <b>VP SCREENER ONLINE</b>\nServer started. First scan beginning now...').catch(console.error);
  setTimeout(() => runBackgroundScan().catch(console.error), 3000);
  setInterval(() => runBackgroundScan().catch(console.error), 3 * 60 * 60 * 1000);
});

'use strict';
// Vertex Hunter UI. All numbers come from the backend API; nothing here is generated or mocked.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokenQ = new URLSearchParams(location.search).get('token');
const api = async (p, opt) => {
  const r = await fetch(p + (tokenQ ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tokenQ) : ''), opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const post = (p, b) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) });

const fmtP = (x) => (x == null ? 'n/a' : x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x >= 0.01 ? x.toFixed(5) : x.toPrecision(4));
const fmtPct = (x, d = 2) => (x == null ? 'n/a' : (x > 0 ? '+' : '') + x.toFixed(d) + '%');
const fmtUsd = (x, d = 2) => (x == null ? 'n/a' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(d));
const fmtVol = (x) => (x == null ? 'n/a' : x >= 1e9 ? '$' + (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : '$' + (x / 1e3).toFixed(0) + 'K');
const cls = (x) => (x == null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const dur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : s < 172800 ? (s / 3600).toFixed(1) + 'h' : Math.round(s / 86400) + 'd'; };
const ts = (t) => new Date(t).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

let tab = 'scanner';
let health = null;
let detailSymbol = null;
let chart = null, candleSeries = null, volSeries = null, lines = [];
const seenCand = new Set();

// ------------------------------------------------------------------ navigation
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  tab = b.dataset.tab;
  $$('#nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + tab));
  refresh(true);
});

// ------------------------------------------------------------------ health
function renderHealth(h, extra) {
  health = h;
  const pill = $('#healthPill');
  pill.className = 'pill ' + ({ LIVE: 'live', DELAYED: 'delayed', STALE: 'stale', DISCONNECTED: 'disc' }[h.state] || 'disc');
  $('span', pill).textContent = h.state === 'LIVE' ? 'LIVE DATA' : h.state === 'DELAYED' ? 'DELAYED DATA' : h.state === 'STALE' ? 'STALE DATA' : 'DISCONNECTED';
  $('#healthDetail').textContent = h.ageMs == null ? h.reason : `last update ${dur(h.ageMs)} ago` + (h.state !== 'LIVE' ? ' · ' + h.reason : '');
  const b = $('#banner');
  if (h.state === 'LIVE') b.hidden = true;
  else {
    b.hidden = false; b.className = 'banner ' + (h.state === 'DISCONNECTED' ? 'bad' : 'warn');
    b.textContent = `${$('span', pill).textContent}: ${h.reason}. New actionable signals and paper entries are PAUSED until live data recovers. Open virtual positions are still tracked.`;
  }
}

// ------------------------------------------------------------------ scanner
async function loadScanner() {
  const [s, m, st] = await Promise.all([api('/api/shortlist'), api('/api/market'), api('/api/status')]);
  renderHealth(s.health);
  const tb = $('#shortlist tbody');
  const existing = new Map($$('tr', tb).map((r) => [r.dataset.sym, r]));
  tb.innerHTML = s.items.map((i) => {
    const bull = i.direction === 'LONG', conf = i.state === 'CONFIRMED_SETUP';
    const color = i.status === 'DETERIORATING' ? 'a' : conf ? (bull ? 'g' : 'r') : 'a';
    const label = i.status === 'DETERIORATING' ? 'DETERIORATING' : conf ? 'CONFIRMED ' + i.direction : (bull ? 'LONG WATCH' : 'SHORT WATCH');
    const bcls = color === 'g' ? 'b-g' : color === 'r' ? 'b-r' : 'b-a';
    const isNew = !seenCand.has(i.symbol + i.direction); seenCand.add(i.symbol + i.direction);
    const spark = i.scoreHistory.length > 1 ? sparkline(i.scoreHistory) : '';
    return `<tr class="row ${isNew ? 'enter' : ''}" data-sym="${esc(i.symbol)}"><td><span class="sig ${color} ${i.status === 'DETERIORATING' ? 'det' : ''}"></span></td><td><b>${esc(i.symbol.replace('_', ''))}</b></td><td><span class="badge ${bcls}">${label}</span></td><td class="num"><span class="scorebar"><i style="width:${Math.min(100, i.score)}%"></i></span>${i.score.toFixed(0)}</td><td>${spark}</td><td class="num">${fmtP(i.price)}</td><td class="num ${cls(i.change24hPct)}">${fmtPct(i.change24hPct, 1)}</td><td class="num">${fmtVol(i.usdVolume24h)}</td><td><span class="badge ${i.risk.level === 'HIGH' ? 'b-r' : i.risk.level === 'MEDIUM' ? 'b-a' : 'b-d'}">${i.risk.level}</span></td><td class="small">${esc((i.reasons[0] || '').slice(0, 90))}</td><td class="num dim">${dur(i.ageMs)}</td></tr>`;
  }).join('');
  void existing;
  const empty = $('#scanEmpty');
  empty.hidden = s.items.length > 0;
  if (!s.items.length) {
    const sc = st.scan;
    empty.innerHTML = `<div class="scanline"></div>${s.health.state === 'LIVE' ? 'Scanning. No contract currently meets the score threshold and filters (this is normal most of the time).' : 'Waiting for live data.'}<br><span class="small">${sc.evaluated} contracts evaluated · ${st.contracts.eligible} eligible · ${st.contracts.tickers} tickers · skipped: ${esc(JSON.stringify(sc.skipped))}</span>`;
  }
  $('#scanMeta').innerHTML = `${st.contracts.eligible} eligible contracts · ${st.scan.evaluated} evaluated · scan ${st.scan.durationMs}ms<br>WS ${st.ws?.connected ? 'connected' : 'down'} (${st.ws?.reconnects ?? 0} reconnects) · REST ok ${st.rest.lastTickerOk ? dur(Date.now() - st.rest.lastTickerOk) + ' ago' : 'never'} · dup/out-of-order dropped ${st.ingest.duplicates}/${st.ingest.outOfOrder}`;
  $('#market tbody').innerHTML = m.rows.slice(0, 25).map((r) => `<tr class="row" data-sym="${esc(r.symbol)}"><td>${esc(r.symbol.replace('_', ''))}</td><td class="num">${fmtP(r.last)}</td><td class="num ${cls(r.change24hPct)}">${fmtPct(r.change24hPct, 1)}</td><td class="num">${fmtVol(r.usdVolume24h)}</td></tr>`).join('');
}
function sparkline(a) {
  const w = 56, h = 16, mn = Math.min(...a), mx = Math.max(...a, mn + 1);
  const pts = a.map((v, i) => `${(i / (a.length - 1)) * w},${h - ((v - mn) / (mx - mn)) * h}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="#27e6ff" stroke-width="1.2" points="${pts}"/></svg>`;
}
document.addEventListener('click', (e) => { const r = e.target.closest('tr.row[data-sym]'); if (r) openDetail(r.dataset.sym); const h = e.target.closest('tr[data-signal]'); if (h) openDetail(h.dataset.sym); });

// ------------------------------------------------------------------ detail panel
async function openDetail(symbol, interval) {
  detailSymbol = symbol;
  $('#detail').hidden = false;
  const iv = interval || $('#dInterval').value;
  let d;
  try { d = await api(`/api/coin/${encodeURIComponent(symbol)}?interval=${iv}`); } catch (e) { $('#dBody').innerHTML = `<div class="warnbox">Cannot load ${esc(symbol)}: ${esc(e.message)}</div>`; return; }
  const c = d.candidate;
  $('#dTitle').textContent = symbol.replace('_', '') + ' PERP';
  $('#dBadge').innerHTML = c ? `<span class="badge ${c.state === 'CONFIRMED_SETUP' ? (c.direction === 'LONG' ? 'b-g' : 'b-r') : 'b-a'}">${esc(c.state.replace('_', ' '))} · ${c.direction}</span>` : '<span class="badge b-d">NOT ON SHORTLIST</span>';
  $('#dSub').textContent = `${d.contract.baseCoin}/${d.contract.quoteCoin} · tick ${d.contract.priceUnit} · contract size ${d.contract.contractSize} · max lev ${d.contract.maxLeverage}x · taker ${(d.contract.takerFeeRate * 100).toFixed(3)}%`;
  $('#dPrice').textContent = fmtP(d.ticker.last);
  $('#dChange').innerHTML = `<span class="${cls(d.change24hPct)}">${fmtPct(d.change24hPct, 2)} 24h</span> <span class="dim small">· updated ${dur(Date.now() - d.ticker.receivedTs)} ago · ${d.ticker.source}</span>`;
  drawChart(d);
  const t = d.ticker;
  const unavail = (v, f) => (v == null ? '<span class="dim">unavailable</span>' : f(v));
  let html = `<div class="kv">
    <div><span>24h turnover (est.)</span><span>${unavail(d.usdVolume24h, fmtVol)}</span></div>
    <div><span>Open interest</span><span>${unavail(t.holdVol, (v) => v.toLocaleString() + ' ct')}</span></div>
    <div><span>Funding rate</span><span>${unavail(t.fundingRate, (v) => (v * 100).toFixed(4) + '%')}</span></div>
    <div><span>Spread</span><span>${unavail(d.spreadBps, (v) => v.toFixed(1) + ' bps')}</span></div>
    <div><span>24h high / low</span><span>${fmtP(t.high24)} / ${fmtP(t.low24)}</span></div>
    <div><span>Fair / index</span><span>${fmtP(t.fairPrice)} / ${fmtP(t.indexPrice)}</span></div>
    <div><span>OI change (30m)</span><span>${unavail(d.oi30m, (v) => fmtPct(v.oiPct * 100, 2) + ' (price ' + fmtPct(v.pricePct * 100, 2) + ')')}</span></div>
    <div><span>Tick age</span><span>${dur(Date.now() - t.receivedTs)}</span></div></div>`;
  if (c) {
    html += `<h3>Signal analysis</h3><div class="small">Score <b>${c.score.toFixed(1)}</b> (raw ${c.rawScore.toFixed(1)}) — a ranking score, <b>not</b> a probability. Risk <span class="badge ${c.risk.level === 'HIGH' ? 'b-r' : c.risk.level === 'MEDIUM' ? 'b-a' : 'b-d'}">${c.risk.level}</span></div>`;
    html += `<h3>Why</h3><ul class="reasons">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li class="dim">no component exceeded its reporting threshold</li>'}</ul>`;
    html += `<h3>Score components</h3>` + c.components.map((k) => `<div class="comp ${k.available ? '' : 'off'}" title="${esc(k.detail)}"><span>${esc(k.key)} <span class="dim">w${k.weight}</span></span><div class="bar"><i style="width:${k.available ? k.score : 0}%"></i></div><span class="num">${k.available ? k.score.toFixed(0) : 'n/a'}</span></div><div class="small dim" style="margin:-2px 0 4px 104px">${esc(k.detail)}</div>`).join('');
    if (c.penalties.length) html += `<h3>Penalties</h3><ul class="reasons">${c.penalties.map((p) => `<li class="amb">-${p.points}: ${esc(p.detail)}</li>`).join('')}</ul>`;
    if (c.unavailable.length) html += `<h3>Unavailable inputs (excluded from score)</h3><ul class="reasons dim">${c.unavailable.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>`;
    if (c.filters.failures.length) html += `<h3>Filters failed</h3><ul class="reasons neg">${c.filters.failures.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>`;
    html += `<h3>Reference levels (hypothetical)</h3><div class="kv"><div><span>Entry reference</span><span>${fmtP(c.entryRef)}</span></div><div><span>Invalidation</span><span class="neg">${fmtP(c.invalidation)}</span></div><div><span>Target</span><span class="pos">${fmtP(c.target)}</span></div><div><span>Stop distance</span><span>${c.stopPct != null ? c.stopPct.toFixed(2) + '%' : 'n/a'}</span></div></div>`;
    if (c.risk.flags.length) html += `<div class="small amb">Risk flags: ${c.risk.flags.map(esc).join(' · ')}</div>`;
    html += `<h3>Measured metrics</h3><div class="kv">${Object.entries(c.metrics).filter(([, v]) => v !== undefined).map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(typeof v === 'number' ? +v.toPrecision(5) : v)}</span></div>`).join('')}</div>`;
  } else html += `<div class="empty small">This contract does not currently qualify. Live market statistics are shown above; there is no analysis to display.</div>`;
  if (d.position) {
    const p = d.position;
    html += `<h3>Virtual position</h3><div class="kv"><div><span>Side</span><span>${p.direction}</span></div><div><span>Contracts</span><span>${p.contracts}</span></div><div><span>Avg entry</span><span>${fmtP(p.avg_entry)}</span></div><div><span>Margin</span><span>${fmtUsd(p.margin)}</span></div><div><span>Stop</span><span>${fmtP(p.stop_price)}</span></div><div><span>Target</span><span>${fmtP(p.target_price)}</span></div></div>`;
  }
  html += `<h3>Signal history for this contract</h3>` + (d.signals.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Dir</th><th>State</th><th class="num">Entry</th><th class="num">Gross</th><th class="num">Net est.</th><th>Status</th></tr></thead><tbody>${d.signals.map((s) => `<tr><td>${ts(s.createdAt)}</td><td>${s.direction}</td><td>${esc(s.state.replace('_', ' '))}</td><td class="num">${fmtP(s.entryPrice)}</td><td class="num ${cls(s.grossRoiPct)}">${fmtPct(s.grossRoiPct)}</td><td class="num ${cls(s.estNetRoiPct)}">${fmtPct(s.estNetRoiPct)}</td><td>${esc(s.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="dim small">No recorded signals for this contract.</div>');
  $('#dBody').innerHTML = html;
}
function drawChart(d) {
  const el = $('#chart');
  if (!window.LightweightCharts) { el.innerHTML = '<div class="warnbox">Chart library not loaded.</div>'; return; }
  if (!chart) {
    chart = LightweightCharts.createChart(el, { layout: { background: { color: '#060b15' }, textColor: '#6f84a0' }, grid: { vertLines: { color: '#0f1b30' }, horzLines: { color: '#0f1b30' } }, rightPriceScale: { borderColor: '#16243b' }, timeScale: { borderColor: '#16243b', timeVisible: true }, autoSize: true });
    candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, { upColor: '#19e68c', downColor: '#ff4d5e', borderVisible: false, wickUpColor: '#19e68c', wickDownColor: '#ff4d5e' });
    volSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  }
  candleSeries.setData(d.candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
  volSeries.setData(d.candles.map((c) => ({ time: c.t, value: c.v, color: c.c >= c.o ? 'rgba(25,230,140,.35)' : 'rgba(255,77,94,.35)' })));
  for (const l of lines) candleSeries.removePriceLine(l);
  lines = [];
  const addLine = (price, color, title) => { if (price) lines.push(candleSeries.createPriceLine({ price, color, lineStyle: 2, lineWidth: 1, title })); };
  if (d.candidate) { addLine(d.candidate.entryRef, '#27e6ff', 'entry ref'); addLine(d.candidate.invalidation, '#ff4d5e', 'invalidation'); addLine(d.candidate.target, '#19e68c', 'target'); }
  chart.timeScale().fitContent();
}
$('#dClose').onclick = () => { $('#detail').hidden = true; detailSymbol = null; };
$('#dInterval').onchange = () => detailSymbol && openDetail(detailSymbol);

// ------------------------------------------------------------------ history
async function loadHistory() {
  const q = new URLSearchParams(); const st = $('#histStatus').value, sy = $('#histSymbol').value.trim().toUpperCase();
  if (st) q.set('status', st); if (sy) q.set('symbol', sy.includes('_') ? sy : sy.replace(/USDT$/, '') + '_USDT');
  const { items } = await api('/api/signals?' + q);
  $('#histTable tbody').innerHTML = items.length ? items.map((s) => `<tr class="row" data-signal="${esc(s.id)}" data-sym="${esc(s.symbol)}"><td>${ts(s.createdAt)}</td><td><b>${esc(s.symbol.replace('_', ''))}</b></td><td><span class="badge ${s.direction === 'LONG' ? 'b-g' : 'b-r'}">${s.direction}</span></td><td>${esc(s.state.replace('_', ' '))}</td><td class="num">${fmtP(s.entryPrice)}</td><td class="num">${fmtP(s.exitPrice ?? s.lastPrice)}</td><td class="num">${dur(s.elapsedMs)}</td><td class="num ${cls(s.grossRoiPct)}">${fmtPct(s.grossRoiPct)}</td><td class="num ${cls(s.estNetRoiPct)}">${fmtPct(s.estNetRoiPct)}</td><td class="num dim">${fmtPct(s.mfePct, 1)} / ${fmtPct(s.maePct, 1)}</td><td><span class="badge ${s.status === 'OPEN' ? 'b-c' : s.status === 'TARGET' ? 'b-g' : s.status === 'INVALIDATED' ? 'b-r' : 'b-d'}">${esc(s.status)}</span></td><td class="num">${s.score.toFixed(0)}</td></tr>`).join('') : '<tr><td colspan="12" class="dim" style="padding:24px;text-align:center">No signals recorded yet. Signals appear only while data is LIVE and a contract qualifies.</td></tr>';
}
$('#histStatus').onchange = loadHistory; $('#histSymbol').oninput = () => { clearTimeout(loadHistory.t); loadHistory.t = setTimeout(loadHistory, 300); };

// ------------------------------------------------------------------ wallet
async function loadWallet() {
  const [w, a] = await Promise.all([api('/api/wallet'), api('/api/activity')]);
  renderHealth(w.health);
  const s = w.summary;
  $('#walletCards').innerHTML = [
    ['Equity (mark-to-market)', fmtUsd(s.equity), cls(s.equity - s.initial)], ['Total return', fmtPct(s.totalReturnPct), cls(s.totalReturnPct)], ['Free cash', fmtUsd(s.cash)], ['Margin in use', fmtUsd(s.marginInUse)],
    ['Unrealised (gross)', fmtUsd(s.unrealized), cls(s.unrealized)], ['Realised (net)', fmtUsd(s.realizedPnl), cls(s.realizedPnl)], ['Initial', fmtUsd(s.initial)],
    ['Ledger check', s.reconcile.ok ? 'RECONCILED' : 'MISMATCH', s.reconcile.ok ? 'pos' : 'neg'],
  ].map(([k, v, c]) => `<div class="card"><div class="k">${k}</div><div class="v ${c || ''}">${v}</div></div>`).join('');
  $('#posTable tbody').innerHTML = w.positions.length ? w.positions.map((p) => `<tr class="row" data-sym="${esc(p.symbol)}"><td><b>${esc(p.symbol.replace('_', ''))}</b></td><td><span class="badge ${p.direction === 'LONG' ? 'b-g' : 'b-r'}">${p.direction}</span></td><td class="num">${p.contracts}</td><td class="num">${fmtP(p.avg_entry)}</td><td class="num">${fmtP(p.mark)}</td><td class="num">${fmtUsd(p.margin)}</td><td class="num ${cls(p.underlyingPct)}">${fmtPct(p.underlyingPct)}</td><td class="num ${cls(p.netUnrealized)}">${fmtUsd(p.netUnrealized, 3)}</td><td class="num ${cls(p.marginRoiPct)}">${fmtPct(p.marginRoiPct)}</td><td class="num dim">${fmtP(p.stop_price)} / ${fmtP(p.target_price)}</td></tr>`).join('') : '<tr><td colspan="10" class="dim" style="padding:20px;text-align:center">No open virtual positions.</td></tr>';
  $('#closedTable tbody').innerHTML = w.history.length ? w.history.map((p) => `<tr><td>${ts(p.closed_at)}</td><td>${esc(p.symbol.replace('_', ''))}</td><td>${p.direction}</td><td class="num">${fmtP(p.avg_entry)}</td><td class="num ${cls(p.realized_pnl)}">${fmtUsd(p.realized_pnl, 3)}</td></tr>`).join('') : '<tr><td colspan="5" class="dim" style="padding:14px;text-align:center">No closed positions.</td></tr>';
  $('#activity').innerHTML = a.items.length ? a.items.map((e) => `<div class="it"><div class="t">${ts(e.ts)} · <span class="badge ${e.type === 'REJECT' ? 'b-a' : e.type === 'CLOSE' || e.type === 'REDUCE' ? 'b-c' : e.type === 'FUNDING' ? 'b-d' : 'b-g'}">${e.type}</span> ${esc(e.symbol ?? '')} ${esc(e.direction ?? '')} · strategy ${esc(e.strategy_version ?? '')} cfg#${e.config_version ?? '-'}</div><div class="small">${e.price != null ? `fill ${fmtP(e.price)} · ` : ''}${e.contracts != null ? `qty ${e.contracts} · ` : ''}fees ${fmtUsd(e.fees, 4)} · cash ${fmtUsd(e.cash_delta, 3)}${e.type === 'CLOSE' || e.type === 'REDUCE' ? ` · realised ${fmtUsd(e.realized_pnl_delta, 3)}` : ''}</div><div class="small dim">${esc(e.reason)}</div></div>`).join('') : '<div class="it dim">No wallet activity yet. The AI wallet only acts on CONFIRMED setups while data is LIVE.</div>';
  drawEquity(w.equityCurve);
}
function drawEquity(pts) {
  const cv = $('#eqChart'); const ctx = cv.getContext('2d'); const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = 150 * devicePixelRatio; ctx.clearRect(0, 0, W, H);
  if (pts.length < 2) { ctx.fillStyle = '#6f84a0'; ctx.font = `${12 * devicePixelRatio}px sans-serif`; ctx.fillText('Equity history builds up while the feed is live (one point per 30s)', 10, 24 * devicePixelRatio); return; }
  const ys = pts.map((p) => p.equity), mn = Math.min(...ys, 100) - 0.5, mx = Math.max(...ys, 100) + 0.5;
  ctx.strokeStyle = '#27e6ff'; ctx.lineWidth = 1.5 * devicePixelRatio; ctx.beginPath();
  pts.forEach((p, i) => { const x = (i / (pts.length - 1)) * W, y = H - ((p.equity - mn) / (mx - mn)) * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  ctx.strokeStyle = '#16243b'; ctx.setLineDash([4, 4]); const y100 = H - ((100 - mn) / (mx - mn)) * H; ctx.beginPath(); ctx.moveTo(0, y100); ctx.lineTo(W, y100); ctx.stroke(); ctx.setLineDash([]);
}

// ------------------------------------------------------------------ strategies & settings
async function loadStrategies() {
  const s = await api('/api/strategies');
  $('#stratVer').textContent = `Strategy version ${s.version}. Disabling a strategy removes its component from the score (remaining weights renormalise).`;
  $('#stratList').innerHTML = s.strategies.map((x) => `<div class="card"><div style="display:flex;justify-content:space-between"><b>${esc(x.name)}</b><label class="small"><input type="checkbox" data-strat="${esc(x.key)}" ${x.enabled ? 'checked' : ''}> enabled</label></div><div class="small" style="margin:8px 0">${esc(x.logic)}</div><div class="small dim">Inputs: ${esc(x.inputs)}</div></div>`).join('');
  $('#weights').innerHTML = `<div class="panel"><h3>Component weights</h3>${Object.entries(s.weights).map(([k, v]) => `<div class="comp"><span>${esc(k)}</span><div class="bar"><i style="width:${v * 250}%"></i></div><span class="num">${v}</span></div>`).join('')}<div class="small dim">Weights are applied only to inputs that are available for a contract. Order book, funding and OI components drop out when their data is missing. Edit them in Settings.</div></div>`;
}
document.addEventListener('change', async (e) => { const k = e.target.dataset?.strat; if (!k) return; try { await post('/api/config', { label: `${e.target.checked ? 'enable' : 'disable'} ${k}`, patch: { strategies: { [k]: { enabled: e.target.checked } } } }); toast('Strategy updated', k + (e.target.checked ? ' enabled' : ' disabled')); } catch (er) { toast('Rejected', er.message); } loadStrategies(); });

async function loadSettings() {
  const c = await api('/api/config');
  const cfg = c.active.config;
  const field = (path, v) => `<input data-path="${path}" type="${typeof v === 'boolean' ? 'checkbox' : 'number'}" step="any" ${typeof v === 'boolean' ? (v ? 'checked' : '') : `value="${v}"`}>`;
  const groups = ['risk', 'thresholds', 'weights', 'dataQuality'];
  $('#settingsBody').innerHTML = `<div class="warnbox">Paper trading only. Leverage here is a simulation parameter: margin ROI is shown separately from price movement and includes fees, slippage, funding and an estimated-liquidation cut-off.</div>
  <div class="panel"><div class="setrow"><span>AI wallet automation</span>${field('walletEnabled', cfg.walletEnabled)}</div>${groups.map((g) => `<h3>${g}</h3>` + Object.entries(cfg[g]).map(([k, v]) => `<div class="setrow"><span>${k}</span>${field(g + '.' + k, v)}</div>`).join('')).join('')}
  <div class="filters" style="margin-top:12px"><input id="cfgLabel" placeholder="Change note (optional)" style="width:260px"><button class="btn" id="cfgSave">Save as new version</button></div></div>
  <div class="panel"><h3>Config versions (active: #${c.active.version})</h3>${c.versions.map((v) => `<div class="setrow"><span>#${v.id} · ${esc(v.label)} <span class="dim small">${ts(v.created_at)}</span></span><span>${v.id === c.active.version ? '<span class="badge b-g">ACTIVE</span>' : `<button class="btn" data-revert="${v.id}">Activate</button>`}</span></div>`).join('')}</div>`;
  $('#cfgSave').onclick = async () => {
    const patch = {};
    $$('#settingsBody input[data-path]').forEach((i) => { const parts = i.dataset.path.split('.'); let o = patch; parts.slice(0, -1).forEach((p) => (o = o[p] ??= {})); o[parts.at(-1)] = i.type === 'checkbox' ? i.checked : Number(i.value); });
    try { const r = await post('/api/config', { patch, label: $('#cfgLabel').value || 'edited via UI' }); toast('Saved', 'Config version #' + r.version + ' is now active'); loadSettings(); } catch (er) { toast('Rejected', er.message); }
  };
  $$('[data-revert]').forEach((b) => (b.onclick = async () => { await post('/api/config/revert', { version: Number(b.dataset.revert) }); toast('Reverted', 'Activated config #' + b.dataset.revert); loadSettings(); }));
}

// ------------------------------------------------------------------ analytics
async function loadAnalytics() {
  const [a, ev, lb] = await Promise.all([api('/api/analytics'), api('/api/events-log?limit=120'), api('/api/backtest/latest')]);
  const w = a.wallet;
  $('#analyticsLive').innerHTML = [['Signals recorded', a.signalsTotal], ['Paper trades closed', w.closedTrades], ['Paper win rate', w.winRatePct == null ? 'n/a' : w.winRatePct.toFixed(0) + '%'], ['Paper profit factor', w.profitFactor == null ? 'n/a' : w.profitFactor.toFixed(2)], ['Sample size', w.sufficientSample ? 'adequate (>=30)' : 'TOO SMALL (<30)']].map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') +
    `<div class="panel" style="grid-column:1/-1"><h3>Live signal outcomes by state</h3>${tbl(a.byState)}<h3>By direction</h3>${tbl(a.byDirection)}<h3>Why the wallet declined entries</h3>${a.topRejections.length ? a.topRejections.map((r) => `<div class="small">${r.c}× ${esc(r.reason)}</div>`).join('') : '<span class="dim small">none yet</span>'}</div>`;
  $('#eventLog').innerHTML = ev.items.map((e) => `<div class="it"><span class="dim">${ts(e.ts)}</span> <span class="badge ${e.level === 'error' ? 'b-r' : e.level === 'warn' ? 'b-a' : 'b-d'}">${esc(e.kind)}</span> ${esc(e.message)}</div>`).join('');
  if (lb) renderBacktest(lb);
}
const tbl = (rows) => `<div class="table-wrap"><table><thead><tr><th>Group</th><th class="num">Signals</th><th class="num">Closed</th><th class="num">Win rate</th><th class="num">Avg gross</th><th class="num">Avg est. net</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.key)}</td><td class="num">${r.signals}</td><td class="num">${r.closed}</td><td class="num">${r.winRatePct == null ? 'n/a' : r.winRatePct.toFixed(0) + '%'}</td><td class="num ${cls(r.avgGrossPct)}">${fmtPct(r.avgGrossPct)}</td><td class="num ${cls(r.avgNetPct)}">${fmtPct(r.avgNetPct)}</td></tr>`).join('')}</tbody></table></div>`;
const mrow = (n, m) => `<tr><td>${n}</td><td class="num">${m.trades}</td><td class="num">${m.winRatePct == null ? 'n/a' : m.winRatePct.toFixed(0) + '%'}</td><td class="num">${fmtPct(m.expectancyPct)}</td><td class="num">${m.profitFactor == null ? 'n/a' : m.profitFactor === null ? 'n/a' : (isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞')}</td><td class="num ${cls(m.netReturnPct)}">${fmtPct(m.netReturnPct)}</td><td class="num">${m.maxDrawdownPct.toFixed(1)}%</td><td>${m.sufficientSample ? '' : '<span class="badge b-a">small sample</span>'}</td></tr>`;
function renderBacktest(r) {
  $('#btResult').innerHTML = `<div class="warnbox"><b>${esc(r.verdict.label.replace(/_/g, ' '))}</b>: ${esc(r.verdict.text)}</div>
  <div class="small dim">${esc(r.kind)} · ${r.params.symbols.length} contracts · ${r.params.days}d · ${r.signals} signals · ${esc(r.params.strategyVersion)} · ${esc(r.timeframe)} · generated ${ts(r.generatedAt)}<br>In-sample ends ${ts(r.dataRange.splitAt * 1000)}; everything after is unseen validation.</div>
  <div class="table-wrap"><table><thead><tr><th>Window</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">Expectancy</th><th class="num">Profit factor</th><th class="num">Net return</th><th class="num">Max DD</th><th></th></tr></thead><tbody>${mrow('All', r.all)}${mrow('In-sample', r.inSample)}${mrow('Out-of-sample', r.outOfSample)}${Object.entries(r.byState).map(([k, v]) => mrow('state: ' + esc(k), v)).join('')}${Object.entries(r.byRegime).map(([k, v]) => mrow('regime: ' + esc(k), v)).join('')}</tbody></table></div>
  <div class="small dim">Exits: ${esc(JSON.stringify(r.byExitReason))}</div><h3>Limitations</h3><ul class="reasons small">${r.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}
$('#btRun').onclick = async () => {
  const b = $('#btRun'); b.disabled = true; $('#btStatus').textContent = 'Downloading history and replaying bars... this can take a minute.';
  try { const r = await post('/api/backtest', { days: Number($('#btDays').value) }); renderBacktest(r); $('#btStatus').textContent = 'Done.'; } catch (e) { $('#btStatus').textContent = 'Failed: ' + e.message; } finally { b.disabled = false; }
};

// ------------------------------------------------------------------ notifications
let lastNotifId = Number(localStorage.getItem('vh_last_notif') || 0);
async function pollNotifs(initial) {
  const { items } = await api('/api/notifications');
  const fresh = items.filter((n) => n.id > lastNotifId).reverse();
  if (!initial) fresh.forEach((n) => toast(n.title, n.body));
  if (items.length) { lastNotifId = Math.max(lastNotifId, items[0].id); try { localStorage.setItem('vh_last_notif', String(lastNotifId)); } catch {} }
  const unread = items.filter((n) => !n.read).length;
  $('#bellCount').hidden = !unread; $('#bellCount').textContent = unread;
  if (!$('#notifPanel').hidden) $('#notifPanel').innerHTML = items.length ? items.map((n) => `<div class="it"><b>${esc(n.title)}</b><span class="small">${esc(n.body)}</span><div class="dim small">${ts(n.ts)}</div></div>`).join('') : '<div class="it dim">No notifications yet.</div>';
  if (!initial && fresh.length && 'Notification' in window && Notification.permission === 'granted') fresh.forEach((n) => new Notification(n.title, { body: n.body }));
}
$('#bell').onclick = async () => { const p = $('#notifPanel'); p.hidden = !p.hidden; if (!p.hidden) { await pollNotifs(true); await post('/api/notifications'); pollNotifs(true); if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } };
function toast(title, body) { const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<b>${esc(title)}</b><div class="small">${esc(body)}</div>`; $('#toasts').append(t); setTimeout(() => t.remove(), 7000); }

// ------------------------------------------------------------------ refresh loop + SSE
let busy = false;
async function refresh(force) {
  if (busy && !force) return; busy = true;
  try {
    if (tab === 'scanner') await loadScanner(); else if (tab === 'history') await loadHistory(); else if (tab === 'wallet') await loadWallet(); else if (tab === 'strategies') await loadStrategies(); else if (tab === 'analytics') await loadAnalytics(); else if (tab === 'settings' && force) await loadSettings();
    if (tab !== 'scanner') { const s = await api('/api/status'); renderHealth(s.health); }
    if (detailSymbol && !$('#detail').hidden && tab === 'scanner') { /* detail refreshed on a slower cadence below */ }
  } catch (e) { renderHealth({ state: 'DISCONNECTED', reason: 'cannot reach Vertex Hunter server: ' + e.message, ageMs: null }); } finally { busy = false; }
}
setInterval(() => refresh(), 2500);
setInterval(() => { if (detailSymbol && !$('#detail').hidden) openDetail(detailSymbol); }, 8000);
setInterval(() => pollNotifs(false).catch(() => {}), 4000);
try { const es = new EventSource('/api/events' + (tokenQ ? '?token=' + encodeURIComponent(tokenQ) : '')); es.addEventListener('notification', () => pollNotifs(false).catch(() => {})); es.onerror = () => {}; } catch {}
pollNotifs(true).catch(() => {}); refresh(true);

// ------------------------------------------------------------------ ambient particles (decorative only)
(function () {
  const cv = $('#particles'), ctx = cv.getContext('2d'); let W, H, ps = [];
  const size = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; ps = Array.from({ length: Math.min(70, Math.floor(W / 22)) }, () => ({ x: Math.random() * W, y: Math.random() * H, v: 0.08 + Math.random() * 0.22, r: 0.6 + Math.random() * 1.2 })); };
  size(); addEventListener('resize', size);
  (function loop() { ctx.clearRect(0, 0, W, H); ctx.fillStyle = 'rgba(39,230,255,.55)'; for (const p of ps) { p.y -= p.v; if (p.y < -4) { p.y = H + 4; p.x = Math.random() * W; } ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill(); } requestAnimationFrame(loop); })();
})();

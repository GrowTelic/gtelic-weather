// Hourly job: MET Norway Locationforecast 2.0 -> one GTelic weather JSON per property, published on GitHub Pages.
// Run: MET_CONTACT="contact@your-domain" node fetch-weather.mjs      (User-Agent becomes "GTelic/1.0 <contact>")
// Node 18+, no dependencies. Output: public/weather/<propertyId>.json and public/weather/status.json
// Exit codes: 0 every property is served with fresh data; 1 at least one property failed, was throttled or is stale
// (its previous file is kept); 2 configuration error.
// Origin: GTelic Guest App Approved v1 weather-job/fetch-weather.mjs. sleep(), code() and convert() are unchanged.
// Added for scale: nearby properties share one request (conservative radius, same time zone, similar altitude),
// request-level Expires / If-Modified-Since / 304 reuse, a global request interval, Retry-After and exponential
// backoff on 429, one retry on 5xx/network errors, a run-time budget with oldest-data-first ordering, status.json,
// day/night data (current.is_day, daily sunrise/sunset) computed from the coordinates, and an hourly series
// (next 48 h by default) taken from the same MET response.
// All limits below are this job's own conservative defaults, not official MET Norway limits.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? +process.env[k] : d);
const BASE = process.env.MET_BASE || 'https://api.met.no';
const PRODUCT = 'GTelic/1.0';
const CONTACT = (process.env.MET_CONTACT || '').trim();
const UA = process.env.MET_UA || (CONTACT ? `${PRODUCT} ${CONTACT}` : '');
const PLACEHOLDER = /example|your-domain|changeme|todo/i;
const OUT = process.env.OUT_DIR || 'public/weather';
const CFG = {
  intervalMs: env('MIN_INTERVAL_MS', env('GAP_MS', 1000)),   // minimum time between request starts (all workers together)
  concurrency: Math.max(1, env('CONCURRENCY', 1)),
  radiusKm: env('SHARE_RADIUS_KM', 1),                         // 0 disables sharing
  maxAltDiffM: env('SHARE_MAX_ALT_DIFF_M', 50),
  staleHours: env('STALE_ALERT_HOURS', 3),                     // served data older than this fails the run (the app drops data after 12 h)
  maxRuntimeMs: env('MAX_RUNTIME_MS', 40 * 60e3),              // stop starting new requests after this; the rest is deferred to the next run
  max429Retries: env('MAX_429_RETRIES', 2),
  backoffBaseMs: env('BACKOFF_BASE_MS', 30e3),
  maxBackoffMs: env('MAX_BACKOFF_MS', 300e3),
  retryDelayMs: env('RETRY_DELAY_MS', 2000),
  hourlyHours: Math.max(0, Math.min(60, env('HOURLY_HOURS', 48))),  // hourly steps kept in the feed (MET compact has hourly steps for about 2.5 days)                   // single retry after a 5xx or network error
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
function code(s) { s = String(s || '').replace(/_(day|night|polartwilight)$/, ''); if (/thunder/.test(s)) return 95; if (/snow/.test(s)) return 73; if (/sleet/.test(s)) return 67; if (/heavyrain/.test(s)) return 65; if (/lightrain/.test(s)) return 61; if (/rain/.test(s)) return 63; if (s === 'fog') return 45; const m = { clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3 }[s]; return m ?? 2; }

function convert(j, tz) {
  const ts = j?.properties?.timeseries || []; if (!ts.length) return null;
  const dk = t => new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
  const hr = t => +new Date(t).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
  const days = {};
  for (const x of ts) {
    const d = dk(x.time), i = x.data.instant.details, n6 = x.data.next_6_hours, n1 = x.data.next_1_hours;
    const o = days[d] ||= { t: [], pop: 0, code: null, cd: 99 };
    o.t.push(i.air_temperature);
    const am = n6?.details?.precipitation_amount ?? n1?.details?.precipitation_amount ?? 0;
    const pp = n6?.details?.probability_of_precipitation ?? (am >= 1 ? 70 : am >= 0.2 ? 35 : 0); // estimated when MET gives no probability
    o.pop = Math.max(o.pop, pp);
    const sy = n6?.summary?.symbol_code || n1?.summary?.symbol_code;
    if (sy) { const dist = Math.abs(hr(x.time) - 13); if (dist < o.cd) { o.cd = dist; o.code = code(sy); } }
  }
  const keys = Object.keys(days).sort().slice(0, 5);
  const i0 = ts[0].data.instant.details, n1 = ts[0].data.next_1_hours || ts[0].data.next_6_hours;
  const T = i0.air_temperature, ws = i0.wind_speed || 0, rh = i0.relative_humidity ?? 50;
  const e = rh / 100 * 6.105 * Math.exp(17.27 * T / (237.7 + T));
  return {
    fictional: false, live: true,
    current: { time: ts[0].time, temperature_2m: Math.round(T), apparent_temperature: Math.round(T + 0.33 * e - 0.7 * ws - 4), weather_code: code(n1?.summary?.symbol_code), is_day: 1, wind_speed_10m: Math.round(ws * 3.6) },
    daily: { time: keys, weather_code: keys.map(k => days[k].code ?? 2), temperature_2m_max: keys.map(k => Math.round(Math.max(...days[k].t))), temperature_2m_min: keys.map(k => Math.round(Math.min(...days[k].t))), precipitation_probability_max: keys.map(k => days[k].pop) },
    hourly: { time: [], precipitation_probability: [] }
  };
}


// ---- Day and night from coordinates (NOAA solar approximation, accurate to about a minute) ----
const RAD = Math.PI / 180;
function solar(date) {
  const d = new Date(date), y = d.getUTCFullYear();
  const doy = (Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 0)) / 864e5;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const g = (2 * Math.PI / 365) * (doy - 1 + (hour - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  return { decl, eqt, hour };
}
export function sunElevation(lat, lon, date) {
  const { decl, eqt, hour } = solar(date);
  const ha = ((hour * 60 + eqt + 4 * lon) / 4 - 180) * RAD;
  const cz = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cz))) / RAD;
}
export const isDay = (lat, lon, date) => (sunElevation(lat, lon, date) > -0.833 ? 1 : 0);
// Sunrise and sunset (UTC ISO) for a calendar date 'YYYY-MM-DD'; null during polar day or night.
export function sunTimes(lat, lon, ymd) {
  const [y, m, d] = ymd.split('-').map(Number), noon = Date.UTC(y, m - 1, d, 12);
  const { decl, eqt } = solar(noon);
  const c = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
  if (c < -1 || c > 1) return { sunrise: null, sunset: null };
  const h = Math.acos(c) / RAD, mid = Date.UTC(y, m - 1, d);
  const at = (min) => new Date(mid + Math.round(min * 60) * 1000).toISOString().replace('.000Z', 'Z');
  return { sunrise: at(720 - 4 * (lon + h) - eqt), sunset: at(720 - 4 * (lon - h) - eqt) };
}
export function addDayNight(w, lat, lon) {
  w.current.is_day = isDay(lat, lon, w.current.time || Date.now());
  const st = w.daily.time.map((k) => sunTimes(lat, lon, k));
  w.daily.sunrise = st.map((s) => s.sunrise);
  w.daily.sunset = st.map((s) => s.sunset);
  return w;
}

// ---- Hourly forecast from the same MET response (no extra request) ----
// Only MET's hourly steps (entries with next_1_hours) are used; nothing is interpolated or invented.
// time: local wall-clock time of the property ("YYYY-MM-DDTHH:mm", DST-correct through Intl); time_utc: the MET instant.
// precipitation: next_1_hours precipitation_amount (mm). precipitation_probability: MET's probability_of_precipitation
// when the response contains it, otherwise null (the compact product normally does not include it).
// apparent_temperature: derived from MET temperature, humidity and wind with the same formula as current (v1).
export function localTime(t, tz) {
  const d = new Date(t);
  const ymd = d.toLocaleDateString('en-CA', { timeZone: tz });
  const hm = d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).replace(/^24/, '00');
  return `${ymd}T${hm}`;
}
export function addHourly(w, j, tz, lat, lon, hours = CFG.hourlyHours) {
  const ts = (j?.properties?.timeseries || []).filter((x) => x?.data?.next_1_hours && x?.data?.instant?.details).slice(0, hours);
  const h = { time: [], time_utc: [], temperature_2m: [], apparent_temperature: [], weather_code: [], is_day: [], wind_speed_10m: [], precipitation: [], precipitation_probability: [] };
  for (const x of ts) {
    const i = x.data.instant.details, n1 = x.data.next_1_hours;
    const T = i.air_temperature, ws = i.wind_speed ?? null, rh = i.relative_humidity ?? null;
    h.time.push(localTime(x.time, tz)); h.time_utc.push(x.time);
    h.temperature_2m.push(Number.isFinite(T) ? Math.round(T) : null);
    if (Number.isFinite(T) && Number.isFinite(ws) && Number.isFinite(rh)) { const e = rh / 100 * 6.105 * Math.exp(17.27 * T / (237.7 + T)); h.apparent_temperature.push(Math.round(T + 0.33 * e - 0.7 * ws - 4)); } else h.apparent_temperature.push(null);
    h.weather_code.push(n1.summary?.symbol_code ? code(n1.summary.symbol_code) : null);
    h.is_day.push(isDay(lat, lon, Date.parse(x.time) + 1800e3));
    h.wind_speed_10m.push(Number.isFinite(ws) ? Math.round(ws * 3.6) : null);
    const pa = n1.details?.precipitation_amount; h.precipitation.push(Number.isFinite(pa) ? pa : null);
    const pp = n1.details?.probability_of_precipitation; h.precipitation_probability.push(Number.isFinite(pp) ? Math.round(pp) : null);
  }
  w.hourly = h;
  w.hourly_meta = { timezone: tz, hours: h.time.length, source: 'MET Norway Locationforecast 2.0 compact, next_1_hours', precipitation_probability_provided: h.precipitation_probability.some((v) => v !== null), apparent_temperature: 'derived from MET temperature, humidity and wind' };
  return w;
}

// ---- Grouping: nearby properties share one forecast request ----
export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const alt = (p) => (p.altitude === undefined || p.altitude === null || p.altitude === '' ? null : Math.round(+p.altitude));
const keyOf = (p) => `${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}${alt(p) === null ? '' : ',' + alt(p)}`;
function canShare(leader, p, radiusKm, maxAltDiffM) {
  if ((leader.tz || 'Europe/Athens') !== (p.tz || 'Europe/Athens')) return false;
  const a = alt(leader), b = alt(p);
  if ((a === null) !== (b === null)) return false;                // conservative: never mix known and unknown altitude
  if (a !== null && Math.abs(a - b) > maxAltDiffM) return false;
  return distanceKm(leader, p) <= radiusKm;
}
// Greedy, deterministic (input order): each property joins the nearest existing leader within the radius, or leads a
// new group. A spatial hash keeps it near O(n). Every member is within radiusKm of its leader, whose coordinates are used.
export function groupProperties(props, radiusKm = CFG.radiusKm, maxAltDiffM = CFG.maxAltDiffM) {
  const groups = [];
  if (!(radiusKm > 0)) { for (const p of props) groups.push({ key: keyOf(p), leader: p, members: [p] }); return mergeSameKey(groups); }
  const cell = radiusKm / 111, grid = new Map();
  for (const p of props) {
    const cy = Math.floor(p.lat / cell), cx = Math.floor(p.lon / cell);
    const span = Math.ceil(1 / Math.max(0.05, Math.cos(p.lat * RAD)));
    let best = null, bestD = Infinity;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - span; x <= cx + span; x++) {
      for (const g of grid.get(y + ':' + x) || []) {
        if (!canShare(g.leader, p, radiusKm, maxAltDiffM)) continue;
        const dd = distanceKm(g.leader, p); if (dd < bestD) { bestD = dd; best = g; }
      }
    }
    if (best) best.members.push(p);
    else { const g = { key: keyOf(p), leader: p, members: [p] }; groups.push(g); const k = cy + ':' + cx; grid.set(k, [...(grid.get(k) || []), g]); }
  }
  return groups;
}
function mergeSameKey(groups) { // identical coordinates always share, even with sharing disabled
  const m = new Map(); for (const g of groups) { const t = g.key + '|' + (g.leader.tz || ''); if (m.has(t)) m.get(t).members.push(...g.members); else m.set(t, g); }
  return [...m.values()];
}

// ---- Request pacing shared by all workers ----
function pacer(intervalMs) {
  let next = 0;
  return {
    async wait() { const now = Date.now(); const at = Math.max(now, next); next = at + intervalMs; if (at > now) await sleep(at - now); },
    pauseUntil(t) { next = Math.max(next, t); },
  };
}
function retryAfterMs(h) {
  if (!h) return null;
  const s = Number(h); if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h); return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

export { convert, code };

export async function run(cfg = CFG) {
  if (!UA || !/@|https?:\/\//.test(UA) || PLACEHOLDER.test(UA)) {
    console.error('Set MET_CONTACT to a real contact email or website (MET Norway requires an identifying User-Agent). Placeholders are refused.');
    return 2;
  }
  const t0 = Date.now();
  const props = JSON.parse(await readFile(process.env.PROPERTIES_FILE || new URL('./properties.json', import.meta.url)));
  const ids = new Set();
  for (const p of props) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(p.id || '') || ids.has(p.id)) { console.error('Invalid or duplicate property id:', p.id); return 2; }
    if (!(Math.abs(+p.lat) <= 90 && Math.abs(+p.lon) <= 180)) { console.error('Invalid coordinates for', p.id); return 2; }
    ids.add(p.id);
  }
  await mkdir(OUT, { recursive: true });
  const readOld = async (id) => { try { return JSON.parse(await readFile(`${OUT}/${id}.json`, 'utf8')); } catch { return null; } };
  const groups = groupProperties(props, cfg.radiusKm, cfg.maxAltDiffM);
  for (const g of groups) {
    g.old = {}; for (const m of g.members) g.old[m.id] = await readOld(m.id);
    // Request-level cache: the newest member file produced by this same request key carries Expires/Last-Modified.
    // Files written before sharing existed (no requestKey) still count as the cache for their own property.
    g.cache = Object.values(g.old).filter((o) => o?._met && (o._met.requestKey === g.key || (!o._met.requestKey && o === g.old[g.leader.id]))).sort((a, b) => Date.parse(b.generated) - Date.parse(a.generated))[0] || null;
    const ages = g.members.map((m) => (g.old[m.id]?.generated ? Date.parse(g.old[m.id].generated) : 0));
    g.priority = Math.min(...ages); // oldest (or missing) data first
  }
  groups.sort((a, b) => a.priority - b.priority);

  const results = new Map(props.map((p) => [p.id, { id: p.id, group: null, result: '', http: null, error: null }]));
  const set = (g, fields) => { for (const m of g.members) Object.assign(results.get(m.id), { group: g.key, shared: g.members.length > 1 ? g.members.length : undefined }, fields); };
  const writeAll = async (g, data, onlyMissing = false) => {
    for (const m of g.members) {
      if (onlyMissing && g.old[m.id]?._met?.requestKey === g.key) continue;
      const w = { ...data, _met: { ...data._met, requestKey: g.key, distanceKm: +distanceKm(g.leader, m).toFixed(3) } };
      await writeFile(`${OUT}/${m.id}.json`, JSON.stringify(w));
    }
  };
  const pace = pacer(cfg.intervalMs);
  let stopped = null, requests = 0, cursor = 0;

  async function fetchGroup(g) {
    const p = g.leader, old = g.cache;
    if (old?._met?.expires && Date.now() < old._met.expires) { await writeAll(g, old, true); set(g, { result: 'fresh-skipped' }); return; } // respect Expires
    const url = `${BASE}/weatherapi/locationforecast/2.0/compact?lat=${(+p.lat).toFixed(4)}&lon=${(+p.lon).toFixed(4)}${alt(p) === null ? '' : '&altitude=' + alt(p)}`;
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (old?._met?.lastModified) headers['If-Modified-Since'] = old._met.lastModified;
    let n429 = 0, retried = false;
    for (;;) {
      if (stopped) throw Object.assign(new Error(stopped), { kind: 'throttled' });
      await pace.wait(); requests++;
      let r;
      try { r = await fetch(url, { headers }); } catch (e) {
        if (!retried && cfg.retryDelayMs >= 0) { retried = true; await sleep(cfg.retryDelayMs); continue; }
        throw new Error('network error: ' + e.message);
      }
      const exp = Date.parse(r.headers.get('Expires') || '') || 0;
      if (r.status === 304 && old) {
        const data = { ...old, generated: new Date().toISOString(), _met: { ...old._met, expires: exp || Date.now() + 1800e3 } };
        await writeAll(g, addDayNight(data, +p.lat, +p.lon)); set(g, { result: 'not-modified', http: 304 }); return;
      }
      if (r.status === 429) {
        const wait = Math.min(cfg.maxBackoffMs, Math.max(retryAfterMs(r.headers.get('Retry-After')) ?? 0, cfg.backoffBaseMs * 2 ** n429));
        if (n429 < cfg.max429Retries && Date.now() - t0 + wait < cfg.maxRuntimeMs) { n429++; pace.pauseUntil(Date.now() + wait); console.warn(p.id, `HTTP 429, backing off ${Math.round(wait / 1000)} s`); continue; }
        stopped = 'not requested: MET returned 429 earlier in this run';
        throw Object.assign(new Error('HTTP 429 throttled by MET Norway: remaining properties not requested this run'), { http: 429 });
      }
      if (r.status >= 500 && !retried && cfg.retryDelayMs >= 0) { retried = true; await sleep(cfg.retryDelayMs); continue; }
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { http: r.status });
      const j = await r.json(), tz = p.tz || 'Europe/Athens';
      const w = convert(j, tz); if (!w) throw new Error('empty forecast');
      addHourly(w, j, tz, +p.lat, +p.lon, cfg.hourlyHours);
      w.generated = new Date().toISOString();
      w.source = { name: 'MET Norway', license: 'CC BY 4.0', licenseUrl: 'https://api.met.no/doc/License', modified: true };
      w._met = { lastModified: r.headers.get('Last-Modified') || null, expires: exp || Date.now() + 1800e3 };
      await writeAll(g, addDayNight(w, +p.lat, +p.lon));
      set(g, { result: 'updated', http: r.status, warning: r.status === 203 ? 'HTTP 203: MET marks this product version as deprecated' : undefined });
      return;
    }
  }

  async function worker() {
    while (cursor < groups.length) {
      const g = groups[cursor++];
      try {
        if (!stopped && Date.now() - t0 > cfg.maxRuntimeMs) { set(g, { result: 'deferred', error: null }); continue; }
        await fetchGroup(g);
      } catch (e) {
        set(g, { result: e.kind || 'failed', error: e.message, http: e.http ?? null });
        console.error(g.leader.id, `(${g.members.length} propert${g.members.length > 1 ? 'ies' : 'y'})`, 'FAILED', e.message, '(previous files kept)');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, groups.length || 1) }, worker));

  const list = [];
  for (const p of props) {
    const res = results.get(p.id), cur = await readOld(p.id);
    res.dataGenerated = cur?.generated || null;
    res.dataAgeHours = cur?.generated ? +((Date.now() - Date.parse(cur.generated)) / 36e5).toFixed(2) : null;
    res.stale = res.dataAgeHours === null || res.dataAgeHours > cfg.staleHours;
    list.push(res);
  }
  const count = (r) => list.filter((x) => x.result === r).length;
  const failed = list.filter((x) => (x.error && x.result !== 'deferred') || x.stale);
  const summary = { properties: list.length, groups: groups.length, requests, updated: count('updated'), notModified: count('not-modified'), freshSkipped: count('fresh-skipped'), deferred: count('deferred'), failed: count('failed'), throttled: count('throttled'), stale: list.filter((x) => x.stale).length, runtimeSeconds: +((Date.now() - t0) / 1000).toFixed(1) };
  const status = { checkedAt: new Date().toISOString(), ok: failed.length === 0, staleAlertHours: cfg.staleHours, config: { ...cfg }, summary, properties: list };
  await writeFile(`${OUT}/status.json`, JSON.stringify(status, null, 2));
  console.log('done:', JSON.stringify(summary));
  return failed.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run();

// Tests fetch-weather.mjs end to end against a local mock of MET Norway (no network access).
// Each case runs the real script as a child process, as GitHub Actions does, and checks files, status and exit code.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metSample } from './met-sample.mjs';

const SCRIPT = fileURLToPath(new URL('../fetch-weather.mjs', import.meta.url));
const FIRA = { id: 'aegean-pearl-demo', lat: 36.4167, lon: 25.4319, tz: 'Europe/Athens' };
const forecastOnly = ({ sunrise, sunset, ...rest }) => rest; // day/night fields are recomputed on every refresh
const LAST_MOD = 'Sun, 01 Nov 2026 18:00:00 GMT';

async function scenario({ handler, properties = [FIRA], previous = {}, env = {} }) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push({ url: req.url, headers: req.headers }); handler(req, res, requests.length); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(path.join(tmpdir(), 'gtelic-weather-'));
  const out = path.join(dir, 'weather');
  await writeFile(path.join(dir, 'properties.json'), JSON.stringify(properties));
  await import('node:fs/promises').then((fs) => fs.mkdir(out, { recursive: true }));
  for (const [id, data] of Object.entries(previous)) await writeFile(path.join(out, `${id}.json`), JSON.stringify(data));
  const runEnv = { ...process.env, MET_BASE: `http://127.0.0.1:${server.address().port}`, OUT_DIR: out, PROPERTIES_FILE: path.join(dir, 'properties.json'), GAP_MS: '0', RETRY_DELAY_MS: '0', BACKOFF_BASE_MS: '20', MAX_BACKOFF_MS: '200', MET_CONTACT: 'ops@gtelic.test', MET_UA: '', ...env };
  const code = await new Promise((resolve) => execFile(process.execPath, [SCRIPT], { env: runEnv }, (err) => resolve(err ? err.code : 0)));
  server.close();
  const read = async (f) => { try { return JSON.parse(await readFile(path.join(out, f), 'utf8')); } catch { return null; } };
  const status = await read('status.json');
  return { code, requests, status, read, out, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const ok200 = (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'last-modified': LAST_MOD, expires: new Date(Date.now() + 1800e3).toUTCString() }); res.end(JSON.stringify(metSample())); };
const previousFeed = (ageHours, extra = {}) => ({ hourly_meta: { hours: 0 }, live: true, fictional: false, current: { temperature_2m: 19, apparent_temperature: 19, weather_code: 1, wind_speed_10m: 10 }, daily: { time: ['2026-11-01'], weather_code: [1], temperature_2m_max: [20], temperature_2m_min: [15], precipitation_probability_max: [0] }, generated: new Date(Date.now() - ageHours * 3600e3).toISOString(), source: { name: 'MET Norway' }, _met: { product: 'complete', lastModified: LAST_MOD, expires: Date.now() - 60e3 }, ...extra });

test('200: writes a live feed with attribution, identifies itself, requests 4-decimal Fira coordinates', async () => {
  const s = await scenario({ handler: ok200 });
  try {
    assert.equal(s.code, 0);
    const w = await s.read('aegean-pearl-demo.json');
    assert.equal(w.live, true); assert.equal(w.fictional, false);
    assert.equal(w.daily.time.length, 5); assert.equal(typeof w.current.temperature_2m, 'number');
    assert.deepEqual(w.source, { name: 'MET Norway', license: 'CC BY 4.0', licenseUrl: 'https://api.met.no/doc/License', modified: true });
    assert.equal(w._met.lastModified, LAST_MOD);
    assert.ok(Date.now() - Date.parse(w.generated) < 60e3);
    assert.equal(s.requests[0].url, '/weatherapi/locationforecast/2.0/complete?lat=36.4167&lon=25.4319');
    assert.equal(s.requests[0].headers['user-agent'], 'GTelic/1.0 ops@gtelic.test');
    assert.equal(s.status.ok, true); assert.equal(s.status.properties[0].result, 'updated');
  } finally { await s.cleanup(); }
});

test('304: sends If-Modified-Since equal to the previous Last-Modified and keeps the data', async () => {
  const prev = previousFeed(1);
  const s = await scenario({ previous: { 'aegean-pearl-demo': prev }, handler: (req, res) => { res.writeHead(304, { expires: new Date(Date.now() + 1800e3).toUTCString() }); res.end(); } });
  try {
    assert.equal(s.requests[0].headers['if-modified-since'], LAST_MOD);
    assert.equal(s.code, 0);
    const w = await s.read('aegean-pearl-demo.json');
    assert.deepEqual(forecastOnly(w.daily), prev.daily); assert.deepEqual({ ...w.current, is_day: undefined }, { ...prev.current, is_day: undefined });
    assert.ok(Date.parse(w.generated) > Date.parse(prev.generated), 'generated refreshed after a successful 304');
    assert.ok(w._met.expires > Date.now());
    assert.equal(s.status.properties[0].result, 'not-modified');
  } finally { await s.cleanup(); }
});

test('Expires still in the future: no request is sent', async () => {
  const s = await scenario({ previous: { 'aegean-pearl-demo': previousFeed(0.2, { _met: { product: 'complete', lastModified: LAST_MOD, expires: Date.now() + 600e3 } }) }, handler: ok200 });
  try {
    assert.equal(s.requests.length, 0); assert.equal(s.code, 0);
    assert.equal(s.status.properties[0].result, 'fresh-skipped');
  } finally { await s.cleanup(); }
});

test('MET failure (500): previous file kept byte for byte, run reported as failed', async () => {
  const prev = previousFeed(0.5);
  const s = await scenario({ previous: { 'aegean-pearl-demo': prev }, handler: (req, res) => { res.writeHead(500); res.end('boom'); } });
  try {
    assert.equal(s.code, 1, 'no false success');
    assert.deepEqual(await s.read('aegean-pearl-demo.json'), prev);
    assert.equal(s.status.ok, false); assert.equal(s.status.properties[0].result, 'failed');
    assert.match(s.status.properties[0].error, /HTTP 500/);
  } finally { await s.cleanup(); }
});

test('MET failure with no previous file: nothing invented, run failed', async () => {
  const s = await scenario({ handler: (req, res) => { res.writeHead(503); res.end(); } });
  try {
    assert.equal(s.code, 1);
    await assert.rejects(stat(path.join(s.out, 'aegean-pearl-demo.json')));
    assert.equal(s.status.properties[0].dataGenerated, null);
  } finally { await s.cleanup(); }
});

test('MET returns a broken body: previous file kept, run failed', async () => {
  const prev = previousFeed(0.5);
  const s = await scenario({ previous: { 'aegean-pearl-demo': prev }, handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"not":"a forecast"}'); } });
  try {
    assert.equal(s.code, 1);
    assert.deepEqual(await s.read('aegean-pearl-demo.json'), prev);
  } finally { await s.cleanup(); }
});

test('429 with retries exhausted: stops requesting the remaining properties and keeps their previous files', async () => {
  const second = { id: 'second-demo', lat: 36.39, lon: 25.46, tz: 'Europe/Athens' };
  const s = await scenario({ properties: [FIRA, second], handler: (req, res) => { res.writeHead(429); res.end(); }, env: { MAX_429_RETRIES: '0' } });
  try {
    assert.equal(s.requests.length, 1, 'only the first property was requested');
    assert.equal(s.code, 1);
    assert.deepEqual(s.status.properties.map((p) => p.result), ['failed', 'throttled']);
  } finally { await s.cleanup(); }
});

test('stale data: MET down for hours marks the run failed even though a file exists', async () => {
  const s = await scenario({ previous: { 'aegean-pearl-demo': previousFeed(5) }, handler: (req, res) => { res.writeHead(500); res.end(); } });
  try {
    assert.equal(s.code, 1);
    assert.equal(s.status.properties[0].stale, true);
    assert.ok(s.status.properties[0].dataAgeHours > 4.9);
  } finally { await s.cleanup(); }
});

test('missing or placeholder contact: exit 2 and no request to MET', async () => {
  for (const contact of ['', 'contact@your-domain.example']) {
    const s = await scenario({ handler: ok200, env: { MET_CONTACT: contact } });
    try { assert.equal(s.code, 2); assert.equal(s.requests.length, 0); } finally { await s.cleanup(); }
  }
});

test('staggered requests: GAP_MS pause between properties', async () => {
  const second = { id: 'second-demo', lat: 36.39, lon: 25.46, tz: 'Europe/Athens' };
  const t0 = Date.now();
  const s = await scenario({ properties: [FIRA, second], handler: ok200, env: { GAP_MS: '400' } });
  try {
    assert.equal(s.requests.length, 2); assert.equal(s.code, 0);
    assert.ok(Date.now() - t0 >= 400, 'second request waited for the gap');
  } finally { await s.cleanup(); }
});

// ---------- Scale: shared requests for nearby properties ----------
const near = (id, dLatKm, dLonKm, extra = {}) => ({ id, lat: +(FIRA.lat + dLatKm / 111).toFixed(4), lon: +(FIRA.lon + dLonKm / (111 * Math.cos(FIRA.lat * Math.PI / 180))).toFixed(4), tz: 'Europe/Athens', ...extra });

test('nearby properties (300 m) share one request but keep separate JSON files', async () => {
  const b = near('fira-b', 0.3, 0);
  const s = await scenario({ properties: [FIRA, b], handler: ok200 });
  try {
    assert.equal(s.requests.length, 1); assert.equal(s.code, 0);
    const [wa, wb] = [await s.read('aegean-pearl-demo.json'), await s.read('fira-b.json')];
    assert.deepEqual(wa.daily, wb.daily); assert.equal(wa._met.requestKey, wb._met.requestKey);
    assert.ok(wb._met.distanceKm > 0.25 && wb._met.distanceKm < 0.35);
    assert.equal(s.status.summary.groups, 1); assert.equal(s.status.properties[1].shared, 2);
  } finally { await s.cleanup(); }
});

test('different areas (5 km apart) get separate requests', async () => {
  const s = await scenario({ properties: [FIRA, near('oia-ish', 5, 0)], handler: ok200 });
  try { assert.equal(s.requests.length, 2); assert.equal(s.status.summary.groups, 2); } finally { await s.cleanup(); }
});

test('radius is configurable: SHARE_RADIUS_KM=0 disables sharing; 2 km includes a 1.5 km neighbour', async () => {
  const b = near('fira-b', 0.3, 0), c = near('fira-c', 1.5, 0);
  const s0 = await scenario({ properties: [FIRA, b], handler: ok200, env: { SHARE_RADIUS_KM: '0' } });
  const s2 = await scenario({ properties: [FIRA, c], handler: ok200, env: { SHARE_RADIUS_KM: '2' } });
  const s1 = await scenario({ properties: [FIRA, c], handler: ok200 });
  try { assert.equal(s0.requests.length, 2); assert.equal(s2.requests.length, 1); assert.equal(s1.requests.length, 2, 'default 1 km does not include 1.5 km'); }
  finally { await s0.cleanup(); await s2.cleanup(); await s1.cleanup(); }
});

test('conditions: different altitude or time zone never share; altitude is sent to MET', async () => {
  const lo = { ...FIRA, altitude: 10 }, hi = near('cliff-top', 0.2, 0, { altitude: 300 }), tz = near('other-tz', 0.2, 0, { tz: 'Europe/Istanbul' });
  const s = await scenario({ properties: [lo, hi, tz], handler: ok200 });
  try {
    assert.equal(s.requests.length, 3);
    assert.ok(s.requests.some((r) => r.url.endsWith('&altitude=300')));
  } finally { await s.cleanup(); }
});

test('a new property joining a group with a still-valid cache gets a copy without any request', async () => {
  const cached = { ...previousFeed(0.2), _met: { product: 'complete', lastModified: LAST_MOD, expires: Date.now() + 600e3, requestKey: '36.4167,25.4319' } };
  const s = await scenario({ properties: [FIRA, near('new-neighbour', 0.2, 0)], previous: { 'aegean-pearl-demo': cached }, handler: ok200 });
  try {
    assert.equal(s.requests.length, 0); assert.equal(s.code, 0);
    assert.deepEqual((await s.read('new-neighbour.json')).daily, cached.daily);
  } finally { await s.cleanup(); }
});

test('304 for a shared group refreshes every member, including one without a file', async () => {
  const cached = { ...previousFeed(1), _met: { product: 'complete', lastModified: LAST_MOD, expires: Date.now() - 1, requestKey: '36.4167,25.4319' } };
  const s = await scenario({ properties: [FIRA, near('joiner', 0.2, 0)], previous: { 'aegean-pearl-demo': cached }, handler: (req, res) => { res.writeHead(304); res.end(); } });
  try {
    assert.equal(s.requests.length, 1); assert.equal(s.requests[0].headers['if-modified-since'], LAST_MOD); assert.equal(s.code, 0);
    assert.deepEqual(forecastOnly((await s.read('joiner.json')).daily), cached.daily);
    assert.deepEqual(s.status.properties.map((p) => p.result), ['not-modified', 'not-modified']);
  } finally { await s.cleanup(); }
});

test('429 then success: honours Retry-After / backoff and completes the run', async () => {
  const s = await scenario({ handler: (req, res, n) => { if (n === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end(); } else ok200(req, res); } });
  try { assert.equal(s.requests.length, 2); assert.equal(s.code, 0); assert.equal(s.status.properties[0].result, 'updated'); } finally { await s.cleanup(); }
});

test('5xx is retried once, then succeeds', async () => {
  const s = await scenario({ handler: (req, res, n) => { if (n === 1) { res.writeHead(502); res.end(); } else ok200(req, res); } });
  try { assert.equal(s.requests.length, 2); assert.equal(s.code, 0); } finally { await s.cleanup(); }
});

test('scale: 2000 properties in 200 resorts -> 200 requests, 2000 files, fast', async () => {
  const props = [];
  for (let c = 0; c < 200; c++) for (let k = 0; k < 10; k++) props.push({ id: `p-${c}-${k}`, lat: +(35 + c * 0.05 + k * 0.0005).toFixed(4), lon: +(20 + (c % 20) * 0.05).toFixed(4), tz: 'Europe/Athens' });
  const t0 = Date.now();
  const s = await scenario({ properties: props, handler: ok200 });
  try {
    assert.equal(s.code, 0); assert.equal(s.requests.length, 200);
    assert.equal(s.status.summary.properties, 2000); assert.equal(s.status.summary.groups, 200); assert.equal(s.status.summary.updated, 2000);
    assert.ok(await s.read('p-199-9.json'));
    assert.ok(Date.now() - t0 < 60e3, `took ${Date.now() - t0} ms`);
  } finally { await s.cleanup(); }
});

test('run-time budget: groups not reached are deferred (not failed) and fetched first next time', async () => {
  const props = [0, 1, 2].map((i) => near(`area-${i}`, i * 10, 0));
  const slow = (req, res) => setTimeout(() => ok200(req, res), 150);
  const s = await scenario({ properties: props, handler: slow, env: { MAX_RUNTIME_MS: '100' } });
  try {
    assert.ok(s.status.summary.deferred >= 1, JSON.stringify(s.status.summary));
    const deferred = s.status.properties.filter((p) => p.result === 'deferred').map((p) => p.id);
    assert.equal(s.code, 1, 'deferred properties with no data at all are stale, so the run is not reported as success');
    // next run: previously deferred (no data) come first
    const s2 = await scenario({ properties: props, handler: ok200, previous: Object.fromEntries(await Promise.all(props.filter((p) => !deferred.includes(p.id)).map(async (p) => [p.id, await s.read(p.id + '.json')]))) });
    try { assert.ok(s2.requests.length >= deferred.length); assert.equal(s2.code, 0); } finally { await s2.cleanup(); }
  } finally { await s.cleanup(); }
});

// ---------- Day and night ----------
test('day/night from coordinates: Fira noon is day, Fira 22:00 is night; feed carries sunrise/sunset', async () => {
  process.env.MET_CONTACT ||= 'ops@gtelic.test';
  const { isDay, sunTimes } = await import('../fetch-weather.mjs');
  assert.equal(isDay(36.4167, 25.4319, '2026-11-01T10:00:00Z'), 1);   // 12:00 Athens
  assert.equal(isDay(36.4167, 25.4319, '2026-11-01T20:00:00Z'), 0);   // 22:00 Athens
  assert.equal(isDay(36.4167, 25.4319, '2027-06-14T17:00:00Z'), 1);   // 20:00 Athens in June, before sunset
  const t = sunTimes(36.4167, 25.4319, '2026-11-01');
  const local = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit' });
  assert.match(local(t.sunrise), /^06:[3-5]\d$/); assert.match(local(t.sunset), /^17:[1-3]\d$/);
  assert.deepEqual(sunTimes(78.2, 15.6, '2026-12-21'), { sunrise: null, sunset: null }); // polar night (Svalbard)
  const s = await scenario({ handler: ok200 });
  try { const w = await s.read('aegean-pearl-demo.json'); assert.ok([0, 1].includes(w.current.is_day)); assert.equal(w.daily.sunrise.length, 5); assert.equal(w.daily.sunset.length, 5); } finally { await s.cleanup(); }
});

// ---------- Hourly forecast (same MET response) ----------
test('hourly: 48 real MET hourly steps; values taken from MET; rain probability null when MET does not provide it', async () => {
  const sample = metSample();
  const s = await scenario({ handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'last-modified': LAST_MOD }); res.end(JSON.stringify(sample)); } });
  try {
    assert.equal(s.requests.length, 1, 'no extra request for hourly data');
    const w = await s.read('aegean-pearl-demo.json'), h = w.hourly, ts = sample.properties.timeseries;
    assert.equal(h.time.length, 48);
    for (const k of ['time', 'time_utc', 'temperature_2m', 'apparent_temperature', 'weather_code', 'is_day', 'wind_speed_10m', 'precipitation', 'precipitation_probability']) assert.equal(h[k].length, 48, k);
    for (let i = 0; i < 48; i++) {
      assert.equal(h.time_utc[i], ts[i].time);
      assert.equal(h.temperature_2m[i], Math.round(ts[i].data.instant.details.air_temperature));
      assert.equal(h.wind_speed_10m[i], Math.round(ts[i].data.instant.details.wind_speed * 3.6));
      assert.equal(h.precipitation[i], ts[i].data.next_1_hours.details.precipitation_amount);
      assert.equal(h.precipitation_probability[i], null);
    }
    assert.equal(h.precipitation[10], 0.4); assert.equal(h.weather_code[10], 61);
    assert.equal(w.hourly_meta.precipitation_probability_provided, false);
    assert.equal(w.hourly_meta.timezone, 'Europe/Athens');
  } finally { await s.cleanup(); }
});

test('hourly: MET probability_of_precipitation is passed through when present; HOURLY_HOURS=24 limits the series', async () => {
  const sample = metSample(new Date(), { probability: true });
  const s = await scenario({ handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(sample)); } , env: { HOURLY_HOURS: '24' } });
  try {
    const h = (await s.read('aegean-pearl-demo.json')).hourly;
    assert.equal(h.time.length, 24);
    assert.deepEqual(h.precipitation_probability, sample.properties.timeseries.slice(0, 24).map((x) => x.data.next_1_hours.details.probability_of_precipitation));
  } finally { await s.cleanup(); }
});

test('hourly: Santorini local time with summer/winter time, including the October switch', async () => {
  process.env.MET_CONTACT ||= 'ops@gtelic.test';
  const { localTime } = await import('../fetch-weather.mjs');
  assert.equal(localTime('2027-06-14T12:00:00Z', 'Europe/Athens'), '2027-06-14T15:00');  // EEST +3
  assert.equal(localTime('2026-12-01T12:00:00Z', 'Europe/Athens'), '2026-12-01T14:00');  // EET +2
  assert.equal(localTime('2026-10-25T00:00:00Z', 'Europe/Athens'), '2026-10-25T03:00');  // last hour of summer time
  assert.equal(localTime('2026-10-25T01:00:00Z', 'Europe/Athens'), '2026-10-25T03:00');  // clocks went back: 03:00 again
  assert.equal(localTime('2026-03-29T00:00:00Z', 'Europe/Athens'), '2026-03-29T02:00');
  assert.equal(localTime('2026-03-29T01:00:00Z', 'Europe/Athens'), '2026-03-29T04:00');  // 03:00 skipped in spring
  assert.equal(localTime('2026-11-01T21:00:00Z', 'Europe/Athens'), '2026-11-01T23:00');
  assert.equal(localTime('2026-11-01T22:00:00Z', 'Europe/Athens'), '2026-11-02T00:00');  // midnight rolls the date
});

test('hourly: day/night per hour from the coordinates', async () => {
  const sample = metSample(new Date('2026-11-01T12:00:00Z'));
  const s = await scenario({ handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(sample)); } });
  try {
    const h = (await s.read('aegean-pearl-demo.json')).hourly;
    const at = (utc) => h.is_day[h.time_utc.indexOf(utc)];
    assert.equal(at('2026-11-01T12:00:00Z'), 1);   // 14:00 Athens
    assert.equal(at('2026-11-01T20:00:00Z'), 0);   // 22:00 Athens
    assert.equal(at('2026-11-02T03:00:00Z'), 0);   // 05:00 Athens, before sunrise
  } finally { await s.cleanup(); }
});

test('hourly: no hourly steps in the MET response -> empty series, nothing invented', async () => {
  const sample = metSample(); for (const x of sample.properties.timeseries) delete x.data.next_1_hours;
  const s = await scenario({ handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(sample)); } });
  try {
    const w = await s.read('aegean-pearl-demo.json');
    assert.equal(w.hourly.time.length, 0); assert.equal(w.hourly.precipitation_probability.length, 0);
    assert.equal(w.hourly_meta.hours, 0); assert.equal(w.daily.time.length, 5, 'daily still built from 6-hour steps');
  } finally { await s.cleanup(); }
});

test('hourly: a 304 keeps the hourly series of the last valid feed', async () => {
  const prev = { ...previousFeed(1), hourly: { time: ['2026-11-01T22:00'], time_utc: ['2026-11-01T20:00:00Z'], temperature_2m: [18], apparent_temperature: [17], weather_code: [0], is_day: [0], wind_speed_10m: [12], precipitation: [0], precipitation_probability: [null] } };
  const s = await scenario({ previous: { 'aegean-pearl-demo': prev }, handler: (req, res) => { res.writeHead(304); res.end(); } });
  try { assert.deepEqual((await s.read('aegean-pearl-demo.json')).hourly, prev.hourly); } finally { await s.cleanup(); }
});

test('format upgrade: a cached file without the hourly series triggers one full request despite Expires', async () => {
  const legacy = { ...previousFeed(0.2, { _met: { product: 'complete', lastModified: LAST_MOD, expires: Date.now() + 600e3 } }) }; delete legacy.hourly_meta;
  const s = await scenario({ previous: { 'aegean-pearl-demo': legacy }, handler: ok200 });
  try {
    assert.equal(s.requests.length, 1); assert.equal(s.requests[0].headers['if-modified-since'], undefined, 'no conditional request: a 304 would carry no hourly data');
    assert.equal((await s.read('aegean-pearl-demo.json')).hourly.time.length, 48);
  } finally { await s.cleanup(); }
});

test('product switch: a cache from the compact product gets one full request; MET_PRODUCT=compact still works', async () => {
  const compactCache = { ...previousFeed(0.2), _met: { lastModified: LAST_MOD, expires: Date.now() + 600e3 } }; // no product = compact
  const s = await scenario({ previous: { 'aegean-pearl-demo': compactCache }, handler: ok200 });
  const c = await scenario({ handler: ok200, env: { MET_PRODUCT: 'compact' } });
  try {
    assert.equal(s.requests.length, 1); assert.equal(s.requests[0].headers['if-modified-since'], undefined);
    assert.match(s.requests[0].url, /\/2\.0\/complete\?/); assert.equal((await s.read('aegean-pearl-demo.json'))._met.product, 'complete');
    assert.match(c.requests[0].url, /\/2\.0\/compact\?/);
  } finally { await s.cleanup(); await c.cleanup(); }
});

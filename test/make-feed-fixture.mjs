// Prints a feed file exactly as fetch-weather.mjs writes it, built by the real convert() from a synthetic
// MET-shaped response. Used by the Guest App browser tests so they exercise the real job output.
// Usage: node test/make-feed-fixture.mjs [ageHours] [ISO time of the forecast start] [prob]
process.env.MET_CONTACT ||= 'fixture@gtelic.test';
const { convert, addDayNight, addHourly } = await import('../fetch-weather.mjs');
const { metSample } = await import('./met-sample.mjs');
const ageHours = +(process.argv[2] || 0);
const at = process.argv[3] ? new Date(process.argv[3]) : new Date();  // optional ISO time, e.g. a night hour
const sample = metSample(at, { probability: process.argv[4] === 'prob' });  // 'prob': include MET probability_of_precipitation
const w = addHourly(addDayNight(convert(sample, 'Europe/Athens'), 36.4167, 25.4319), sample, 'Europe/Athens', 36.4167, 25.4319);
const base = process.argv[3] ? at.getTime() : Date.now(); // with a fixed time, age is relative to it
w.generated = new Date(base - ageHours * 3600e3).toISOString();
w.source = { name: 'MET Norway', license: 'CC BY 4.0', licenseUrl: 'https://api.met.no/doc/License', modified: true };
w._met = { lastModified: new Date().toUTCString(), expires: Date.now() + 1800e3 };
process.stdout.write(JSON.stringify(w));

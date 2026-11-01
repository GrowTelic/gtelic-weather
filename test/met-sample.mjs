// Synthetic response in the shape of MET Norway Locationforecast 2.0 /compact (no real API data).
// Hourly steps for the first 60 h, then 6-hourly up to 5 days, as MET publishes them.
export function metSample(now = new Date(), { temp = 24, probability = false } = {}) {
  const start = new Date(now); start.setUTCMinutes(0, 0, 0);
  const timeseries = [];
  for (let h = 0; h <= 120; h += h < 60 ? 1 : 6) {
    const t = new Date(start.getTime() + h * 3600e3);
    const hourOfDay = (t.getUTCHours() + 3) % 24; // Athens summer time
    const air = +(temp + 4 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI)).toFixed(1);
    const symbol = (h >= 72 && h < 84) || h === 10 ? 'lightrain' : hourOfDay >= 6 && hourOfDay < 20 ? 'clearsky_day' : 'clearsky_night';
    const entry = { time: t.toISOString().replace('.000Z', 'Z'), data: { instant: { details: { air_temperature: air, wind_speed: 4.2, relative_humidity: 55 } } } };
    if (h < 60) entry.data.next_1_hours = { summary: { symbol_code: symbol }, details: { precipitation_amount: symbol === 'lightrain' ? 0.4 : 0, ...(probability ? { probability_of_precipitation: (h * 7) % 100 } : {}) } };
    entry.data.next_6_hours = { summary: { symbol_code: symbol }, details: { precipitation_amount: symbol === 'lightrain' ? 1.2 : 0 } };
    timeseries.push(entry);
  }
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [25.4319, 36.4167, 0] }, properties: { meta: { updated_at: start.toISOString(), units: {} }, timeseries } };
}

# gtelic-weather

An hourly MET Norway Locationforecast 2.0 feed for the GTelic Guest App. It is published as static JSON on GitHub Pages: one file per property. Guests' apps read these files and never call api.met.no directly.

This is the weather job from the GTelic Guest App Approved v1 (`weather-job/`), packaged as its own repository.
- `convert()` and `code()` are unchanged from v1.
- Added: the User-Agent built from a contact variable, `status.json`, a stale-data alert, stopping on HTTP 429, a non-zero exit on any failure, tests, and a **new** workflow. The original v1 `weather.yml` was lost and was not recreated from memory.

## What is public in this repository
Only the files listed below. It contains no GTelic application code, no Guest App design kit material, and no customer data.

| File | Content |
|---|---|
| `properties.json` | Properties to fetch: `id`, `lat`, `lon`, `tz`. Currently only the demo property `aegean-pearl-demo` (Fira, Santorini: 36.4167, 25.4319). For real customers, use opaque ids rather than hotel names: this file is public. |
| `fetch-weather.mjs` | The job. Node 18 or later, no dependencies. |
| `public/index.html` | Check page: last update, current values, refresh status. |
| `.github/workflows/weather.yml` | Hourly at minute 7 (UTC), plus a manual run button. Steps: tests, restore the published files, fetch, publish to Pages, fail the run if anything failed or is stale. |
| `test/` | Tests against a local mock of MET. No network access. |

Published on Pages: `weather/<id>.json` (feed), `weather/status.json` (last refresh result), `index.html` (check page).

## Behaviour
- **Shared requests for nearby properties.**
  - A property joins the nearest group leader within `SHARE_RADIUS_KM` (default **1 km**) only if both are in the same time zone and both have the same kind of altitude: either both unknown, or both given and within `SHARE_MAX_ALT_DIFF_M` (default 50 m).
  - Every property still gets its **own** `weather/<id>.json`. `_met.requestKey` names the shared request and `_met.distanceKm` the distance to its coordinates.
  - Set `SHARE_RADIUS_KM=0` to disable sharing. Properties with identical coordinates always share.
- **Caching:**
  - If the cached `Expires` is still in the future, no request is sent; a new member of the group simply gets a copy.
  - Otherwise the request sends `If-Modified-Since` with the previous `Last-Modified`. A `304` keeps the data for the whole group and refreshes `generated`.
- **Pacing:**
  - One request at a time (`CONCURRENCY=1`) with at least `MIN_INTERVAL_MS` (default **1000 ms**) between request starts.
  - On **HTTP 429**: wait for `Retry-After` or an exponential backoff (30 s, then 60 s, at most 5 min). After 2 retries, stop requesting for this run; the remaining properties are reported as `throttled`.
  - A 5xx or network error is retried once after 2 s.
- **Run-time budget:**
  - New requests stop after `MAX_RUNTIME_MS` (default 40 min). The remaining groups are `deferred` to the next run.
  - Groups are always processed oldest data first, so nothing starves.
- **Failure:**
  - The previous data (from the Actions cache, or the published file on the first run) is restored before fetching. On any error that data stays and is republished.
  - Nothing is invented. A property with no data has no file, and the app shows its demo weather.
  - Files of properties removed from `properties.json` are deleted from the site.
- **Hourly forecast (same MET response, no extra request):**
  - `hourly` contains the next `HOURLY_HOURS` (default 48, at most about 60) **hourly** steps that MET provides (`next_1_hours`). Nothing is interpolated.
  - Fields:
    - `time`: Santorini local wall-clock time, summer/winter time correct.
    - `time_utc`, `temperature_2m`, `weather_code`, `wind_speed_10m` (km/h), `precipitation` (mm, MET).
    - `is_day`, from the coordinates.
    - `apparent_temperature`, derived from MET temperature, humidity and wind with the formula used for `current`.
    - `precipitation_probability`: MET's own value when the response contains it, otherwise `null`. The app shows "—" for `null`.
  - `hourly_meta` records the time zone, the number of hours, and whether MET provided a probability.
  - The existing keys `hourly.time` and `hourly.precipitation_probability` keep their names.
- **Day and night:**
  - `current.is_day` is computed from the coordinates and time (solar elevation).
  - `daily.sunrise` and `daily.sunset` are computed per day (UTC; `null` during polar day or night), so the app can decide day or night at viewing time.
- **Published-feed check:** after each deploy, the workflow downloads the published JSON over real HTTP, checks that it is this run's file and that it has live hourly data, and logs a sample.
- **Monitoring:**
  - `status.json` holds totals and, for each property: group, result, HTTP status, data age and a stale flag.
  - The run **fails** (red, with GitHub's failure email) when any property failed, was throttled, or its data is older than `STALE_ALERT_HOURS` (default 3 h). Deferred properties fail the run only once their data is stale.
  - The job summary shows the totals and the problem rows.
- **User-Agent:** `GTelic/1.0 <MET_CONTACT>`. The job refuses to run without a real contact, and placeholders are rejected.
- **Attribution:**
  - Every file carries `source: MET Norway, CC BY 4.0, modified: true`.
  - The Guest App shows the MET Norway (CC BY 4.0) attribution with a link to https://api.met.no/doc/License, only on live data.
  - Do not use the name "Yr" or its logo.

All numbers above are this job's own conservative defaults. **They are not official MET Norway limits**; check the current terms at https://api.met.no/doc/TermsOfService before raising any of them. Optional repository variables override them: `MIN_INTERVAL_MS`, `CONCURRENCY`, `SHARE_RADIUS_KM`, `SHARE_MAX_ALT_DIFF_M`, `STALE_ALERT_HOURS`, `MAX_RUNTIME_MS`.

### Capacity
- One run sends at most about 2,400 requests: 40 min at 1 request per second.
- Requests are needed per **group**, not per property. Properties in the same village share one group, so thousands of properties typically need far fewer requests. `Expires` and `304` cut the rest.
- `test/` checks 2,000 properties in 200 resorts: 200 requests, 2,000 files.

### Not built yet (only if growth needs it)
- More than about 2,000 groups per hour. Options: split `properties.json` into shards run by a matrix job; raise the pacing after confirming MET's terms; or move to the GTelic backend (a scheduled server function writing to object storage behind a CDN).
- `properties.json` in a database. It stays a file while the list is small and contains no customer names.

## Setup
The repository `GrowTelic/gtelic-weather` exists and holds these files. The owner does steps 1 and 2 once, in the repository settings:
1. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
2. Settings > Secrets and variables > Actions > **Variables**: add `MET_CONTACT` = the real contact email or website for MET Norway.
3. Actions > "Refresh and publish weather" > **Run workflow**.
4. Check `https://growtelic.github.io/gtelic-weather/`. Then check `https://growtelic.github.io/gtelic-weather/weather/aegean-pearl-demo.json` and `.../weather/status.json`.

Notes:
- Public repositories have unlimited Actions minutes.
- GitHub disables scheduled workflows in public repositories after 60 days without repository activity. Any commit, or re-enabling the workflow in the Actions tab, restarts it.
- Scheduled runs can start a few minutes late, or be skipped under heavy GitHub load. The app tolerates up to 12 h of age.

## Tests
```bash
npm test
```
Cases (27):
- **Feed and caching:** `200` (live feed, attribution, User-Agent, 4-decimal coordinates); `304` with `If-Modified-Since`; `Expires` skip.
- **Failures:** `500` (previous file kept); `503` with no previous file; broken body; `429` with retries exhausted, and `429` followed by success; `5xx` retried once; stale data; missing or placeholder contact.
- **Sharing:** nearby properties share a request; different areas do not; the radius is configurable; different altitude or time zone never share; a new member is served from cache; `304` refreshes a whole group.
- **Scale:** 2,000 properties; the run-time budget defers groups and serves them first next time; staggered requests.
- **Day and night:** Fira noon is day and 22:00 is night; sunrise and sunset; polar night.
- **Hourly:** 48 MET hourly values with a null probability; probability passed through when present; `HOURLY_HOURS=24`; local time including both DST switches and midnight; day/night per hour; no hourly steps means an empty series; `304` keeps the hourly series.

`npm run feed-fixture [ageHours] [ISO time]` prints a feed file exactly as the job writes it. The Guest App tests use it.

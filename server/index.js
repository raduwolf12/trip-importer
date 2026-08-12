'use strict'
const { definePlugin } = require('trek-plugin-sdk')

function safeJson(status, obj) {
  try { return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) } }
  catch (e) { return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String(e) }) } }
}
async function tryAttempt(fn) {
  try { return await fn() } catch (e) {
    // Node's undici wraps every low-level fetch failure (DNS, connection refused, TLS, blocked
    // egress) in a generic top-level "fetch failed" — the actual reason lives in e.cause and was
    // getting silently dropped, making a real failure (e.g. an egress host not yet granted after
    // a permissions bump) indistinguishable from any other fetch problem in the client-visible error.
    let msg = e?.message || String(e)
    if (e?.cause?.message) msg += ' (' + e.cause.message + ')'
    return { error: msg }
  }
}
// For optional/best-effort ctx calls (meta, trips.update cover_image, …) that must never break
// the surrounding import — swallows both a thrown rejection and the synchronous property-access
// throw some ctx namespaces raise when unavailable on a given host (hence the thunk: fn must be
// a closure, not an already-evaluated ctx.foo.bar(...) call, or the throw happens before this
// runs at all).
async function attempt(fn, fallback) {
  try { return await fn() } catch (_e) { return fallback }
}
// A trip_files row's created_at format isn't pinned down by the plugin-sdk's loosely-typed
// TripFile (`[k: string]: unknown`) — could be an epoch-ms number or a SQL-style timestamp
// string depending on the column. takenAt is purely decorative on a Photo, so never surface
// "Invalid Date" — just omit it if parsing didn't produce a real date.
function safeIsoDate(raw) {
  if (!raw) return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function unixToDate(ts) {
  if (!ts) return null
  return new Date(ts * 1000).toISOString().slice(0, 10)
}

// Polarsteps timestamps are Unix epoch seconds (UTC), but each step also carries its own
// IANA timezone_id (e.g. "Asia/Shanghai"). Converting straight to UTC via unixToDate() silently
// puts a late-night/early-morning step on the WRONG calendar day whenever the step's local time
// and UTC fall on different dates — which then cascades into the wrong day-row/itinerary
// assignment for that step's place and journal entry. en-CA locale formats as YYYY-MM-DD
// directly, so no manual reassembly is needed. Falls back to plain UTC if tz is missing/invalid
// (an unrecognized IANA name throws in Intl.DateTimeFormat's constructor).
function unixToDateInTz(ts, tz) {
  if (!ts) return null
  if (!tz) return unixToDate(ts)
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000))
  } catch (_e) { return unixToDate(ts) }
}

// Maps raw Polarsteps step objects (trip.all_steps entries) to the shape /import consumes.
// Extracted out of /parse-polarsteps's handler so the SAME mapping runs whether steps arrive as
// part of a full trip.json (small trips, single request) or as one `stepsChunk` of a large trip
// split across several requests to stay under the plugin-route proxy's body-size ceiling.
// startIndex offsets the "Stop N" fallback name (used only when a step has neither name nor
// display_name) so numbering stays globally correct across chunked calls instead of restarting
// at "Stop 1" for every chunk.
function mapPolarstepsSteps(steps, startIndex) {
  startIndex = startIndex || 0
  return steps.map((s, i) => {
    i += startIndex
    const tz = s.timezone_id || null
    const date = unixToDateInTz(s.start_time || s.creation_time, tz)
    // A step can span multiple calendar days (e.g. a week-long stay) — end_time was
    // previously never read at all, so every day after the start date showed nothing
    // on the itinerary for that stay. Only set when it's a genuinely later day, so a
    // same-day end_time doesn't trigger the multi-day assignment path in /import for no reason.
    const endDate = unixToDateInTz(s.end_time, tz)
    return {
      // Polarsteps' own step id — trip.json itself carries no LOCAL photo path (photos
      // live in a sibling ZIP folder named "<slug>_<id>/photos/*", confirmed against the
      // community polarsteps-data-parser project's folder-matching logic) — but it CAN
      // carry a direct CDN url for the step's own designated cover photo
      // (main_media_item_path, mediaUrl below), which /import uses as a fallback when no
      // local ZIP photo was found for this step (e.g. a bare trip.json with no full ZIP
      // export). The client uses this id to find the ZIP's sibling photo folder and
      // upload its photos once /import has created this step's place — see
      // doAnalyze()/doImport() in client/index.html.
      id: s.id != null ? String(s.id) : (s.uuid != null ? String(s.uuid) : null),
      name: (s.name && s.name.trim()) || s.display_name || ('Stop ' + (i + 1)),
      description: (s.description && s.description.trim()) || null,
      date,
      endDate: endDate && endDate > date ? endDate : null,
      weather: s.weather_condition ? { condition: s.weather_condition, tempC: s.weather_temperature ?? null } : null,
      mediaUrl: s.main_media_item_path || null,
      location: s.location ? {
        name: s.location.full_detail || s.location.name || null,
        lat: typeof s.location.lat === 'number' ? s.location.lat : null,
        lon: typeof s.location.lon === 'number' ? s.location.lon : null,
      } : null,
    }
  })
}

function mapPolarstepsWeather(condition) {
  const c = String(condition || '').toLowerCase()
  if (!c) return null
  if (c.includes('thunder') || c.includes('storm')) return 'stormy'
  if (c.includes('rain') || c.includes('drizzle') || c.includes('sleet')) return 'rainy'
  if (c.includes('snow') || c.includes('hail')) return 'cold'
  if (c.includes('partly') || c.includes('mostly') || c.includes('few-clouds')) return 'partly'
  if (c.includes('cloud') || c.includes('fog') || c.includes('overcast')) return 'cloudy'
  if (c.includes('clear') || c.includes('sun')) return 'sunny'
  return null
}

function mapPolarstepsEntryLocation(step, fallbackName) {
  if (!step?.location || typeof step.location.lat !== 'number' || typeof step.location.lon !== 'number') return {}
  return {
    location_name: step.location.name || fallbackName || step.name || null,
    location_lat: step.location.lat,
    location_lng: step.location.lon,
  }
}

// Normalize a loose date string (various separators/field orders, as found in expense CSVs)
// to YYYY-MM-DD, or null if it can't be parsed. Mirrors the disambiguation already used for
// booking-text date extraction below: a 4-digit first field is YYYY-MM-DD; a 4-digit last
// field assumes day-first (this plugin's exports skew European); a 2-digit last field assumes
// day-first with a 20xx century. Left un-normalized, a raw CSV date string ("16/07/2026")
// sorted alongside proper ISO dates from other sources produces a garbage min/max — confirmed
// as the cause of trip date auto-detection silently failing once an expense CSV was added
// (an <input type="date"> silently ignores a non-ISO string, leaving the field blank).
function normalizeDateStr(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const m = s.match(/^(\d{1,4})[-./](\d{1,2})[-./](\d{1,4})$/)
  if (!m) return null
  const [, p1, p2, p3] = m
  let y, mo, d
  if (p1.length === 4) { y = p1; mo = p2; d = p3 }
  else if (p3.length === 4) { d = p1; mo = p2; y = p3 }
  else if (p3.length === 2) { d = p1; mo = p2; y = '20' + p3 }
  else return null
  mo = mo.padStart(2, '0'); d = d.padStart(2, '0')
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null
  return y + '-' + mo + '-' + d
}

// ── Nominatim reverse geocode ─────────────────────────────────────────────────
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14`
    // The 30s server-side route timeout the SDK documents is NOT the real ceiling here — TREK's
    // own trek:invoke bridge in the browser enforces its own ~8s timeout on the whole round-trip,
    // confirmed against a real instance ("timeout of 8000ms exceeded" client-side, well before the
    // route's 30s would ever fire). withinBudget() in /import only gates whether a NEW geocode call
    // starts, it can't interrupt one already in flight, so keep any single call well under that.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    let res
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'TREK-trip-importer/1.0' }, signal: controller.signal })
    } finally { clearTimeout(timeout) }
    if (!res.ok) return null
    const data = await res.json()
    const a = data.address || {}
    // Build a nice short name: neighbourhood/suburb/city
    return a.tourism || a.attraction || a.amenity ||
      [a.neighbourhood || a.suburb || a.quarter, a.city || a.town || a.village || a.county]
        .filter(Boolean).join(', ') || data.display_name?.split(',').slice(0, 2).join(', ') || null
  } catch (_e) { return null }
}

// ── Nominatim forward geocode (name -> coords) ────────────────────────────────
// Guide places (Mindtrip-style day-by-day PDF guides — see parseGuidePlaces) arrive with
// only a name, no coordinates at all, unlike every other place-shaped source in this plugin
// (GPS EXIF, Google Timeline, Wanderlog, Google/Naver list imports all already carry lat/lng
// by the time they reach the client). This is the one forward-geocode call site in the whole
// plugin — mirrors reverseGeocode's timeout/UA/error-swallowing conventions exactly.
async function geocodePlaceName(name) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    let res
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'TREK-trip-importer/1.0' }, signal: controller.signal })
    } finally { clearTimeout(timeout) }
    if (!res.ok) return null
    const data = await res.json()
    const hit = Array.isArray(data) ? data[0] : null
    if (!hit) return null
    const lat = parseFloat(hit.lat), lng = parseFloat(hit.lon)
    if (!isFinite(lat) || !isFinite(lng)) return null
    return { lat, lng }
  } catch (_e) { return null }
}

// ── Follow redirects for a short link, stopping as soon as a wanted pattern shows up ──────────
// Confirmed against a real instance: a maps.app.goo.gl share-list link's redirect chain is
// maps.app.goo.gl -> www.google.com/maps/@/data=...!2s<listId>...  -> consent.google.com/ml?... (a
// GDPR interstitial this plugin's egress allowlist correctly refuses to fetch — and shouldn't need
// to). The critical realization: the list ID substring (`!2s<id>`) is already present in the
// SECOND url — the Location header of the FIRST redirect — before we ever fetch it. So this
// resolver checks `matchFn` against the redirect TARGET (from the Location header) before
// deciding whether to fetch it at all, and returns as soon as it matches. It only ever fetches a
// hop when the pattern hasn't been found yet and there's still chain left to follow — meaning a
// consent-wall hop the pattern already matched before is never actually requested. If the pattern
// truly isn't found before the chain runs into a host outside this plugin's egress list, that
// fetch throws (surfaced to the caller as a normal error, now with the real host name via
// tryAttempt's e.cause handling) rather than silently stalling.
async function resolveRedirectChain(url, matchFn, timeoutMs) {
  let current = url
  if (matchFn(current)) return current
  for (let hop = 0; hop < 5; hop++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs || 10000)
    let res
    try {
      res = await fetch(current, { redirect: 'manual', signal: controller.signal })
    } finally { clearTimeout(timeout) }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return current
      current = new URL(loc, current).toString()
      if (matchFn(current)) return current
      continue
    }
    return current
  }
  return current
}

// ── Google Maps internal feature-id encoding ──────────────────────────────────
// Ported verbatim (logic, not code) from TREK core's own List Import feature
// (server/src/services/placeService.ts, importGoogleList(), liketrek/TREK, AGPL-3.0) so places
// imported via /parse-google-list carry the same google_ftid shape TREK's native import produces.
function googleMapsHexId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const raw = String(value).trim()
  if (/^0x[0-9a-f]+$/i.test(raw)) return raw.toLowerCase()
  if (!/^-?\d+$/.test(raw)) return null
  try {
    const parsed = BigInt(raw)
    const unsigned = parsed < 0n ? (1n << 64n) + parsed : parsed
    return '0x' + unsigned.toString(16)
  } catch (_e) { return null }
}
function googleMapsFeatureIdFromItem(item) {
  if (!Array.isArray(item)) return null
  const candidates = [
    Array.isArray(item[1]) ? item[1][6] : null,
    Array.isArray(item[7]) ? item[7][1] : null,
  ]
  for (const ids of candidates) {
    if (!Array.isArray(ids) || ids.length < 2) continue
    const first = googleMapsHexId(ids[0])
    const second = googleMapsHexId(ids[1])
    if (first && second) return first + ':' + second
  }
  return null
}

// ── Distance between two coords in metres ────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Cluster GPS points within radius into groups ──────────────────────────────
// Proximity alone isn't enough to merge two points into one place: a landmark or hotel
// revisited on different days must stay assignable to each of those days, not collapse into
// one place tied to whichever visit happened to be processed first. So a merge also requires
// the dates to agree — unless one side has no date at all, in which case it can still join
// (nothing to conflict with), and the cluster adopts that date if it didn't have one yet.
// Confirmed as the cause of places silently never landing on a day: /parse-timeline clusters
// a trip's ENTIRE location history in one pass (no per-day bucketing, unlike /parse-gps), so
// any place visited more than once was already collapsing to a single date before this fix —
// and even for GPS-only imports, a cluster whose first-processed member had no EXIF date used
// to stay dateless forever regardless of how many dated members merged into it afterward.
function clusterByProximity(places, radiusMetres = 800) {
  const clusters = []
  for (const p of places) {
    const match = clusters.find(c => haversine(c.lat, c.lng, p.lat, p.lng) < radiusMetres && (!c.date || !p.date || c.date === p.date))
    if (match) {
      match.members.push(p)
      if (!match.date && p.date) match.date = p.date
      // Update centroid
      match.lat = match.members.reduce((s, m) => s + m.lat, 0) / match.members.length
      match.lng = match.members.reduce((s, m) => s + m.lng, 0) / match.members.length
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, members: [p], name: p.name, date: p.date })
    }
  }
  return clusters
}

// Every paginated /import (and /import-collection) section — Polarsteps steps, bookings,
// expenses, places — used to independently re-derive its own offset/total/loop-bounds inline
// from a `<section>Offset`/`total<Section>` (or `polarsteps._stepOffset`/`_totalSteps`) pair on
// the request. That duplication once shipped a real bug: the steps-pagination work referenced
// `stepOffset`/`totalSteps` in two code paths but never actually declared them, throwing a
// ReferenceError (this file has 'use strict') on every single Polarsteps journal import. One
// shared helper makes it structurally impossible to use an offset without its matching total (or
// vice versa) — the actual root cause of that bug — and centralizes the "no offset/total sent ==
// unpaginated call, this IS the whole list starting at 0" backward-compatibility fallback that
// every call site needs to keep older/unpaginated clients working unchanged.
//
// `slice` is this round's window of the array (or the full array, on an unpaginated call);
// `offset`/`total` come straight off the request body, as-is (possibly undefined/null). Returns:
//   - `total`: the GLOBAL item count across every round (for "done"/"N more queued" checks)
//   - `end`: the loop's upper bound, i.e. offset + slice.length, re-based into global-index space
//   - `get(globalIdx)`: re-bases a global progress index (p.bookings, p.costs, etc.) back onto
//     `slice`, equivalent to the old `arr[i - offset]`
// Callers still do their own `for (let i = p.<section>; i < win.end; i++)` and set
// `p.<section> = i` after the loop, exactly as before — this only removes the repeated
// offset/total derivation and index math, not the loop shape itself.
function paginatedWindow(slice, offset, total) {
  const arr = slice || []
  const off = offset || 0
  const tot = total ?? (off + arr.length)
  return { off, total: tot, end: off + arr.length, get: (globalIdx) => arr[globalIdx - off] }
}

// ── Parse Google Maps Timeline ────────────────────────────────────────────────
function parseGoogleTimeline(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json

  // New format: { semanticSegments: [...] } or { timelineObjects: [...] }
  // Old format: { locations: [...] }
  const places = []

  // New format (2024+): semanticSegments with placeVisit
  if (data.semanticSegments) {
    for (const seg of data.semanticSegments) {
      const visit = seg.timelinePath || seg.visit || seg.placeVisit
      if (seg.visit) {
        const loc = seg.visit.topCandidate?.placeLocation?.latLng || seg.visit.hierarchyLevel
        if (loc) {
          const [lat, lng] = typeof loc === 'string' ? loc.split(',').map(Number) : [loc.latitudeE7 / 1e7, loc.longitudeE7 / 1e7]
          const start = seg.startTime || seg.visit.startTime
          const date = start ? start.slice(0, 10) : null
          const name = seg.visit.topCandidate?.semanticType || null
          places.push({ lat, lng, date, name, photoCount: 1 })
        }
      }
    }
  }

  // Old format: timelineObjects with placeVisit
  if (data.timelineObjects) {
    for (const obj of data.timelineObjects) {
      if (obj.placeVisit) {
        const pv = obj.placeVisit
        const loc = pv.location
        if (loc) {
          const lat = loc.latitudeE7 / 1e7
          const lng = loc.longitudeE7 / 1e7
          const date = pv.duration?.startTimestamp?.slice(0, 10) || null
          places.push({ lat, lng, date, name: loc.name || null, photoCount: 1 })
        }
      }
    }
  }

  // Raw locations format
  if (data.locations && places.length === 0) {
    // Sample every ~100th point to avoid thousands of places
    const locs = data.locations
    const step = Math.max(1, Math.floor(locs.length / 200))
    for (let i = 0; i < locs.length; i += step) {
      const l = locs[i]
      // Truthy checks silently drop a real point exactly on the equator or prime meridian
      // (latitudeE7/longitudeE7 === 0, a legitimate coordinate, is falsy) — check the fields
      // are actually present instead of checking they're non-zero.
      if (typeof l.latitudeE7 === 'number' && typeof l.longitudeE7 === 'number') {
        const date = l.timestamp ? l.timestamp.slice(0, 10) : null
        places.push({ lat: l.latitudeE7 / 1e7, lng: l.longitudeE7 / 1e7, date, name: null, photoCount: 1 })
      }
    }
  }

  return places
}


// ── Regex-based booking extractor ────────────────────────────────────────────
// Parse a localized number string ("1 978,00", "1,234.56", "1.234,56", "978.00", "20.5")
// into a plain float — the last comma/dot followed by exactly 1 OR 2 trailing digits is the
// decimal separator; everything else (spaces, other commas/dots, or a 3+-digit trailing group)
// is a thousands separator. Originally required exactly 2 trailing digits, which silently
// mis-parsed any single-decimal-digit amount ("20.5" EUR, "20,5" DKK — both real, common
// formats) as a thousands-grouped integer instead: falling through to the plain digit-strip
// path turned "20.5" into 205, a silent 10x inflation with no error surfaced. A 3+-digit
// trailing group is still treated as thousands ("1.234" -> 1234), since real currency amounts
// essentially never carry 3 decimal places.
function parseLocalizedNumber(str) {
  const s = String(str).replace(/\s/g, '')
  const m = s.match(/^(.*)[.,](\d{1,2})$/)
  if (m) return parseFloat(m[1].replace(/[.,]/g, '') + '.' + m[2])
  return parseFloat(s.replace(/[.,]/g, ''))
}

// Month names (English + Nordic) for written-out dates like "17 July 2026" / "17 juli 2026"
const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  januari: 1, februari: 2, mars: 3, maj: 5, juni: 6, juli: 7, augusti: 8, oktober: 10,
  januar: 1, februar: 2, desember: 12,
}
function parseWrittenDate(day, monthName, year) {
  const mo = MONTH_NAMES[monthName.toLowerCase()]
  if (!mo) return null
  return year + '-' + String(mo).padStart(2, '0') + '-' + String(day).padStart(2, '0')
}

function parseBookingsRegex(text) {
  const bookings = []
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const full = text

  // ── Flight number patterns ─────────────────────────────────────────────────
  // e.g. SK983, CA598, IJ018, LH123, FR1234
  const flightRe = /\b([A-Z]{2}|[A-Z]\d)\s*(\d{3,4})\b/g
  const dateRe = /\b(\d{4}[-.](0[1-9]|1[0-2])[-.](\d{2}))|(([0-2]?\d|3[01])[-./](0[1-9]|1[0-2])[-./](\d{2,4}))\b/g
  const timeRe = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g
  const priceRe = /\b(EUR|USD|GBP|SEK|DKK|NOK|JPY|CNY|THB)\s*([\d][\d ,.]*\d|\d)\b|\b([\d][\d ,.]*\d|\d)\s*(EUR|USD|GBP|SEK|DKK|NOK|JPY)/g
  const iataRe = /\b([A-Z]{3})\b/g
  // Keyword may be followed by a glue word ("no"/"nr"/"number"/"nummer") and/or punctuation before the code —
  // e.g. "Booking no: W3RUY83D", "Bokningsnummer   W3RUY83D". Case spelled out explicitly (not /i) so the
  // final [A-Z0-9] capture stays uppercase-only and doesn't grab stray lowercase words.
  const bookingRefRe = /\b(?:[Bb]ooking|[Cc]onfirmation|[Rr]eservation|[Rr]eference|[Rr]ef|[Pp]nr|[Cc]ode|[Bb]okningsnummer|[Bb]estillingsnummer)\b(?:\s*(?:[Nn]o|[Nn]r|[Nn]umber|[Nn]ummer)\b)?[\s:#.-]{0,4}([A-Z0-9]{4,12})\b/g

  // Extract all dates
  const allDates = []
  let dm; dateRe.lastIndex = 0
  while ((dm = dateRe.exec(full)) !== null) {
    const raw = dm[0]
    // Normalize to YYYY-MM-DD
    try {
      const parts = raw.split(/[-./]/)
      let y, mo, d
      if (parts[0].length === 4) { y = parts[0]; mo = parts[1]; d = parts[2] }
      else if (parts[2].length === 4) { d = parts[0]; mo = parts[1]; y = parts[2] }
      else if (parts[2].length === 2) { d = parts[0]; mo = parts[1]; y = '20' + parts[2] }
      if (y && mo && d) allDates.push(y + '-' + mo.padStart(2,'0') + '-' + d.padStart(2,'0'))
    } catch (_e) {}
  }
  // Also pick up written-out dates ("17 juli 2026", "17 July 2026") — common on
  // European rail/receipt exports that don't use a numeric date format at all.
  // Keeps each match's string position too (dateMarks), so the multi-leg train
  // detector below can attach the nearest preceding date to each leg.
  const writtenDateRe = /\b(\d{1,2})\s+([\p{L}]+)\s+(\d{4})\b/gu
  const dateMarks = []
  let wdm; writtenDateRe.lastIndex = 0
  while ((wdm = writtenDateRe.exec(full)) !== null) {
    const iso = parseWrittenDate(wdm[1], wdm[2], wdm[3])
    if (iso) {
      dateMarks.push({ index: wdm.index, iso })
      if (!allDates.includes(iso)) allDates.push(iso)
    }
  }

  // Extract all times
  const allTimes = []
  let tm; timeRe.lastIndex = 0
  while ((tm = timeRe.exec(full)) !== null) allTimes.push(tm[0])

  // Extract price
  let price = null, currency = null
  let pm; priceRe.lastIndex = 0
  while ((pm = priceRe.exec(full)) !== null) {
    if (pm[1]) { currency = pm[1]; price = parseLocalizedNumber(pm[2]) }
    else if (pm[4]) { currency = pm[4]; price = parseLocalizedNumber(pm[3]) }
    if (price) break
  }

  // Extract booking ref
  let bookingRef = null
  let bm; bookingRefRe.lastIndex = 0
  while ((bm = bookingRefRe.exec(full)) !== null) { bookingRef = bm[1]; break }

  // ── Detect structured multi-leg train tickets ─────────────────────────────
  // Rail e-ticket exports (SJ/Resplus-style, and similar) print each leg as
  // "HH:MM  From Station  HH:MM  To Station  Train NNNN" — matched here BEFORE
  // flight detection, because a train/service number like "SJ 3000" would
  // otherwise false-match the [A-Z]{2}\d{3,4} flight-number pattern below.
  const legRe = /(\d{1,2}:\d{2})\s+([\p{L}][\p{L} .'-]{1,40}?)\s+(\d{1,2}:\d{2})\s+([\p{L}][\p{L} .'-]{1,40}?)\s+Train\s+(\d+)/gu
  const legOperatorRe = /\b(SJ|Öresundståg|Oresundstag|Resplus|SNCF|Trenitalia|Renfe|Eurostar|Thalys|ICE|TGV|Amtrak|DB|MAV|Intercity)\b/i
  // dateMarks (built above alongside allDates) already holds every written-date match with its string
  // position — reuse it to attach the nearest preceding date to each leg.
  const nearestDate = idx => {
    let best = null
    for (const d of dateMarks) { if (d.index <= idx) best = d.iso; else break }
    return best
  }

  const legs = []
  const seenLegs = new Set()
  let lm; legRe.lastIndex = 0
  while ((lm = legRe.exec(full)) !== null) {
    const [, fromTime, fromStationRaw, toTime, toStationRaw, trainNum] = lm
    const fromStation = fromStationRaw.trim(), toStation = toStationRaw.trim()
    // Same physical leg often repeats once per co-traveller's ticket — dedupe.
    const key = fromStation + '|' + toStation + '|' + fromTime + '|' + toTime + '|' + trainNum
    if (seenLegs.has(key)) continue
    seenLegs.add(key)
    const date = nearestDate(lm.index)
    const opMatch = legOperatorRe.exec(full.slice(lm.index, legRe.lastIndex + 300))
    legs.push({ fromStation, toStation, fromTime, toTime, trainNum, date, operator: opMatch ? opMatch[1] : null })
  }

  if (legs.length) {
    legs.forEach((leg, i) => {
      bookings.push({
        _id: 't' + i,
        type: 'train',
        title: 'Train ' + leg.trainNum + ' ' + leg.fromStation + '→' + leg.toStation,
        from: leg.fromStation, from_code: null,
        from_date: leg.date, from_time: leg.fromTime,
        to: leg.toStation, to_code: null,
        to_date: leg.date, to_time: leg.toTime,
        operator: leg.operator,
        flight_number: null,
        booking_ref: bookingRef,
        price: i === 0 ? price : null,
        currency: i === 0 ? currency : null,
        notes: 'Train ' + leg.trainNum,
        confidence: leg.date ? 'high' : 'medium',
        _source: 'regex',
      })
    })
    return bookings
  }

  // ── Detect flights ─────────────────────────────────────────────────────────
  const flightNums = []
  let fm; flightRe.lastIndex = 0
  while ((fm = flightRe.exec(full)) !== null) {
    const fn = fm[1] + fm[2]
    if (!flightNums.includes(fn)) flightNums.push(fn)
  }

  if (flightNums.length) {
    // Extract airport codes — look for IATA codes near arrows or "to/from" keywords
    const airports = []
    const airportCtx = full.replace(/\n/g, ' ')
    // Pattern: CPH → HND or Copenhagen (CPH) or from CPH to HND
    const arrowPat = /\b([A-Z]{3})\s*(?:->|→|to)\s*([A-Z]{3})\b/g
    let ap
    while ((ap = arrowPat.exec(airportCtx)) !== null) airports.push([ap[1], ap[2]])

    flightNums.forEach((fn, i) => {
      const pair = airports[i] || airports[0] || []
      bookings.push({
        _id: 'f' + i,
        type: 'flight',
        title: fn + (pair.length ? ' ' + pair[0] + '→' + pair[1] : ''),
        from: pair[0] || null,
        from_code: pair[0] || null,
        from_date: allDates[i * 2] || allDates[0] || null,
        from_time: allTimes[i * 2] || allTimes[0] || null,
        to: pair[1] || null,
        to_code: pair[1] || null,
        to_date: allDates[i * 2 + 1] || allDates[1] || null,
        to_time: allTimes[i * 2 + 1] || allTimes[1] || null,
        operator: detectAirline(fn),
        flight_number: fn,
        booking_ref: bookingRef,
        price: i === 0 ? price : null,
        currency: i === 0 ? currency : null,
        notes: null,
        confidence: pair.length ? 'high' : 'medium',
        _source: 'regex',
      })
    })
    return bookings
  }

  // ── Detect hotels ──────────────────────────────────────────────────────────
  const hotelRe = /\b(hotel|hostel|inn|resort|suites?|lodge|b&b|bed and breakfast|airbnb)\b/i
  if (hotelRe.test(full)) {
    // Try to extract hotel name from first capitalised line containing hotel keyword
    let hotelName = null
    for (const line of lines) {
      if (hotelRe.test(line) && line.length < 60) { hotelName = line; break }
    }
    bookings.push({
      _id: 'h0',
      type: 'hotel',
      title: hotelName || 'Hotel booking',
      from: null,
      from_date: allDates[0] || null,
      to: null,
      to_date: allDates[1] || null,
      operator: hotelName,
      booking_ref: bookingRef,
      price,
      currency,
      notes: null,
      confidence: hotelName ? 'medium' : 'low',
      _source: 'regex',
    })
    return bookings
  }

  // ── Detect buses / trains ──────────────────────────────────────────────────
  const busRe = /\b(flixbus|eurolines|regiojet|blablabus|ouibus|megabus|nationalexpress|intercars)\b/i
  const trainRe = /\b(intercity|eurostar|thalys|ice|tgv|renfe|trenitalia|db bahn|amtrak|sncf|mav|öresundståg|oresundstag|resplus|sj ab)\b/i
  const busMatch = busRe.exec(full)
  const trainMatch = trainRe.exec(full)

  if (busMatch || trainMatch) {
    const op = busMatch ? busMatch[1] : trainMatch[1]
    // Find route — look for "City A - City B", "City A to City B", or "City A–City B" (en dash).
    // Each side must be 1-3 Title-Case words (allowing accented letters: Göteborg, Malmö, …) starting
    // right after a field boundary (line start or 2+ spaces) — anchoring on capitalization instead of
    // a loose "any letters" class avoids swallowing unrelated lowercase filler text ("your journey", …)
    // or stray hyphens inside reference numbers.
    const titleWord = "[A-ZÀ-Þ][\\p{Ll}'-]*"
    const placeName = titleWord + '(?: ' + titleWord + '){0,2}'
    const routePat = new RegExp('(?:^|(?<=\\s{2}))(' + placeName + ')\\s*(?:to|-|–|→)\\s*(' + placeName + ')(?=\\s{2}|$)', 'u')
    const rm = routePat.exec(full)
    bookings.push({
      _id: 'bt0',
      type: busMatch ? 'bus' : 'train',
      title: op + (rm ? ' ' + rm[1] + '→' + rm[2] : ''),
      from: rm ? rm[1] : null,
      from_date: allDates[0] || null,
      from_time: allTimes[0] || null,
      to: rm ? rm[2] : null,
      to_date: allDates[1] || allDates[0] || null,
      to_time: allTimes[1] || null,
      operator: op,
      booking_ref: bookingRef,
      price,
      currency,
      notes: null,
      confidence: rm ? 'medium' : 'low',
      _source: 'regex',
    })
    return bookings
  }

  return bookings
}

// ── Mindtrip-style day-by-day guide detector ────────────────────────────────
// Mindtrip.ai (and similar trip-guide tools) export PDFs shaped as a sequence of day
// headers ("Day 1", "Day 2 - Rome", or a written-out date) each followed by a list of
// place+category lines ("Colosseum — Landmark", "Trattoria Roma (Restaurant)"). This is
// a fundamentally different shape than a booking confirmation — there's no from/to,
// no price, no single "type" — so it's parsed as an independent pass over the same text
// and returned as a SEPARATE `guidePlaces` array, never folded into `bookings`.
//
// IMPORTANT: no real Mindtrip export was available to develop this against — these
// patterns are a best guess based on how day-by-day trip-guide exports typically read
// (informed by the sibling `featured-guides` project's treatment of such PDFs as
// "generic trip-guide documents"), NOT confirmed against real Mindtrip output. Treat any
// guidePlaces result as heuristic; the caller surfaces a `notices` warning accordingly.
//
// Runs independently of parseBookingsRegex's detectors above — it looks for a day-header/
// place-list pattern, not a route/flight/train pattern, so there's no ordering conflict
// with the rail-vs-flight sequencing those detectors need (confirmed by reading them: none
// of them return early in a way that would prevent this from also scanning the same text).
const DAY_HEADER_RE = /^(?:Day\s+(\d+))\b(?:\s*[-–:]\s*(.+))?$/i
const DAY_HEADER_DATE_RE = /^(\d{1,2})\s+([\p{L}]+)\s+(\d{4})\b(?:\s*[-–:]\s*(.+))?$/u
// "Place Name — Category" / "Place Name (Category)" / "Place Name - Category". Requires the
// left side to start with a capital letter (avoids matching stray sentence fragments) and the
// category side to be short (a real category word/phrase, not a full sentence).
const GUIDE_PLACE_LINE_RE = /^([A-ZÀ-Þ][\p{L}0-9 .,'&-]{1,60}?)\s*(?:—|-|–|\()\s*([\p{L}][\p{L} /&-]{1,30})\)?\s*$/u
const GUIDE_CATEGORY_HINT_RE = /\b(restaurant|cafe|café|bar|museum|landmark|hotel|park|attraction|activity|tour|viewpoint|market|shop|beach|temple|church|gallery|monument|hike|trail|bakery|brewery|winery)\b/i

function parseGuidePlaces(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
  const guidePlaces = []
  let currentDayIndex = null
  let currentDate = null

  for (const line of lines) {
    const dm = DAY_HEADER_RE.exec(line)
    if (dm) {
      currentDayIndex = parseInt(dm[1], 10) - 1
      currentDate = null
      continue
    }
    const ddm = DAY_HEADER_DATE_RE.exec(line)
    if (ddm) {
      const iso = parseWrittenDate(ddm[1], ddm[2], ddm[3])
      if (iso) {
        currentDate = iso
        if (currentDayIndex === null) currentDayIndex = guidePlaces.length ? currentDayIndex : 0
        continue
      }
    }
    if (currentDayIndex === null) continue // haven't seen a day header yet — not a guide layout (yet)
    const pm = GUIDE_PLACE_LINE_RE.exec(line)
    if (pm) {
      const name = pm[1].trim()
      const category = pm[2].trim()
      // Require the category side to actually look like a category (either a known keyword,
      // or short enough — 1-2 words — to plausibly be one) to avoid false-matching an ordinary
      // "Name - some longer descriptive clause" line as a place+category pair.
      if (GUIDE_CATEGORY_HINT_RE.test(category) || category.split(/\s+/).length <= 2) {
        guidePlaces.push({ name, category, dayIndex: currentDayIndex, date: currentDate })
      }
    }
  }
  return guidePlaces
}

// Map IATA airline prefix to name
function detectAirline(flightNum) {
  const codes = {
    SK:'SAS',CA:'Air China',LH:'Lufthansa',FR:'Ryanair',W6:'Wizz Air',
    U2:'easyJet',BA:'British Airways',AF:'Air France',KL:'KLM',
    IJ:'Spring Japan',MU:'China Eastern',AY:'Finnair',TK:'Turkish Airlines',
    OS:'Austrian Airlines',LX:'Swiss',EK:'Emirates',QR:'Qatar',
    CX:'Cathay Pacific',NH:'ANA',JL:'JAL',SQ:'Singapore Airlines',
  }
  // The prefix is always exactly the first 2 characters (fn = flightRe's [A-Z]{2}|[A-Z]\d
  // capture, concatenated directly with the digits that follow) — stripping ALL digits instead
  // broke every mixed letter+digit code (W6 Wizz Air, U2 easyJet): "W61234" lost its "6" too,
  // leaving prefix "W" (not in the map) instead of "W6", so the operator silently came back null.
  const prefix = flightNum.slice(0, 2).toUpperCase()
  return codes[prefix] || null
}

// ── ICS/iCalendar booking extractor ──────────────────────────────────────────
// Booking confirmations often arrive as a structured .ics VEVENT (DTSTART/DTEND/
// SUMMARY/LOCATION) rather than free text — parse those fields directly instead
// of running the regex guesswork above on them.
function guessBookingType(text) {
  const t = text || ''
  if (/\b(hotel|hostel|inn|resort|suites?|lodge|b&b|bed and breakfast|airbnb)\b/i.test(t)) return 'hotel'
  if (/\b([A-Z]{2}|[A-Z]\d)\s*\d{3,4}\b/.test(t)) return 'flight'
  if (/\b(flixbus|eurolines|regiojet|blablabus|ouibus|megabus|nationalexpress|intercars|\bbus\b)\b/i.test(t)) return 'bus'
  if (/\b(intercity|eurostar|thalys|\bice\b|\btgv\b|renfe|trenitalia|db bahn|amtrak|sncf|\bmav\b|öresundståg|oresundstag|resplus|sj ab|\btrain\b|\brail\b)\b/i.test(t)) return 'train'
  if (/\b(ferry|ferries|cruise)\b/i.test(t)) return 'ferry'
  return 'transport_other'
}

// RFC 5545 line folding: a continuation line starts with a single space/tab and
// must be joined onto the previous line before parsing key:value pairs.
function icsUnfold(text) {
  const out = []
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1)
    else out.push(line)
  }
  return out
}

// DTSTART/DTEND values look like '20260716T140000Z', '20260716T140000', or a bare
// '20260716' (VALUE=DATE, all-day). Timezone offset/TZID is intentionally ignored —
// good enough for slotting the booking onto the right day, not scheduling to the minute.
function icsDate(value) {
  const m = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/)
  if (!m) return { date: null, time: null }
  const [, y, mo, d, h, mi] = m
  return { date: y + '-' + mo + '-' + d, time: h ? h + ':' + mi : null }
}

function icsUnescape(s) {
  return String(s || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

function parseICS(text) {
  const lines = icsUnfold(text)
  const bookings = []
  let cur = null
  let idx = 0
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = {}; continue }
    if (/^END:VEVENT/i.test(line)) {
      if (cur) {
        const summary = cur.SUMMARY || 'Event'
        const location = cur.LOCATION || ''
        const description = cur.DESCRIPTION || ''
        const type = guessBookingType(summary + ' ' + location + ' ' + description)
        const start = icsDate(cur._DTSTART)
        const end = icsDate(cur._DTEND)
        // Crude route split from the summary text ("Flight LH123 CPH-FRA", "CPH to FRA …").
        const routeMatch = /\b([\p{L}][\p{L} .'-]{1,30}?)\s+(?:->|→|to)\s+([\p{L}][\p{L} .'-]{1,30})\b/u.exec(summary)
        // A real confirmation code in the description/summary ("Booking ref XJ92KD") is more
        // useful than the calendar event's own UID — prefer it, UID is just the fallback.
        const refMatch = /\b(?:booking|confirmation|reservation|reference|ref|pnr|code)\b(?:\s*(?:no|nr|number|nummer)\b)?[\s:#.-]{0,4}([A-Z0-9]{4,12})\b/i.exec(summary + ' ' + description)
        bookings.push({
          _id: 'ics' + (idx++),
          type,
          title: summary,
          from: routeMatch ? routeMatch[1].trim() : null,
          from_code: null,
          from_date: start.date,
          from_time: start.time,
          to: routeMatch ? routeMatch[2].trim() : null,
          to_code: null,
          to_date: end.date || start.date,
          to_time: end.time,
          operator: null,
          flight_number: null,
          booking_ref: (refMatch ? refMatch[1].toUpperCase() : null) || cur.UID || null,
          price: null,
          currency: null,
          notes: [location, description].filter(Boolean).join('\n') || null,
          confidence: 'high',
          _source: 'ics',
        })
      }
      cur = null
      continue
    }
    if (!cur) continue
    // KEY;PARAM=..:VALUE — params are ignored (VALUE=DATE is inferred from the value's own
    // shape in icsDate, TZID's offset is intentionally not applied — see icsDate above).
    const m = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/)
    if (!m) continue
    const key = m[1].toUpperCase()
    const val = m[2]
    if (key === 'SUMMARY') cur.SUMMARY = icsUnescape(val)
    else if (key === 'LOCATION') cur.LOCATION = icsUnescape(val)
    else if (key === 'DESCRIPTION') cur.DESCRIPTION = icsUnescape(val)
    else if (key === 'UID') cur.UID = val
    else if (key === 'DTSTART') cur._DTSTART = val
    else if (key === 'DTEND') cur._DTEND = val
  }
  return bookings
}

const BOOKING_PROMPT = `Extract all travel bookings from the text below. Return ONLY valid JSON, no markdown.

{"bookings":[{"type":"flight|hotel|bus|train|transfer|ferry","title":"short title","from":"origin","from_code":"IATA or null","from_date":"YYYY-MM-DD or null","from_time":"HH:MM or null","to":"destination","to_code":"IATA or null","to_date":"YYYY-MM-DD or null","to_time":"HH:MM or null","operator":"name","booking_ref":"ref or null","flight_number":"e.g. SK983 or null","price":0,"currency":"EUR","notes":"notes or null","confidence":"high|medium|low"}],"trip_name":"name or null","summary":"one sentence"}

Rules: extract ALL bookings, one entry per flight leg, dates YYYY-MM-DD, times HH:MM 24h, price as number only.

If the text instead reads as a day-by-day trip guide (e.g. "Day 1", "Day 2 - City", or written-out day dates, each followed by a list of place names with a category like Restaurant/Museum/Landmark) rather than booking confirmations, do NOT force those into the bookings shape — instead add a top-level "guidePlaces" array: [{"name":"place name","category":"category or null","dayIndex":0,"date":"YYYY-MM-DD or null"}], with dayIndex being the 0-based day number from the guide. Both "bookings" and "guidePlaces" may be present together if the text contains both kinds of content.

---TEXT---
`

// Diagnostic instrumentation added after a real host reported the plugin's own process getting
// SIGKILL'd for exceeding a 300MB memory ceiling, repeatedly, with the host's own supervisor logs
// giving no indication of which route was in flight at the time — nothing in this file's own
// module-level state (no caches, no timers, no globals that grow) explains a leak on its own, so
// this wraps every handler to log request size + heap usage before/after, to catch which specific
// route (and what payload shape) is actually responsible next time this reproduces. Remove once
// the real cause is confirmed — this is not meant to be permanent.
function instrumentRoutes(routes) {
  return routes.map(route => ({
    ...route,
    async handler(req, ctx) {
      const before = process.memoryUsage().heapUsed
      const bodyBytes = (() => { try { return JSON.stringify(req.body || {}).length } catch (_e) { return -1 } })()
      let result, err
      try { result = await route.handler(req, ctx) } catch (e) { err = e; throw e }
      finally {
        const after = process.memoryUsage().heapUsed
        const line = `[mem] ${route.method} ${route.path} bodyBytes=${bodyBytes} heapBefore=${Math.round(before / 1e6)}MB heapAfter=${Math.round(after / 1e6)}MB delta=${Math.round((after - before) / 1e6)}MB${err ? ' THREW=' + err.message : ''}`
        try { ctx.log.info(line) } catch (_e) { console.log(line) }
      }
      return result
    },
  }))
}

module.exports = definePlugin({
  async onLoad(ctx) { ctx.log.info('trip-importer v2.0.0 loaded') },
  routes: instrumentRoutes([

    // ── List trips ────────────────────────────────────────────────────────────
    {
      method: 'GET', path: '/trips', auth: true,
      async handler(req, ctx) {
        const result = await tryAttempt(async () => {
          const trips = await ctx.trips.listMine()
          const arr = Array.isArray(trips) ? trips : []
          return { trips: arr.map(t => ({ id: t.id, title: t.title || 'Untitled', startDate: t.start_date, endDate: t.end_date })).filter(t => t.id) }
        })
        return safeJson(200, result)
      },
    },

    // ── Parse Polarsteps ──────────────────────────────────────────────────────
    {
      method: 'POST', path: '/parse-polarsteps', auth: true,
      async handler(req, ctx) {
        // A trip.json with many steps is exactly the shape most likely to trip the plugin-route
        // proxy's own undocumented body-size ceiling — confirmed against a REAL instance at just
        // ~0.27MB (300 steps), far below where local dev-server testing could ever catch it (the
        // dev server doesn't enforce whatever the production proxy does). Below this ceiling
        // basically no real trip.json is safe to send in one request, so the client now chunks
        // `all_steps` client-side (see doAnalyze()/parsePolarstepsChunked() in client/index.html)
        // and calls this route once per chunk via `stepsChunk`, merging the results itself — the
        // original single-shot `{json}` shape stays exactly as it was for backward compatibility
        // (and is still what the client uses for the trip-metadata-only call, all_steps stripped).
        const stepsChunk = req.body?.stepsChunk
        if (Array.isArray(stepsChunk)) {
          const startIndex = Number(req.body?.stepsChunkOffset) || 0
          const result = await tryAttempt(async () => ({ steps: mapPolarstepsSteps(stepsChunk, startIndex) }))
          return safeJson(200, result)
        }

        const raw = req.body?.json
        if (!raw) return safeJson(200, { error: 'json required' })
        const result = await tryAttempt(async () => {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw
          const trip = Array.isArray(data) ? data[0] : data
          const steps = Array.isArray(trip.all_steps) ? trip.all_steps : []
          return {
            name: trip.name || 'Untitled trip',
            startDate: unixToDate(trip.start_date),
            endDate: unixToDate(trip.end_date),
            totalKm: trip.total_km ? Math.round(trip.total_km) : null,
            uuid: String(trip.uuid || trip.id || ''),
            // The trip's own free-text narrative and cover photo — both previously discarded
            // entirely. coverPhotoUrl prefers cover_photo_path (Polarsteps' own "large_thumb"
            // rendition — a reasonable size for a trip cover banner) over the full-res original
            // (cover_photo.path, likely far larger than needed) or the small thumbnail.
            summary: (trip.summary && trip.summary.trim()) || null,
            coverPhotoUrl: trip.cover_photo_path || trip.cover_photo?.large_thumbnail_path || trip.cover_photo?.path || null,
            stepCount: steps.length,
            steps: mapPolarstepsSteps(steps),
          }
        })
        return safeJson(200, result)
      },
    },

    // ── Parse bookings — regex first, AI optional fallback ──────────────────
    {
      method: 'POST', path: '/parse-bookings', auth: true,
      async handler(req, ctx) {
        const text = req.body?.text
        const useAI = req.body?.useAI === true
        if (!text || text.trim().length < 20) return safeJson(200, { bookings: [], summary: 'No text' })
        const result = await tryAttempt(async () => {
          const bookings = parseBookingsRegex(text)
          // Independent pass — a day-by-day Mindtrip-style guide may appear in the same text
          // regardless of whether the booking detectors above found anything (they look for a
          // different pattern; see parseGuidePlaces' own comment for why there's no ordering
          // conflict). guidePlaces is a places-with-a-day-index shape, never merged into bookings.
          const guidePlaces = parseGuidePlaces(text)
          const notices = []
          if (guidePlaces.length) {
            notices.push({ level: 'warn', message: `Found ${guidePlaces.length} day-by-day guide place(s) (Mindtrip-style layout) — this pattern is a best guess, UNCONFIRMED against a real Mindtrip export. Double-check names/days before importing.` })
          }

          // If regex found nothing and AI is requested, try AI
          if (!bookings.length && useAI) {
            try {
              const aiResult = await ctx.ai.complete(BOOKING_PROMPT + text.slice(0, 18000))
              const raw = (aiResult?.text || '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
              const parsed = JSON.parse(raw)
              const aiBookings = (parsed.bookings || []).map((b, i) => ({ ...b, _id: 'ai' + i, _source: 'ai' }))
              const aiGuidePlaces = Array.isArray(parsed.guidePlaces) ? parsed.guidePlaces : []
              const aiNotices = notices.slice()
              if (aiGuidePlaces.length) aiNotices.push({ level: 'warn', message: `AI extracted ${aiGuidePlaces.length} day-by-day guide place(s) — unconfirmed, double-check before importing.` })
              return { bookings: aiBookings, guidePlaces: aiGuidePlaces, tripName: parsed.trip_name || null, summary: parsed.summary || null, source: 'ai', notices: aiNotices }
            } catch (_e) {}
          }

          return { bookings, guidePlaces, summary: bookings.length + ' booking' + (bookings.length === 1 ? '' : 's') + ' found', source: 'regex', notices }
        })
        return safeJson(200, result)
      },
    },

    // ── Forward-geocode guide-place names (Mindtrip-style day-by-day guides have no coords) ──
    // Budget-aware and index-resumable like /import, for the same reason: Nominatim's 1req/sec
    // limit means only a handful of names fit under the ~8s trek:invoke bridge ceiling (see
    // CLAUDE.md's "/import is index-resumable" section) — a large guide needs several rounds.
    // Client (`geocodeGuidePlaces()`) loops calling this with `offset` until `done`.
    {
      method: 'POST', path: '/geocode-guide-places', auth: true,
      async handler(req, ctx) {
        const names = req.body?.names || []
        const offset = req.body?.offset || 0
        const result = await tryAttempt(async () => {
          const resolved = []
          const deadline = Date.now() + 6000
          let i = offset
          for (; i < names.length; i++) {
            if (Date.now() > deadline) break
            const coords = await geocodePlaceName(names[i])
            resolved.push({ index: i, lat: coords?.lat ?? null, lng: coords?.lng ?? null })
            if (i < names.length - 1) await sleep(1100) // Nominatim's ~1 req/sec usage policy
          }
          return { resolved, nextOffset: i, done: i >= names.length }
        })
        return safeJson(200, result)
      },
    },

    // ── Parse GPS from photos (client sends pre-extracted coords) ─────────────
    {
      method: 'POST', path: '/parse-gps', auth: true,
      async handler(req, ctx) {
        const photos = req.body?.photos || []
        const result = await tryAttempt(async () => {
          const byDate = {}
          for (const p of photos) {
            // Truthy checks silently drop a real photo taken exactly on the equator or prime
            // meridian (lat/lng === 0 is a legitimate coordinate, but falsy) — check the fields
            // are actually numbers instead of checking they're non-zero.
            if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue
            const date = (p.date || '').slice(0, 10) || 'unknown'
            if (!byDate[date]) byDate[date] = []
            byDate[date].push(p)
          }
          // One point per DAY (median lat/lng of all that day's photos) collapses multiple distinct
          // locations visited the same day into a single, sometimes-nowhere-real point — e.g. a day
          // with photos from 3 different attractions produced 1 "place" roughly between them. Cluster
          // by proximity WITHIN each day first (same radius as parse-timeline), so a day only becomes
          // one place if its photos were actually all taken near each other.
          // 'unknown' above is only a grouping key for photos with no EXIF date — it must never
          // leak into the place's own `date` field. It's not a valid YYYY-MM-DD, and downstream
          // consumers (the client's date-auto-detect fallback, /import's date-range fallback,
          // both of which sort raw date strings to find a min/max) would otherwise treat the
          // literal string "unknown" as sorting after every real date and wrongly pick it as
          // the trip's end date.
          const places = []
          for (const [date, pts] of Object.entries(byDate)) {
            const clusters = clusterByProximity(pts, 500)
            for (const c of clusters) {
              places.push({
                date: date === 'unknown' ? null : date,
                lat: c.lat,
                lng: c.lng,
                photoCount: c.members.length,
                photoNames: c.members.map(m => m.name),
              })
            }
          }
          places.sort((a, b) => (a.date || '').localeCompare(b.date || ''))
          return { places, totalPhotos: photos.length }
        })
        return safeJson(200, result)
      },
    },

    // ── Parse Google Maps Timeline JSON ───────────────────────────────────────
    {
      method: 'POST', path: '/parse-timeline', auth: true,
      async handler(req, ctx) {
        const raw = req.body?.json
        if (!raw) return safeJson(200, { places: [] })
        const result = await tryAttempt(async () => {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw
          const places = parseGoogleTimeline(data)
          // Cluster nearby points
          const clusters = clusterByProximity(places, 500)
          // Hard cap, not a paginated window — any cluster beyond the 200th is dropped for good,
          // unlike the resumable per-round windowing /import uses for steps/bookings/expenses.
          const notices = []
          if (clusters.length > 200) notices.push({ level: 'warn', message: `Your Google Timeline data clustered into ${clusters.length} distinct places — only the first 200 were kept (a hard limit for this import), so ${clusters.length - 200} were not imported` })
          return { places: clusters.slice(0, 200), totalPoints: places.length, notices }
        })
        return safeJson(200, result)
      },
    },

    // ── Parse expense CSV ─────────────────────────────────────────────────────
    {
      method: 'POST', path: '/parse-csv', auth: true,
      async handler(req, ctx) {
        const text = req.body?.text
        const aiEnhance = req.body?.aiEnhance !== false
        if (!text) return safeJson(200, { expenses: [] })
        const result = await tryAttempt(async () => {
          function parseCSVLine(line) {
            const r = []; let cur = '', inQ = false
            for (const c of line) {
              if (c === '"') inQ = !inQ
              else if ((c === ',' || c === ';' || c === '\t') && !inQ) { r.push(cur.trim()); cur = '' }
              else cur += c
            }
            r.push(cur.trim()); return r
          }
          const lines = text.trim().split('\n').filter(l => l.trim())
          if (lines.length < 2) return { expenses: [], error: 'Need header + data rows' }
          const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''))
          const findCol = (...ns) => ns.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1
          const dateCol = findCol('date', 'datum', 'data', 'day', 'time', 'timestamp')
          const nameCol = findCol('name', 'description', 'desc', 'item', 'note', 'title', 'merchant', 'payee', 'memo')
          const amtCol = findCol('amount', 'price', 'cost', 'total', 'value', 'sum', 'bedrag', 'debit', 'credit')
          const currCol = findCol('currency', 'curr', 'valuta', 'ccy')
          const catCol = findCol('category', 'cat', 'type', 'tag', 'label')

          const expenses = []
          // Counts surfaced via `notices` below — per the CLAUDE.md "no silent caps/skips"
          // guidance, a row silently disappearing (unparseable amount, or no name AND no
          // amount at all) or silently falling back to no-currency must be visible to the
          // user, not just absent from the resulting count with no explanation.
          let skippedBadAmount = 0
          let skippedEmpty = 0
          let unparseableDate = 0
          let noCurrency = 0
          for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i])
            if (!cols.length || cols.every(c => !c)) continue
            const raw = amtCol >= 0 ? cols[amtCol] || '' : ''
            // Strip currency symbols/codes but keep digits, both separators, spaces, and the sign —
            // parseLocalizedNumber() decides which of ,/. is the decimal point (same fix as booking prices).
            const amt = parseLocalizedNumber(raw.replace(/[^0-9.,\s-]/g, ''))
            if (amtCol >= 0 && (isNaN(amt) || amt === 0)) { skippedBadAmount++; continue }
            const name = nameCol >= 0 ? cols[nameCol] || null : null
            if (!name && !amt) { skippedEmpty++; continue }

            // Smart category detection from name
            const nameLower = (name || '').toLowerCase()
            let detectedCat = catCol >= 0 ? cols[catCol] || null : null
            if (!detectedCat) {
              if (/hotel|hostel|airbnb|accommodation|inn|motel|resort/.test(nameLower)) detectedCat = 'accommodation'
              else if (/flight|airline|airways|airport|air |ryanair|easyjet|wizz|sas|lufthansa/.test(nameLower)) detectedCat = 'transport'
              else if (/train|rail|flixbus|bus|tram|metro|taxi|uber|grab|bolt/.test(nameLower)) detectedCat = 'transport'
              else if (/restaurant|cafe|coffee|food|meal|dinner|lunch|breakfast|bar|pub|eat/.test(nameLower)) detectedCat = 'food'
              else if (/museum|ticket|tour|entry|admission|attraction/.test(nameLower)) detectedCat = 'activities'
              else if (/supermarket|market|grocery|shop|store/.test(nameLower)) detectedCat = 'shopping'
            }

            let normDate = null
            if (dateCol >= 0 && cols[dateCol]) {
              normDate = normalizeDateStr(cols[dateCol])
              if (!normDate) unparseableDate++
            }
            const currency = currCol >= 0 ? (cols[currCol] || '').toUpperCase().slice(0, 3) || null : null
            if (!currency) noCurrency++

            expenses.push({
              _id: 'e' + i,
              date: normDate,
              name: name || ('Expense ' + i),
              amount: Math.abs(amt), // always positive
              currency,
              category: detectedCat || 'other',
            })
          }
          const notices = []
          if (skippedBadAmount) notices.push({ level: 'warn', message: `Skipped ${skippedBadAmount} row(s) with an amount column that couldn't be parsed as a number` })
          if (skippedEmpty) notices.push({ level: 'warn', message: `Skipped ${skippedEmpty} row(s) with no recognizable name or amount` })
          if (unparseableDate) notices.push({ level: 'warn', message: `${unparseableDate} row(s) had a date that couldn't be parsed — left blank, so they won't be date-scoped` })
          if (noCurrency && expenses.length) notices.push({ level: 'warn', message: `${noCurrency} of ${expenses.length} expense row(s) had no currency column value — will use the trip's default currency` })
          return { expenses, rowCount: expenses.length, notices }
        })
        return safeJson(200, result)
      },
    },

    // ── Parse ICS/iCalendar bookings (structured VEVENT fields) ──────────────
    {
      method: 'POST', path: '/parse-ics', auth: true,
      async handler(req, ctx) {
        const text = req.body?.text
        if (!text) return safeJson(200, { bookings: [] })
        const result = await tryAttempt(async () => {
          const bookings = parseICS(text)
          return { bookings, summary: bookings.length + ' event' + (bookings.length === 1 ? '' : 's') + ' found' }
        })
        return safeJson(200, result)
      },
    },

    // ── Cluster raw geo points (client-parsed GPX/KML) ────────────────────────
    // GPX/KML are XML, so parsing happens client-side (DOMParser) — this route just
    // does the same proximity clustering + cap that /parse-timeline applies to
    // Google Timeline points, reused so both sources land on the same places pipeline.
    {
      method: 'POST', path: '/parse-geo-points', auth: true,
      async handler(req, ctx) {
        const points = Array.isArray(req.body?.points) ? req.body.points : []
        const result = await tryAttempt(async () => {
          const clean = points.filter(p => typeof p?.lat === 'number' && typeof p?.lng === 'number' && !isNaN(p.lat) && !isNaN(p.lng))
          const clusters = clusterByProximity(clean, 500)
          // Hard cap, not a paginated window — same as /parse-timeline's 200 cap above.
          const notices = []
          if (clusters.length > 300) notices.push({ level: 'warn', message: `Your GPX/KML track clustered into ${clusters.length} distinct places — only the first 300 were kept (a hard limit for this import), so ${clusters.length - 300} were not imported` })
          return { places: clusters.slice(0, 300), totalPoints: clean.length, notices }
        })
        return safeJson(200, result)
      },
    },

    // ── Parse Google Maps Takeout "Saved Places" export ───────────────────────
    // Google's Takeout export for starred/saved places is a GeoJSON FeatureCollection, but the
    // exact `properties` field names have varied across export versions — at least two variants
    // are known: lowercase `properties.location.{name,address,geo_coordinates}` and a
    // capitalized `properties.Location["Business Name"/"Address"/"Geo Coordinates"]`. This is
    // UNCONFIRMED against a real current export (no sample was available to verify against, only
    // a live Google Maps share link, which isn't the same thing as a Takeout file) — built from
    // general knowledge of the format, trying several known property paths and falling back
    // gracefully rather than assuming one exact shape holds. `geometry.coordinates` (plain
    // GeoJSON `[lng,lat]`) is tried first for coordinates, since it's the most likely field to
    // stay stable regardless of which `properties` variant a given export uses.
    //
    // Unlike GPS-photo/timeline points, every entry here already carries its own distinct
    // name — so these are NOT proximity-clustered like clusterByProximity() does for anonymous
    // GPS pings; clustering would wrongly merge two differently-named saved places that happen
    // to sit near each other (e.g. two restaurants on the same block).
    {
      method: 'POST', path: '/parse-google-places', auth: true,
      async handler(req, ctx) {
        const raw = req.body?.json
        if (!raw) return safeJson(200, { places: [], notices: [] })
        const result = await tryAttempt(async () => {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw
          const features = Array.isArray(data?.features) ? data.features : []
          const places = []
          let skippedNoCoords = 0
          let skippedMalformed = 0
          for (const f of features) {
            // Each feature is parsed inside its own try/catch — a single malformed/unexpected-shape
            // feature (any Takeout format-version drift beyond the variants already handled below)
            // must degrade to "one fewer place extracted", never abort the whole export's parse.
            try {
              const props = f?.properties || {}
              // Known Takeout GeoJSON variants, confirmed against real exports:
              // lowercase `properties.location.*` and capitalized `properties.Location["Business Name"/...]`.
              // The remaining variants below (locationInfo, placeVisit-style nesting, top-level
              // properties.name/props.title as name fallbacks) are UNCONFIRMED guesses at other
              // Takeout format-version/locale layouts — kept because they're cheap to try and can
              // only help, not because they're verified against a real sample.
              const loc = props.location || props.Location || props.locationInfo || {}
              let lat = null, lng = null
              if (Array.isArray(f?.geometry?.coordinates) && f.geometry.coordinates.length >= 2) {
                lng = Number(f.geometry.coordinates[0]); lat = Number(f.geometry.coordinates[1])
              } else {
                const geo = loc.geo_coordinates || loc['Geo Coordinates'] || loc.geoCoordinates || {}
                lat = Number(geo.latitude ?? geo.Latitude ?? geo.lat)
                lng = Number(geo.longitude ?? geo.Longitude ?? geo.lng)
              }
              if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skippedNoCoords++; continue }
              const name = loc.name || loc['Business Name'] || loc.businessName || props.name || props.Title || props.title || null
              const address = loc.address || loc.Address || loc.formattedAddress || null
              const rawDate = props.date || props.Date || props.Published || props.published || null
              const date = rawDate ? String(rawDate).slice(0, 10) : null
              places.push({
                name: name || address || 'Saved place',
                lat, lng,
                address: address || null,
                date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
              })
            } catch (_e) { skippedMalformed++ }
            if (places.length >= 1000) break
          }
          const notices = []
          if (skippedNoCoords) notices.push({ level: 'warn', message: `Skipped ${skippedNoCoords} saved place(s) with no recognizable coordinates` })
          if (skippedMalformed) notices.push({ level: 'warn', message: `Skipped ${skippedMalformed} saved place(s) with an unrecognized/malformed format` })
          return { places, totalFeatures: features.length, notices }
        })
        return safeJson(200, result)
      },
    },

    // ── Parse a generic place-list CSV ────────────────────────────────────────
    // Distinct from /parse-csv (expenses) — fuzzy-matches name/lat/lng/address/notes columns
    // instead of amount/category ones. A row with no recognizable lat/lng is skipped, since a
    // place with no coordinates can't be saved into a collection.
    {
      method: 'POST', path: '/parse-places-csv', auth: true,
      async handler(req, ctx) {
        const text = req.body?.text
        if (!text) return safeJson(200, { places: [] })
        const result = await tryAttempt(async () => {
          function parseCSVLine(line) {
            const r = []; let cur = '', inQ = false
            for (const c of line) {
              if (c === '"') inQ = !inQ
              else if ((c === ',' || c === ';' || c === '\t') && !inQ) { r.push(cur.trim()); cur = '' }
              else cur += c
            }
            r.push(cur.trim()); return r
          }
          const lines = text.trim().split('\n').filter(l => l.trim())
          if (lines.length < 2) return { places: [], error: 'Need header + data rows' }
          const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''))
          const findCol = (...ns) => ns.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1
          const nameCol = findCol('name', 'title', 'place', 'placename')
          const latCol = findCol('lat', 'latitude', 'y')
          const lngCol = findCol('lng', 'lon', 'long', 'longitude', 'x')
          const addressCol = findCol('address', 'addr', 'location', 'formattedaddress')
          const notesCol = findCol('notes', 'note', 'comment', 'comments', 'description', 'desc')
          const dateCol = findCol('date', 'saved', 'savedon', 'added', 'addedon', 'created')

          const places = []
          for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i])
            if (!cols.length || cols.every(c => !c)) continue
            const lat = latCol >= 0 ? Number(cols[latCol]) : NaN
            const lng = lngCol >= 0 ? Number(cols[lngCol]) : NaN
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
            const name = nameCol >= 0 ? cols[nameCol] || null : null
            places.push({
              name: name || 'Place ' + i,
              lat, lng,
              address: addressCol >= 0 ? cols[addressCol] || null : null,
              notes: notesCol >= 0 ? cols[notesCol] || null : null,
              date: dateCol >= 0 ? normalizeDateStr(cols[dateCol]) : null,
            })
            if (places.length >= 1000) break
          }
          return { places, rowCount: places.length }
        })
        return safeJson(200, result)
      },
    },

    // ── Import a shared Google Maps list link ─────────────────────────────────
    // This exists because TREK's own core app already has a "List Import" feature (Google List /
    // Naver List) that does exactly this against a trip — confirmed by reading the real source
    // (server/src/services/placeService.ts, liketrek/TREK, AGPL-3.0). A plain fetch of the
    // interactive maps.google.com page hits a GDPR consent interstitial (consent.google.com) that
    // a plugin has no way to click through — but TREK's own feature doesn't click through it
    // either: it only follows the short-link redirect far enough to pull a list ID out of the
    // resulting URL string (which survives intact even inside consent.google.com's own
    // `continue=` param, since `!` isn't URL-escaped), then hits a completely separate,
    // unauthenticated internal Google Maps AJAX endpoint (`maps/preview/entitylist/getlist` — the
    // same call Maps' own web frontend makes to populate a list side panel) that isn't part of
    // the consent-gated page-view flow at all. `gl=us` on THAT endpoint (not the redirect) is what
    // avoids the EU consent gate. This is an undocumented, unofficial Google endpoint with no
    // stability guarantee — same caveat TREK's own core code carries.
    {
      method: 'POST', path: '/parse-google-list', auth: true,
      async handler(req, ctx) {
        const url = req.body?.url
        const result = await tryAttempt(async () => {
          if (!url || typeof url !== 'string') throw new Error('No link provided')
          const extractListId = (u) => {
            const plMatch = u.match(/placelists\/list\/([A-Za-z0-9_-]+)/)
            if (plMatch) return plMatch[1]
            const dataMatch = u.match(/!2s([A-Za-z0-9_-]{15,})/)
            if (dataMatch) return dataMatch[1]
            return null
          }
          let resolvedUrl = url
          let listId = extractListId(url)
          if (!listId && /goo\.gl|maps\.app/i.test(url)) {
            // Stops at the first URL in the redirect chain containing the list ID — which is the
            // FIRST redirect target here, well before the chain ever reaches consent.google.com
            // (an interstitial this plugin's egress allowlist correctly won't fetch, and doesn't
            // need to: the ID is already present one hop earlier). See resolveRedirectChain().
            resolvedUrl = await resolveRedirectChain(url, (u) => !!extractListId(u), 10000)
            listId = extractListId(resolvedUrl)
          }
          if (!listId) {
            if (resolvedUrl.includes('/maps/place/')) {
              throw new Error('That link points to a single place, not a list — paste a "Share list" link instead')
            }
            throw new Error('Could not find a list in that link — make sure it\'s a shared Google Maps list ("Share list")')
          }
          const apiUrl = `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=us&pb=!1m1!1s${encodeURIComponent(listId)}!2e2!3e2!4i500!16b1`
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 15000)
          let apiRes
          try {
            apiRes = await fetch(apiUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
              signal: controller.signal,
            })
          } finally { clearTimeout(timeout) }
          if (!apiRes.ok) throw new Error('Google Maps did not return list data (the list may be private, or the link expired)')
          const rawText = await apiRes.text()
          const jsonStr = rawText.substring(rawText.indexOf('\n') + 1)
          let listData
          try { listData = JSON.parse(jsonStr) } catch (_e) { throw new Error('Could not parse the response from Google Maps') }
          const meta = Array.isArray(listData) ? listData[0] : null
          if (!meta) throw new Error('Invalid list data received from Google Maps')
          const listName = (Array.isArray(meta) && meta[4]) || 'Google Maps List'
          const items = Array.isArray(meta) ? meta[8] : null
          if (!Array.isArray(items) || !items.length) throw new Error('That list is empty or could not be read')
          const places = []
          let skippedNoCoords = 0
          let skippedNoFtid = 0
          let skippedMalformed = 0
          // The `[8]`/`item[1][5][2]`/`item[1][5][3]` indices below are empirically reverse-engineered
          // (see CLAUDE.md) against one real response shape, with no guarantee Google's undocumented
          // endpoint keeps that shape stable. Every item is parsed defensively so a shape drift (a
          // shifted index, a missing nested array) degrades to "fewer places extracted", not a
          // hard failure of the whole route.
          for (const item of items) {
            try {
              if (!Array.isArray(item)) { skippedMalformed++; continue }
              const inner = Array.isArray(item[1]) ? item[1] : null
              const coords = inner && Array.isArray(inner[5]) ? inner[5] : null
              const lat = coords ? coords[2] : null
              const lng = coords ? coords[3] : null
              const name = item[2]
              const notes = item[3] || null
              if (!(name && typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng))) {
                skippedNoCoords++
                continue
              }
              let googleFtid = null
              try { googleFtid = googleMapsFeatureIdFromItem(item) } catch (_e2) { googleFtid = null }
              if (!googleFtid) skippedNoFtid++
              places.push({ name, lat, lng, notes, googleFtid })
            } catch (_e) { skippedMalformed++ }
          }
          if (!places.length) throw new Error('No places with coordinates found in that list')
          const notices = []
          // `!4i500` in the request requests at most 500 items in this single (unpaginated) call —
          // if the list actually has more, there's no way to fetch the rest and they're silently
          // dropped. There's no total-count field in this undocumented response to compare against,
          // so items.length hitting exactly the requested cap is the only available signal that
          // truncation may have happened.
          if (items.length >= 500) notices.push({ level: 'warn', message: `This list returned exactly 500 items — if it actually has more than 500 saved places, the rest could not be fetched (a hard limit for this import)` })
          if (skippedNoCoords) notices.push({ level: 'warn', message: `Skipped ${skippedNoCoords} list item(s) with no recognizable name/coordinates` })
          if (skippedMalformed) notices.push({ level: 'warn', message: `Skipped ${skippedMalformed} list item(s) with an unrecognized/malformed format` })
          if (skippedNoFtid) notices.push({ level: 'warn', message: `Could not extract a Google feature ID for ${skippedNoFtid} place(s) (place was still imported)` })
          return { places, listName, notices }
        })
        return safeJson(200, result)
      },
    },

    // ── Import a shared Naver Maps list link ───────────────────────────────────
    // Same technique as /parse-google-list, ported from TREK core's importNaverList(): resolve a
    // naver.me short link, pull the folder ID out of the resolved URL, then page through Naver's
    // own internal bookmarks-share JSON API — a normal, documented-shape JSON API (item.py/item.px
    // for lat/lng, Naver's own y/x-order field names), no consent wall, no array-index walk needed.
    {
      method: 'POST', path: '/parse-naver-list', auth: true,
      async handler(req, ctx) {
        const url = req.body?.url
        const result = await tryAttempt(async () => {
          if (!url || typeof url !== 'string') throw new Error('No link provided')
          const extractFolderId = (u) => {
            const m = u.match(/favorite\/myPlace\/folder\/([A-Za-z0-9_-]+)/i)
            return m ? m[1] : null
          }
          let resolvedUrl = url
          let parsedUrl
          try { parsedUrl = new URL(url) } catch (_e) { throw new Error('Invalid URL') }
          if (parsedUrl.hostname === 'naver.me' && !extractFolderId(url)) {
            resolvedUrl = await resolveRedirectChain(url, (u) => !!extractFolderId(u), 10000)
          }
          const folderMatch = resolvedUrl.match(/favorite\/myPlace\/folder\/([A-Za-z0-9_-]+)/i)
          const folderId = folderMatch && folderMatch[1]
          if (!folderId) throw new Error('Could not find a shared list folder in that link — make sure it\'s a shared Naver Maps list')

          const limit = 20
          async function fetchPage(start) {
            const apiUrl = `https://pages.map.naver.com/save-pages/api/maps-bookmark/v3/shares/${encodeURIComponent(folderId)}/bookmarks?placeInfo=true&start=${start}&limit=${limit}&sort=lastUseTime&mcids=ALL&createIdNo=true`
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 15000)
            try {
              const res = await fetch(apiUrl, {
                headers: {
                  Accept: 'application/json',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
                signal: controller.signal,
              })
              if (!res.ok) throw new Error('Failed to fetch list from Naver Maps')
              return await res.json()
            } finally { clearTimeout(timeout) }
          }

          const firstPage = await fetchPage(0)
          const listName = firstPage?.folder?.name || 'Naver Maps List'
          const totalCount = typeof firstPage?.folder?.bookmarkCount === 'number' ? firstPage.folder.bookmarkCount : (firstPage?.bookmarkList || []).length
          const allItems = (firstPage?.bookmarkList || []).slice()
          // Capped at 500 to bound worst-case round-trips within this route's own time budget.
          for (let start = limit; start < Math.min(totalCount, 500); start += limit) {
            const page = await fetchPage(start)
            const pageItems = page?.bookmarkList || []
            if (!pageItems.length) break
            allItems.push(...pageItems)
          }
          if (!allItems.length) throw new Error('That list is empty or could not be read')

          const places = []
          let skippedNoCoords = 0
          let skippedMalformed = 0
          for (const item of allItems) {
            try {
              const lat = Number(item?.py)
              const lng = Number(item?.px)
              const name = (typeof item?.name === 'string' && item.name.trim()) || (typeof item?.displayName === 'string' && item.displayName.trim()) || ''
              const notes = (typeof item?.memo === 'string' && item.memo.trim()) || null
              const address = (typeof item?.address === 'string' && item.address.trim()) || null
              if (name && Number.isFinite(lat) && Number.isFinite(lng)) places.push({ name, lat, lng, notes, address })
              else skippedNoCoords++
            } catch (_e) { skippedMalformed++ }
          }
          if (!places.length) throw new Error('No places with coordinates found in that list')
          const notices = []
          // Unlike the windowed-pagination pattern used elsewhere in this plugin (steps/bookings/
          // expenses/places all resume across multiple /import rounds), this loop fetches
          // everything in one route call and hard-stops at 500 total bookmarks as a time-budget
          // bound — any bookmark beyond the 500th is dropped for good, not deferred to a later
          // round. Per CLAUDE.md's "no silent caps" guidance, that must be visible.
          if (totalCount > 500) notices.push({ level: 'warn', message: `This list has ${totalCount} saved places — only the first 500 were fetched (a hard limit for this import), so ${totalCount - 500} were not imported` })
          if (skippedNoCoords) notices.push({ level: 'warn', message: `Skipped ${skippedNoCoords} bookmark(s) with no recognizable name/coordinates` })
          if (skippedMalformed) notices.push({ level: 'warn', message: `Skipped ${skippedMalformed} bookmark(s) with an unrecognized/malformed format` })
          return { places, listName, notices }
        })
        return safeJson(200, result)
      },
    },

    // ── Import a shared Wanderlog trip plan link ──────────────────────────────
    // UNCONFIRMED against a real Wanderlog response — no live sample was available to verify
    // against; this is built from knowing that a sibling plugin (danl12353231/TREK-Wanderlog-plugin)
    // hits the same unofficial public endpoint (`GET wanderlog.com/api/tripPlans/{key}?clientSchemaVersion=2`)
    // directly from a pasted share link/key, the same "unofficial public endpoint, no official API"
    // pattern this plugin already uses for /parse-google-list and /parse-naver-list — modeled on
    // that code's structure and conventions (server-side fetch, since a plugin's client-side fetch
    // can't reach an arbitrary egress host — CORS/egress, same reasoning as those routes). Every
    // field access below is defensive (optional chaining, multiple plausible field-name guesses
    // per concept, per-item try/catch skipping rather than throwing) exactly like
    // /parse-google-places already does for Takeout format-version drift, and every skip/guess is
    // surfaced via `notices` rather than silently dropped. Needs real-world testing against an
    // actual Wanderlog share link/response to confirm or correct every field name guessed here.
    {
      method: 'POST', path: '/parse-wanderlog', auth: true,
      async handler(req, ctx) {
        const input = req.body?.link
        const result = await tryAttempt(async () => {
          if (!input || typeof input !== 'string' || !input.trim()) throw new Error('No link or trip key provided')
          const trimmed = input.trim()
          let key = null
          if (!/^https?:\/\//i.test(trimmed) && !trimmed.includes('/') && /^[A-Za-z0-9_-]+$/.test(trimmed)) {
            // Looks like a bare key already (no protocol, no slashes) — use it directly.
            key = trimmed
          } else {
            // Plausible Wanderlog share-URL shapes — UNCONFIRMED, since no real link was available
            // to check against. Tried in order, first match wins; a plugin can't verify these at
            // authoring time so this is deliberately generous rather than narrowly exact.
            const patterns = [
              /wanderlog\.com\/view\/[^/?#]+\/([A-Za-z0-9_-]+)/i,
              /wanderlog\.com\/edit\/[^/?#]+\/([A-Za-z0-9_-]+)/i,
              /wanderlog\.com\/list\/[^/?#]+\/([A-Za-z0-9_-]+)/i,
              /wanderlog\.com\/[^?#]*[?&]tripId=([A-Za-z0-9_-]+)/i,
              /wanderlog\.com\/[^/?#]+\/[^/?#]+\/([A-Za-z0-9_-]{6,})(?:[/?#]|$)/i,
            ]
            for (const re of patterns) {
              const m = trimmed.match(re)
              if (m) { key = m[1]; break }
            }
          }
          if (!key) throw new Error('Could not find a trip key in that link — paste a Wanderlog trip share link, or the trip key itself')

          const apiUrl = `https://wanderlog.com/api/tripPlans/${encodeURIComponent(key)}?clientSchemaVersion=2`
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 15000)
          let res
          try {
            res = await fetch(apiUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'application/json',
              },
              signal: controller.signal,
            })
          } finally { clearTimeout(timeout) }
          if (!res.ok) throw new Error('Wanderlog did not return trip data (the trip may be private, or the link/key is wrong)')
          let data
          try { data = await res.json() } catch (_e) { throw new Error('Could not parse the response from Wanderlog') }
          const plan = data?.tripPlan || data?.trip || data
          if (!plan || typeof plan !== 'object') throw new Error('Invalid trip data received from Wanderlog')

          const notices = []
          const title = plan.title || plan.name || plan.tripName || null
          const startDate = normalizeDateStr(plan.startDate || plan.start_date || plan.fromDate || null)
          const endDate = normalizeDateStr(plan.endDate || plan.end_date || plan.toDate || null)
          // Confirmed against a real /api/tripPlans/<key> response: currency lives at
          // itinerary.budget.amount.currencyCode, not a top-level plan.currency field.
          const currency = plan.itinerary?.budget?.amount?.currencyCode || plan.currency || plan.currencyCode || null

          // Places: CONFIRMED shape (fetched and inspected a real trip plan directly) —
          // Wanderlog's itinerary is NOT grouped by calendar day the way the original guess
          // assumed. It's `plan.itinerary.sections[]`, each a named group (e.g. "Tokyo
          // attractions") with a `blocks[]` array; a block is a place only when
          // `block.type === 'place'`, holding the actual data under `block.place` in Google
          // Places API shape: `place.geometry.location.{lat,lng}`, `place.formatted_address`
          // (snake_case, not `formattedAddress`), `place.name`. Other observed block types are
          // `checklist` and `note` — not places, skipped. No per-block/per-section date field
          // was present on the one real trip inspected (a "guide"-style trip with no day-by-day
          // planning — startDate/endDate/days were all null on that trip too), so `date` stays
          // null unless a section/block-level date does turn up on some other trip's response;
          // still checked defensively below in case a day-planned trip shapes it differently.
          // Each place already carries its own distinct name (like every Collection-mode
          // source), so these are NOT proximity-clustered client-side the way anonymous GPS
          // pings are — clustering would wrongly merge two differently-named stops that happen
          // to sit close together (e.g. two restaurants across the street from each other).
          const places = []
          let skippedNoCoords = 0, skippedMalformed = 0
          const sections = Array.isArray(plan.itinerary?.sections) ? plan.itinerary.sections : []
          for (const section of sections) {
            try {
              const sectionDate = normalizeDateStr(section?.date || section?.day || null)
              const blocks = Array.isArray(section?.blocks) ? section.blocks : []
              for (const block of blocks) {
                if (block?.type !== 'place' || !block?.place) continue
                try {
                  const p = block.place
                  const lat = Number(p?.geometry?.location?.lat ?? p?.lat ?? p?.latitude ?? p?.location?.lat)
                  const lng = Number(p?.geometry?.location?.lng ?? p?.lng ?? p?.longitude ?? p?.location?.lng)
                  if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skippedNoCoords++; continue }
                  const name = p?.name || p?.title || null
                  const address = p?.formatted_address || p?.address || p?.formattedAddress || null
                  const blockDate = normalizeDateStr(block?.date || null)
                  places.push({
                    name: name || address || 'Wanderlog place', lat, lng,
                    address: address || null,
                    notes: section?.heading || null,
                    date: blockDate || sectionDate || null,
                  })
                } catch (_e) { skippedMalformed++ }
                if (places.length >= 1000) break
              }
            } catch (_e) { skippedMalformed++ }
            if (places.length >= 1000) break
          }
          // Fallback: a flat top-level places array, for any response shape that isn't the
          // sections/blocks structure confirmed above (e.g. a future schema version).
          if (!places.length) {
            const flat = plan.places || plan.savedPlaces || plan.optimize?.places || []
            if (Array.isArray(flat)) {
              for (const p of flat) {
                try {
                  const lat = Number(p?.geometry?.location?.lat ?? p?.lat ?? p?.latitude ?? p?.location?.lat)
                  const lng = Number(p?.geometry?.location?.lng ?? p?.lng ?? p?.longitude ?? p?.location?.lng)
                  if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skippedNoCoords++; continue }
                  const name = p?.name || p?.title || null
                  places.push({ name: name || 'Wanderlog place', lat, lng, address: p?.formatted_address || p?.address || null, notes: p?.notes || null, date: null })
                } catch (_e) { skippedMalformed++ }
                if (places.length >= 1000) break
              }
              if (places.length) notices.push({ level: 'warn', message: 'Used a flat places list fallback — this response shape was not the confirmed sections/blocks structure' })
            }
          }

          // Bookings: reservations/flights/hotels, mapped into this plugin's existing flat booking
          // shape (matching parseBookingsRegex's own field names exactly, since /import's bookings
          // section consumes that shape as-is regardless of which route produced it).
          const bookings = []
          let skippedBookingMalformed = 0
          const resList = plan.reservations || plan.bookings || plan.flights || []
          if (Array.isArray(resList)) {
            resList.forEach((r, i) => {
              try {
                const kind = String(r?.type || r?.reservationType || '').toLowerCase()
                const isFlight = kind.includes('flight') || !!r?.flightNumber || !!r?.airline
                const isHotel = !isFlight && (kind.includes('hotel') || kind.includes('lodging') || kind.includes('accommodation'))
                if (isFlight) {
                  bookings.push({
                    _id: 'wf' + i, type: 'flight',
                    title: r?.flightNumber ? ('Flight ' + r.flightNumber) : (r?.title || 'Flight'),
                    from: r?.departureAirport || r?.from || null, from_code: r?.departureAirportCode || null,
                    from_date: normalizeDateStr(r?.departureDate || r?.startDate || null), from_time: r?.departureTime || null,
                    to: r?.arrivalAirport || r?.to || null, to_code: r?.arrivalAirportCode || null,
                    to_date: normalizeDateStr(r?.arrivalDate || r?.endDate || null), to_time: r?.arrivalTime || null,
                    operator: r?.airline || null, flight_number: r?.flightNumber || null,
                    booking_ref: r?.confirmationNumber || r?.bookingRef || null,
                    price: typeof r?.price === 'number' ? r.price : (typeof r?.cost === 'number' ? r.cost : null),
                    currency: r?.currency || currency || null,
                    notes: r?.notes || null, confidence: 'medium', _source: 'wanderlog',
                  })
                } else if (isHotel) {
                  bookings.push({
                    _id: 'wh' + i, type: 'hotel',
                    title: r?.name || r?.title || 'Hotel booking',
                    from: null, from_date: normalizeDateStr(r?.checkIn || r?.startDate || null),
                    to: null, to_date: normalizeDateStr(r?.checkOut || r?.endDate || null),
                    operator: r?.name || null,
                    booking_ref: r?.confirmationNumber || r?.bookingRef || null,
                    price: typeof r?.price === 'number' ? r.price : (typeof r?.cost === 'number' ? r.cost : null),
                    currency: r?.currency || currency || null,
                    notes: r?.notes || null, confidence: 'medium', _source: 'wanderlog',
                  })
                } else {
                  skippedBookingMalformed++
                }
              } catch (_e) { skippedBookingMalformed++ }
            })
          }

          if (skippedNoCoords) notices.push({ level: 'warn', message: `Skipped ${skippedNoCoords} place(s) with no recognizable coordinates` })
          if (skippedMalformed) notices.push({ level: 'warn', message: `Skipped ${skippedMalformed} place(s) with an unrecognized/malformed format` })
          if (skippedBookingMalformed) notices.push({ level: 'warn', message: `Skipped ${skippedBookingMalformed} reservation(s) not recognized as a flight or hotel` })
          // Places mapping (sections[].blocks[].place, Google Places API shape) is now CONFIRMED
          // against a real trip plan response. Reservations/flights/hotels are still a guess —
          // the one real trip inspected had none (showReservations: false on its TripPlanKeys
          // entry, itinerary.journal.stops: []), so this still needs a real day-planned trip
          // with actual bookings to verify or correct.
          notices.push({ level: 'warn', message: 'Wanderlog flight/hotel booking mapping is still best-effort and UNCONFIRMED — no real trip with bookings was available to verify against. Places/dates are confirmed against a real response.' })

          return { title, startDate, endDate, currency, places, bookings, notices }
        })
        return safeJson(200, result)
      },
    },

    // ── List the user's existing Collections (saved-place lists) ─────────────
    // For the "add to an existing collection" choice, mirroring /trips for the trip-import flow.
    {
      method: 'GET', path: '/collections', auth: true,
      async handler(req, ctx) {
        const result = await tryAttempt(async () => {
          const data = await ctx.collections.listMine()
          const arr = Array.isArray(data) ? data : (data?.collections || [])
          return { collections: arr.map(c => ({ id: c.id, name: c.name, placeCount: c.place_count })).filter(c => c.id) }
        })
        return safeJson(200, result)
      },
    },

    // ── Import parsed places into a Collection ────────────────────────────────
    // A Collection (ctx.collections.*) is a user-owned saved-place list, entirely independent
    // of any trip — no dates, no days, no itinerary, so this is a much simpler resumable import
    // than /import: create-or-use a collection, then ctx.collections.savePlace() once per place.
    // Same index-resumable shape as /import (progress carries the next index + running totals),
    // since a large saved-places export can just as easily need multiple rounds to fit the
    // ~8s bridge budget and/or the ~100KB body-size ceiling (see /import's own notes on both).
    {
      method: 'POST', path: '/import-collection', auth: true,
      async handler(req, ctx) {
        const { collectionConfig, places, placesOffset, totalPlaces, progress: progressIn } = req.body || {}
        const result = await tryAttempt(async () => {
          const log = []; const errors = []
          const deadline = Date.now() + 6000
          const withinBudget = () => Date.now() < deadline

          const p = Object.assign({
            collectionId: null, places: 0, placesSaved: 0, placesDuplicate: 0,
            createdRefs: [],
          }, progressIn || {})

          let collectionId = p.collectionId
          if (!collectionId) {
            if (collectionConfig?.mode === 'existing') {
              collectionId = Number(collectionConfig.collectionId)
            } else {
              const created = await ctx.collections.create({ name: collectionConfig?.name || 'Imported places' })
              collectionId = created?.id ?? created?.data?.id
              if (!collectionId) throw new Error('Failed to create collection')
              log.push({ type: 'collection', message: 'Created collection: ' + (collectionConfig?.name || 'Imported places') })
            }
            p.collectionId = collectionId
          }

          const placesArr = Array.isArray(places) ? places : []
          // Same pagination pattern as /import's steps/bookings/expenses/places — a large
          // saved-places export is windowed by the client; paginatedWindow() re-bases the
          // received slice back onto the correct global index.
          const win = paginatedWindow(placesArr, placesOffset, totalPlaces)
          const total = win.total

          if (p.places < total) {
            let i = p.places
            for (; i < win.end; i++) {
              if (!withinBudget()) break
              const place = win.get(i)
              try {
                let name = place.name || null
                // A generic fallback name (from the parser, when the source had none) is worth
                // trying to improve via reverse geocoding, same as trip GPS/timeline places do —
                // but a Google-Maps-saved-place or CSV row usually already has a real name, so
                // this only fires for the genuinely nameless case.
                if ((!name || /^(Saved place|Place \d+)$/.test(name)) && withinBudget()) {
                  try {
                    const geocoded = await reverseGeocode(place.lat, place.lng)
                    if (geocoded) name = geocoded
                    await sleep(1100) // Nominatim rate limit
                  } catch (_e) {}
                }
                name = name || 'Saved place'
                const saveRes = await ctx.collections.savePlace({
                  collection_id: collectionId,
                  name,
                  lat: place.lat,
                  lng: place.lng,
                  address: place.address || null,
                  notes: place.notes || null,
                  google_ftid: place.googleFtid || undefined,
                })
                if (saveRes?.duplicate) {
                  p.placesDuplicate++
                } else {
                  p.placesSaved++
                  const placeId = saveRes?.place?.id ?? saveRes?.id
                  if (placeId) p.createdRefs.push({ type: 'collectionPlace', id: placeId })
                }
                await sleep(80)
              } catch (e) { errors.push('Place ' + (place.name || '') + ': ' + e.message) }
            }
            p.places = i
          }
          let msg = 'Saved ' + p.placesSaved + ' place' + (p.placesSaved === 1 ? '' : 's') + ' to the collection'
          if (p.placesDuplicate) msg += ' (' + p.placesDuplicate + ' already saved, skipped)'
          if (p.places < total) msg += ' (' + (total - p.places) + ' more queued)'
          log.push({ type: 'places', message: msg })

          p.done = p.places >= total
          return { ok: true, collectionId, log, errors, progress: p }
        })
        return safeJson(200, result)
      },
    },

    // ── Main import ───────────────────────────────────────────────────────────
    {
      method: 'POST', path: '/import', auth: true,
      async handler(req, ctx) {
        const {
          tripConfig, polarsteps, bookings, gpsPlaces, timelinePlaces, expenses, options, progress: progressIn,
          // Pagination fields: bookings/expenses/places can each arrive as just this round's
          // window (client-sliced) rather than the full array, mirroring polarsteps.steps'
          // existing _stepOffset/_totalSteps pattern — needed once a source alone can push the
          // request past the plugin-route proxy's real ~100KB body-size ceiling (confirmed:
          // server sets a global express.json({limit:'100kb'}) applied to every plugin route).
          // Absent (an unpaginated call, or an older client) defaults to "this is everything,
          // starting at 0" via the ?? / || fallbacks where each is consumed below.
          bookingsOffset, totalBookings, expensesOffset, totalExpenses,
          places: placesIn, placesOffset, totalPlaces,
        } = req.body || {}
        const result = await tryAttempt(async () => {
          const log = []; const errors = []
          let tripId = null

          // The SDK docs' 30s route timeout is NOT the real ceiling for this route — TREK's
          // trek:invoke bridge in the browser enforces its own ~8s round-trip timeout, confirmed
          // against a real instance ("timeout of 8000ms exceeded", client-side, well under 30s).
          // 6s leaves ~2s margin for the response to actually get back through the bridge before
          // that fires. This is VERY tight: reverse-geocoding is rate-limited to ~1/sec, so at most
          // a couple of geocoded items fit per call. Rather than make the user click Import
          // repeatedly, /import is INDEX-RESUMABLE: it takes a `progress` object (per-section next
          // index + running totals + the once-created journeyId), processes as much as fits in this
          // call's budget, and returns the updated `progress` — the client (doImport()) loops,
          // feeding each response's `progress` back in as the next call's input, switching
          // tripConfig to {mode:'existing', tripId} after the first call, until `progress.done`.
          // This is why every section below is an INDEXED loop that `break`s (not `continue`s) on
          // budget exhaustion, and why nothing here may run twice for the same array index — no
          // item is deduplicated server-side, so re-processing an index would create a duplicate.
          const deadline = Date.now() + 6000
          const withinBudget = () => Date.now() < deadline

          const p = Object.assign({
            journeyId: null, journal: 0, journalEntries: 0, journalDayNotes: 0,
            places: 0, placesCreated: 0,
            bookings: 0, bookingsRes: 0, bookingsAcc: 0, bookingsReview: 0,
            costs: 0, costsCreated: 0,
            // {type, id} refs for everything created this import, newest-last — the source
            // for /undo-import. Trip/day rows are deliberately never added here (see that
            // route's comment).
            createdRefs: [],
            days: 0, daysCreated: 0,
            // Polarsteps step.id -> the place created for it. The client needs this to attach
            // a step's own embedded photos (uploaded separately, post-import, via /upload-photo)
            // to the right place — placeId only ever exists inside this request, so it has to be
            // handed back out through progress the same way createdRefs is.
            stepPlaceIds: {},
          }, progressIn || {})

          // ── 0. Journal-only mode — a standalone journey, no trip at all ────
          // ctx.journal.createJourney's trip_ids is OPTIONAL (confirmed against TREK's actual
          // plugin-sdk/src/index.ts type: `trip_ids?: number[]`), so a Journey can exist with
          // no associated trip. options.journalOnly skips trip creation and every trip-scoped
          // section entirely — places/days/itinerary/bookings/costs all need a tripId, and
          // ctx.files/ctx.meta are trip-scoped too, so photo uploads and duplicate-import
          // detection don't apply here either. This is for a user who just wants a travel
          // story/journal from their data without engaging the full trip-planning machinery
          // (day rows, itinerary assignment, a place per stop on a map, etc).
          if (options?.journalOnly) {
            const steps = polarsteps?.steps || []
            // steps here is whatever slice the client sent this round (see importOneTarget()'s
            // STEPS_PER_ROUND windowing) — polarsteps._stepOffset/_totalSteps carry the true
            // position/count across the whole paginated step list; paginatedWindow() re-bases
            // them. Absent (an unpaginated call, or no polarsteps at all) defaults to "this is
            // the whole list starting at 0".
            const stepsWin = paginatedWindow(steps, polarsteps?._stepOffset, polarsteps?._totalSteps)
            const totalSteps = stepsWin.total
            if (!polarsteps || !options?.importJournal) {
              // Must mark done — otherwise the client's resumable loop (which only stops on
              // progress.done) would keep resending this exact same no-op call up to its 200-round cap.
              return { ok: true, tripId: null, log: [{ type: 'journal', message: 'Nothing to import — journal-only mode needs a Polarsteps trip with journal import enabled' }], errors: [], progress: { ...p, done: true } }
            }
            let journeyId = p.journeyId
            if (!journeyId) {
              try {
                const journey = await ctx.journal.createJourney({
                  title: polarsteps.name,
                  subtitle: polarsteps.totalKm ? polarsteps.totalKm.toLocaleString() + ' km travelled' : null,
                })
                journeyId = journey?.id ?? journey?.data?.id
                p.journeyId = journeyId || null
                if (journeyId) p.createdRefs.push({ type: 'journey', id: journeyId })
                if (journeyId && polarsteps.summary) {
                  try {
                    const introRes = await ctx.journal.createEntry(journeyId, {
                      entry_date: polarsteps.startDate || (steps[0] && steps[0].date) || null,
                      title: 'Trip overview',
                      story: polarsteps.summary,
                      content: polarsteps.summary,
                    })
                    p.journalEntries++
                    const introId = introRes?.id ?? introRes?.data?.id
                    if (introId) p.createdRefs.push({ type: 'journalEntry', id: introId })
                  } catch (e) { errors.push('Trip overview entry: ' + e.message) }
                }
              } catch (e) { errors.push('Journal: ' + e.message) }
            }
            if (journeyId && p.journal < totalSteps) {
              // p.journal is a GLOBAL index across the whole (possibly paginated) step list;
              // stepsWin re-bases it onto this round's local `steps` window — mirrors section
              // 2's identical pattern below for the normal (non-journal-only) path.
              let i = p.journal
              for (; i < stepsWin.end; i++) {
                if (!withinBudget()) break
                const step = stepsWin.get(i)
                try {
                  const weatherNote = step.weather
                    ? '\n\n_' + step.weather.condition.replace(/-/g, ' ') + (step.weather.tempC != null ? ', ' + step.weather.tempC + '°C' : '') + '_'
                    : ''
                  const entryDate = step.date || polarsteps.startDate
                  const entryWeather = mapPolarstepsWeather(step.weather?.condition)
                  const entryLocation = mapPolarstepsEntryLocation(step)
                  const entryRes = await ctx.journal.createEntry(journeyId, {
                    entry_date: entryDate, title: step.name, story: (step.description || '') + weatherNote, content: (step.description || '') + weatherNote,
                    weather: entryWeather,
                    ...entryLocation,
                  })
                  p.journalEntries++
                  const entryId = entryRes?.id ?? entryRes?.data?.id
                  if (entryId) p.createdRefs.push({ type: 'journalEntry', id: entryId })
                  await sleep(100)
                } catch (e) { errors.push('Step ' + step.name + ': ' + e.message) }
              }
              p.journal = i
            } else if (!journeyId) {
              p.journal = totalSteps // couldn't create/find a journey — don't retry forever
            }
            let msg = 'Created journal with ' + p.journalEntries + ' entries'
            if (p.journal < totalSteps) msg += ' (' + (totalSteps - p.journal) + ' more queued)'
            log.push({ type: 'journal', message: msg })
            p.done = p.journal >= totalSteps
            return { ok: true, tripId: null, log, errors, progress: p }
          }

          // ── 1. Trip ────────────────────────────────────────────────────────
          if (tripConfig.mode === 'existing') {
            tripId = Number(tripConfig.tripId)
          } else {
            // Detect re-importing a Polarsteps trip that's already been imported before, via its
            // own stable uuid (parsed by /parse-polarsteps but previously never used for
            // anything). Without this, re-running the same export — e.g. after tweaking import
            // options — silently creates a second, duplicate trip. Only checked on a genuinely
            // fresh call (no progress yet, so tripConfig is still {mode:'new'} rather than the
            // {mode:'existing', tripId} every resumed round switches to) and only when the client
            // hasn't already confirmed proceeding anyway (tripConfig.forceDuplicate) — so this
            // can't re-trigger mid-import once a trip exists.
            if (polarsteps?.uuid && !progressIn && !tripConfig.forceDuplicate) {
              const mine = await attempt(() => ctx.trips.listMine(), [])
              // Unlike every other section in this route, this loop runs entirely BEFORE trip
              // creation and has no resumable fallback if it stalls — the RPC dispatch boundary's
              // own rate limit (20/s) alone means 200 sequential ctx.meta.get calls take >=10s,
              // already past the whole round's ~6-8s budget with zero added latency. Bail out and
              // just create the trip normally rather than risk timing out the entire import over
              // a duplicate check — a user with enough trips to hit this misses the dedup
              // check sometimes, which is a far smaller cost than the import never completing.
              for (const t of (mine || []).slice(0, 200)) {
                if (!withinBudget()) break
                const existingUuid = await attempt(() => ctx.meta.get('trip', t.id, 'polarsteps_uuid'))
                if (existingUuid && existingUuid === polarsteps.uuid) {
                  return { ok: true, duplicateOf: { tripId: t.id, title: t.title || null }, log, errors, progress: p }
                }
              }
            }

            const newTrip = await ctx.trips.create({
              title: tripConfig.title || polarsteps?.name || 'Imported Trip',
              start_date: tripConfig.startDate || polarsteps?.startDate || null,
              end_date: tripConfig.endDate || polarsteps?.endDate || null,
            })
            tripId = newTrip?.id ?? newTrip?.data?.id
            if (!tripId) throw new Error('Failed to create trip')
            log.push({ type: 'trip', message: 'Created trip: ' + (tripConfig.title || polarsteps?.name) })

            if (polarsteps?.uuid) await attempt(() => ctx.meta.set('trip', tripId, 'polarsteps_uuid', polarsteps.uuid))

            // Import the trip's own Polarsteps cover photo, best-effort. The exact shape
            // ctx.trips.update expects for cover_image isn't documented beyond the permission
            // name (trip_cover_upload) — a data: URI is the closest match to how every other
            // upload in this plugin works (ctx.files.create's content_base64) — so this is
            // wrapped defensively and never blocks the rest of the import if the shape is wrong
            // or the fetch fails.
            if (polarsteps?.coverPhotoUrl) {
              try {
                // No timeout here would risk the same problem reverseGeocode() already guards
                // against: a slow response could eat this whole round's ~6-8s budget before
                // anything else (day rows, journal, places) even gets a chance to run.
                const coverController = new AbortController()
                const coverTimeout = setTimeout(() => coverController.abort(), 3000)
                let resp
                try {
                  resp = await fetch(polarsteps.coverPhotoUrl, { signal: coverController.signal })
                } finally { clearTimeout(coverTimeout) }
                if (resp.ok) {
                  const buf = Buffer.from(await resp.arrayBuffer())
                  const contentType = resp.headers.get('content-type') || 'image/jpeg'
                  await ctx.trips.update(tripId, { cover_image: 'data:' + contentType + ';base64,' + buf.toString('base64') })
                  log.push({ type: 'trip', message: 'Imported trip cover photo from Polarsteps' })
                }
              } catch (e) { errors.push('Cover photo: ' + e.message) }
            }
          }

          // Build a date→dayId map for day note/itinerary assignment
          let dayMap = {} // date string → day id
          try {
            const days = await ctx.trips.getDays(tripId)
            for (const d of (days || [])) {
              if (d.date) dayMap[d.date] = d.id
            }
          } catch (_e) {}

          const steps = polarsteps?.steps || []
          // steps is whatever slice the client sent this round (see importOneTarget()'s
          // STEPS_PER_ROUND windowing in client/index.html) — polarsteps._stepOffset/_totalSteps
          // carry the true position/count across the whole paginated step list; paginatedWindow()
          // re-bases them. Absent (an unpaginated call, or no polarsteps at all) defaults to
          // "this is the whole list starting at 0".
          const stepsWin = paginatedWindow(steps, polarsteps?._stepOffset, polarsteps?._totalSteps)
          const totalSteps = stepsWin.total

          // ── 1.5. Ensure day rows exist for the trip's date range ──────────
          // Nothing in this plugin (or, per available docs, TREK itself) auto-creates day rows
          // spanning a trip's start/end date when a plugin calls ctx.trips.create — without them,
          // dayMap stays empty and every itinerary.assign/daynotes.create/accommodation day-link
          // below silently no-ops (places import "successfully" but never land on a day). Ensure
          // any missing day for the trip's range (falling back to the imported data's own date
          // span if the trip has no declared start/end) BEFORE anything that depends on dayMap —
          // this is its own gating, resumable section so a long trip's day-creation can't eat the
          // budget meant for journal/places/bookings/costs, and so those sections never run
          // against a partially-populated dayMap (which would silently skip assignable items).
          let rangeStart = tripConfig.startDate || polarsteps?.startDate || null
          let rangeEnd = tripConfig.endDate || polarsteps?.endDate || null
          if (!rangeStart || !rangeEnd) {
            try {
              const tripInfo = await ctx.trips.getById(tripId)
              rangeStart = rangeStart || tripInfo?.start_date || null
              rangeEnd = rangeEnd || tripInfo?.end_date || null
            } catch (_e) {}
          }
          {
            // REGRESSION FIX: this had reverted to only falling back to the data's own span
            // when the trip had NO declared range at all (`if (!rangeStart || !rangeEnd)`) —
            // the exact pre-1.6.4 bug. Since a Polarsteps trip (or an existing TREK trip)
            // almost always DOES have a start/end date, that fallback essentially never fires,
            // so any GPS/timeline/booking/expense date outside the Polarsteps-reported window
            // gets no day row and silently never lands on the itinerary. Always EXTEND instead
            // of only falling back — see the original 1.6.4 fix notes in CLAUDE.md.
            //
            // Caveat now that `steps` can be a per-round PAGE rather than the full list (see
            // stepsWin above): this only sees the current page's step dates, so a
            // narrow first page could under-extend the range for a large paginated trip. The
            // client's own date-range computation (prepareStep3()/importOneTarget(), run
            // against the FULL in-memory arrays before this loop starts) is the real fix for
            // that — this stays as defense-in-depth, not the sole source of truth.
            //
            // Only well-formed YYYY-MM-DD strings are safe to sort for min/max — a single
            // malformed date (e.g. a raw un-normalized CSV cell, or a stray non-date string)
            // sorts unpredictably against real ISO dates and can silently produce a garbage
            // range. All sources below are expected to already emit ISO or null, but this
            // filter is cheap insurance against any that don't.
            const isoDateRe = /^\d{4}-\d{2}-\d{2}$/
            const allDates = []
            for (const s of steps) if (isoDateRe.test(s.date)) allDates.push(s.date)
            for (const c of (gpsPlaces || [])) if (isoDateRe.test(c.date)) allDates.push(c.date)
            for (const c of (timelinePlaces || [])) if (isoDateRe.test(c.date)) allDates.push(c.date)
            for (const b of (bookings || [])) {
              if (isoDateRe.test(b.from_date)) allDates.push(b.from_date)
              if (isoDateRe.test(b.to_date)) allDates.push(b.to_date)
            }
            for (const e of (expenses || [])) if (isoDateRe.test(e.date)) allDates.push(e.date)
            allDates.sort()
            if (allDates.length) {
              if (!rangeStart || allDates[0] < rangeStart) rangeStart = allDates[0]
              if (!rangeEnd || allDates[allDates.length - 1] > rangeEnd) rangeEnd = allDates[allDates.length - 1]
            }
          }

          // Sanity cap: the data-derived fallback above takes the min/max of every date across
          // bookings/expenses/etc, so a single bad/placeholder date (e.g. a "no end date" sentinel
          // like 2099-01-01, or a data-entry typo) can make the range span years — confirmed to
          // otherwise burn the entire budget creating tens of thousands of day rows and never reach
          // the actual import. 400 days is generous for even a long round-the-world trip; beyond
          // that, treat it as "couldn't determine a sane range" rather than let it run away.
          let dateRange = []
          if (rangeStart && rangeEnd) {
            try {
              const start = new Date(rangeStart + 'T00:00:00Z'), end = new Date(rangeEnd + 'T00:00:00Z')
              for (let d = new Date(start); d <= end && dateRange.length <= 400; d.setUTCDate(d.getUTCDate() + 1)) dateRange.push(d.toISOString().slice(0, 10))
              if (dateRange.length > 400) dateRange = []
            } catch (_e) {}
          }

          if (p.days < dateRange.length) {
            let i = p.days
            for (; i < dateRange.length; i++) {
              if (!withinBudget()) break
              const dateStr = dateRange[i]
              if (!dayMap[dateStr]) {
                try {
                  const day = await ctx.days.create(tripId, { date: dateStr })
                  const dayId = day?.id ?? day?.data?.id
                  if (dayId) { dayMap[dateStr] = dayId; p.daysCreated++ }
                } catch (e) { errors.push('Day ' + dateStr + ': ' + e.message) }
              }
            }
            p.days = i
            let msg = 'Prepared ' + p.daysCreated + ' calendar day' + (p.daysCreated === 1 ? '' : 's')
            if (p.days < dateRange.length) msg += ' (' + (dateRange.length - p.days) + ' more queued)'
            log.push({ type: 'days', message: msg })
          }

          // Nothing else can correctly use dayMap until every day in range exists — if this round
          // ran out of budget partway through, stop here rather than let journal/places/bookings
          // run against an incomplete dayMap (they'd silently skip assignment for dates whose day
          // hasn't been created yet, and — since indices are never revisited — never get another
          // chance to).
          if (p.days < dateRange.length) {
            return { ok: true, tripId, log, errors, progress: p }
          }

          // ── 2. Polarsteps → Journal + Places + Day Notes ───────────────────
          const journalActive = !!(polarsteps && options?.importJournal)
          if (journalActive && p.journal < totalSteps) {
            try {
              // Journey is created ONCE (first call, journeyId not yet known) and reused on every
              // resume call — otherwise each resumed call would start a brand new empty journey.
              let journeyId = p.journeyId
              if (!journeyId) {
                const journey = await ctx.journal.createJourney({
                  title: polarsteps.name,
                  subtitle: polarsteps.totalKm ? polarsteps.totalKm.toLocaleString() + ' km travelled' : null,
                  trip_ids: [tripId],
                })
                journeyId = journey?.id ?? journey?.data?.id
                p.journeyId = journeyId || null
                if (journeyId) p.createdRefs.push({ type: 'journey', id: journeyId })

                // The trip's own free-text narrative (trip.summary) was previously parsed
                // nowhere and discarded entirely. Added as an intro entry dated to the trip's
                // first day, created here alongside the journey itself — this whole block only
                // ever runs once (guarded by `!journeyId` above), so a resumed round can't
                // duplicate it the way a separate progress flag would need extra bookkeeping for.
                if (journeyId && polarsteps.summary) {
                  try {
                    const introRes = await ctx.journal.createEntry(journeyId, {
                      entry_date: polarsteps.startDate || (steps[0] && steps[0].date) || null,
                      title: 'Trip overview',
                      story: polarsteps.summary,
                      content: polarsteps.summary,
                    })
                    p.journalEntries++
                    const introId = introRes?.id ?? introRes?.data?.id
                    if (introId) p.createdRefs.push({ type: 'journalEntry', id: introId })
                  } catch (e) { errors.push('Trip overview entry: ' + e.message) }
                }
              }
              if (journeyId) {
                let i = p.journal
                for (; i < stepsWin.end; i++) {
                  if (!withinBudget()) break
                  const step = stepsWin.get(i)
                  try {
                    // Reverse geocode if no name
                    let placeName = step.location?.name || step.name
                    let placeId = null

                    if (options.importPlaces && step.location?.lat != null) {
                      // Geocode for better name if location name is generic
                      if (step.location.name && step.location.name.includes(',')) {
                        placeName = step.location.name // already good
                      } else if (step.location.lat && withinBudget()) {
                        try {
                          const geocoded = await reverseGeocode(step.location.lat, step.location.lon)
                          if (geocoded) placeName = geocoded
                          await sleep(1100) // Nominatim rate limit: 1/sec
                        } catch (_e) {}
                      }
                      try {
                        const place = await ctx.places.create(tripId, {
                          name: placeName,
                          lat: step.location.lat,
                          lng: step.location.lon,
                        })
                        placeId = place?.id ?? place?.data?.id ?? null
                        if (placeId) {
                          p.createdRefs.push({ type: 'place', id: placeId })
                          if (step.id != null) p.stepPlaceIds[step.id] = placeId
                        }
                      } catch (_e) {}
                      await sleep(80)
                    }

                    const weatherNote = step.weather
                      ? '\n\n_' + step.weather.condition.replace(/-/g, ' ') + (step.weather.tempC != null ? ', ' + step.weather.tempC + '°C' : '') + '_'
                      : ''
                    const entryDate = step.date || polarsteps.startDate
                    const entryContent = (step.description || '') + weatherNote
                    const entryWeather = mapPolarstepsWeather(step.weather?.condition)
                    const entryLocation = mapPolarstepsEntryLocation(step, placeName)

                    const entry = { entry_date: entryDate, title: step.name, story: entryContent, content: entryContent, weather: entryWeather, ...entryLocation }
                    if (placeId) entry.place_id = placeId
                    const entryRes = await ctx.journal.createEntry(journeyId, entry)
                    p.journalEntries++
                    const entryId = entryRes?.id ?? entryRes?.data?.id
                    if (entryId) p.createdRefs.push({ type: 'journalEntry', id: entryId })

                    // Linking a place to the journal entry (above) does NOT put it on the trip's
                    // day/itinerary view — that's a separate assignment, easy to forget since the
                    // place still looks "imported" either way.
                    if (placeId && entryDate && dayMap[entryDate]) {
                      try { await ctx.itinerary.assign(tripId, dayMap[entryDate], placeId) } catch (_e) {}

                      // A step can span multiple calendar days (step.endDate, from Polarsteps'
                      // own end_time — e.g. a week-long stay somewhere) — assign the same place
                      // to every day in that range too, not just the day the step "started" on,
                      // otherwise every day after day one of a multi-day stay showed nothing on
                      // the itinerary even though the place was genuinely there the whole time.
                      // Capped at 60 days as a sanity limit (mirrors the trip-wide 400-day cap
                      // elsewhere) — this loop runs inside a single step's own iteration rather
                      // than as its own resumable section, so an implausibly long span could
                      // still eat into this round's remaining budget.
                      if (step.endDate) {
                        try {
                          const d = new Date(entryDate + 'T00:00:00Z')
                          const end = new Date(step.endDate + 'T00:00:00Z')
                          d.setUTCDate(d.getUTCDate() + 1)
                          for (let n = 0; d <= end && n < 60; d.setUTCDate(d.getUTCDate() + 1), n++) {
                            const dateStr = d.toISOString().slice(0, 10)
                            if (dayMap[dateStr]) {
                              try { await ctx.itinerary.assign(tripId, dayMap[dateStr], placeId) } catch (_e) {}
                              await sleep(60)
                            }
                          }
                        } catch (_e) {}
                      }
                    }

                    // Also add to day notes if day exists for this date
                    if (options.importDayNotes && entryDate && dayMap[entryDate] && step.description) {
                      try {
                        const noteRes = await ctx.daynotes.create(tripId, dayMap[entryDate], {
                          content: '**' + step.name + '**\n' + step.description,
                        })
                        p.journalDayNotes++
                        const noteId = noteRes?.id ?? noteRes?.data?.id
                        if (noteId) p.createdRefs.push({ type: 'daynote', id: noteId })
                      } catch (_e) {}
                    }

                    await sleep(100)
                  } catch (e) { errors.push('Step ' + step.name + ': ' + e.message) }
                }
                p.journal = i
              } else {
                p.journal = totalSteps // couldn't create/find a journey — don't retry forever
              }
            } catch (e) { errors.push('Journal: ' + e.message) }
          }
          if (journalActive) {
            let msg = 'Created journal with ' + p.journalEntries + ' entries'
            if (p.journalDayNotes) msg += ', ' + p.journalDayNotes + ' day notes'
            if (p.journal < totalSteps) msg += ' (' + (totalSteps - p.journal) + ' more queued)'
            log.push({ type: 'journal', message: msg })
          }

          // ── 3. GPS + Timeline Places — deduplicated and geocoded ──────────
          // Two ways this data can arrive: the NEW way, `placesIn` — the client ports
          // clusterByProximity()/haversine() itself (see client/index.html) and computes the
          // deduplicated, clustered places list ONCE up front, then sends only this round's
          // window of it (placesOffset/totalPlaces, same pattern as polarsteps.steps) — so the
          // full gpsPlaces/timelinePlaces arrays never need to be resent every round. The OLD
          // way — no `totalPlaces` sent — recomputes clustering fresh server-side from the full
          // arrays every call, exactly as this route always did; kept as a fallback so an older
          // client (or any caller that doesn't pre-cluster) still works.
          let clusters = []
          let totalClusters = 0
          let clustersWin = null
          if (options?.importPlaces) {
            if (Array.isArray(placesIn) && totalPlaces != null) {
              clusters = placesIn
              totalClusters = totalPlaces
            } else {
              const allRawPlaces = [...(gpsPlaces || []), ...(timelinePlaces || [])]
              const polarstepsCoords = steps.filter(s => s.location?.lat).map(s => ({ lat: s.location.lat, lng: s.location.lon }))
              const deduplicated = allRawPlaces.filter(pt => !polarstepsCoords.some(ps => haversine(ps.lat, ps.lng, pt.lat, pt.lng) < 800))
              clusters = clusterByProximity(deduplicated, 800)
              totalClusters = clusters.length
            }
            clustersWin = paginatedWindow(clusters, placesOffset, totalClusters)

            if (p.places < totalClusters) {
              let i = p.places
              for (; i < clustersWin.end; i++) {
                if (!withinBudget()) break
                const cluster = clustersWin.get(i)
                try {
                  // Reverse geocode for a real place name
                  let name = cluster.name || null
                  if ((!name || name.startsWith('Photo location')) && withinBudget()) {
                    try {
                      name = await reverseGeocode(cluster.lat, cluster.lng)
                      await sleep(1100) // Nominatim rate limit
                    } catch (_e) {}
                  }
                  name = name || ('Location ' + (cluster.date || ''))

                  const place = await ctx.places.create(tripId, { name, lat: cluster.lat, lng: cluster.lng })
                  p.placesCreated++

                  // Assign to day if date known
                  const placeId = place?.id ?? place?.data?.id
                  if (placeId) p.createdRefs.push({ type: 'place', id: placeId })
                  if (placeId && cluster.date && dayMap[cluster.date]) {
                    try { await ctx.itinerary.assign(tripId, dayMap[cluster.date], placeId) } catch (_e) {}
                  }
                  await sleep(80)
                } catch (e) { errors.push('Place: ' + e.message) }
              }
              p.places = i
            }
            let msg = 'Created ' + p.placesCreated + ' places (geocoded, deduplicated)'
            if (p.places < totalClusters) msg += ' (' + (totalClusters - p.places) + ' more queued)'
            if (p.placesCreated || p.places < totalClusters) log.push({ type: 'places', message: msg })
          }

          // ── 4. Upload photos (one at a time, compressed client-side) ──────
          // Photos are uploaded via /upload-photo route — import just tracks placeIds
          // (handled post-import by client in separate calls)

          // ── 5. Bookings ───────────────────────────────────────────────────
          // Reservation `type` drives whether TREK buckets a booking under
          // "Transports" — it MUST be one of the app's known type values.
          const RESERVATION_TYPE = { flight: 'flight', train: 'train', bus: 'bus', ferry: 'ferry' }
          // reservation_time / reservation_end_time are 'YYYY-MM-DD[THH:MM]' — TREK
          // derives the reservation's day from this, no day_id needed.
          const combineDateTime = (date, time) => date ? (date + (time ? 'T' + time : '')) : (time || null)

          // Same pagination pattern as polarsteps.steps — a large bookings array (many PDF/ICS/
          // email confirmations) can push the request past the ~100KB proxy ceiling on its own.
          // paginatedWindow() falls back to the plain array length when offset/total are absent
          // (an unpaginated call sends everything, offset 0).
          const bookingsWin = paginatedWindow(bookings, bookingsOffset, totalBookings)
          const totalBookingsCount = bookingsWin.total
          const bookingsActive = !!(options?.importBookings && totalBookingsCount)
          if (bookingsActive && p.bookings < totalBookingsCount) {
            let i = p.bookings
            for (; i < bookingsWin.end; i++) {
              if (!withinBudget()) break
              const b = bookingsWin.get(i)
              try {
                await sleep(150)
                if (b.type === 'hotel') {
                  // Accommodations need a place + the trip's day ids for check-in/out —
                  // create a place for the hotel, then only attach it if both dates land
                  // on an actual trip day.
                  const hotelName = b.operator || b.title || 'Hotel'
                  let place = null
                  try {
                    place = await ctx.places.create(tripId, { name: hotelName, address: b.to || b.from || undefined })
                  } catch (_e) {}
                  const placeId = place?.id ?? place?.data?.id
                  if (placeId) p.createdRefs.push({ type: 'place', id: placeId })
                  const startDayId = b.from_date && dayMap[b.from_date]
                  const endDayId = b.to_date && dayMap[b.to_date]
                  if (placeId && startDayId && endDayId) {
                    // create() also auto-creates the partner hotel reservation — that reservation's
                    // own id is never returned to us, but deleting the accommodation (below, in
                    // /undo-import) cascades to remove it too, so only the accommodation needs tracking.
                    const acc = await ctx.accommodations.create(tripId, {
                      place_id: placeId,
                      start_day_id: startDayId,
                      end_day_id: endDayId,
                      check_in: b.from_time || null,
                      check_out: b.to_time || null,
                      confirmation: b.booking_ref || null,
                      notes: b.notes || null,
                    })
                    p.bookingsAcc++
                    const accId = acc?.id ?? acc?.data?.id
                    if (accId) p.createdRefs.push({ type: 'accommodation', id: accId })
                  } else {
                    p.bookingsReview++
                    errors.push('Hotel ' + hotelName + ': no matching trip day for check-in/check-out — add it manually')
                  }
                } else {
                  const metadata = {}
                  if (b.operator) metadata.airline = b.operator
                  if (b.flight_number) metadata.flight_number = b.flight_number
                  if (b.from_code || b.from) metadata.departure_airport = [b.from_code, b.from].filter(Boolean).join(' ')
                  if (b.to_code || b.to) metadata.arrival_airport = [b.to_code, b.to].filter(Boolean).join(' ')
                  if (b.price != null) metadata.price = b.price
                  if (b.price != null) metadata.priceCurrency = b.currency || options?.defaultCurrency

                  const input = {
                    title: b.title,
                    type: RESERVATION_TYPE[b.type] || 'transport_other',
                    status: 'confirmed',
                    reservation_time: combineDateTime(b.from_date, b.from_time),
                    reservation_end_time: combineDateTime(b.to_date, b.to_time),
                    confirmation_number: b.booking_ref || null,
                    notes: b.notes || null,
                  }
                  if (Object.keys(metadata).length) input.metadata = JSON.stringify(metadata)
                  const resv = await ctx.reservations.create(tripId, input)
                  p.bookingsRes++
                  const resvId = resv?.id ?? resv?.data?.id
                  if (resvId) p.createdRefs.push({ type: 'reservation', id: resvId })
                }
              } catch (e) { errors.push('Booking ' + b.title + ': ' + e.message) }
            }
            p.bookings = i
          }
          if (bookingsActive) {
            let msg = 'Created ' + p.bookingsRes + ' transports, ' + p.bookingsAcc + ' accommodations'
            if (p.bookings < totalBookingsCount) msg += ' (' + (totalBookingsCount - p.bookings) + ' more queued)'
            log.push({ type: 'bookings', message: msg })
            if (p.bookingsReview) log.push({ type: 'bookings', message: p.bookingsReview + ' hotel booking(s) need manual review (no matching trip day)' })
          }

          // ── 6. Costs ──────────────────────────────────────────────────────
          // Same pagination pattern as bookings/steps above — a large expense CSV can push the
          // request past the ~100KB proxy ceiling on its own.
          const expensesWin = paginatedWindow(expenses, expensesOffset, totalExpenses)
          const totalExpensesCount = expensesWin.total
          const costsActive = !!(options?.importCosts && totalExpensesCount)
          if (costsActive && p.costs < totalExpensesCount) {
            let i = p.costs
            for (; i < expensesWin.end; i++) {
              if (!withinBudget()) break
              const e = expensesWin.get(i)
              try {
                if (!e.amount || !e.name) continue
                const cost = await ctx.costs.create(tripId, {
                  name: e.name,
                  total_price: e.amount,
                  currency: e.currency || options?.defaultCurrency || 'EUR',
                  category: e.category || 'other',
                  notes: e.date ? 'Date: ' + e.date : null,
                })
                p.costsCreated++
                const costId = cost?.id ?? cost?.data?.id
                if (costId) p.createdRefs.push({ type: 'cost', id: costId })
                await sleep(80)
              } catch (err) { errors.push('Cost ' + e.name + ': ' + err.message) }
            }
            p.costs = i
          }
          if (costsActive) {
            let msg = 'Created ' + p.costsCreated + ' cost entries'
            if (p.costs < totalExpensesCount) msg += ' (' + (totalExpensesCount - p.costs) + ' more queued)'
            log.push({ type: 'costs', message: msg })
          }

          p.done = p.days >= dateRange.length &&
            (!journalActive || p.journal >= totalSteps) &&
            (!options?.importPlaces || p.places >= totalClusters) &&
            (!bookingsActive || p.bookings >= totalBookingsCount) &&
            (!costsActive || p.costs >= totalExpensesCount)

          return { ok: true, tripId, log, errors, progress: p }
        })
        return safeJson(200, result)
      },
    },


    // ── PDF file attachment (backup) ──────────────────────────────────────────
    // The actual booking is extracted from the PDF's text layer client-side
    // (pdf.js) and imported as a normal booking via /parse-bookings + /import —
    // plugins have no session/REST access to TREK's own PDF booking parser, so
    // that route can't be driven from here. This route just attaches the
    // original PDF to the trip's files for reference (e.g. if extraction found
    // nothing, or the user wants the source document on hand).
    {
      method: 'POST', path: '/import-pdf-booking', auth: true,
      async handler(req, ctx) {
        const tripId = Number(req.body?.tripId)
        const filename = req.body?.filename
        const base64 = req.body?.base64
        const mimetype = req.body?.mimetype || 'application/pdf'
        if (!tripId || !base64 || !filename) return safeJson(200, { error: 'tripId, base64, filename required' })

        const result = await tryAttempt(async () => {
          const file = await ctx.files.create(tripId, {
            name: filename,
            content_base64: base64,
            mimetype,
          })
          const fileId = file?.id ?? file?.data?.id
          if (!fileId) return { error: 'File upload failed' }
          return { ok: true, fileId }
        })
        return safeJson(200, result)
      },
    },

    // ── Upload single photo (avoids 413) ──────────────────────────────────────
    {
      method: 'POST', path: '/upload-photo', auth: true,
      async handler(req, ctx) {
        const tripId = Number(req.body?.tripId)
        const photo = req.body?.photo
        if (!tripId || !photo?.base64 || !photo?.name) return safeJson(200, { error: 'tripId, photo.base64 and photo.name required' })
        const result = await tryAttempt(async () => {
          if (photo.sizeBytes > 10 * 1024 * 1024) return { error: 'File too large' }
          const file = await ctx.files.create(tripId, {
            name: photo.name,
            content_base64: photo.base64,
            mimetype: photo.mimetype || 'image/jpeg',
            description: photo.description || '',
            place_id: photo.placeId || undefined,
          })
          return { ok: true, fileId: file?.id ?? file?.data?.id ?? null }
        })
        return safeJson(200, result)
      },
    },

    // ── Undo an import ─────────────────────────────────────────────────────────
    // /import (and the client's own PDF-attach/photo-upload loops) return a `type`+`id`
    // ref for everything they create. The client sends them back here, newest-first, to
    // delete them — but NOT the trip itself (ctx.trips has no delete method) and NOT the
    // calendar day rows /import created (removing those could cascade into content the
    // user added by hand since the import). Same 6s-budget/resumable shape as /import:
    // whatever doesn't fit this call comes back in `remaining` for the client to resend.
    {
      method: 'POST', path: '/undo-import', auth: true,
      async handler(req, ctx) {
        // tripId is optional — a journal-only import (options.journalOnly) never creates a
        // trip at all, so its refs are only ever 'journey'/'journalEntry', neither of which
        // ctx.journal.deleteEntry/deleteJourney take a tripId for. Every OTHER ref type is
        // still trip-scoped and guarded below.
        const tripId = req.body?.tripId != null ? Number(req.body.tripId) : null
        const refs = Array.isArray(req.body?.refs) ? req.body.refs : []
        if (!refs.length) return safeJson(200, { done: true, deleted: 0, remaining: [], errors: [] })
        const result = await tryAttempt(async () => {
          const deadline = Date.now() + 6000
          const withinBudget = () => Date.now() < deadline
          const tripScopedTypes = ['place', 'reservation', 'accommodation', 'cost', 'file', 'daynote']
          let deleted = 0
          const errors = []
          let i = 0
          for (; i < refs.length; i++) {
            if (!withinBudget()) break
            const r = refs[i]
            try {
              if (tripScopedTypes.includes(r.type) && !tripId) throw new Error('no trip id for a ' + r.type + ' ref')
              if (r.type === 'place') await ctx.places.delete(tripId, r.id)
              else if (r.type === 'reservation') await ctx.reservations.delete(tripId, r.id)
              else if (r.type === 'accommodation') await ctx.accommodations.delete(tripId, r.id)
              else if (r.type === 'cost') await ctx.costs.delete(tripId, r.id)
              else if (r.type === 'file') await ctx.files.softDelete(tripId, r.id)
              else if (r.type === 'daynote') await ctx.daynotes.delete(tripId, r.id)
              else if (r.type === 'journalEntry') await ctx.journal.deleteEntry(r.id)
              else if (r.type === 'journey') await ctx.journal.deleteJourney(r.id)
              // Not trip-scoped (a collection isn't a trip) — like journey/journalEntry above,
              // no tripId needed. The collection itself is never deleted, same as trips/journeys
              // are never deleted by undo — only what was added to it.
              else if (r.type === 'collectionPlace') await ctx.collections.deletePlace(r.id)
              deleted++
            } catch (e) { errors.push((r.type || 'item') + ' ' + r.id + ': ' + e.message) }
          }
          return { deleted, remaining: refs.slice(i), errors, done: i >= refs.length }
        })
        return safeJson(200, result)
      },
    },
  ]),

  // ── photoProvider hook ──────────────────────────────────────────────────────
  // Confirmed against TREK's actual source (plugin-sdk/src/index.ts + the real
  // plugin-photos.controller.ts that consumes this hook — the trek-plugin-dev skill's own
  // docs only had a one-line description, not the interface): implementing this makes every
  // photo this plugin has ever uploaded via ctx.files.create() (Polarsteps step photos, GPS
  // photos, the CDN-fallback photos, everything from doImport()'s photo-upload loops)
  // searchable and pickable directly from TREK's native photo picker — including, per the
  // controller's own comment ("the picker fans these into its 'plugin sources' tab"), the
  // picker used when adding a photo to a journal entry. This is the actual fix for "get
  // imported photos into the Journey view": not by creating gallery records ourselves (no
  // ctx API for that — see the CLAUDE.md platform-gap note), but by making our own uploaded
  // files choosable through the same native UI that already lets a user attach any photo.
  //
  // hooks run with an acting user bound (confirmed: the controller calls invokeHook(...,
  // userId, 5000) — same as a route handler), so ctx.trips/ctx.files work here. But every
  // returned Photo.thumbnailUrl/fullUrl MUST be an absolute http(s) URL — TREK's controller
  // validates with `new URL(raw)`, which throws (and silently drops the photo) on a bare
  // relative path. ctx.files.create()/list() already return a relative `url` field
  // (`/api/trips/<tripId>/files/<fileId>/download` — confirmed in server/src/services/
  // fileService.ts's formatFile()), and that download route "accepts a cookie, a Bearer
  // header OR a one-shot ?token= param" (confirmed in files-download.controller.ts) — so a
  // plain <img> tag rendered inside the user's own already-logged-in TREK tab loads it fine
  // via the existing session cookie, no token needed. The one piece a plugin has no way to
  // know on its own is TREK's own public base URL (nothing in `ctx` exposes it) — hence the
  // `trek_base_url` setting below. scope:'user' (not 'instance') so each user fills in their
  // own value with no admin involvement required — read here via ctx.settings.get(), the
  // acting user's own decrypted value (unlike ctx.config, which only surfaces instance-scoped
  // settings). Same underlying reason TREK's own APP_URL env var exists for OIDC, just
  // per-user instead of instance-wide here. Left unset, search()/getById() both return
  // nothing for that user rather than emitting broken (relative) URLs TREK would just drop.
  hooks: {
    photoProvider: {
      async search(query, opts, ctx) {
        const baseUrl = String((await attempt(() => ctx.settings.get('trek_base_url'))) || '').replace(/\/+$/, '')
        if (!baseUrl) return { photos: [], total: 0, hasMore: false }
        const q = String(query || '').trim().toLowerCase()
        const page = Math.max(1, Number(opts?.page) || 1)
        const limit = Math.max(1, Math.min(60, Number(opts?.limit) || 30))

        const trips = await attempt(() => ctx.trips.listMine(), [])
        const all = []
        // Bounded on two axes (trips scanned, files per trip) — this hook has a hard 5s
        // host-side timeout (confirmed in plugin-photos.controller.ts), and ctx.files.list is
        // its own RPC round trip per trip.
        for (const t of (trips || []).slice(0, 25)) {
          const files = await attempt(() => ctx.files.list(t.id), [])
          for (const f of (files || []).slice(0, 200)) {
            if (!f.mime_type || !String(f.mime_type).startsWith('image/')) continue
            const name = f.original_name || f.description || ''
            if (q && !String(name).toLowerCase().includes(q) && !String(f.description || '').toLowerCase().includes(q)) continue
            if (!f.url) continue
            all.push({
              id: t.id + ':' + f.id,
              title: f.description || f.original_name || undefined,
              thumbnailUrl: baseUrl + f.url,
              fullUrl: baseUrl + f.url,
              takenAt: safeIsoDate(f.created_at),
            })
          }
        }
        const start = (page - 1) * limit
        return { photos: all.slice(start, start + limit), total: all.length, hasMore: start + limit < all.length }
      },
      async getById(id, ctx) {
        const baseUrl = String((await attempt(() => ctx.settings.get('trek_base_url'))) || '').replace(/\/+$/, '')
        if (!baseUrl) return null
        const [tripIdStr, fileIdStr] = String(id).split(':')
        const tripId = Number(tripIdStr); const fileId = Number(fileIdStr)
        if (!tripId || !fileId) return null
        const files = await attempt(() => ctx.files.list(tripId), [])
        const f = (files || []).find(x => Number(x.id) === fileId)
        if (!f || !f.url) return null
        return {
          id,
          title: f.description || f.original_name || undefined,
          thumbnailUrl: baseUrl + f.url,
          fullUrl: baseUrl + f.url,
          takenAt: safeIsoDate(f.created_at),
        }
      },
    },
  },
})

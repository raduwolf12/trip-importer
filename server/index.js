'use strict'
const { definePlugin } = require('trek-plugin-sdk')

function safeJson(status, obj) {
  try { return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) } }
  catch (e) { return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String(e) }) } }
}
async function tryAttempt(fn) {
  try { return await fn() } catch (e) { return { error: e?.message || String(e) } }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function unixToDate(ts) {
  if (!ts) return null
  return new Date(ts * 1000).toISOString().slice(0, 10)
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

// ── Distance between two coords in metres ────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Cluster GPS points within radius into groups ──────────────────────────────
function clusterByProximity(places, radiusMetres = 800) {
  const clusters = []
  for (const p of places) {
    const match = clusters.find(c => haversine(c.lat, c.lng, p.lat, p.lng) < radiusMetres)
    if (match) {
      match.members.push(p)
      // Update centroid
      match.lat = match.members.reduce((s, m) => s + m.lat, 0) / match.members.length
      match.lng = match.members.reduce((s, m) => s + m.lng, 0) / match.members.length
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, members: [p], name: p.name, date: p.date })
    }
  }
  return clusters
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
      if (l.latitudeE7 && l.longitudeE7) {
        const date = l.timestamp ? l.timestamp.slice(0, 10) : null
        places.push({ lat: l.latitudeE7 / 1e7, lng: l.longitudeE7 / 1e7, date, name: null, photoCount: 1 })
      }
    }
  }

  return places
}


// ── Regex-based booking extractor ────────────────────────────────────────────
// Parse a localized number string ("1 978,00", "1,234.56", "1.234,56", "978.00")
// into a plain float — the last comma/dot followed by exactly 2 digits is the
// decimal separator; everything else (spaces, other commas/dots) is a thousands separator.
function parseLocalizedNumber(str) {
  const s = String(str).replace(/\s/g, '')
  const m = s.match(/^(.*)[.,](\d{2})$/)
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

// Map IATA airline prefix to name
function detectAirline(flightNum) {
  const codes = {
    SK:'SAS',CA:'Air China',LH:'Lufthansa',FR:'Ryanair',W6:'Wizz Air',
    U2:'easyJet',BA:'British Airways',AF:'Air France',KL:'KLM',
    IJ:'Spring Japan',MU:'China Eastern',AY:'Finnair',TK:'Turkish Airlines',
    OS:'Austrian Airlines',LX:'Swiss',EK:'Emirates',QR:'Qatar',
    CX:'Cathay Pacific',NH:'ANA',JL:'JAL',SQ:'Singapore Airlines',
  }
  const prefix = flightNum.replace(/\d/g,'').toUpperCase()
  return codes[prefix] || null
}

const BOOKING_PROMPT = `Extract all travel bookings from the text below. Return ONLY valid JSON, no markdown.

{"bookings":[{"type":"flight|hotel|bus|train|transfer|ferry","title":"short title","from":"origin","from_code":"IATA or null","from_date":"YYYY-MM-DD or null","from_time":"HH:MM or null","to":"destination","to_code":"IATA or null","to_date":"YYYY-MM-DD or null","to_time":"HH:MM or null","operator":"name","booking_ref":"ref or null","flight_number":"e.g. SK983 or null","price":0,"currency":"EUR","notes":"notes or null","confidence":"high|medium|low"}],"trip_name":"name or null","summary":"one sentence"}

Rules: extract ALL bookings, one entry per flight leg, dates YYYY-MM-DD, times HH:MM 24h, price as number only.

---TEXT---
`

module.exports = definePlugin({
  async onLoad(ctx) { ctx.log.info('trip-importer v1.6.0 loaded') },
  routes: [

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
            stepCount: steps.length,
            steps: steps.map((s, i) => ({
              name: (s.name && s.name.trim()) || s.display_name || ('Stop ' + (i + 1)),
              description: (s.description && s.description.trim()) || null,
              date: unixToDate(s.start_time || s.creation_time),
              weather: s.weather_condition ? { condition: s.weather_condition, tempC: s.weather_temperature ?? null } : null,
              location: s.location ? {
                name: s.location.full_detail || s.location.name || null,
                lat: typeof s.location.lat === 'number' ? s.location.lat : null,
                lon: typeof s.location.lon === 'number' ? s.location.lon : null,
              } : null,
            })),
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

          // If regex found nothing and AI is requested, try AI
          if (!bookings.length && useAI) {
            try {
              const aiResult = await ctx.ai.complete(BOOKING_PROMPT + text.slice(0, 18000))
              const raw = (aiResult?.text || '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
              const parsed = JSON.parse(raw)
              const aiBookings = (parsed.bookings || []).map((b, i) => ({ ...b, _id: 'ai' + i, _source: 'ai' }))
              return { bookings: aiBookings, tripName: parsed.trip_name || null, summary: parsed.summary || null, source: 'ai' }
            } catch (_e) {}
          }

          return { bookings, summary: bookings.length + ' booking' + (bookings.length === 1 ? '' : 's') + ' found', source: 'regex' }
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
            if (!p.lat || !p.lng) continue
            const date = (p.date || '').slice(0, 10) || 'unknown'
            if (!byDate[date]) byDate[date] = []
            byDate[date].push(p)
          }
          // One point per DAY (median lat/lng of all that day's photos) collapses multiple distinct
          // locations visited the same day into a single, sometimes-nowhere-real point — e.g. a day
          // with photos from 3 different attractions produced 1 "place" roughly between them. Cluster
          // by proximity WITHIN each day first (same radius as parse-timeline), so a day only becomes
          // one place if its photos were actually all taken near each other.
          const places = []
          for (const [date, pts] of Object.entries(byDate)) {
            const clusters = clusterByProximity(pts, 500)
            for (const c of clusters) {
              places.push({
                date,
                lat: c.lat,
                lng: c.lng,
                photoCount: c.members.length,
                photoNames: c.members.map(m => m.name),
              })
            }
          }
          places.sort((a, b) => a.date.localeCompare(b.date))
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
          return { places: clusters.slice(0, 200), totalPoints: places.length }
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
          for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i])
            if (!cols.length || cols.every(c => !c)) continue
            const raw = amtCol >= 0 ? cols[amtCol] || '' : ''
            // Strip currency symbols/codes but keep digits, both separators, spaces, and the sign —
            // parseLocalizedNumber() decides which of ,/. is the decimal point (same fix as booking prices).
            const amt = parseLocalizedNumber(raw.replace(/[^0-9.,\s-]/g, ''))
            if (amtCol >= 0 && (isNaN(amt) || amt === 0)) continue
            const name = nameCol >= 0 ? cols[nameCol] || null : null
            if (!name && !amt) continue

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

            expenses.push({
              _id: 'e' + i,
              date: dateCol >= 0 ? cols[dateCol] || null : null,
              name: name || ('Expense ' + i),
              amount: Math.abs(amt), // always positive
              currency: currCol >= 0 ? (cols[currCol] || '').toUpperCase().slice(0, 3) || null : null,
              category: detectedCat || 'other',
            })
          }
          return { expenses, rowCount: expenses.length }
        })
        return safeJson(200, result)
      },
    },

    // ── Main import ───────────────────────────────────────────────────────────
    {
      method: 'POST', path: '/import', auth: true,
      async handler(req, ctx) {
        const { tripConfig, polarsteps, bookings, gpsPlaces, timelinePlaces, expenses, options, progress: progressIn } = req.body || {}
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
            days: 0, daysCreated: 0,
          }, progressIn || {})

          // ── 1. Trip ────────────────────────────────────────────────────────
          if (tripConfig.mode === 'existing') {
            tripId = Number(tripConfig.tripId)
          } else {
            const newTrip = await ctx.trips.create({
              title: tripConfig.title || polarsteps?.name || 'Imported Trip',
              start_date: tripConfig.startDate || polarsteps?.startDate || null,
              end_date: tripConfig.endDate || polarsteps?.endDate || null,
            })
            tripId = newTrip?.id ?? newTrip?.data?.id
            if (!tripId) throw new Error('Failed to create trip')
            log.push({ type: 'trip', message: 'Created trip: ' + (tripConfig.title || polarsteps?.name) })
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
          if (!rangeStart || !rangeEnd) {
            const allDates = []
            for (const s of steps) if (s.date) allDates.push(s.date)
            for (const c of (gpsPlaces || [])) if (c.date) allDates.push(c.date)
            for (const c of (timelinePlaces || [])) if (c.date) allDates.push(c.date)
            for (const b of (bookings || [])) { if (b.from_date) allDates.push(b.from_date); if (b.to_date) allDates.push(b.to_date) }
            for (const e of (expenses || [])) if (e.date) allDates.push(e.date)
            allDates.sort()
            if (allDates.length) { rangeStart = rangeStart || allDates[0]; rangeEnd = rangeEnd || allDates[allDates.length - 1] }
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
          if (journalActive && p.journal < steps.length) {
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
              }
              if (journeyId) {
                let i = p.journal
                for (; i < steps.length; i++) {
                  if (!withinBudget()) break
                  const step = steps[i]
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
                      } catch (_e) {}
                      await sleep(80)
                    }

                    const weatherNote = step.weather
                      ? '\n\n_' + step.weather.condition.replace(/-/g, ' ') + (step.weather.tempC != null ? ', ' + step.weather.tempC + '°C' : '') + '_'
                      : ''
                    const entryDate = step.date || polarsteps.startDate
                    const entryContent = (step.description || '') + weatherNote

                    const entry = { entry_date: entryDate, title: step.name, content: entryContent }
                    if (placeId) entry.place_id = placeId
                    await ctx.journal.createEntry(journeyId, entry)
                    p.journalEntries++

                    // Linking a place to the journal entry (above) does NOT put it on the trip's
                    // day/itinerary view — that's a separate assignment, easy to forget since the
                    // place still looks "imported" either way.
                    if (placeId && entryDate && dayMap[entryDate]) {
                      try { await ctx.itinerary.assign(tripId, dayMap[entryDate], placeId) } catch (_e) {}
                    }

                    // Also add to day notes if day exists for this date
                    if (options.importDayNotes && entryDate && dayMap[entryDate] && step.description) {
                      try {
                        await ctx.daynotes.create(tripId, dayMap[entryDate], {
                          content: '**' + step.name + '**\n' + step.description,
                        })
                        p.journalDayNotes++
                      } catch (_e) {}
                    }

                    await sleep(100)
                  } catch (e) { errors.push('Step ' + step.name + ': ' + e.message) }
                }
                p.journal = i
              } else {
                p.journal = steps.length // couldn't create/find a journey — don't retry forever
              }
            } catch (e) { errors.push('Journal: ' + e.message) }
          }
          if (journalActive) {
            let msg = 'Created journal with ' + p.journalEntries + ' entries'
            if (p.journalDayNotes) msg += ', ' + p.journalDayNotes + ' day notes'
            if (p.journal < steps.length) msg += ' (' + (steps.length - p.journal) + ' more queued)'
            log.push({ type: 'journal', message: msg })
          }

          // ── 3. GPS + Timeline Places — deduplicated and geocoded ──────────
          // Recomputed fresh every call — deterministic given the same gpsPlaces/timelinePlaces/
          // polarsteps input (which the client always resends unchanged), so p.places stays a
          // valid resume index into it across calls.
          let clusters = []
          if (options?.importPlaces) {
            const allRawPlaces = [...(gpsPlaces || []), ...(timelinePlaces || [])]
            const polarstepsCoords = steps.filter(s => s.location?.lat).map(s => ({ lat: s.location.lat, lng: s.location.lon }))
            const deduplicated = allRawPlaces.filter(pt => !polarstepsCoords.some(ps => haversine(ps.lat, ps.lng, pt.lat, pt.lng) < 800))
            clusters = clusterByProximity(deduplicated, 800)

            if (p.places < clusters.length) {
              let i = p.places
              for (; i < clusters.length; i++) {
                if (!withinBudget()) break
                const cluster = clusters[i]
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
                  if (placeId && cluster.date && dayMap[cluster.date]) {
                    try { await ctx.itinerary.assign(tripId, dayMap[cluster.date], placeId) } catch (_e) {}
                  }
                  await sleep(80)
                } catch (e) { errors.push('Place: ' + e.message) }
              }
              p.places = i
            }
            let msg = 'Created ' + p.placesCreated + ' places (geocoded, deduplicated)'
            if (p.places < clusters.length) msg += ' (' + (clusters.length - p.places) + ' more queued)'
            if (p.placesCreated || p.places < clusters.length) log.push({ type: 'places', message: msg })
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

          const bookingsActive = !!(options?.importBookings && bookings?.length)
          if (bookingsActive && p.bookings < bookings.length) {
            let i = p.bookings
            for (; i < bookings.length; i++) {
              if (!withinBudget()) break
              const b = bookings[i]
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
                  const startDayId = b.from_date && dayMap[b.from_date]
                  const endDayId = b.to_date && dayMap[b.to_date]
                  if (placeId && startDayId && endDayId) {
                    await ctx.accommodations.create(tripId, {
                      place_id: placeId,
                      start_day_id: startDayId,
                      end_day_id: endDayId,
                      check_in: b.from_time || null,
                      check_out: b.to_time || null,
                      confirmation: b.booking_ref || null,
                      notes: b.notes || null,
                    })
                    p.bookingsAcc++
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
                  await ctx.reservations.create(tripId, input)
                  p.bookingsRes++
                }
              } catch (e) { errors.push('Booking ' + b.title + ': ' + e.message) }
            }
            p.bookings = i
          }
          if (bookingsActive) {
            let msg = 'Created ' + p.bookingsRes + ' transports, ' + p.bookingsAcc + ' accommodations'
            if (p.bookings < bookings.length) msg += ' (' + (bookings.length - p.bookings) + ' more queued)'
            log.push({ type: 'bookings', message: msg })
            if (p.bookingsReview) log.push({ type: 'bookings', message: p.bookingsReview + ' hotel booking(s) need manual review (no matching trip day)' })
          }

          // ── 6. Costs ──────────────────────────────────────────────────────
          const costsActive = !!(options?.importCosts && expenses?.length)
          if (costsActive && p.costs < expenses.length) {
            let i = p.costs
            for (; i < expenses.length; i++) {
              if (!withinBudget()) break
              const e = expenses[i]
              try {
                if (!e.amount || !e.name) continue
                await ctx.costs.create(tripId, {
                  name: e.name,
                  total_price: e.amount,
                  currency: e.currency || options?.defaultCurrency || 'EUR',
                  category: e.category || 'other',
                  notes: e.date ? 'Date: ' + e.date : null,
                })
                p.costsCreated++; await sleep(80)
              } catch (err) { errors.push('Cost ' + e.name + ': ' + err.message) }
            }
            p.costs = i
          }
          if (costsActive) {
            let msg = 'Created ' + p.costsCreated + ' cost entries'
            if (p.costs < expenses.length) msg += ' (' + (expenses.length - p.costs) + ' more queued)'
            log.push({ type: 'costs', message: msg })
          }

          p.done = p.days >= dateRange.length &&
            (!journalActive || p.journal >= steps.length) &&
            (!options?.importPlaces || p.places >= clusters.length) &&
            (!bookingsActive || p.bookings >= bookings.length) &&
            (!costsActive || p.costs >= expenses.length)

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
  ],
})

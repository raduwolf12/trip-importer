#!/usr/bin/env node
/**
 * generate-test-data.js
 * Generates sample data covering every import source the Trip Importer plugin understands
 * (Polarsteps ZIP/JSON, booking text/.eml/.ics, expense/place CSVs, GPX/KML/KMZ, Google Maps
 * Timeline, Google Photos Takeout sidecars, Google "Saved places" Collection-mode exports),
 * plus several edge cases and oversized variants that exercise the client-side pagination/
 * chunking added to stay under TREK's confirmed ~100KB plugin-route body limit.
 *
 * Usage:
 *   node generate-test-data.js [--steps N] [--out ./test-data]
 *
 * Defaults: 300 steps for the main Polarsteps stress test, output to ./test-data/
 *
 * Run `node generate-test-data.js` with no args, then drop the whole test-data/ folder
 * (or individual files/subfolders) onto the Trip Importer wizard. See the printed manifest
 * at the end of a run for what each file exercises.
 */

'use strict'
const fs = require('fs')
const path = require('path')

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (flag, def) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const STEPS = Number(getArg('--steps', 300))
const OUT = getArg('--out', path.join(process.cwd(), 'test-data'))

fs.mkdirSync(OUT, { recursive: true })

// ── Helpers ───────────────────────────────────────────────────────────────────
const rand = (min, max) => Math.random() * (max - min) + min
const randInt = (min, max) => Math.floor(rand(min, max + 1))
const pick = arr => arr[randInt(0, arr.length - 1)]
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
})
const isoDate = ts => new Date(ts * 1000).toISOString().slice(0, 10)
const manifest = [] // {file, note} — printed at the end
const note = (file, text) => manifest.push({ file, text })

const CITIES = [
  { name: 'Tokyo', country: 'JP', lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo' },
  { name: 'Kyoto', country: 'JP', lat: 35.0116, lon: 135.7681, tz: 'Asia/Tokyo' },
  { name: 'Osaka', country: 'JP', lat: 34.6937, lon: 135.5023, tz: 'Asia/Tokyo' },
  { name: 'Hiroshima', country: 'JP', lat: 34.3853, lon: 132.4553, tz: 'Asia/Tokyo' },
  { name: 'Nara', country: 'JP', lat: 34.6851, lon: 135.8050, tz: 'Asia/Tokyo' },
  { name: 'Sapporo', country: 'JP', lat: 43.0642, lon: 141.3469, tz: 'Asia/Tokyo' },
  { name: 'Bangkok', country: 'TH', lat: 13.7563, lon: 100.5018, tz: 'Asia/Bangkok' },
  { name: 'Chiang Mai', country: 'TH', lat: 18.7883, lon: 98.9853, tz: 'Asia/Bangkok' },
  { name: 'Phuket', country: 'TH', lat: 7.9519, lon: 98.3381, tz: 'Asia/Bangkok' },
  { name: 'Hanoi', country: 'VN', lat: 21.0278, lon: 105.8342, tz: 'Asia/Ho_Chi_Minh' },
  { name: 'Ho Chi Minh City', country: 'VN', lat: 10.8231, lon: 106.6297, tz: 'Asia/Ho_Chi_Minh' },
  { name: 'Hoi An', country: 'VN', lat: 15.8801, lon: 108.3380, tz: 'Asia/Ho_Chi_Minh' },
  { name: 'Seoul', country: 'KR', lat: 37.5665, lon: 126.9780, tz: 'Asia/Seoul' },
  { name: 'Busan', country: 'KR', lat: 35.1796, lon: 129.0756, tz: 'Asia/Seoul' },
  { name: 'Singapore', country: 'SG', lat: 1.3521, lon: 103.8198, tz: 'Asia/Singapore' },
  { name: 'Copenhagen', country: 'DK', lat: 55.6761, lon: 12.5683, tz: 'Europe/Copenhagen' },
  { name: 'Stockholm', country: 'SE', lat: 59.3293, lon: 18.0686, tz: 'Europe/Stockholm' },
  { name: 'Berlin', country: 'DE', lat: 52.5200, lon: 13.4050, tz: 'Europe/Berlin' },
  { name: 'Prague', country: 'CZ', lat: 50.0755, lon: 14.4378, tz: 'Europe/Prague' },
  { name: 'Vienna', country: 'AT', lat: 48.2082, lon: 16.3738, tz: 'Europe/Vienna' },
  { name: 'Budapest', country: 'HU', lat: 47.4979, lon: 19.0402, tz: 'Europe/Budapest' },
  { name: 'Bucharest', country: 'RO', lat: 44.4268, lon: 26.1025, tz: 'Europe/Bucharest' },
  { name: 'Lisbon', country: 'PT', lat: 38.7223, lon: -9.1393, tz: 'Europe/Lisbon' },
  { name: 'Barcelona', country: 'ES', lat: 41.3851, lon: 2.1734, tz: 'Europe/Madrid' },
]

const WEATHER = ['sunny', 'partly-cloudy', 'cloudy', 'rainy', 'thunderstorm', 'snowy', 'foggy', 'windy']
const DESCRIPTIONS = [
  'Explored the old town area and visited the local market. The food was incredible — tried street noodles and fresh mango sticky rice.',
  'Took a day trip to the nearby temple complex. The architecture was breathtaking, especially at sunrise when the mist was still rolling in.',
  'Rest day. Spent most of the morning in a cafe working, then wandered through the neighbourhood in the afternoon.',
  'Long travel day — bus journey took about 4 hours with a lunch stop at a roadside restaurant. Arrived exhausted but the guesthouse was lovely.',
  'Hiked up to the viewpoint overlooking the city. The climb was steep but absolutely worth it for the panorama.',
  'Museum day. Spent three hours in the national history museum, then a quick visit to the contemporary art gallery nearby.',
  'Found a great night market with dozens of food stalls. Ate way too much. No regrets.',
  'Beach day. The water was crystal clear and warm enough to swim. Rented a kayak for the afternoon.',
  'Cooking class in the morning — learned to make three local dishes. The instructor was fantastic and very patient.',
  null, // intentional null — some steps have no description
  'Got completely lost trying to find the famous viewpoint. Ended up stumbling onto a much better one that no tourists visit.',
  'Early morning bike ride around the lake. The whole thing was only about 15km but the scenery made it feel much longer.',
  'Train journey through the mountains. Genuinely one of the most beautiful rail routes I\'ve ever taken.',
  'Checked into the new place — a bit further from the centre but has a rooftop terrace with a perfect city view.',
  null,
]

// ── Minimal ZIP writer (stored/uncompressed, no dependencies) ────────────────
// Just enough of the ZIP spec for JSZip (used client-side) to read back: local file headers +
// central directory + end-of-central-directory record, method 0 (stored). Good enough for
// test-data purposes — real Polarsteps/KMZ exports are read the same way regardless of whether
// their entries happen to be deflated.
const CRC_TABLE = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF]
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function makeZip(entries) {
  // entries: [{name, data: Buffer}]
  const localParts = [], centralParts = []
  let offset = 0
  const dosTime = ((12 << 11) | (0 << 5) | 0) & 0xFFFF
  const dosDate = (((2026 - 1980) << 9) | (1 << 5) | 1) & 0xFFFF
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const size = data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const centralSize = centralParts.reduce((s, b) => s + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}
// A minimal but structurally valid 1x1 JPEG — enough to be treated as a real photo file by the
// plugin's extension-based bucketing; no real EXIF, which is fine for Polarsteps step photos
// (uploaded as-is, never EXIF-read) and irrelevant to the ZIP-structure tests below.
const FAKE_JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
])

// ── Generate a Polarsteps trip.json ──────────────────────────────────────────
// opts: { revisit: reuse an earlier city after moving on, to test same-place-different-day
//        clustering; longStay: give one step a >60-day end_time to test the itinerary
//        multi-day-assignment sanity cap; midnightCrossing: place a step's start_time just
//        before local midnight in a timezone far ahead of UTC, to test unixToDateInTz; noLocation/
//        noName/noWeather: force those fields null on at least one step; sentinelEndDate: push
//        the trip's own end_date to a bad-data placeholder far in the future. }
function generateTrip(stepCount, tripName, opts = {}) {
  const startTs = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000)
  const endTs = startTs + stepCount * 2 * 24 * 3600 // ~2 days per stop
  const tripUuid = opts.uuid || uuid()

  const steps = []
  let currentTs = startTs
  let cityIndex = 0
  const firstCity = CITIES[0]

  for (let i = 0; i < stepCount; i++) {
    let city = CITIES[cityIndex % CITIES.length]
    if (i > 0 && randInt(0, 2) === 0) cityIndex++ // occasionally move to next city

    // Revisit edge case: near the end of the trip, jump back to the very first city visited —
    // clusterByProximity()'s date-aware merge must keep these as separate itinerary days, not
    // collapse them into one place tied to whichever visit was processed first.
    if (opts.revisit && i === stepCount - 2) city = firstCity

    const stayDays = randInt(1, 4)
    const stepStart = currentTs
    let stepEnd = currentTs + stayDays * 24 * 3600
    currentTs = stepEnd + randInt(0, 6) * 3600 // 0–6h gap between stops

    // Long-stay edge case: one step spans >60 days — /import's per-step multi-day itinerary
    // assignment caps at 60 days as a sanity limit; this step should show places on the first
    // 60 days of the stay and nothing beyond that, not silently balloon the round's budget.
    if (opts.longStay && i === Math.floor(stepCount / 2)) {
      stepEnd = stepStart + 90 * 24 * 3600
      currentTs = stepEnd + 3600
    }

    let lat = city.lat + rand(-0.05, 0.05)
    let lon = city.lon + rand(-0.05, 0.05)
    let effectiveStart = stepStart

    // Midnight-crossing edge case: a step timestamped just before local midnight in a timezone
    // well ahead of UTC (e.g. 23:40 Asia/Tokyo, UTC+9) lands on the FOLLOWING day in plain UTC —
    // unixToDateInTz() must resolve this to the correct local calendar date, not the UTC one.
    if (opts.midnightCrossing && i === 1) {
      const localMidnight = Math.floor(new Date(`${isoDate(stepStart)}T23:40:00+09:00`).getTime() / 1000)
      effectiveStart = localMidnight
    }

    const forceNoLocation = opts.noLocation && i === 2
    const forceNoName = opts.noName && i === 0
    const forceNoWeather = opts.noWeather && i === 3
    const hasWeather = !forceNoWeather && Math.random() > 0.3
    const hasLocation = !forceNoLocation && Math.random() > 0.1

    steps.push({
      id: 100000 + i,
      uuid: uuid(),
      name: forceNoName || i % 7 === 0 ? null : `${city.name} — Day ${i + 1}`,
      display_name: `${city.name}`,
      description: pick(DESCRIPTIONS),
      start_time: effectiveStart,
      end_time: stepEnd,
      creation_time: effectiveStart,
      timezone_id: city.tz,
      weather_condition: hasWeather ? pick(WEATHER) : null,
      weather_temperature: hasWeather ? randInt(10, 35) : null,
      main_media_item_path: Math.random() > 0.7 ? `https://example.com/photos/step${i}.jpg` : null,
      location: hasLocation ? {
        id: 200000 + i,
        name: `${city.name} City Centre`,
        full_detail: `${city.name}, ${city.country}`,
        lat, lon,
        country_code: city.country,
      } : null,
    })
  }

  return {
    id: randInt(10000, 99999),
    uuid: tripUuid,
    name: tripName,
    summary: `An epic journey through ${[...new Set(CITIES.slice(0, Math.min(stepCount, CITIES.length)).map(c => c.name))].slice(0, 4).join(', ')} and beyond. ${stepCount} stops over ${Math.round((endTs - startTs) / 86400)} days.`,
    start_date: startTs,
    end_date: opts.sentinelEndDate ? Math.floor(new Date('2099-01-01').getTime() / 1000) : Math.min(endTs, startTs + 365 * 86400),
    total_km: randInt(2000, 15000),
    cover_photo_path: opts.coverPhoto ? 'https://example.com/photos/cover.jpg' : null,
    all_steps: steps,
  }
}

// ── Booking text sources ─────────────────────────────────────────────────────
function generateBookings() {
  return `--- BOOKING 1: FLIGHT CONFIRMATION ---
Booking Reference: XKPL72
Airline: Spring Japan
Flight: IJ018
From: Beijing Capital Airport (PEK)
To: Narita Airport, Tokyo (NRT)
Departure: 14 September 2026 10:45
Arrival: 14 September 2026 15:30
Passenger: Test Traveller
Class: Economy
Fare: GBP 142.42
Status: CONFIRMED - Instant confirmation
Seat: 24A (window)

--- BOOKING 2: HOTEL ---
Confirmation Number: HB-9928341
Property: The Peninsula Tokyo
Address: 1-8-1 Yurakucho, Chiyoda City, Tokyo, Japan
Check-in: 14 September 2026 (from 15:00)
Check-out: 18 September 2026 (until 12:00)
Room type: Deluxe City View Room
Rate: JPY 45,000 per night
Total: JPY 180,000
Prepaid: No — pay at hotel
Cancellation policy: Free cancellation until 12 September 2026

--- BOOKING 3: BUS ---
Operator: FlixBus
Route: Copenhagen Bus Terminal → Arlanda Airport T5, Stockholm
Bus Number: 502
Departure: 14 July 2026 22:05
Arrival: 15 July 2026 08:48
Duration: 10h 43m
Booking ref: W3RUY83D-016
Class: Standard
Price: EUR 66.98
2 stops: Gothenburg Central Station, Jönköping

--- BOOKING 4: FLIGHT ---
Confirmation: PNR-DK77AB
SAS Scandinavian Airlines
Flight SK983
Copenhagen (CPH) → Tokyo Haneda (HND)
Date: 10 September 2026
Departs: 13:20 — Arrives: 08:45+1
Duration: 11h 25m
Economy Light
Price: DKK 5,490

--- BOOKING 5: TRANSFER ---
Booking ID: DT-882910
Operator: Daytrip Private Transfer
Service: Private transfer with English-speaking driver
From: Osaka Airport (KIX)
To: Kyoto City Centre
Date: 18 October 2026 at 09:00
Vehicle: Standard Sedan (3 passengers max)
Price: USD 89.00
Instant confirmation — Free cancellation until 48h before
`
}

// Many confirmations concatenated — each individually small, but together comfortably over the
// client's 60KB-per-request booking-text chunk budget, so a single-file drop still exercises the
// multi-call windowing added to /parse-bookings (as opposed to bookings across MANY files, which
// the plain bookings.txt + multiple .eml/.pdf drops already covers in normal use).
function generateBookingsLarge(count) {
  const ops = ['Spring Japan', 'SAS', 'FlixBus', 'Ryanair', 'Eurostar', 'Amtrak', 'Lufthansa']
  const blocks = []
  for (let i = 0; i < count; i++) {
    const city = pick(CITIES)
    blocks.push(`--- BOOKING ${i + 1}: FLIGHT CONFIRMATION ---
Booking Reference: REF${1000 + i}XZ
Airline: ${pick(ops)}
Flight: FL${randInt(100, 999)}
From: Origin Airport (ORG)
To: ${city.name} Airport (${city.name.slice(0, 3).toUpperCase()})
Departure: ${randInt(1, 28)} September 2026 ${String(randInt(0, 23)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}
Arrival: same day
Passenger: Test Traveller ${i}
Fare: EUR ${randInt(50, 500)}.00
Status: CONFIRMED
`)
  }
  return blocks.join('\n')
}

// SJ/Resplus-style multi-leg rail e-ticket export — exercises parseBookingsRegex's dedicated
// structured detector (repeating "HH:MM From HH:MM To Train NNNN" blocks anchored to a written-
// out date), which runs BEFORE flight-number detection specifically so "SJ 3000" doesn't
// false-match the flight-number pattern. Includes a duplicate leg (same physical journey printed
// twice, once per co-traveller's ticket in the export) to test the dedup step.
function generateRailTickets() {
  return `SJ Biljett / Ticket
Resenär: Test Traveller
Bokningsnummer: SJXY123456

17 juli 2026
08:12  Stockholm Central   10:47  Göteborg Central   Tåg 442

17 juli 2026
08:12  Stockholm Central   10:47  Göteborg Central   Tåg 442

18 juli 2026
14:05  Göteborg Central    16:58  Malmö Central       Tåg 1921

--- Andra resenärens biljett ---
17 juli 2026
08:12  Stockholm Central   10:47  Göteborg Central   Tåg 442
`
}

// .eml MIME message with a quoted-printable HTML body — extractEmlText() must decode the MIME
// structure (headers + Content-Transfer-Encoding) rather than feed raw quoted-printable bytes
// to the regex/AI booking pipeline.
function generateEml() {
  const body = `<html><body>
<p>Your booking is confirmed.</p>
<p>Confirmation Number: HB-4471209<br>
Property: Hotel Gracery Shinjuku<br>
Check-in: 20 September 2026 (from 15:00)<br>
Check-out: 23 September 2026 (until 11:00)<br>
Total: JPY 62=2C000<br>
</p>
</body></html>`
  return `From: bookings@example-hotels.com
To: traveller@example.com
Subject: Your hotel booking confirmation
MIME-Version: 1.0
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

${body}
`
}

// ICS/iCalendar export with a flight and a hotel stay as VEVENTs.
function icsDt(d) { return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z' }
function generateIcs() {
  const flightStart = new Date('2026-09-10T13:20:00Z')
  const flightEnd = new Date('2026-09-11T08:45:00Z')
  const hotelStart = new Date('2026-09-14T15:00:00Z')
  const hotelEnd = new Date('2026-09-18T12:00:00Z')
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//trip-importer test data//EN
BEGIN:VEVENT
UID:flight-sk983@example.com
SUMMARY:Flight SK983 Copenhagen to Tokyo
LOCATION:Copenhagen Airport (CPH)
DESCRIPTION:Booking reference PNR-DK77AB
DTSTART:${icsDt(flightStart)}
DTEND:${icsDt(flightEnd)}
END:VEVENT
BEGIN:VEVENT
UID:hotel-peninsula@example.com
SUMMARY:The Peninsula Tokyo — hotel stay
LOCATION:1-8-1 Yurakucho, Chiyoda City, Tokyo
DESCRIPTION:Confirmation HB-9928341
DTSTART;VALUE=DATE:${icsDt(hotelStart).slice(0, 8)}
DTEND;VALUE=DATE:${icsDt(hotelEnd).slice(0, 8)}
END:VEVENT
END:VCALENDAR
`
}

// ── Expense CSVs ──────────────────────────────────────────────────────────────
const MERCHANTS = [
  ['Ramen Ichiraku', 'food'], ['7-Eleven Japan', 'food'], ['Conveyor Belt Sushi', 'food'],
  ['JR Pass Activation', 'transport'], ['Shinkansen CPH→OSK', 'transport'], ['Uber', 'transport'],
  ['Bangkok BTS Skytrain', 'transport'], ['FlixBus ticket', 'transport'],
  ['Hotel Gracery Shinjuku', 'accommodation'], ['Airbnb Kyoto machiya', 'accommodation'],
  ['Guest House Bangkok', 'accommodation'], ['Tokyo National Museum', 'activities'],
  ['Fushimi Inari entry', 'activities'], ['Snorkeling tour Phuket', 'activities'],
  ['Cooking class', 'activities'], ['Uniqlo', 'shopping'], ['Tokyu Hands', 'shopping'],
  ['Chatuchak Market', 'shopping'], ['Pharmacy', 'other'], ['ATM fee', 'other'],
  ['Travel insurance', 'other'], ['SIM card', 'other'],
]
function generateExpenses(count, { startDate = '2026-09-14' } = {}) {
  const currencies = ['JPY', 'JPY', 'JPY', 'THB', 'THB', 'EUR', 'EUR', 'DKK', 'USD']
  const rows = [['Date', 'Name', 'Amount', 'Currency', 'Category']]
  let currentDate = new Date(startDate)
  for (let i = 0; i < count; i++) {
    if (i > 0 && randInt(0, 2) === 0) currentDate.setDate(currentDate.getDate() + randInt(1, 3))
    const [merchant, cat] = pick(MERCHANTS)
    const currency = pick(currencies)
    let amount
    if (currency === 'JPY') amount = randInt(300, 8000)
    else if (currency === 'THB') amount = randInt(80, 1200)
    else if (currency === 'DKK') amount = randInt(50, 800)
    else amount = parseFloat(rand(3, 120).toFixed(2))
    rows.push([currentDate.toISOString().slice(0, 10), merchant, amount, currency, cat])
  }
  return rows.map(r => r.join(',')).join('\n')
}

// European-format decimal-comma numbers ("1 978,00") mixed with a thousands-separator case
// ("20,00" DKK, which parseLocalizedNumber() must NOT read as 2000) — the exact production bug
// documented in CLAUDE.md for parseLocalizedNumber().
function generateExpensesLocalized() {
  const rows = [
    ['Date', 'Name', 'Amount', 'Currency', 'Category'],
    ['2026-09-15', 'Restaurant Nusantara', '1 978,00', 'DKK', 'food'],
    ['2026-09-15', 'Bakery', '20,00', 'DKK', 'food'],
    ['2026-09-16', 'Souvenir shop', '1.234,56', 'EUR', 'shopping'],
    ['2026-09-16', 'Taxi', '1,234.56', 'USD', 'transport'],
    ['2026-09-17', 'Museum entry', '978.00', 'USD', 'activities'],
    ['2026-09-17', 'Coffee', '20.5', 'USD', 'food'],
  ]
  return rows.map(r => r.join(',')).join('\n')
}

// ── GPX / KML ─────────────────────────────────────────────────────────────────
function generateGpx(trackPointCount) {
  const start = new Date('2026-09-01T08:00:00Z').getTime()
  let lat = 35.6762, lon = 139.6503
  const trkpts = []
  for (let i = 0; i < trackPointCount; i++) {
    lat += rand(-0.002, 0.002)
    lon += rand(-0.002, 0.002)
    const t = new Date(start + i * 60000).toISOString()
    trkpts.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><time>${t}</time></trkpt>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="trip-importer test data">
  <wpt lat="35.6895" lon="139.6917"><name>Shinjuku Gyoen</name><time>2026-09-01T09:00:00Z</time></wpt>
  <wpt lat="35.7100" lon="139.8107"><name>Skytree Viewpoint</name><time>2026-09-01T14:00:00Z</time></wpt>
  <trk>
    <name>Test walking track</name>
    <trkseg>
${trkpts.join('\n')}
    </trkseg>
  </trk>
</gpx>
`
}

function generateKml() {
  // Includes a revisited-location edge case (two placemarks, same coordinates, different
  // TimeStamp) — clusterByProximity()'s date-aware merge should keep these as two itinerary days.
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Fushimi Inari Shrine</name>
      <description>URL: https://maps.google.com/?cid=123<br>Notitie: Amazing at sunrise<br></description>
      <TimeStamp><when>2026-09-05</when></TimeStamp>
      <Point><coordinates>135.7727,34.9671,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Kyoto Station area</name>
      <TimeStamp><when>2026-09-05</when></TimeStamp>
      <Point><coordinates>135.7580,34.9858,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Kyoto Station area</name>
      <TimeStamp><when>2026-09-09</when></TimeStamp>
      <Point><coordinates>135.7580,34.9858,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Coastal hiking route</name>
      <LineString><coordinates>135.10,34.20,0 135.11,34.21,0 135.12,34.22,0</coordinates></LineString>
    </Placemark>
  </Document>
</kml>
`
}

// ── Google Maps Timeline ──────────────────────────────────────────────────────
function generateTimelineSemanticSegments() {
  const segs = []
  let t = new Date('2026-09-01T00:00:00Z').getTime()
  for (const city of CITIES.slice(0, 8)) {
    segs.push({
      startTime: new Date(t).toISOString(),
      visit: {
        startTime: new Date(t).toISOString(),
        topCandidate: {
          placeLocation: { latLng: `${city.lat}°, ${city.lon}°`.replace(/°/g, '') },
          semanticType: 'Inferred visit',
        },
      },
    })
    t += 2 * 24 * 3600 * 1000
  }
  return JSON.stringify({ semanticSegments: segs }, null, 2)
}

function generateTimelineOldFormat() {
  const objs = []
  let t = new Date('2026-09-01T00:00:00Z').getTime()
  for (const city of CITIES.slice(0, 6)) {
    objs.push({
      placeVisit: {
        location: { latitudeE7: Math.round(city.lat * 1e7), longitudeE7: Math.round(city.lon * 1e7), name: city.name },
        duration: { startTimestamp: new Date(t).toISOString(), endTimestamp: new Date(t + 3600000).toISOString() },
      },
    })
    t += 2 * 24 * 3600 * 1000
  }
  return JSON.stringify({ timelineObjects: objs }, null, 2)
}

// Raw `locations` array, large enough to exercise the client's sample-to-200 logic
// (parseGoogleTimelineClient()) — this is also the shape most likely to be many MB in a real
// export, which is why it's parsed/clustered entirely client-side rather than sent to the server.
function generateTimelineRawLocations(count) {
  const locs = []
  let t = new Date('2026-06-01T00:00:00Z').getTime()
  let lat = 55.6761, lon = 12.5683
  for (let i = 0; i < count; i++) {
    lat += rand(-0.01, 0.01)
    lon += rand(-0.01, 0.01)
    locs.push({ latitudeE7: Math.round(lat * 1e7), longitudeE7: Math.round(lon * 1e7), timestamp: new Date(t).toISOString() })
    t += 5 * 60000
  }
  return JSON.stringify({ locations: locs })
}

// ── Google Photos Takeout sidecars ────────────────────────────────────────────
function generateTakeoutSidecar(name, lat, lng, ts) {
  return JSON.stringify({
    title: name,
    geoData: { latitude: lat, longitude: lng, altitude: 0 },
    photoTakenTime: { timestamp: String(ts), formatted: new Date(ts * 1000).toISOString() },
  }, null, 2)
}

// ── Google Maps "Saved places" Takeout export (Collection mode) ──────────────
// Two known property-naming variants — see /parse-google-places' own comment on why both are
// tried. Neither has been verified against a real current export.
function generateSavedPlacesLowercase() {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.6917, 35.6895] },
        properties: { location: { name: 'Shinjuku Gyoen', address: 'Shinjuku, Tokyo, Japan', geo_coordinates: { latitude: 35.6895, longitude: 139.6917 } }, date: '2026-09-01T10:00:00Z' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [135.7727, 34.9671] },
        properties: { location: { name: 'Fushimi Inari Shrine', address: 'Fushimi Ward, Kyoto, Japan', geo_coordinates: { latitude: 34.9671, longitude: 135.7727 } }, date: '2026-09-05T06:00:00Z' },
      },
    ],
  }, null, 2)
}
function generateSavedPlacesCapitalized() {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [100.5018, 13.7563] },
        properties: { Location: { 'Business Name': 'Chatuchak Weekend Market', Address: 'Chatuchak, Bangkok, Thailand', 'Geo Coordinates': { Latitude: 13.7563, Longitude: 100.5018 } }, Published: '2026-09-20' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [98.3381, 7.9519] },
        properties: { Location: { 'Business Name': 'Patong Beach', Address: 'Patong, Phuket, Thailand', 'Geo Coordinates': { Latitude: 7.9519, Longitude: 98.3381 } } },
      },
    ],
  }, null, 2)
}
function generateSavedPlacesLarge(count) {
  const features = []
  for (let i = 0; i < count; i++) {
    const city = pick(CITIES)
    const lat = city.lat + rand(-0.3, 0.3), lng = city.lon + rand(-0.3, 0.3)
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { location: { name: `Saved place ${i} near ${city.name}`, address: `${city.name}, ${city.country}`, geo_coordinates: { latitude: lat, longitude: lng } } },
    })
  }
  return JSON.stringify({ type: 'FeatureCollection', features })
}

// ── Generic place-list CSV (Collection mode) ──────────────────────────────────
function generatePlacesCsv(count) {
  const rows = [['Name', 'Lat', 'Lng', 'Address', 'Notes', 'Date']]
  for (let i = 0; i < count; i++) {
    const city = pick(CITIES)
    const lat = (city.lat + rand(-0.2, 0.2)).toFixed(5)
    const lng = (city.lon + rand(-0.2, 0.2)).toFixed(5)
    rows.push([`Place ${i} near ${city.name}`, lat, lng, `${city.name}, ${city.country}`, i % 5 === 0 ? 'Must revisit!' : '', ''])
  }
  return rows.map(r => r.map(c => /,/.test(String(c)) ? `"${c}"` : c).join(',')).join('\n')
}

// ── Write files ────────────────────────────────────────────────────────────────
console.log(`\nGenerating test data in: ${OUT}\n`)

function writeFile(rel, content) {
  const outPath = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, content)
  const bytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content)
  const kb = (bytes / 1024).toFixed(1)
  console.log(`✓ ${rel.padEnd(34)} ${kb.padStart(8)} KB`)
  return outPath
}

console.log('── Polarsteps (bare JSON) ──')
const polarstepsSizes = [
  { file: 'trip.json', steps: STEPS, name: `Synthetic Long Trip (${STEPS} steps)`, opts: {},
    text: `Main stress test — ${Math.ceil(STEPS / 40)} expected /parse-polarsteps + /import rounds at the 40-step chunk size` },
  { file: 'trip_small.json', steps: 10, name: 'Synthetic Small Trip (10 steps)', opts: {},
    text: 'Control — small enough to import in one round, no chunking' },
  { file: 'trip_medium.json', steps: 50, name: 'Synthetic Medium Trip (50 steps)', opts: {},
    text: 'Just over the 40-step chunk size — needs exactly 2 rounds' },
  { file: 'trip_boundary.json', steps: 41, name: 'Synthetic Boundary Trip (41 steps)', opts: {},
    text: 'Exactly one step over the chunk boundary' },
  { file: 'trip_edge_cases.json', steps: 12, name: 'Synthetic Edge-Case Trip (12 steps)',
    opts: { revisit: true, longStay: true, midnightCrossing: true, noLocation: true, noName: true, noWeather: true, coverPhoto: true },
    text: 'Revisited location (same-day-set dedup), a 90-day step (tests 60-day itinerary cap), a timezone-midnight-crossing step (tests unixToDateInTz), null location/name/weather fields, and a cover photo URL' },
  { file: 'trip_sentinel_date.json', steps: 8, name: 'Synthetic Sentinel-Date Trip (8 steps)',
    opts: { sentinelEndDate: true },
    text: 'Trip-level end_date is a bad-data sentinel (2099-01-01) — /import\'s day-range computation must fall back to the 400-day sanity cap rather than trying to create tens of thousands of day rows' },
]
for (const { file, steps, name, opts, text } of polarstepsSizes) {
  const trip = generateTrip(steps, name, opts)
  const json = JSON.stringify(trip)
  writeFile(file, json)
  note(file, `${steps} steps. ${text}`)
}

// Bare multi-trip file: some Polarsteps export paths bundle "all my trips" as one JSON array of
// full trip objects rather than one file per trip — /parse-polarsteps must detect this shape.
const multiTrips = [generateTrip(6, 'Multi-Trip Bundle: Japan Leg'), generateTrip(5, 'Multi-Trip Bundle: Korea Leg')]
writeFile('trip_multi.json', JSON.stringify(multiTrips))
note('trip_multi.json', 'A bare JSON ARRAY of 2 full trip objects — some Polarsteps exports bundle multiple trips in one file with no ZIP wrapper')

console.log('\n── Polarsteps ZIP export ──')
{
  const zipTrip = generateTrip(5, 'Synthetic ZIP Export Trip (5 steps)')
  const zipTripJson = JSON.stringify(zipTrip)
  const nestedTrip = generateTrip(3, 'Nested ZIP Trip (3 steps)')
  const entries = [
    { name: 'trip.json', data: Buffer.from(zipTripJson, 'utf8') },
    // Step-photo folder naming convention: "<slug>_<stepId>/photos/*"
    { name: `synthetic-zip-export-trip-5-steps_${zipTrip.all_steps[0].id}/photos/photo1.jpg`, data: FAKE_JPEG },
    { name: `synthetic-zip-export-trip-5-steps_${zipTrip.all_steps[0].id}/photos/photo2.jpg`, data: FAKE_JPEG },
    // A Google Timeline export bundled inside the same ZIP — extractZipEntries() matches
    // location-history.json/Records.json by filename anywhere in the archive, not just at the root.
    { name: 'extras/location-history.json', data: Buffer.from(generateTimelineOldFormat(), 'utf8') },
    // One level of nested ZIP (a ZIP inside the ZIP) — extractZipEntries() recurses up to depth 3.
    { name: 'nested/another-export.zip', data: makeZip([{ name: 'trip.json', data: Buffer.from(JSON.stringify(nestedTrip), 'utf8') }]) },
  ]
  writeFile('polarsteps-export.zip', makeZip(entries))
  note('polarsteps-export.zip', 'Real ZIP: trip.json + a step-photo folder matching the "<slug>_<stepId>/photos/*" convention + a bundled Google Timeline JSON + one level of nested ZIP (recursive extraction)')
}

console.log('\n── Bookings (text / .eml / .ics) ──')
writeFile('bookings.txt', generateBookings())
note('bookings.txt', '5 mixed booking confirmations (flight/hotel/bus/flight/transfer) — regex extraction')
writeFile('bookings_large.txt', generateBookingsLarge(80))
note('bookings_large.txt', '80 flight confirmations concatenated in one file — exercises the client-side ~60KB booking-text chunk windowing added to /parse-bookings')
writeFile('rail-tickets.txt', generateRailTickets())
note('rail-tickets.txt', 'SJ/Resplus-style multi-leg rail e-ticket text — exercises the dedicated structured rail detector + duplicate-leg dedup')
writeFile('booking.eml', generateEml())
note('booking.eml', 'MIME email, quoted-printable HTML body — exercises extractEmlText() MIME decoding')
writeFile('bookings.ics', generateIcs())
note('bookings.ics', 'iCalendar export with a flight + hotel-stay VEVENT — exercises /parse-ics')

console.log('\n── Expenses (CSV) ──')
writeFile('expenses.csv', generateExpenses(30))
note('expenses.csv', '30 rows, mixed JPY/THB/EUR/DKK/USD currencies and auto-detected categories')
writeFile('expenses_localized.csv', generateExpensesLocalized())
note('expenses_localized.csv', 'European decimal-comma formats ("1 978,00", "20,00") mixed with US/UK formats — exercises parseLocalizedNumber()')
writeFile('expenses_large.csv', generateExpenses(3000, { startDate: '2026-01-01' }))
note('expenses_large.csv', '3000 rows, comfortably over 60KB — exercises the client-side chunkCsvRows() windowing added to /parse-csv')

console.log('\n── GPX / KML / KMZ ──')
writeFile('track.gpx', generateGpx(40))
note('track.gpx', '40 trackpoints + 2 named waypoints')
writeFile('track_large.gpx', generateGpx(3000))
note('track_large.gpx', '3000 trackpoints — exercises the client-side trkpt sampling (max 500) and clustering pipeline')
writeFile('places.kml', generateKml())
note('places.kml', 'Placemarks incl. an HTML <description> (URL/Notitie/<br> stripping), a revisited location on two different dates, and a LineString (route) placemark')
{
  const kmlBuf = Buffer.from(generateKml(), 'utf8')
  writeFile('places.kmz', makeZip([{ name: 'doc.kml', data: kmlBuf }]))
  note('places.kmz', 'Same placemarks as places.kml, zipped as a real KMZ')
}

console.log('\n── Google Maps Timeline ──')
writeFile('location-history.json', generateTimelineSemanticSegments())
note('location-history.json', 'New-format (2024+) semanticSegments/placeVisit shape')
writeFile('Records.json', generateTimelineOldFormat())
note('Records.json', 'Old-format timelineObjects/placeVisit shape')
writeFile('timeline_raw_locations.json', generateTimelineRawLocations(6000))
note('timeline_raw_locations.json', 'Raw `locations` array, 6000 points — likely several MB in a real export; exercises client-side JSON.parse + sample-to-200 + clustering entirely in-browser (never sent to the server whole)')

console.log('\n── Google Photos Takeout sidecars ──')
{
  const sidecars = [
    ['IMG_0001.jpg.json', 35.6895, 139.6917, Math.floor(new Date('2026-09-01T10:00:00Z').getTime() / 1000)],
    ['IMG_0002.jpg.json', 34.9671, 135.7727, Math.floor(new Date('2026-09-05T06:00:00Z').getTime() / 1000)],
    ['IMG_0003.jpg.json', 13.7563, 100.5018, Math.floor(new Date('2026-09-20T12:00:00Z').getTime() / 1000)],
  ]
  for (const [name, lat, lng, ts] of sidecars) {
    writeFile(path.join('takeout-sidecars', name), generateTakeoutSidecar(name.replace(/\.json$/, ''), lat, lng, ts))
  }
  note('takeout-sidecars/*.jpg.json', 'Google Photos Takeout per-photo sidecars (photoTakenTime + geoData) — sidecar data wins over EXIF when a matching photo is also present; sidecars alone are enough to test detection/parsing')
}

console.log('\n── Collection mode: Google Saved Places / place-list CSV ──')
writeFile('google-saved-places-lowercase.json', generateSavedPlacesLowercase())
note('google-saved-places-lowercase.json', 'Takeout GeoJSON, lowercase properties.location.{name,address,geo_coordinates} variant')
writeFile('google-saved-places-capitalized.json', generateSavedPlacesCapitalized())
note('google-saved-places-capitalized.json', 'Takeout GeoJSON, capitalized properties.Location["Business Name"/"Address"/"Geo Coordinates"] variant')
writeFile('google-saved-places-large.json', generateSavedPlacesLarge(1200))
note('google-saved-places-large.json', '1200 features — exercises the client-side FeatureCollection chunking added to /parse-google-places')
writeFile('places.csv', generatePlacesCsv(25))
note('places.csv', 'Generic place-list CSV for Collection mode (name/lat/lng/address/notes/date fuzzy header matching)')
writeFile('places_large.csv', generatePlacesCsv(2500))
note('places_large.csv', '2500 rows — exercises the client-side chunkCsvRows() windowing added to /parse-places-csv')

console.log(`
Manifest — what each file exercises:
`)
for (const { file, text } of manifest) console.log(`  ${file}\n    ${text}\n`)

console.log(`How to use:
  1. Open Trip Importer in TREK (Trip mode) and drop the Polarsteps files, bookings/.eml/.ics,
     expense CSVs, GPX/KML/KMZ, and Google Timeline JSON together (or in separate runs).
  2. Switch to "Import into a Collection" mode and drop the google-saved-places-*.json / places*.csv
     files separately — those are Collection-mode-only sources.
  3. trip.json (${STEPS} steps) is the main chunking stress test; trip_boundary.json (41 steps) tests
     the exact chunk-size boundary; trip_small.json (10 steps) is the control (no chunking needed).
  4. trip_edge_cases.json and trip_sentinel_date.json specifically target known-tricky code paths
     (see the manifest above) rather than raw size.
  5. The *_large.* files (bookings_large.txt, expenses_large.csv, track_large.gpx,
     timeline_raw_locations.json, google-saved-places-large.json, places_large.csv) are sized to
     land well over TREK's confirmed ~100KB plugin-route body limit if sent whole — they should
     import successfully now that each source is windowed/clustered client-side; if any of them
     ever 413s again, that's a regression in that source's chunking.

Chunk size: 40 Polarsteps steps / ~60KB per request for text-ish sources.
Expected rounds for ${STEPS}-step trip.json: ${Math.ceil(STEPS / 40)} rounds.
`)

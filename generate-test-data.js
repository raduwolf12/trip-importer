#!/usr/bin/env node
/**
 * generate-test-data.js
 * Generates sample Polarsteps trip.json files and a booking text file
 * to stress-test the Trip Importer's chunked import path.
 *
 * Usage:
 *   node generate-test-data.js [--steps N] [--out ./test-data]
 *
 * Defaults: 300 steps (the exact size that triggered the 413), output to ./test-data/
 *
 * Outputs:
 *   test-data/trip.json            — Polarsteps export (N steps)
 *   test-data/trip_small.json      — 10 steps (control, should work without chunking)
 *   test-data/trip_medium.json     — 50 steps (boundary case, just over the 40-step chunk size)
 *   test-data/bookings.txt         — 5 mixed booking confirmations (flight + hotel + bus)
 *   test-data/expenses.csv         — 30 expense rows
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

const CITIES = [
  { name: 'Tokyo', country: 'JP', lat: 35.6762, lon: 139.6503 },
  { name: 'Kyoto', country: 'JP', lat: 35.0116, lon: 135.7681 },
  { name: 'Osaka', country: 'JP', lat: 34.6937, lon: 135.5023 },
  { name: 'Hiroshima', country: 'JP', lat: 34.3853, lon: 132.4553 },
  { name: 'Nara', country: 'JP', lat: 34.6851, lon: 135.8050 },
  { name: 'Sapporo', country: 'JP', lat: 43.0642, lon: 141.3469 },
  { name: 'Bangkok', country: 'TH', lat: 13.7563, lon: 100.5018 },
  { name: 'Chiang Mai', country: 'TH', lat: 18.7883, lon: 98.9853 },
  { name: 'Phuket', country: 'TH', lat: 7.9519, lon: 98.3381 },
  { name: 'Hanoi', country: 'VN', lat: 21.0278, lon: 105.8342 },
  { name: 'Ho Chi Minh City', country: 'VN', lat: 10.8231, lon: 106.6297 },
  { name: 'Hoi An', country: 'VN', lat: 15.8801, lon: 108.3380 },
  { name: 'Seoul', country: 'KR', lat: 37.5665, lon: 126.9780 },
  { name: 'Busan', country: 'KR', lat: 35.1796, lon: 129.0756 },
  { name: 'Singapore', country: 'SG', lat: 1.3521, lon: 103.8198 },
  { name: 'Copenhagen', country: 'DK', lat: 55.6761, lon: 12.5683 },
  { name: 'Stockholm', country: 'SE', lat: 59.3293, lon: 18.0686 },
  { name: 'Berlin', country: 'DE', lat: 52.5200, lon: 13.4050 },
  { name: 'Prague', country: 'CZ', lat: 50.0755, lon: 14.4378 },
  { name: 'Vienna', country: 'AT', lat: 48.2082, lon: 16.3738 },
  { name: 'Budapest', country: 'HU', lat: 47.4979, lon: 19.0402 },
  { name: 'Bucharest', country: 'RO', lat: 44.4268, lon: 26.1025 },
  { name: 'Lisbon', country: 'PT', lat: 38.7223, lon: -9.1393 },
  { name: 'Barcelona', country: 'ES', lat: 41.3851, lon: 2.1734 },
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

// ── Generate a Polarsteps trip.json ──────────────────────────────────────────
function generateTrip(stepCount, tripName) {
  const startTs = Math.floor(new Date('2026-03-01').getTime() / 1000)
  const endTs = startTs + stepCount * 2 * 24 * 3600 // ~2 days per stop
  const tripUuid = uuid()

  const steps = []
  let currentTs = startTs
  let cityIndex = 0

  for (let i = 0; i < stepCount; i++) {
    // Cycle through cities, staying 1–4 days per stop
    const city = CITIES[cityIndex % CITIES.length]
    if (i > 0 && randInt(0, 2) === 0) cityIndex++ // occasionally move to next city

    const stayDays = randInt(1, 4)
    const stepStart = currentTs
    const stepEnd = currentTs + stayDays * 24 * 3600
    currentTs = stepEnd + randInt(0, 6) * 3600 // 0–6h gap between stops

    // Add small GPS jitter so nearby stops within same city aren't identical coords
    const lat = city.lat + rand(-0.05, 0.05)
    const lon = city.lon + rand(-0.05, 0.05)

    const hasWeather = Math.random() > 0.3
    const hasLocation = Math.random() > 0.1

    steps.push({
      id: 100000 + i,
      uuid: uuid(),
      name: i % 7 === 0 ? null : `${city.name} — Day ${i + 1}`, // some steps have null name
      display_name: `${city.name}`,
      description: pick(DESCRIPTIONS),
      start_time: stepStart,
      end_time: stepEnd,
      creation_time: stepStart,
      timezone_id: city.country === 'JP' ? 'Asia/Tokyo'
        : city.country === 'TH' ? 'Asia/Bangkok'
        : city.country === 'VN' ? 'Asia/Ho_Chi_Minh'
        : city.country === 'KR' ? 'Asia/Seoul'
        : city.country === 'SG' ? 'Asia/Singapore'
        : city.country === 'DK' ? 'Europe/Copenhagen'
        : city.country === 'SE' ? 'Europe/Stockholm'
        : city.country === 'DE' ? 'Europe/Berlin'
        : 'Europe/London',
      weather_condition: hasWeather ? pick(WEATHER) : null,
      weather_temperature: hasWeather ? randInt(10, 35) : null,
      main_media_item_path: Math.random() > 0.7 ? `https://example.com/photos/step${i}.jpg` : null,
      location: hasLocation ? {
        id: 200000 + i,
        name: `${city.name} City Centre`,
        full_detail: `${city.name}, ${city.country}`,
        lat,
        lon,
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
    end_date: Math.min(endTs, startTs + 365 * 86400),
    total_km: randInt(2000, 15000),
    all_steps: steps,
  }
}

// ── Generate bookings.txt ─────────────────────────────────────────────────────
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

// ── Generate expenses.csv ─────────────────────────────────────────────────────
function generateExpenses(count) {
  const categories = ['food', 'transport', 'accommodation', 'activities', 'shopping', 'other']
  const merchants = [
    ['Ramen Ichiraku', 'food'],
    ['7-Eleven Japan', 'food'],
    ['Conveyor Belt Sushi', 'food'],
    ['JR Pass Activation', 'transport'],
    ['Shinkansen CPH→OSK', 'transport'],
    ['Uber', 'transport'],
    ['Bangkok BTS Skytrain', 'transport'],
    ['FlixBus ticket', 'transport'],
    ['Hotel Gracery Shinjuku', 'accommodation'],
    ['Airbnb Kyoto machiya', 'accommodation'],
    ['Guest House Bangkok', 'accommodation'],
    ['Tokyo National Museum', 'activities'],
    ['Fushimi Inari entry', 'activities'],
    ['Snorkeling tour Phuket', 'activities'],
    ['Cooking class', 'activities'],
    ['Uniqlo', 'shopping'],
    ['Tokyu Hands', 'shopping'],
    ['Chatuchak Market', 'shopping'],
    ['Pharmacy', 'other'],
    ['ATM fee', 'other'],
    ['Travel insurance', 'other'],
    ['SIM card', 'other'],
  ]

  const currencies = ['JPY', 'JPY', 'JPY', 'THB', 'THB', 'EUR', 'EUR', 'DKK', 'USD']
  const rows = [['Date', 'Name', 'Amount', 'Currency', 'Category']]

  let currentDate = new Date('2026-09-14')
  for (let i = 0; i < count; i++) {
    // Advance date every 1–3 rows
    if (i > 0 && randInt(0, 2) === 0) currentDate.setDate(currentDate.getDate() + randInt(1, 3))

    const [merchant, cat] = pick(merchants)
    const currency = pick(currencies)
    let amount
    if (currency === 'JPY') amount = randInt(300, 8000)
    else if (currency === 'THB') amount = randInt(80, 1200)
    else if (currency === 'DKK') amount = randInt(50, 800)
    else amount = parseFloat(rand(3, 120).toFixed(2))

    rows.push([
      currentDate.toISOString().slice(0, 10),
      merchant,
      amount,
      currency,
      cat,
    ])
  }

  return rows.map(r => r.join(',')).join('\n')
}

// ── Write files ────────────────────────────────────────────────────────────────
const sizes = [
  { file: 'trip.json', steps: STEPS, name: `Synthetic Long Trip (${STEPS} steps)` },
  { file: 'trip_small.json', steps: 10, name: 'Synthetic Small Trip (10 steps)' },
  { file: 'trip_medium.json', steps: 50, name: 'Synthetic Medium Trip (50 steps)' },
  { file: 'trip_boundary.json', steps: 41, name: 'Synthetic Boundary Trip (41 steps — just over chunk size)' },
]

console.log(`\nGenerating test data in: ${OUT}\n`)

for (const { file, steps, name } of sizes) {
  const trip = generateTrip(steps, name)
  const outPath = path.join(OUT, file)
  const json = JSON.stringify(trip)
  fs.writeFileSync(outPath, json)
  const kb = (json.length / 1024).toFixed(1)
  console.log(`✓ ${file.padEnd(22)} ${steps.toString().padStart(4)} steps  ${kb.padStart(7)} KB`)
}

const bookingsPath = path.join(OUT, 'bookings.txt')
fs.writeFileSync(bookingsPath, generateBookings())
console.log(`✓ bookings.txt         5 mixed booking confirmations`)

const expensesPath = path.join(OUT, 'expenses.csv')
fs.writeFileSync(expensesPath, generateExpenses(30))
console.log(`✓ expenses.csv         30 expense rows`)

console.log(`
How to use:
  1. Open Trip Importer in TREK
  2. Drop trip.json (300 steps) — this is the main stress test
  3. Also drop bookings.txt and expenses.csv for full coverage
  4. Compare against trip_small.json (10 steps) which should work without chunking
  5. trip_boundary.json (41 steps) tests the exact boundary where chunking kicks in

Chunk size: 40 steps per request
Expected rounds for ${STEPS} steps: ${Math.ceil(STEPS / 40)} rounds
`)
'use strict'
// Regression tests for server/index.js parsers. Each case pins a bug that actually shipped
// (see CLAUDE.md). Run: npm test
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const loadServer = require('./load-server')

const { fn, call } = loadServer()

// Fixtures come from the project's own generator, written to a throwaway dir.
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-importer-test-'))
execFileSync(process.execPath, [path.join(__dirname, '..', 'generate-test-data.js'),
  '--scenario', 'bookings,expenses,polarsteps-basic', '--out', FIX], { stdio: 'ignore' })
const fixture = rel => fs.readFileSync(path.join(FIX, rel), 'utf8')
test.after(() => fs.rmSync(FIX, { recursive: true, force: true }))

test('parseLocalizedNumber: European and US/UK formats', () => {
  assert.equal(fn.parseLocalizedNumber('1 978,00'), 1978)
  assert.equal(fn.parseLocalizedNumber('20,00'), 20) // was 2000
  assert.equal(fn.parseLocalizedNumber('20.5'), 20.5) // was 205
  assert.equal(fn.parseLocalizedNumber('1.234,56'), 1234.56)
  assert.equal(fn.parseLocalizedNumber('1,234.56'), 1234.56)
  assert.equal(fn.parseLocalizedNumber('1.234'), 1234)
})

test('normalizeDateStr: always ISO or null, never a raw string', () => {
  assert.equal(fn.normalizeDateStr('2026-07-16'), '2026-07-16')
  assert.equal(fn.normalizeDateStr('2026-07-16T10:00:00Z'), '2026-07-16')
  assert.equal(fn.normalizeDateStr('16/07/2026'), '2026-07-16')
  assert.equal(fn.normalizeDateStr('16.7.26'), '2026-07-16')
  assert.equal(fn.normalizeDateStr('2026/7/6'), '2026-07-06')
  assert.equal(fn.normalizeDateStr('13/13/2026'), null)
  assert.equal(fn.normalizeDateStr('unknown'), null)
  assert.equal(fn.normalizeDateStr(''), null)
})

test('unixToDateInTz: a late-night local step lands on its local calendar day', () => {
  const ts = Date.UTC(2026, 6, 16, 17, 30) / 1000 // 2026-07-17 01:30 in Shanghai
  assert.equal(fn.unixToDate(ts), '2026-07-16')
  assert.equal(fn.unixToDateInTz(ts, 'Asia/Shanghai'), '2026-07-17')
  assert.equal(fn.unixToDateInTz(ts, 'Not/AZone'), '2026-07-16') // invalid tz falls back to UTC
})

test('clusterByProximity: merges nearby same-day points, keeps revisits on other days apart', () => {
  const hotel = { lat: 55.6761, lng: 12.5683 }
  const near = { lat: 55.6765, lng: 12.5690 } // ~60m away
  const c = fn.clusterByProximity([
    { ...hotel, date: null },
    { ...near, date: '2026-07-16' },
    { ...hotel, date: '2026-07-18' },
    { lat: 55.70, lng: 12.60, date: '2026-07-16' }, // ~4km away
  ])
  assert.equal(c.length, 3)
  assert.equal(c[0].date, '2026-07-16') // dateless first member adopts a later member's date
  assert.equal(c[0].members.length, 2)
  assert.equal(c[1].date, '2026-07-18') // revisit stays its own place
})

test('/parse-csv: localized amounts in a quoted comma CSV', async () => {
  const { expenses } = await call('/parse-csv', { text: fixture('expenses/expenses_localized.csv') })
  assert.deepEqual(expenses.map(e => [e.amount, e.currency]), [
    [1978, 'DKK'], [20, 'DKK'], [1234.56, 'EUR'], [1234.56, 'USD'], [978, 'USD'], [20.5, 'USD'],
  ])
  assert.ok(expenses.every(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date)))
})

test('/parse-csv: semicolon CSV keeps decimal commas intact', async () => {
  const { expenses } = await call('/parse-csv', { text: 'Datum;Name;Amount;Currency\n16/07/2026;Lunch;20,00;DKK\n17/07/2026;Hotel;1 978,50;SEK\n' })
  assert.deepEqual(expenses.map(e => [e.date, e.amount, e.currency]), [
    ['2026-07-16', 20, 'DKK'], ['2026-07-17', 1978.5, 'SEK'],
  ])
})

test('/parse-csv: edge cases (refund, empty currency, empty amount) do not crash', async () => {
  const { expenses, error } = await call('/parse-csv', { text: fixture('expenses/expenses_edge_cases.csv') })
  assert.equal(error, undefined)
  assert.ok(expenses.length > 0)
  assert.ok(expenses.every(e => e.amount > 0 && Number.isFinite(e.amount)))
})

test('/parse-places-csv: semicolon CSV with decimal-comma coordinates', async () => {
  const { places } = await call('/parse-places-csv', { text: 'Name;Lat;Lng\nNyhavn;55,6798;12,5907\n' })
  assert.equal(places.length, 1)
  assert.equal(places[0].lat, 55.6798)
  assert.equal(places[0].lng, 12.5907)
})

test('/parse-bookings: multi-leg Swedish rail ticket, one booking per unique leg', async () => {
  const { bookings } = await call('/parse-bookings', { text: fixture('bookings/rail-tickets.txt') })
  const legs = bookings.filter(b => b.type === 'train')
  assert.equal(legs.length, 2) // the repeated co-traveller leg is deduped
  assert.deepEqual(legs.map(b => b.from_date).sort(), ['2026-07-17', '2026-07-18'])
})

// booking_no_currency.txt is left out: it's a walking tour, which the regex extractor has no type
// for (AI-assist territory); that fixture exists for /import's currency fallback, not detection.
test('/parse-bookings: generic booking fixtures each yield at least one booking', async () => {
  for (const f of ['bookings.txt', 'booking.eml', 'booking_loose_route.txt']) {
    const { bookings, error } = await call('/parse-bookings', { text: fixture('bookings/' + f) })
    assert.equal(error, undefined, f)
    assert.ok(bookings.length > 0, f + ' produced no bookings')
  }
})

test('/parse-bookings: operator-less bus route uses the loose route fallback', async () => {
  const { bookings } = await call('/parse-bookings', { text: fixture('bookings/booking_loose_route.txt') })
  assert.equal(bookings[0].type, 'bus')
  assert.equal(bookings[0].from, 'Prague Florenc')
  assert.equal(bookings[0].to, 'Cesky Krumlov')
  assert.equal(bookings[0].price, 12.5)
})

test('/parse-bookings: a passing "bus" mention without a route invents nothing', async () => {
  const { bookings } = await call('/parse-bookings', { text: 'Hotel Aurora confirmation. Free airport bus every 30 minutes from the terminal.' })
  assert.ok(!bookings.some(b => b.type === 'bus'))
})

test('/parse-polarsteps: full trip.json and chunked steps agree', async () => {
  const dir = path.join(FIX, 'polarsteps-basic')
  const file = fs.readdirSync(dir).find(f => f.endsWith('.json'))
  const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
  const trip = Array.isArray(json) ? json[0] : json
  const full = await call('/parse-polarsteps', { json })
  assert.equal(full.error, undefined)
  assert.equal(full.steps.length, trip.all_steps.length)
  assert.ok(full.steps.every(s => s.date === null || /^\d{4}-\d{2}-\d{2}$/.test(s.date)))
  const chunk = await call('/parse-polarsteps', { stepsChunk: trip.all_steps.slice(1), stepsChunkOffset: 1 })
  assert.deepEqual(chunk.steps, full.steps.slice(1)) // "Stop N" numbering stays global
})

'use strict'
// Smoke tests for /import's resumable, paginated loop: a fake ctx records every call, and
// runImport() replays the client's round loop (importOneTarget() in client/index.html) with the
// same windowing rules. Pins the regressions CLAUDE.md lists: the stepOffset ReferenceError,
// the journal-only indexing bug, the day-range "fallback instead of extend" revert, a journey
// re-created per round, and items re-processed (duplicated) after a resume.
const test = require('node:test')
const assert = require('node:assert/strict')
const loadServer = require('./load-server')

const { call } = loadServer({
  fakeClock: true,
  fetch: async () => ({ ok: true, json: async () => ({ address: { city: 'Testville' } }) }),
})

function fakeCtx() {
  let nextId = 1
  const calls = []
  const days = {} // tripId -> [{id, date}]
  const rec = (name, ret) => async (...args) => { calls.push({ name, args }); return typeof ret === 'function' ? ret(...args) : ret }
  const newId = () => ({ id: nextId++ })
  const ctx = {
    log: { info() {}, warn() {}, error() {} },
    trips: {
      create: rec('trips.create', newId),
      getDays: rec('trips.getDays', t => (days[t] || []).slice()),
      getById: rec('trips.getById', {}),
      listMine: rec('trips.listMine', []),
      update: rec('trips.update', {}),
    },
    days: { create: rec('days.create', (t, { date }) => { const d = { id: nextId++, date }; (days[t] = days[t] || []).push(d); return d }) },
    journal: { createJourney: rec('journal.createJourney', newId), createEntry: rec('journal.createEntry', newId) },
    places: { create: rec('places.create', newId) },
    itinerary: { assign: rec('itinerary.assign', {}) },
    daynotes: { create: rec('daynotes.create', newId) },
    reservations: { create: rec('reservations.create', newId) },
    accommodations: { create: rec('accommodations.create', newId) },
    costs: { create: rec('costs.create', newId) },
    meta: { get: rec('meta.get', undefined), set: rec('meta.set', {}) },
  }
  const of = name => calls.filter(c => c.name === name)
  const dayDate = id => Object.values(days).flat().find(d => d.id === id)?.date
  return { ctx, calls, of, dayDate }
}

// Mirrors importOneTarget()'s round loop: windows each source larger than PER_ROUND from the
// returned progress index, switches to {mode:'existing'} after round 1, stops on progress.done.
async function runImport(ctx, target, options, PER_ROUND = 3, STEPS_PER_ROUND = PER_ROUND) {
  const allSteps = target.polarsteps?.steps || []
  const meta = target.polarsteps ? { ...target.polarsteps, steps: [] } : undefined
  const win = (all, off) => all.length > PER_ROUND ? all.slice(off, off + PER_ROUND) : all
  let tripConfig = target.tripConfig
  let progress, result, rounds = 0
  const allErrors = []
  do {
    if (++rounds > 50) throw new Error('import never finished')
    const body = {
      tripConfig, progress, options,
      totalBookings: (target.bookings || []).length,
      totalExpenses: (target.expenses || []).length,
      totalPlaces: (target.places || []).length,
      bookings: win(target.bookings || [], progress?.bookings || 0), bookingsOffset: progress?.bookings || 0,
      expenses: win(target.expenses || [], progress?.costs || 0), expensesOffset: progress?.costs || 0,
      places: win(target.places || [], progress?.places || 0), placesOffset: progress?.places || 0,
    }
    if (meta) {
      const off = progress?.journal || 0
      body.polarsteps = allSteps.length > STEPS_PER_ROUND
        ? { ...meta, steps: allSteps.slice(off, off + STEPS_PER_ROUND), _stepOffset: off, _totalSteps: allSteps.length }
        : target.polarsteps
    }
    result = await call('/import', body, ctx)
    assert.equal(result.error, undefined, 'round ' + rounds + ': ' + result.error)
    allErrors.push(...(result.errors || []))
    progress = result.progress
    if (result.tripId) tripConfig = { mode: 'existing', tripId: result.tripId }
  } while (!progress.done)
  return { result, rounds, errors: allErrors }
}

// No comma in the location name, so every step place is reverse-geocoded (~1.2s simulated each):
// with 6 steps per window the 6s budget runs out mid-window, exercising the budget-break resume.
const step = (n, date, extra) => ({
  id: 's' + n, name: 'Stop ' + n, description: 'Story ' + n, date,
  location: { name: 'Place ' + n, lat: 55 + n / 10, lon: 12 + n / 10 }, ...extra,
})

test('/import: paginated Polarsteps trip with every source, resumed over many rounds', async () => {
  const f = fakeCtx()
  const target = {
    tripConfig: { mode: 'new', title: 'Test trip' },
    polarsteps: {
      name: 'Test trip', startDate: '2026-07-10', endDate: '2026-07-16', uuid: 'u-1', summary: 'Overview',
      steps: [
        step(1, '2026-07-10'), step(2, '2026-07-11'), step(3, '2026-07-12', { endDate: '2026-07-14' }),
        step(4, '2026-07-14'), step(5, '2026-07-15'), step(6, '2026-07-15'), step(7, '2026-07-16'),
      ],
    },
    // Pre-clustered by the client (computeTargetPlaces); nameless, so each is reverse-geocoded.
    places: [{ lat: 56.5, lng: 13.5, date: '2026-07-13' }, { lat: 57, lng: 14, date: '2026-07-16' }],
    bookings: [
      { type: 'train', title: 'SJ 442', from: 'Stockholm', to: 'Göteborg', from_date: '2026-07-12', from_time: '08:12', price: 300, currency: 'SEK' },
      { type: 'hotel', title: 'Hotel Aurora', operator: 'Hotel Aurora', from_date: '2026-07-11', to_date: '2026-07-13' },
    ],
    // 2026-07-18 is outside the Polarsteps window: a day row must still be created for it.
    expenses: [
      { name: 'Lunch', amount: 20, currency: 'DKK', date: '2026-07-10', category: 'food' },
      { name: 'Taxi', amount: 15, date: '2026-07-11', category: 'transport' },
      { name: 'Souvenir', amount: 9, currency: 'SEK', date: '2026-07-18', category: 'shopping' },
      { name: 'Museum', amount: 12, currency: 'SEK', date: '2026-07-16', category: 'activities' },
    ],
  }
  const options = { importJournal: true, importPlaces: true, importDayNotes: true, importBookings: true, importCosts: true, defaultCurrency: 'EUR' }
  const { result, rounds, errors } = await runImport(f.ctx, target, options, 3, 6)

  assert.deepEqual(errors, [])
  assert.ok(rounds > 2, 'expected several resumed rounds, got ' + rounds)
  assert.equal(f.of('trips.create').length, 1)
  assert.equal(f.of('journal.createJourney').length, 1, 'journey must be created once, not per round')

  // Day rows: 07-10..07-18 (extended past the Polarsteps end for the expense), no duplicates.
  const dayDates = f.of('days.create').map(c => c.args[1].date)
  assert.equal(new Set(dayDates).size, dayDates.length)
  assert.equal(dayDates[0], '2026-07-10')
  assert.equal(dayDates[dayDates.length - 1], '2026-07-18')
  assert.equal(dayDates.length, 9)

  // Every step processed exactly once despite pagination + budget breaks.
  const entryTitles = f.of('journal.createEntry').map(c => c.args[1].title)
  assert.deepEqual(entryTitles, ['Trip overview', ...target.polarsteps.steps.map(s => s.name)])
  assert.equal(Object.keys(result.progress.stepPlaceIds).length, 7)
  assert.equal(Object.keys(result.progress.stepEntryIds).length, 7)
  assert.equal(f.of('daynotes.create').length, 7)

  // 7 step places + 2 GPS places + 1 hotel place, each created once.
  const placeNames = f.of('places.create').map(c => c.args[1].name)
  assert.equal(placeNames.length, 10)
  assert.equal(placeNames.filter(n => n === 'Testville').length, 9) // geocoded steps + GPS places

  // Every step and GPS place lands on its day; the multi-day step covers 07-12..07-14.
  const assigned = f.of('itinerary.assign').map(c => [c.args[2], f.dayDate(c.args[1])])
  const datesFor = placeId => assigned.filter(a => a[0] === placeId).map(a => a[1])
  assert.deepEqual(datesFor(result.progress.stepPlaceIds.s3), ['2026-07-12', '2026-07-13', '2026-07-14'])
  for (const s of target.polarsteps.steps) assert.ok(datesFor(result.progress.stepPlaceIds[s.id]).includes(s.date), s.id)
  assert.ok(assigned.some(a => a[1] === '2026-07-13' && !Object.values(result.progress.stepPlaceIds).includes(a[0])))

  assert.equal(f.of('reservations.create').length, 1)
  assert.equal(f.of('accommodations.create').length, 1)
  const costs = f.of('costs.create').map(c => c.args[1])
  assert.equal(costs.length, 4)
  assert.equal(costs.find(c => c.name === 'Taxi').currency, 'EUR') // defaultCurrency fallback

  const refIds = result.progress.createdRefs.map(r => r.type + r.id)
  assert.equal(new Set(refIds).size, refIds.length)
  assert.equal(result.progress.journal, 7)
})

test('/import: day rows finish (retrying a rate-limited day) before any step is assigned', async () => {
  // A host rate-limit error stops day creation early with budget left over. Steps must still
  // wait for the remaining days, or the late-dated step finds no day row and is never
  // reassigned; and the rate-limited day itself must be retried, not skipped.
  const f = fakeCtx()
  const createDay = f.ctx.days.create
  let failed = false
  f.ctx.days.create = async (...a) => {
    if (!failed && a[1].date === '2026-02-19') { failed = true; throw new Error('rate limit exceeded') }
    return createDay(...a)
  }
  const steps = [step(1, '2026-01-01'), step(2, '2026-04-30')]
  const { result, rounds } = await runImport(f.ctx,
    { tripConfig: { mode: 'new', title: 'Long' }, polarsteps: { name: 'Long', startDate: '2026-01-01', endDate: '2026-04-30', steps } },
    { importPlaces: true })
  assert.ok(rounds > 1)
  assert.equal(f.of('days.create').length, 120)
  const lastPlace = result.progress.stepPlaceIds.s2
  assert.ok(f.of('itinerary.assign').some(c => c.args[2] === lastPlace && f.dayDate(c.args[1]) === '2026-04-30'))
})

test('/import: journal-only mode, paginated, creates no trip', async () => {
  const f = fakeCtx()
  const steps = [1, 2, 3, 4, 5].map(n => step(n, '2026-08-0' + n))
  const { result } = await runImport(f.ctx,
    { tripConfig: { mode: 'new' }, polarsteps: { name: 'Story', startDate: '2026-08-01', steps } },
    { journalOnly: true, importJournal: true }, 2)
  assert.equal(result.tripId, null)
  assert.equal(f.of('trips.create').length, 0)
  assert.equal(f.of('days.create').length, 0)
  assert.equal(f.of('journal.createJourney').length, 1)
  assert.deepEqual(f.of('journal.createEntry').map(c => c.args[1].title), steps.map(s => s.name))
})

test('/import: journal-only with nothing to import still finishes', async () => {
  const f = fakeCtx()
  const { rounds } = await runImport(f.ctx, { tripConfig: { mode: 'new' } }, { journalOnly: true })
  assert.equal(rounds, 1)
})

test('/import: Polarsteps cover is set by its https URL, never downloaded (#16)', async () => {
  const cover = 'https://media.prod.polarsteps.com/u_1/cover.jpg'
  let fetched = 0
  const s = loadServer({ fakeClock: true, fetch: async () => { fetched++; throw new Error('no network in tests') } })
  const f = fakeCtx()
  const r = await s.call('/import', {
    tripConfig: { mode: 'new', title: 'T' },
    polarsteps: { name: 'T', startDate: '2026-07-01', endDate: '2026-07-01', coverPhotoUrl: cover, steps: [] },
    options: {},
  }, f.ctx)
  assert.deepEqual(f.of('trips.update').map(c => c.args[1].cover_image), [cover]) // vm-realm objects: compare values
  assert.equal(fetched, 0)
  assert.ok(!r.errors.some(e => e.startsWith('Cover photo')))

  const g = fakeCtx()
  const r2 = await s.call('/import', {
    tripConfig: { mode: 'new', title: 'T' },
    polarsteps: { name: 'T', coverPhotoUrl: 'http://insecure.example/c.jpg', steps: [] },
    options: {},
  }, g.ctx)
  assert.equal(g.of('trips.update').length, 0) // mixed content would not render on an https TREK
  assert.ok(r2.errors.includes('Cover photo: not a usable https URL'))
})

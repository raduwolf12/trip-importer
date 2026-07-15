# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **TREK plugin** (self-hosted travel planner, github.com/mauriceboe/TREK) called "trip-importer". It reconstructs a past trip from any combination of: Polarsteps ZIP/trip.json exports, booking confirmation PDFs/emails, photos with GPS EXIF, expense CSVs, and Google Maps Timeline JSON. Manifest: `trek-plugin.json` (id, permissions, egress). Type: `page` plugin — it renders as a wizard page inside TREK, not a widget.

## Repo layout — read this before assuming structure

This is an unusually flat repo — **do not expect a src/ tree, a bundler, or per-module files**:

- `server/index.js` — the *entire* backend. One `definePlugin({ onLoad, routes })` call with all route handlers and parsing/import logic written inline (no separate parser modules, no `require`d local files).
- `client/index.html` — the *entire* frontend, one file. CSS, vendored libraries (JSZip v3.10.1, exifr, and pdf.js v2.16.105 legacy build — all minified and pasted inline as `<script>` blocks), and the app's own vanilla ES5-style JS (`var`, no framework, no JSX/TSX). No build step produces this file — it's edited directly. **Every vendored library must be inlined, not shipped as a separate file** — see the CORP gotcha below; this was tried and confirmed broken.
- No `tsconfig.json`, `.eslintrc`, test framework, or build config exists anywhere in the repo. No `client/package.json` or `server/package.json` — the root `package.json` (with `trek-plugin-sdk` as sole devDependency) is the only manifest.

Vendoring client libraries (instead of npm+bundle) is deliberate: the client runs in a sandboxed, egress-restricted iframe (only `nominatim.openstreetmap.org` is allowed per `trek-plugin.json`), so it can't load anything from a CDN at runtime.

### Confirmed gotcha: a plugin's own bundled files can't be loaded via `<script src>` — CORP blocks it

The client-bridge docs describe an "own-path" CSP source that allow-lists the plugin's own `client/` files in `script-src`, implying a multi-file bundle (`<script src="./pdf.worker.js">`, etc.) should work with no inlining needed. **In practice, against a real TREK instance, this fails**: the iframe runs at an **opaque origin** (sandbox without `allow-same-origin`), so *any* `<script src>` fetch — even to the plugin's own same-path asset — is blocked by the browser as cross-origin at the network layer: `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`, despite the request itself returning **200 OK**. CSP `script-src` allowing the path doesn't help, because this is a separate browser mechanism (`Cross-Origin-Resource-Policy`), not a CSP check. This was hit firsthand while vendoring pdf.js as `client/pdf.min.js` + `client/pdf.worker.min.js` — the pattern only started working once **both files were inlined** as `<script>…</script>` blocks directly in `index.html`, exactly like JSZip/exifr already were. **Lesson: any new vendored library must be fully inlined, never referenced via `<script src="./…">` or any other relative-path asset fetch, regardless of what the CSP docs imply is possible.**

pdf.js additionally needs a Worker, and a `blob:`-URL worker would violate CSP (`worker-src` isn't declared, so it falls back to `script-src 'self' 'unsafe-inline'`, which doesn't cover `blob:`). The fix: inline **both** `pdf.js` and `pdf.worker.js` as plain `<script>` tags with no `GlobalWorkerOptions.workerSrc` set at all. pdf.js's UMD worker bundle, when executed as an ordinary script (not `require`d, no AMD), assigns itself to `globalThis.pdfjsWorker`; pdf.js's own worker-init code checks for that global *before* it ever needs `workerSrc`, and if found, uses it directly as a "fake worker" running on the main thread (no `new Worker()`, no second fetch, no CSP/CORP exposure at all). Confirmed against the actual vendored bytes via a Node `vm` sandbox emulating a bare `<script>` execution context (no CommonJS): the fake-worker path engages and `getTextContent()` returns correct text. This is fine for the small (1–3 page) PDFs this plugin parses; don't reach for a real Worker here.

## Commands

There are **no npm scripts** defined in this repo. Development workflow is entirely through the `trek-plugin-sdk` CLI (the sole devDependency), invoked directly:

```
npx trek-plugin-sdk dev       # local dev/hot-reload against a TREK instance
npx trek-plugin-sdk validate  # validate trek-plugin.json + permissions
npx trek-plugin-sdk pack      # package for the TREK-Plugins registry
```

There is no build, lint, or test command — there is nothing to compile and no test suite. Use the `trek-plugin-dev` skill for the manifest schema, the `ctx` API surface, the sandboxed postMessage bridge contract, and TREK-Plugins registry CI gates.

## Architecture

### Client/server split of labor

Anything requiring browser-only APIs (ZIP unpacking, EXIF reading, image compression, FileReader) happens **client-side**; all text/JSON *interpretation* happens **server-side** via `invoke()` calls to the plugin's own routes. This keeps `server/index.js` pure-JS with no zip/exif dependencies.

### The import pipeline (upload → detect → parse → preview → import)

1. **Detection** (`doAnalyze()` in `client/index.html`): dropped files are bucketed purely by extension (`.zip`, `.json`, `.pdf`, `.txt`/`.eml`, images, `.csv`/`.tsv`).
2. **Polarsteps ZIP**: unzipped client-side with JSZip; any `trip.json` found becomes a candidate (supports multiple trips per ZIP) → sent to `POST /parse-polarsteps`.
3. **Google Timeline JSON**: `parseGoogleTimeline` on the server handles three schema generations (`semanticSegments`, old `timelineObjects`, raw `locations`), then clusters points via `clusterByProximity` (haversine, 500m radius).
4. **Photos**: GPS EXIF extracted client-side via exifr → `POST /parse-gps`. Buckets by date, then **clusters by proximity within each day** (`clusterByProximity`, 500m radius — same helper `parse-timeline` uses) rather than collapsing a whole day to one median point. A single median-per-day was a real, user-reported bug: a day with photos from multiple distinct attractions produced exactly one point, sometimes landing nowhere real (independently-computed median lat + median lng doesn't have to correspond to any actual visited location) — confirmed against real data (user's manual EXIF check found 42 distinct coordinates; the old code produced 7, one per calendar day, regardless of how spread out that day's photos actually were). Each cluster becomes its own place with its own `date`/`lat`/`lng`/`photoCount`, so one calendar day can now legitimately produce several places. Deliberately does **not** carry over `clusterByProximity`'s generic `.name` (which would be a photo's filename, useless as a place name and would wrongly suppress the downstream `/import` reverse-geocode step, which only geocodes when `cluster.name` is falsy).
5. **Bookings**: `.pdf`/`.txt`/`.eml` all feed the **same** text pipeline. PDFs are read client-side with pdf.js (`extractPDFText()` → `getDocument().getPage().getTextContent()`, capped at 20 pages, 15s timeout per file) and their text is concatenated alongside `.txt`/`.eml` content, then sent to `POST /parse-bookings` — a regex-first extractor (`parseBookingsRegex`) with an opt-in AI fallback (`POST /parse-bookings {useAI:true}` → `ctx.ai.complete(BOOKING_PROMPT + text)`) that only fires if regex found nothing, surfaced as a "✨ Try AI assist" button. There is still no `ctx` API to drive TREK's own server-side PDF booking parser from a plugin (isolated child process, no session/REST access to core) — that's *why* extraction has to happen this way rather than by proxying to TREK's parser. Separately, the **original PDF file** is always attached to the trip too (`POST /import-pdf-booking` → `ctx.files.create`) as a backup for reference, regardless of whether text extraction found a recognizable booking.

   `parseBookingsRegex` has a **dedicated structured detector for multi-leg rail e-tickets** (SJ/Resplus-style exports, and likely similar layouts from other European rail operators): it matches repeating `HH:MM  From Station  HH:MM  To Station  Train NNNN` blocks, attaches the nearest preceding written-out date ("17 July 2026" / "17 juli 2026" — see `MONTH_NAMES`/`parseWrittenDate`, English + Nordic month names), dedupes identical legs (the same physical leg often repeats once per co-traveller's ticket in the extracted text), and returns one `type: 'train'` booking **per leg** — this runs *before* flight detection specifically because a service number like "SJ 3000" would otherwise false-match the `[A-Z]{2}\d{3,4}` flight-number pattern. A looser single-row fallback (unicode-aware `routePat`, requiring 1-3 Title-Case words on each side of a `-`/`–`/`to`/`→` separator, anchored to a field boundary so it doesn't swallow filler text or a stray hyphen from a reference number) covers other bus/train formats that don't have the `Train NNNN` marker, at lower confidence. `parseLocalizedNumber()` handles European price formats ("1 978,00") alongside US/UK ones.
6. **Expense CSV**: read client-side as text → `POST /parse-csv`, a hand-rolled quote-aware CSV/TSV parser with fuzzy header matching and keyword-based category detection. Amount parsing goes through the same `parseLocalizedNumber()` as booking prices (was previously a naive `parseFloat(strip-non-digits)`, which silently turned "20,00" DKK into 2000 by treating the decimal comma as a thousands separator — a real bug hit in production, not hypothetical). Currency comes from a detected CSV column when present; **when the CSV/booking text has no currency at all, the fallback is the user-selected `options.defaultCurrency`** from the Configure step's currency `<select>` (`#opt-currency`), not a hardcoded one — a trip can genuinely span multiple currencies (e.g. Sweden + Denmark), so `prepareStep3()` only *pre-selects* a best guess (majority vote across any currencies actually detected in `parsed.expenses`/`parsed.bookings`) and leaves the final call to the user.
7. **Preview**: one card per source type; individual rows are toggleable (`_selected`) — this selection state is what's actually sent to `/import`.
8. **Import** (`POST /import`, the orchestrator): creates or links the trip, then sequentially processes journal entries, places (deduped/clustered, reverse-geocoded via Nominatim), bookings (→ `ctx.accommodations.create` for hotels with valid check-in/out dates, else `ctx.reservations.create`), and costs.

### Trip day rows must be created explicitly — nothing does it for you

Neither TREK (as far as any available doc states) nor this plugin auto-creates day rows spanning a trip's start/end date when a plugin calls `ctx.trips.create` — confirmed by the fact that `ctx.days.create` was never called anywhere in this file until this was fixed, yet `ctx.trips.getDays` was relied on everywhere to build `dayMap`. The practical symptom: places/journal entries/costs all "imported successfully" (they exist as records) but never actually landed on a day in the trip planner, because `dayMap[date]` was silently `undefined` for a brand-new trip. `/import` now has its own gating section (before journal/places/bookings/costs) that computes the trip's date range — `tripConfig.startDate/endDate` → Polarsteps dates → `ctx.trips.getById` (existing trip) → the min/max date actually found across the imported data, in that order — and calls `ctx.days.create` for any missing day in range, capped at 400 days (a single bad/placeholder date, e.g. a "no end date" sentinel like `2099-01-01`, was confirmed to otherwise balloon the range to tens of thousands of days and burn the entire budget on that one section forever). **This section must fully finish (all days in range created) before journal/places/bookings/costs are allowed to run** — letting them start against a partially-built `dayMap` would silently and permanently skip day-assignment for items whose date's day hadn't been created yet (indices are never revisited once consumed).

Separately — and easy to miss even once day rows exist — **linking a place to a journal entry (`entry.place_id`) is not the same as putting that place on the trip's day/itinerary view.** The Polarsteps journal loop creates a place per step and attaches it to the journal entry, but was never calling `ctx.itinerary.assign(tripId, dayId, placeId)` — so those places existed and were journal-linked, yet never appeared in the day-by-day itinerary. (The separate GPS/timeline places section already called `itinerary.assign` correctly — only the Polarsteps path was missing it.) Any future place-creation path needs both: attach to whatever entity makes sense (journal entry, booking, etc.) *and* `itinerary.assign` it to the day, if a day for its date exists.

There are no shared type/schema files between client and server — object shapes (e.g. the booking shape `{type, title, from, from_date, ...}`) are implicit JSON contracts kept in sync by hand between `server/index.js` and `client/index.html`. When changing a field name or shape, grep both files.

### `/import` is index-resumable — real per-call ceiling is ~8s, not the documented 30s

The `trek-plugin-dev` skill documents a 30s server-side route timeout, and that's real — but it is **not** the actual constraint on this route. **Confirmed against a real instance**: TREK's own `trek:invoke` bridge in the browser enforces its own **~8-second round-trip timeout**, independent of and much shorter than the route's 30s execution budget. Symptom: the client showed `Import failed: timeout of 8000ms exceeded` while the server-side route was likely still well inside its own 30s allowance. Nothing in the SDK docs mentions this; treat it as a hard fact about this TREK instance, not a documentation gap to double-check away.

Reverse-geocoding is rate-limited to ~1/sec, so at most a couple of geocoded items fit under an 8s ceiling — for any non-trivial trip (many Polarsteps steps, many distinct GPS-photo dates, many bookings/costs), **a single `/import` call finishing everything is the exception, not the norm**. Rather than push that back onto the user as "click Import again," `/import` is **index-resumable**:

- Request carries an optional `progress` object: `{journeyId, journal, journalEntries, journalDayNotes, places, placesCreated, bookings, bookingsRes, bookingsAcc, bookingsReview, costs, costsCreated, done}`. The four `*Idx`-style fields (`journal`/`places`/`bookings`/`costs`) are **the next array index to process** for that section — every per-section loop is a plain indexed `for` (not `for...of`) that `break`s (not `continue`s) on `!withinBudget()`, so it can report exactly where it stopped.
- The journal section creates its `ctx.journal.createJourney` **once** (when `progress.journeyId` is falsy) and reuses the id on every resumed call — a naive rewrite that re-creates the journey per call would silently produce one near-empty journey per round.
- The "places" section recomputes `clusters` fresh **every call** from `gpsPlaces`/`timelinePlaces`/`polarsteps` — safe only because the client always resends those arrays unchanged across rounds, so the same deterministic computation reproduces the same array and `progress.places` stays a valid index into it.
- Response returns the updated `progress` (with `done: true` once every active section's index has reached its array's length) alongside `log` (**cumulative** totals, safe to just redisplay each round) and `errors` (**per-round only** — the per-item failures from whatever was processed in *this* call; must be accumulated client-side, not overwritten).
- **No item is ever re-attempted once its index has been consumed** — this is what makes resuming safe instead of duplicating. Any future section added to `/import` needs the same indexed-loop-with-reported-stop-index treatment, or resuming it will either duplicate work or skip it.

`doImport()` in `client/index.html` loops calling `/import`, feeding each response's `progress` back in as the next call's input and switching `tripConfig` to `{mode:'existing', tripId}` after the first call, until `progress.done` (capped at 200 rounds as a runaway backstop). `result.log` messages are redisplayed as-is each round (cumulative); `result.errors` are concatenated across rounds into `allErrors`. `setProgUpdate()` (spinner, not checkmark) is used for a section's UI row until the round where `progress.done` is true, at which point `setProgDone()` (checkmark) takes over — except the `'trip'` row, which checkmarks immediately since trip creation/linking always completes in the first round.

`reverseGeocode()`'s own per-call timeout is 2500ms and `/import`'s deadline is `Date.now() + 6000` — both sized for the ~8s bridge ceiling, not the 30s route ceiling. **`withinBudget()` only gates whether a *new* item starts, it can't interrupt one already in flight** — this is why `reverseGeocode()` needs its own bounded `AbortController` timeout rather than relying on the shared deadline alone; any future per-item operation that makes an external call needs the same treatment.

### Error-handling convention

Every route handler is wrapped in `tryAttempt()` + `safeJson(200, ...)`, so the client's `invoke()` promise always resolves (never rejects) even on expected failures — errors surface as `{error: message}` in a 200 response, not an HTTP error status. Inside batch loops (`/import`), each item is individually try/caught into a local `errors[]` array so one bad item doesn't abort the rest of the batch.

### Client postMessage bridge — two parallel implementations, only one is live

`client/index.html` contains **two** separate `postMessage`/`invoke()` implementations:
1. A full "TREK plugin design kit" bridge (~lines 324-633) exposing `window.trek.invoke()`, theme/context application, auto-enhanced `<select>`s.
2. A second, simpler `invoke()`/message-listener pair defined again in the app's own script (~lines 871-884).

**The app logic calls the second (`invoke()`), not `window.trek.invoke()`.** Both listeners independently key off `requestId` so they don't conflict, but this is duplication to be aware of — don't assume `window.trek.invoke()` is what's driving the wizard.

### Confirmed gotcha: plugin route requests 413 well under any documented limit

`ctx.files.getContent`'s 10MB cap (per the `trek-plugin-dev` skill) is a *read*-side limit and does **not** describe the request-body ceiling for calling **into** a plugin route. In practice, POSTing a base64-encoded file to a plugin route (`/import-pdf-booking`, `/upload-photo`) 413s well below 10MB — confirmed against a real instance. This is presumably a body-size limit on the plugin-route proxy itself (not documented anywhere), and it's why `/upload-photo` already compresses images client-side and skips the upload if the base64 payload still exceeds **900KB** (`sizeB=b64.length*0.75; if(sizeB>900*1024) skip`). PDFs can't be recompressed the same way, so `doImport()`'s PDF-attach step applies the same **900KB base64** ceiling (`PDF_ATTACH_MAX_BASE64`) and skips attaching (with a clear log message) rather than sending a request that will just 413 — the booking itself already made it in via the text pipeline regardless, so this only affects the backup file attachment. **Any new route that uploads a file's content as a request body needs the same guard**; don't assume the 10MB `getContent` figure applies to the upload direction too.

### External API usage

`reverseGeocode(lat, lng)` calls `nominatim.openstreetmap.org/reverse` directly with `fetch`, always followed by `sleep(1100)` to respect Nominatim's 1 req/sec limit. `ctx.*.create()` calls are also throttled with small sleeps (80-150ms) between iterations during bulk import. Any new external call must be added to both `permissions` (`http:outbound:...`) and `egress` in `trek-plugin.json`.

### Versioning

`trek-plugin.json`'s `"version"` and the `onLoad` log string in `server/index.js` (`'trip-importer vX.Y.Z loaded'`) are two independent literals — nothing keeps them in sync automatically. They had drifted apart before (`1.3.2` vs `v1.3.1`); update both together on every version bump.

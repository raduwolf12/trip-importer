# Changelog

All notable changes to the Trip Importer TREK plugin are documented here.

## [1.7.1] - 2026-10-08

### Changed
- Widened the supported TREK version range from `>=4.2.0 <5.0.0` to `>=4.2.0 <6.0.0` so the plugin installs and activates on the upcoming TREK 5.0.0.

## [1.7.0] - 2026-09-13

### Added
- **Instance-scoped fallback settings** for the three previously user-only settings (`trek_base_url`, `immich_base_url`, `immich_api_key`): `trek_base_url_default`, `immich_base_url_default`, `immich_api_key_default`, all `scope:'instance'`, set once by the admin under Admin → Plugins → Instance settings. A user's own `scope:'user'` value, when set, always takes priority — the instance default is only used when a given user hasn't configured their own. Read via a shared `settingWithInstanceFallback(ctx, userKey, instanceKey)` helper (`server/index.js`), which checks `ctx.settings.get(userKey)` first and falls back to `ctx.config[instanceKey]` (the resolved instance-scoped value). Useful for single-tenant/family instances where every user shares the same TREK URL or the same Immich server, so nobody has to re-enter the same value into their own Settings page.

### Docs
- Documented that an Immich server on a private network (LAN address, `*.local`, Tailscale) needs `TREK_PLUGIN_ALLOW_PRIVATE_EGRESS=on` set on the TREK server, in addition to the admin allowing the hostname under Admin → Plugins — otherwise TREK blocks the request and the Immich picker can't connect. Added to the README's Known limitations and to the `immich_base_url` setting hint in `trek-plugin.json` (see issue #10).

## [1.6.0] - 2026-09-01

### Added
- **Route/track geometry for GPX and KML/KMZ**: a dropped GPX file with a `<trk>`, or a KML/KMZ file with a `LineString`/`Polygon` placemark, now offers an opt-in checkbox ("Draw the track line(s)/route(s) on the trip map") in its preview card, in addition to the existing clustered places. When enabled, each track/route becomes its own dedicated place (positioned at its start point, named after the track/placemark) carrying `route_geometry` — a TREK 4.0.0+ place field that renders the full line on the native trip map. Confirmed against TREK's own source (`shared/src/place/place.schema.ts`, `places.service.ts`'s GPX importer, `MapView.tsx`'s renderer): `route_geometry` is a `JSON.stringify()`'d array of `[lat,lng]` pairs, matching exactly what TREK's own native GPX `<trk>` importer produces. Capped at 4 tracks/routes and 300 points each, client-side. Independent of the existing "places" import toggle — a user who only wants the route line, not photo/timeline place pins, can still get it.

### Fixed
- **Google Timeline export misdetected as an empty Polarsteps trip when not named `location-history.json`/`Records.json`.** Detection was filename-only; a real-world export named e.g. `Timeline.json`/`timelines.json` fell through to the Polarsteps parser and silently produced "Untitled trip · 0 stops" with no indication the file was actually valid Timeline data. Fixed by adding a content-shape sniff (`looksLikeGoogleTimelineJson()`) that runs before the Polarsteps fallback for any `.json` file the filename check didn't already flag. Bare (non-ZIP) `.json` drops named exactly `location-history.json`/`Records.json` get the same filename-based fast path they always did.
- **`parseGoogleTimelineClient()` couldn't parse the real 2025/2026 semantic-segments export shape at all**, even when correctly detected — two separate bugs, both confirmed against a real sample: (1) a real export can be a bare top-level JSON *array* of segment objects with no `{semanticSegments:[...]}` wrapper, which the parser never checked for; (2) `topCandidate.placeLocation` arrives as a `"geo:<lat>,<lng>"` URI string, which the old comma-split logic turned into `NaN` (it expected a bare `"lat, lng"` pair, a shape not actually seen from a real export — the test-data generator had been modeling the wrong format). Both fixed in a shared `parseTimelineSegment()` helper reused by both the wrapped and bare-array shapes.
- **`places.kml`/`places.kmz` test fixtures detected nothing at all.** `generate-test-data.js`'s `generateKml()` embedded raw, unclosed `<br>` tags inside a `<description>` with no CDATA wrapper — invalid XML, which made `DOMParser`'s strict `text/xml` parse fail for the ENTIRE document, silently dropping every placemark, not just the malformed one. Fixed the fixture (wrapped in CDATA, matching what a real Google MyMaps export actually does) and hardened `parseKMLText()` itself with a defensive pre-pass that self-closes `<br>`/`<hr>`/unclosed `<img>` before parsing, since some real-world KML exporters are known to emit exactly this invalid pattern outside CDATA too.

## [1.5.0] - 2026-08-29

### Added
- Polarsteps step photos now attach directly into a journal entry's own photo gallery via `ctx.journal.addEntryPhoto`, through a new `/attach-entry-photo` route — this is what actually shows up in TREK's Journey view, distinct from the existing `ctx.files.create()` upload to the trip's Files tab. Both happen side by side; a step can have one, the other, or both depending on whether its place and/or journal entry were created.
- `progress.stepEntryIds` (Polarsteps `step.id` → its journal entry id), returned from `/import` and round-tripped back to the client the same way `progress.stepPlaceIds` already was, so the step-photo upload loop can look up the right entry to attach to.
- Declared the `hook:trip-warning-provider` and `hook:table-contributor` permissions in the manifest — both hooks were already implemented (surfacing unresolved import failures as a trip warning, and a "Source" column on imported places/reservations) but the manifest was missing the permissions needed to actually grant them.

### Fixed
- **Journal-only mode ("just the story, no trip plan") silently imported zero photos.** Two separate bugs compounded:
  - `toggleJournalOnly()` force-disabled and unchecked the "Upload photos" option in Journal-only mode, on the (now outdated) assumption that photos only ever attach to places/Files, neither of which exist without a trip.
  - The step-photo upload loop itself was gated on `result.tripId`, which is always `null` by design in Journal-only mode (no trip is ever created) — so even re-enabling the checkbox wasn't enough on its own.
  
  Both are fixed: the checkbox stays available, and the loop now also runs when `options.journalOnly` is set, attaching straight to the journal entry (which needs no `tripId`) instead of skipping entirely.
- "Upload photos" was shown as unavailable for a Polarsteps-ZIP-only import with no separately dropped photo files — its availability check only ever counted loose dropped images (`imgFiles.length`), never the ZIP's own embedded step photos (`parsed._stepPhotosByStepId`).

### Changed
- Raised the minimum required TREK version to `>=4.1.1` (from `>=3.4.0`); the compatibility ceiling remains `<5.0.0` ahead of TREK 4.0.0/5.0.0.
- `server/index.js`'s `onLoad` log string resynced to `v1.5.0` (was drifted to `v1.6.0`).

### Docs
- Corrected a CLAUDE.md section that stated flatly there was "no way to write directly into" a journal entry's photo gallery — that's no longer true now that `addEntryPhoto` exists; the `photoProvider` hook is documented as the remaining path for sources that never get their own journal entry (GPS/timeline photos, Immich picks).

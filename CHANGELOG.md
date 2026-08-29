# Changelog

All notable changes to the Trip Importer TREK plugin are documented here.

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

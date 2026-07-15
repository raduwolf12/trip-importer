# Trip Importer

Reconstruct a complete past trip from any combination of data sources.

## What it imports

| Source | What gets created |
|---|---|
| Polarsteps ZIP or trip.json | Journey with entries, places with coordinates |
| Booking confirmation PDFs/emails | Flight/bus/train reservations, hotel accommodations |
| Photos with GPS EXIF | Places pinned to the map |
| Expense CSV | Cost entries |

## How to use

1. Drop any files — ZIP, PDFs, photos, CSVs — all at once
2. The importer auto-detects what each file contains and shows a preview
3. Configure: create a new trip or link to an existing one, toggle what to import
4. Import — everything is created in one go

## Requires

AI provider configured in TREK admin settings (for booking extraction from PDFs).

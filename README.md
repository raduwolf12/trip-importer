# Trip Importer

Reconstruct a complete past trip from any combination of data sources — drop your files and the importer creates the trip, journal, places, transports, accommodations and costs automatically.

## What it imports

| File type | What gets created |
|---|---|
| **Polarsteps ZIP** or `trip.json` | Journey with entries + places with GPS coordinates |
| **Booking confirmation PDFs** | PDF uploaded as a trip file (use Transports → Automated import to finish) |
| **Booking text / .eml** | Flight/bus/train reservations and hotel accommodations parsed by pattern matching |
| **ICS calendar files** | Transport and accommodation bookings from calendar events |
| **Photos with GPS EXIF** (JPG/PNG) | Places pinned to the map, grouped by date |
| **GPX tracks / KML / KMZ** | Places from waypoints and placemarks |
| **Google Maps Timeline** (`location-history.json` / `Records.json`) | Places clustered from location history |
| **Expense CSV** | Cost entries with auto-detected categories |

## How to use

1. Drop any files — ZIP, PDFs, photos, CSVs, GPX/KML, ICS — all at once
2. The importer detects each file type and shows a preview per source — review and deselect anything you don't want
3. Configure: create a new trip or link to an existing one, toggle what to import
4. Import — progress shown per step, each source runs in sequence
5. If something went wrong, use **Undo this import** on the results screen to remove everything the import just created

## Notes

- **GPS places** are reverse-geocoded via Nominatim (OpenStreetMap) to get real location names — rate limited to 1 request/second, so large imports may be split across multiple runs
- **GPS places** within 800m of an existing Polarsteps stop are deduplicated automatically
- **PDF bookings** are uploaded as trip files — TREK's native booking parser runs separately (Transports tab → Automated import button)
- **AI assist** button appears if pattern matching finds nothing in text/email confirmations — requires an AI provider configured in Admin settings
- **Undo** removes reservations, accommodations, costs, places and journal entries created by the import — it does not delete the trip itself or its calendar days

## Permissions used

| Permission | Why |
|---|---|
| `db:create:trips` | Create new trip |
| `db:write:journal` | Create journey + entries from Polarsteps |
| `db:write:places` | Create places from GPS/Polarsteps/timeline |
| `db:write:reservations` | Create transport bookings |
| `db:write:accommodations` | Create hotel stays |
| `db:write:costs` | Create expense entries |
| `db:write:files` | Attach PDF confirmation files |
| `db:write:daynotes` | Add Polarsteps descriptions to planner day notes |
| `db:write:days` | Create trip days if missing |
| `db:write:itinerary` | Assign GPS places to planner days |
| `db:meta` | Store import refs for undo |
| `ai:invoke` | Optional AI fallback for unrecognised booking confirmations |
| `http:outbound:nominatim.openstreetmap.org` | Reverse geocoding |

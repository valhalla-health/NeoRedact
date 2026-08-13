# NeoRedact Sync

Lives in this repo as `backend/` (moved 2026-08-10 from the unversioned
`nicu-tools/neoredact-sync/`, which no longer exists). It is still its own
clasp-managed Apps Script project — `.clasp.json` is here, not at the repo
root — but it shares the frontend's history deliberately: the two duplicate a
`CODENAMES` list that the submit endpoint validates against, and keeping them
in separate places is what let them drift apart between 2026-07-16 and
2026-08-10. Change one, change the other, same commit.

GAS backend that receives already-redacted patient-label photos from the
NeoRedact PWA (any nurse, any phone) and centralizes them for Praew to
organize — same stack as PSS-NICU / NeoFeed / LOS Pilot: Apps Script +
Google Sheets + Drive, no separate server.

## What this does (Phase 1 — collection only)

1. NeoRedact redacts the patient name **on the nurse's phone**, and the nurse
   types the remaining printed fields (HN, DOB, ward, etc.) by hand on the
   Review step — nothing new here, same privacy invariant as before.
   (On-device Tesseract OCR used to do this reading; it was removed
   2026-07-20 for poor accuracy on real chart photos. This line still said
   "and OCRs whatever printed fields it can" until 2026-08-13.)
2. The nurse logs in (Google Sign-In or email/password) — see Auth below.
3. The nurse picks a **codename** (fixed pool of 24, NATO phonetic alphabet
   minus X-ray and Echo, with November replaced by Nomad — see NeoRedact's
   `../codenames.js`; this script's own `CODENAMES` is transitionally 25, still
   accepting `November` while installed PWAs update — see the comment there)
   — the only patient identifier that ever
   reaches this script. HN/DOB/name are stripped client-side and re-stripped
   here (`stripIdentifyingFields_`) before anything is written — this backend
   is never supposed to learn who the patient actually is. The real mapping
   (codename + date -> HN/AN/name) is Praew's own private sheet, kept outside
   this system entirely.
4. The redacted photo + non-identifying printed fields + codename get
   POSTed here.
5. This script saves the photo to Drive (`<codename>/<yyyy-MM-dd>/`) and logs
   one row per submission in the `Submissions` sheet, tagged with which nurse
   submitted it.
6. A read-only dashboard (`dashboard.html`, staff-login-gated) lists
   submissions grouped by codename via the `list_dashboard` action.

**Phase 2 is not built yet.** `ocr_status` / `ocr_data_json` are placeholder
columns for a future pass that would send the (already-redacted) photo to
Claude for handwriting OCR — gated on hospital IT/legal approval for
sending any patient-derived image to a third-party AI API. Nothing in this
script calls any external AI service.

## Auth

Per-nurse login, not a shared secret — this project is meant to be public on
GitHub, so a hardcoded token in the client wouldn't hold up. Two paths, both
end up producing the same `CacheService` session token (6h TTL):

- **Google Sign-In** — nurse's Google JWT is decoded locally (`decodeJwtEmail`,
  no signature verification, but every login still goes through the `Staff`
  whitelist below). First-time verified Google users are auto-registered as
  `admin` in `Staff` — restrict later by setting `active=FALSE`.
- **Email + password** — for nurses without a Google account. Requires you to
  run `setInitialPassword(email, password)` once per nurse from the Apps
  Script editor first; there's no self-registration for this path.

`Staff` sheet columns: `email | role | name | active | password_hash | salt`.
Google-account rows can leave `password_hash`/`salt` blank.

## Data dictionary (`Submissions` sheet)

| Column | Notes |
|---|---|
| syncId | Client-generated UUID, used to dedupe retries |
| submitted_at | Server timestamp (ISO) |
| device_captured_at | Client-reported capture time |
| submitted_by | Email of the logged-in nurse — audit trail |
| codename | One of the fixed 24 (NATO alphabet minus X-ray and Echo) — the only patient identifier this sheet ever holds |
| ward | Nurse-entered ward, passed separately (non-identifying) |
| fields_json | Labeled region OCR text, with anything labeled HN/DOB/name/AN stripped both client- and server-side before it gets here |
| drive_file_url | Link to the redacted photo in Drive (`<codename>/<yyyy-MM-dd>/<syncId>.jpg`) |
| ocr_status | `"printed fields only"` for now |
| ocr_data_json | Empty — reserved for Phase 2 |

No HN/DOB/name column exists here by design — see "What this does" above.

## Migrating an already-deployed sheet (HN/DOB → codename)

If `setupSpreadsheet()` already ran before 2026-07-16, the live `Submissions`
sheet still has the old header row (`HN`, `DOB` columns, no `codename`). This
script does not auto-migrate an existing header row. Before pushing this
version: either delete the header row 1 and re-run `setupSpreadsheet()` (safe
if there's no submitted data yet), or manually edit row 1 to match the new
`HEADERS` order above and rename the old `HN`/`DOB` columns to `codename` +
one spare, deleting the other. Old Drive files under the flat
`<yyyy-MM-dd>/<syncId>.jpg` layout are not moved into the new
`<codename>/<yyyy-MM-dd>/` structure.

## Setup

1. `clasp login` (as `peeraporn.po@chula.ac.th`)
2. `cp .clasp.json.example .clasp.json` and fill in your `scriptId` — or just
   `clasp clone <scriptId>`, which writes the same file. **`.clasp.json` is
   gitignored** (since 2026-08-13): it points at one specific Apps Script
   project, and this repo is public. It isn't a credential — nobody can touch
   the script without permission on the Google account — but there's no reason
   to publish it either. Existing checkouts already have the file and need
   nothing.
3. `cd backend && clasp push` (run clasp from *this* folder — `.clasp.json`
   lives here with `rootDir: ""`, so the repo root above is not uploaded)
4. Open in Apps Script editor → run `setupSpreadsheet()` once (creates the
   `Submissions` + `Staff` sheets + the `NeoRedact Submissions` Drive folder)
5. Sign in to NeoRedact with your own Google account once — this
   auto-registers you as `admin` in the `Staff` sheet. Add other nurses'
   emails as rows (Google-account nurses: leave `password_hash`/`salt`
   blank; they self-register the same way on first login). For non-Google
   nurses, run `setInitialPassword("their@email.com", "some-password")` from
   the Apps Script editor once each.
6. Deploy → **Manage deployments** → edit the existing deployment → Version:
   **New** → Deploy (use this, not "New deployment", once a deployment
   already exists — that would mint a different `/exec` URL and break every
   already-configured client)
7. Set `NEOREDACT_CLIENT_ID` in NeoRedact's `index.html` config block to a
   Google OAuth Client ID (try reusing NeoFeed's existing one first — Google
   validates by authorized JavaScript **origin**, not path, so if NeoRedact
   is hosted under the same origin it may just work; otherwise create a new
   OAuth Client ID in Google Cloud Console → Credentials, with NeoRedact's
   hosted origin added to "Authorized JavaScript origins")

## Daily workflow

```powershell
cd "~\OneDrive\Desktop\PraewPP\Web App Projects\NeoRedact\backend"
clasp pull
# edit
clasp push
# Deploy > Manage deployments > edit > New version, after every Code.gs change
```

## Security / PDPA

- The Web App URL itself is still public (`Anyone` access — required for an
  unauthenticated PWA to reach it at all), but every write now requires a
  valid session from a whitelisted, active `Staff` row — not a static secret
  anyone can extract from GitHub source. This was the point of adding login:
  the old `SYNC_TOKEN` approach doesn't survive a public repo.
- `submitted_by` gives real accountability (who submitted what) — a PDPA
  Accountability-principle safeguard the previous token-only version didn't
  have.
- Patient name is never in any payload this script receives — it was
  redacted before the photo left the phone. HN/DOB are also stripped before
  they ever reach this script (client- and server-side) — the only patient
  identifier that persists here is the codename. Still treat the Sheet/Drive
  folder's own sharing settings as a real security boundary (ward + OCR'd
  clinical text are still patient-derived data), and keep access restricted
  to people who need it.
- This data flow (patient-derived photos processed outside the hospital's
  core EMR) is new enough that it should have hospital IT/legal/DPO sign-off
  before real patients' data flows through it in production, independent of
  anything built here.
- The JWT decode does not verify Google's cryptographic signature — an
  acceptable tradeoff for an internal tool gated by the `Staff` whitelist,
  same as NeoFeed, but not a substitute for genuine token verification if
  this were ever exposed more broadly.

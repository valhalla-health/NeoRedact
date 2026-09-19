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
6. A read-only dashboard (`dashboard.html`, **admin-only** since 2026-09-18)
   lists submissions grouped by codename via the `list_dashboard` action.

**Phase 2 is not built yet.** `ocr_status` / `ocr_data_json` are placeholder
columns for a future pass that would send the (already-redacted) photo to
Claude for handwriting OCR — gated on hospital IT/legal approval for
sending any patient-derived image to a third-party AI API. Nothing in this
script calls any external AI service.

## Auth

Per-nurse login, not a shared secret — this project is meant to be public on
GitHub, so a hardcoded token in the client wouldn't hold up. Two paths, both
end up producing the same `CacheService` session token (6h TTL):

- **Google Sign-In** — the ID token is verified with Google's `tokeninfo`
  endpoint (`verifyGoogleIdToken_`), which is what checks the signature and
  expiry; `aud` must equal `GOOGLE_CLIENT_ID`, so a token minted for a
  different Google OAuth client can't be replayed here. The address must
  then already have an active `Staff` row.
- **Email + password** — for nurses without a Google account. Requires you to
  run `setInitialPassword(email, password)` once per nurse from the Apps
  Script editor first; there's no self-registration for this path. Five wrong
  passwords lock that address for 15 minutes. The lock lifts on its own, and
  setting a new password doesn't lift it sooner. An address with no password
  behind it gets exactly the answer a wrong password gets, so the login screen
  can't be used to find out who is staff. Passwords are stored stretched
  (`v2$…`, 3000 rounds of HMAC-SHA256); one set up before 2026-09-18 keeps
  working, and is re-stored that way the next time its owner signs in.

**Neither path creates an account.** Signing in only ever *looks up* a row.

`Staff` sheet columns: `email | role | name | active | password_hash | salt`.
Google-account rows can leave `password_hash`/`salt` blank.
`role` is `admin` or `nurse`; anything unrecognized is treated as `nurse`.

### Adding a nurse

From the Apps Script editor (or by typing the row into the sheet by hand):

```js
addStaff("nurse@example.com", "nurse", "Her Name")   // Google sign-in
setInitialPassword("nurse@example.com", "a-password") // no Google account
```

Only give `admin` to someone who should read the whole dashboard — every
submitting nurse's address, ward and photo link.

### Turning someone off

Set `active` to `FALSE` (or fix the `role`) in the `Staff` sheet. Both are
re-read on every request, so it takes effect on her next action rather than
whenever her 6h session happens to expire.

## Data dictionary (`Submissions` sheet)

| Column | Notes |
|---|---|
| syncId | Client-generated, used to dedupe retries and to name the Drive file: `crypto.randomUUID()`, or `String(Date.now()) + Math.random()` on a browser without it. Any other shape is refused. |
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

Every value is written as text. One that starts with `=`, `+`, `-` or `@` gets
a leading apostrophe, which makes Sheets store it as text instead of a formula
that would run when the sheet is opened; it reads back without the apostrophe.

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
5. Add yourself as the first admin from the editor:
   `addStaff("you@example.com", "admin", "Your Name")`. Signing in does **not**
   create an account (see Auth above), so this step can't be skipped. Add each
   Google-account nurse the same way with `"nurse"`; for non-Google nurses run
   `setInitialPassword("their@email.com", "some-password")` once each.
6. **Run any function once from the editor and accept the permission prompt.**
   Since 2026-09-18 `appsscript.json` also requests
   `script.external_request`, which is what lets the backend call Google to
   verify a sign-in token. Adding a scope invalidates the existing
   authorization: until the deploying account grants it, every Google login
   fails. `addStaff(...)` in step 5 is a fine way to trigger it.
7. Deploy → **Manage deployments** → edit the existing deployment → Version:
   **New** → Deploy (use this, not "New deployment", once a deployment
   already exists — that would mint a different `/exec` URL and break every
   already-configured client)
8. Sign in once through the app and confirm it works, then open
   `dashboard.html` and confirm it loads for you and not for a nurse account.
9. Set `NEOREDACT_CLIENT_ID` in NeoRedact's `index.html` config block to a
   Google OAuth Client ID (try reusing NeoFeed's existing one first — Google
   validates by authorized JavaScript **origin**, not path, so if NeoRedact
   is hosted under the same origin it may just work; otherwise create a new
   OAuth Client ID in Google Cloud Console → Credentials, with NeoRedact's
   hosted origin added to "Authorized JavaScript origins"). **The same value
   must be set in three places** — `index.html`, `dashboard.html` and
   `GOOGLE_CLIENT_ID` in `Code.gs` — because the backend now checks the
   token's `aud` against it. Change all three in the same commit;
   `test/verify-auth.cjs` fails if they drift apart.

## Daily workflow

```powershell
cd "$env:USERPROFILE\repos\PraewPP\Web App Projects\NeoRedact\backend"
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
- **Fixed 2026-09-18 — do not reintroduce.** This backend was copied from a
  mid-2026 NeoFeed revision and inherited two faults NeoFeed had fixed long
  before — the admin auto-registration on 2026-05-28 (its commit `8d49cd1`),
  the unverified token on 2026-07-12 (`4e927b9`) — which this README used to
  describe as an acceptable tradeoff:
  1. the Google ID token was only base64-decoded. Every claim it checked
     (`iss`, `exp`, `email`, `email_verified`) is written by whoever sends
     the token, and the signature — the only part that proves Google wrote
     them — was never examined. `aud` wasn't checked either;
  2. an address with no `Staff` row was appended as `admin`, active. So the
     "gated by the `Staff` whitelist" defence above was circular: the gate
     admitted anyone who knocked, as an administrator.
  Together these meant the dashboard — every nurse's address, ward and photo
  link — was reachable without a genuine account. Verification now goes
  through Google, accounts are never self-created, and the dashboard is
  admin-only. `test/verify-auth.cjs` fails against the old behaviour.
- **Also since 2026-09-18 (the follow-up)** — the rest of what NeoFeed had
  (its `4e927b9` and `8ca0f74`) and this copy lacked: the password lockout,
  counted before the hash; one answer, at one cost, for addresses with no
  password; stretched hashes compared in constant time; formula escaping on
  every cell a submission writes; a `syncId` that must have a shape the app
  mints; and no exception text in any response. `doPost` logs the detail
  instead — read it under Apps Script → Executions.
  `test/verify-auth.cjs` and `test/verify-submit-input.cjs` pin all of it.
- **The `Staff` sheet needs a review after this deploy.** While the above was
  live, any first Google sign-in wrote an `admin` row, so rows created that
  way are indistinguishable from intended ones. Read the sheet: anything you
  don't recognise should be removed or set `active=FALSE`, and colleagues who
  only submit photos belong on `nurse`, not `admin`. Check the `submitted_by`
  column of `Submissions` for the same reason.

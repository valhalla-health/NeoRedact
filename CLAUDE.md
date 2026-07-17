# NeoRedact

Offline PWA: nurse photographs a patient label, blacks out the name on-device, OCRs the
remaining labeled fields (Thai+English), and lets the redacted photo be downloaded locally.
Redaction and OCR are fully local — the raw, pre-redaction photo and the name never leave
the phone, ever. The
already-redacted result can optionally sync to a central NICU Sheet (see "Sync" below);
that's the only network traffic this app ever generates.

## Status

Core redact+OCR flow (v1) done. Phase 1 sync to `nicu-tools/neoredact-sync` (GAS backend)
is now wired in — see "Sync" section below. Codename identity model + read-only dashboard
(`dashboard.html`) landed 2026-07-16 — see "Codename identity model" below.

## Codename identity model (added 2026-07-16)

The cloud side (Sheet, Drive, dashboard) is never supposed to learn who a patient actually
is — only a codename. Praew keeps her own private mapping (codename + date -> real
HN/AN/name) on her desktop, entirely outside this system; date is what disambiguates a
reused codename on her side, this app never tracks that.

- **Codename pool**: fixed 24 values, the NATO phonetic alphabet minus X-ray and Zulu
  (Alpha…Yankee) — see `codenames.js`. Identical list duplicated in
  `neoredact-sync/Code.gs`'s `CODENAMES` constant; keep both in sync if this ever changes.
- **Wizard step**: the "codename" step is the *first* step of the wizard (right after
  Login, before Capture) — nurse picks one of the 24 before she ever takes the photo, so
  every artifact produced downstream (redacted image, OCR results, local export, Sync
  payload) is already tagged. Moved 2026-07-17 from its original position between Review
  and Export; Review's "ส่งออก" button now goes straight to Export since the codename was
  already picked at the start of the run. Back-navigation follows the new order: Codename
  back to Login, Capture back to Codename, Export back to Review.
- **HN/DOB never reach the cloud**: `sync.js` strips any field labeled HN/DOB/name/AN
  (`IDENTIFYING_FIELD_KEYS`) before building the sync payload; `Code.gs`'s
  `stripIdentifyingFields_` independently re-filters server-side — defense in depth, same
  pattern as the redact-before-OCR guard. The `Submissions` sheet has no HN/DOB/name
  column at all (replaced by `codename`).
- **Drive layout**: `NeoRedact Submissions/<codename>/<yyyy-MM-dd>/<syncId>.jpg` — one
  folder per codename, dated subfolder inside. (Changed from the old flat
  `<yyyy-MM-dd>/<syncId>.jpg` layout — old files aren't migrated.)
- **Dashboard** (`dashboard.html` + `dashboard.js`): read-only, staff-login-gated (reuses
  `auth.js`), lists submissions grouped by codename with date/ward/fields/photo link.
  Calls a new `list_dashboard` action on the same GAS backend. No patient-management
  (create/rename/discharge) — v1 is intentionally just a viewer.
- **Local export (`export.js`) is PNG-only** (the redacted photo) and carries the codename
  in its filename, plus a shared `artifactId` (`app.js`'s `state.artifactId`, generated
  once at redact time) — the same id becomes the Sync payload's `syncId` if that same
  photo is later synced, so a locally-downloaded file and its eventual Sheet row are
  cross-referenceable. Fixed 2026-07-16 after Praew noticed exported filenames
  (`neoredact-photo-20260716-2221.png`) had no codename at all — a `/scrutinize` review
  traced it to `export.js` never having been updated when the codename step was added.
  The separate `.txt`/`.json` download buttons were removed the same day (UI simplification
  — the reviewed fields already reach the NICU Sheet via Sync; `exportTxt`/`exportJson`
  were deleted from `export.js` along with them).
- **The codename step intentionally gates the whole capture flow** (and therefore both
  Sync and local export downstream), with no "skip" option (unlike login's explicit skip).
  This was scrutinized and kept as-is: codename selection is a pure client-side step with
  no network dependency, so it doesn't violate "works fully offline" — and forcing it
  before *any* output (not just Sync) matches the actual threat model, since nurses
  already share raw photos informally via LINE outside the app's control. Don't "fix"
  this by adding a skip button.

## Template auto-redact (added 2026-07-17)

Completes the backlog "template-based auto-redact of a fixed label position." New
`templates.js` defines a small set of known KCMH paper chart pages (Critical Care
Monitoring p1, Progress Note p3, Admission/Delivery Info p6 — measured from real blank
chart photos, not committed to this repo, see below) with two hand-measured boxes each:
the KCMH letterhead logo, and the "Sticker" box where the patient ID sticker (Name/HN/AN)
is affixed. Coordinates are stored as **fractions of image width/height** (not absolute
pixels), computed against the EXIF-corrected upright photo.

- **UI**: a new "แบบฟอร์มที่กำลังถ่าย" (which form page) `<select>` on the Capture step
  (`index.html`/`app.js`). Default is `manual` — the original free-hand behavior, unchanged.
  Picking a KCMH template doesn't change how the photo is taken (still the OS camera picker,
  no live preview/alignment guide — see "Known limitation" below); it only pre-seeds the
  Annotate step.
- **Seeding**: `canvas-annotator.js`'s new `seedFromTemplate(regions)` converts each
  template region's `xPct/yPct/wPct/hPct` to pixels against the *actual loaded photo's*
  canvas size, and pushes them as ordinary regions (`redact: true`, pre-labeled). Called
  once, right after `reset()`, in `app.js`'s `handleFileChosen`.
- **Still fully manual after seeding**: a seeded region is otherwise an ordinary region —
  the nurse can remove it and redraw, or toggle redact/read, same controls as always
  (`renderRegionList`). Nothing about the redact invariant changes: `redactor.js` still
  just blacks out whatever's in `state.regions` with `redact: true`, template-seeded or
  not. One difference from a hand-drawn redact box: `renderRegionList` shows the seeded
  region's label (e.g. "พื้นที่ปิดทึบ: KCMH logo") instead of the generic "ไม่ต้องตั้งชื่อ"
  caption, since a template can place *two* redact boxes at once and the nurse needs to
  tell them apart while checking — the label is still never read by `redactor.js` or
  `ocr-engine.js`, purely a display convenience.
- **Pages with no identifying fields aren't listed** — e.g. the Intake & Output Record page
  has no logo or sticker box on it at all, so it isn't a template option; `manual` is used
  for it same as the original single-label workflow (the wizard still requires at least one
  `redact: true` region to continue, unchanged).
- **Known limitation**: capture is still the OS-native camera app via
  `<input type="file" capture="environment">` (see `camera-capture.js`) — there is no live
  in-app preview to show an alignment guide while shooting, only the existing static
  `capture-guide` SVG shown beforehand. So the seeded boxes are only as accurate as how
  closely the nurse's framing (distance, rotation, crop) matches the one reference photo
  each template was measured from. Boxes were padded generously beyond the measured text/logo
  bounds specifically to absorb this, and `redactor.js`'s own per-region padding adds further
  margin on top — but a badly-off photo can still miss the target. This is why seeded regions
  stay fully editable rather than being "trusted" outright; there is deliberately no way to
  skip past Annotate without the nurse's eyes on the boxes.
- **Reference photos not committed**: the real chart photos used to measure these
  coordinates live in `LocalOnly/photo to text project/template/` (outside any repo, per this
  machine's `LocalOnly` convention) — only the derived numeric fractions are in `templates.js`.
- **If KCMH revises these forms or a new page type is needed**: re-measure the same way —
  load the photo, correct EXIF orientation, read off the logo/sticker box's pixel bounds, and
  divide by the corrected image's width/height to get the new `xPct/yPct/wPct/hPct`. Pad
  generously; err toward over-covering, never under-covering.

## Stack

Vanilla JS, no bundler, single `index.html` entry, `<script src>` load order (NOT the
React+Babel-CDN pattern used by sibling apps — see reasoning below). CSS custom-property
tokens in `styles.css`. Google Fonts CDN (Sarabun for Thai, Source Sans 3 for English) —
these need internet on first load only; already-cached fonts are not required for the
offline guarantee since the app is legible without them.

**Why not React here:** this app is a strictly linear wizard, and its central operation is
a destructive, imperative canvas pixel mutation (blackout) that must complete before OCR
ever runs. Framework re-renders touching the same canvas would risk silently undoing or
bypassing the blackout — an unacceptable risk for a tool whose entire purpose is a privacy
guarantee. Plain DOM + canvas removes that risk class entirely.

## Privacy invariant — do not violate when editing this code

Redact-before-OCR, redact-before-export, never-whole-image-OCR, never-retain-original:

- There is exactly one working canvas/ImageData for the photo. No clone of the
  pre-redaction pixels is ever kept alive past the redact step.
- The wizard state machine (`app.js`) will not allow entry to the OCR step until a
  `redacted = true` flag is set by `redactor.js`. `ocr-engine.js` independently re-checks
  this flag and throws if it is not set — defense in depth, not just a UI gate.
- OCR only ever receives per-region crops built from the already-redacted canvas — never
  the full image — so a hypothetical bug in the blackout logic still can't leak the name
  region into OCR.
- Zero network calls involving the **pre-redaction** image or the name, ever, under any
  code path. `sync.js` is the one intentional exception to "no network calls at all" — it
  only ever reads from the already-redacted canvas and the reviewed OCR results (same data
  `export.js` would download locally), never the original. If you touch `sync.js`, keep it
  that way: it must not gain access to anything upstream of the redact step.
- The raw pre-redaction photo is never exported, uploaded, or persisted under any code
  path. Only the already-redacted canvas can be serialized or synced.

## Offline OCR engine (vendored, not CDN)

`vendor/tesseract/` holds Tesseract.js core + worker + wasm + `tha.traineddata.gz` /
`eng.traineddata.gz`, fetched once during development and committed locally so the app's
very first load is same-origin and reliably cacheable by the service worker — no runtime
dependency on jsdelivr/unpkg, even on first run.

- Tesseract.js version pinned: **5.1.1** (`tesseract.js` + `tesseract.js-core`, npm)
- Files vendored: `tesseract.min.js`, `worker.min.js` (from `tesseract.js/dist`);
  `tesseract-core-lstm.wasm(.js)` + `tesseract-core-simd-lstm.wasm(.js)` (from
  `tesseract.js-core` — both SIMD and non-SIMD variants, since the worker feature-detects
  and picks one at runtime; we only vendor the LSTM-only build since `ocr-engine.js` calls
  `createWorker(lang, 1, ...)`, OEM 1 = LSTM only, no legacy engine needed)
- Traineddata: `eng.traineddata.gz` + `tha.traineddata.gz`, fetched from
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0_best_int/<lang>.traineddata.gz`
  (the same source Tesseract.js would hit by default) — this is the "best_int" (LSTM)
  variant matching OEM 1.
- Re-vendoring later: `npm install tesseract.js@<ver> tesseract.js-core@<ver>` somewhere
  scratch, copy the same file set out of `dist`/package root into `vendor/tesseract/`,
  re-download traineddata if the data version changes, bump the version noted above, bump
  `CACHE_VERSION` in `sw.js` so clients pick up the new files.

## Sync + login (Phase 1 collection — `sync.js` + `auth.js`)

Backend lives at `nicu-tools/neoredact-sync/` (separate clasp-managed Apps Script project;
see its README for setup/deploy steps). It's a stateless GAS REST API — Drive for the
redacted photos, a Sheet for everything else — same shape as `nicu-tools/los-pilot`.

NeoRedact is meant to be hosted on a **public** GitHub repo, so there is no static shared
secret anywhere in this app — a hardcoded token in public source doesn't hold up. Instead,
`auth.js` handles per-nurse login (Google Sign-In, or email/password for nurses without a
Google account) against `neoredact-sync`, which issues a session token. `sync.js` sends that
session token with every submission instead. Login is **optional up front** — the login step
has a "Skip for now" button, since redaction and OCR must keep working fully offline without
an account; a session is only required at the moment of actually hitting Sync.

- **Config**: `index.html`'s config block has `NEOREDACT_GAS_URL` (the deployed
  `neoredact-sync` URL) and `NEOREDACT_CLIENT_ID` (a Google OAuth Client ID — see
  `neoredact-sync/README.md` for reusing NeoFeed's or creating a new one).
- **Session**: `auth.js` stores `{name, role, email, token}` in `sessionStorage` (not
  `localStorage` — clears when the browser fully closes, the right call for a shared/BYOD
  device) under `neoredact_session_v1`.
- **What gets sent**: the already-redacted canvas (JPEG, base64) + the reviewed field
  labels/text from the OCR step (minus anything HN/DOB/name-labeled — see "Codename
  identity model") + the selected codename + a client-generated `syncId` (UUID) + the
  session token. Nothing upstream of the redact step is ever touched by either module.
- **Offline handling**: `sync.js` keeps a `localStorage` retry queue
  (`neoredact_sync_queue_v1`). A failed POST (no connection, GAS down, expired session)
  queues the payload instead of losing it; the queue flushes automatically on page load and
  on the browser `online` event. The backend dedupes by `syncId`, so a flush that partially
  succeeded before, or double-fires, is harmless. If a queued item's session has expired by
  the time it flushes, `flushQueue()` stops and reports `needsLogin` rather than silently
  dropping the data — `sync.js` responds by clearing the stale session so the export step
  naturally prompts a fresh login next time, instead of retrying with a token that will
  never work again.
- **Auth caveat**: the JWT decode in `neoredact-sync/Code.gs` does not verify Google's
  cryptographic signature (checks issuer/expiry/`email_verified` only) — acceptable because
  every login still goes through the `Staff` whitelist server-side, same tradeoff NeoFeed
  ships with. See `nicu-tools/neoredact-sync/README.md`'s Security section for the rest.
- **Phase 2 placeholder**: the Sheet has `ocr_status` / `ocr_data_json` columns reserved for
  a future Claude-vision pass over the handwritten fields — not built, gated on hospital
  approval. Nothing in this app or the backend calls any AI API today.

## Known limitation: iOS Safari cache eviction

iOS can evict a PWA's Cache Storage / service worker after ~7 days of disuse. The "works
offline after install" guarantee can silently break on a phone that hasn't opened the app
in a while. `ocr-engine.js` should detect a failed/missing cached engine and show a clear
"reconnect to Wi-Fi to refresh the OCR engine" message rather than fail silently or crash.

## Local testing

Service workers require `http(s)://` — do not open via `file://`.

```
python -m http.server 8000
```

Then on a phone on the same LAN: `http://<dev-machine-LAN-IP>:8000/`.

**Offline test protocol (the core requirement — always run this before shipping a
change):**
1. Fresh load over Wi-Fi.
2. Run one full capture → redact → OCR → export cycle (warms both SW caches).
3. Enable Airplane Mode.
4. Fully close the app from the app switcher (not just backgrounded).
5. Relaunch from the home-screen icon, still in airplane mode.
6. Run a full cycle again — OCR must still produce results and export must still download.

Also: watch the Network tab through a full session and confirm zero outgoing requests
after the initial load.

# NeoRedact

Offline PWA: nurse photographs a patient label, blacks out the name on-device, manually
transcribes the remaining labeled fields (Thai+English) into text, and lets the redacted
photo be downloaded locally. A nurse can capture several photos in a row under the same
codename (e.g. multiple chart pages for one patient) without re-picking it each time — see
"Multiple photos per codename" below. Redaction is fully local — the raw, pre-redaction
photo and the name never leave the phone, ever. The already-redacted result can optionally
sync to a central NICU Sheet (see "Sync" below); that's the only network traffic this app
ever generates.

## Status

Core redact + manual field-entry flow (v1) done. Local on-device OCR (Tesseract.js) was
tried and removed 2026-07-20 — see "Local OCR removed" below; a nurse now types field
values by hand on the Review step instead. Phase 1 sync to the GAS backend in `backend/`
(moved into this repo 2026-08-10) is wired in — see "Sync" section below. Codename identity model + read-only
dashboard (`dashboard.html`) landed 2026-07-16 — see "Codename identity model" below.

## Codename identity model (added 2026-07-16)

The cloud side (Sheet, Drive, dashboard) is never supposed to learn who a patient actually
is — only a codename. Praew keeps her own private mapping (codename + date -> real
HN/AN/name) on her desktop, entirely outside this system; date is what disambiguates a
reused codename on her side, this app never tracks that.

- **Codename pool**: fixed 24 values — the NATO phonetic alphabet minus X-ray and Echo,
  with November replaced by Nomad (Alpha…Zulu) — see `codenames.js`. Swapped 2026-07-20
  (was minus X-ray and Zulu; Echo dropped and Zulu added at the end, in alphabetical
  order), then November → Nomad on 2026-08-10. Both removals were for the same reason and
  it's the rule to apply to any future change: **a codename must not be mistakable for
  clinical content on a chart.** "Echo" reads as a cranial ultrasound note, "November" as
  a date of birth. Substitutes keep the initial letter (Eagle was the proposed E; Nomad is
  the N) so the pool stays a rough A–Z. Identical list duplicated in
  `backend/Code.gs`'s `CODENAMES` constant; keep both in sync if this ever changes, in the
  same commit. The backend went un-updated through the 2026-07-20 swap — it sat in a
  separate, unversioned folder and kept the old 26-name pool for three weeks. That was
  survivable only because the frontend's 24 were a strict subset, so submissions still
  validated; the reverse (frontend offering a name the backend lacks) is rejected outright
  at `Code.gs`'s submit handler with "invalid or missing codename". Reconciled and the
  backend moved into this repo as `backend/` on 2026-08-10, specifically so the two lists
  can't drift again.
- **There are three copies of this list, and they are correctly all different sizes.** All
  three moved into this repo (2026-08-10) precisely because separate locations let them
  drift silently. Before changing any of them, know which rule each one follows:
  | File | Count | Rule |
  |---|---|---|
  | `codenames.js` (frontend) | 24 | What a nurse may pick **today**. The source of truth. |
  | `backend/Code.gs` | 25 | What the server **accepts** — must be a superset of every version of the frontend still installed on a phone. See below. |
  | `tools/neoredact-organizer/app.js` | 27 | What may appear in a **filename already on disk** — every name ever shipped. Only ever grows. |
  Making them equal breaks two of the three: the backend would reject codenames from
  not-yet-updated phones, and the organizer would stop recognizing older exports.
- **The backend list is intentionally 25 right now, not 24** — it holds both `November` and
  `Nomad` (deployed `@5`, 2026-08-10). This is a deliberate transitional superset, not the
  drift described above: this app is an *installed PWA*, so a phone keeps serving its
  cached `codenames.js` until the service worker picks up the `CACHE_VERSION` bump (v7 → v8
  ships the rename). Until every install has updated, some clients still offer November and
  some offer Nomad, and the backend must accept either. The asymmetry is the whole point —
  accepting a name no client sends is harmless, rejecting one a live phone still shows is
  a failed sync on a nurse's phone. **Don't "fix" this by deleting November to match the
  frontend.** Drop it only once all installs are confirmed updated (or leave it — nothing
  breaks; it just lingers in the dashboard's codename list).
- **Wizard step**: the "codename" step is the *first* step of the wizard (right after
  Login, before Capture) — nurse picks one of the 24 before she ever takes the photo, so
  every artifact produced downstream (redacted image, manually-typed field values, local
  export, Sync payload) is already tagged. Moved 2026-07-17 from its original position
  between Review and Export; Review's "ส่งออก" button now goes straight to Export since the
  codename was already picked at the start of the run. Back-navigation follows the new
  order: Codename back to Login, Capture back to Codename, Export back to Review. As of
  2026-07-20, a nurse can also loop Export → Capture directly for another photo under the
  *same* codename — see "Multiple photos per codename" below; only the explicit "เสร็จสิ้น"
  button on Export clears the codename and returns to this step.
- **HN/DOB never reach the cloud**: `sync.js` strips any field labeled HN/DOB/name/AN
  (`IDENTIFYING_FIELD_KEYS`) before building the sync payload; `Code.gs`'s
  `stripIdentifyingFields_` independently re-filters server-side — defense in depth, same
  pattern as the privacy invariant below. The `Submissions` sheet has no HN/DOB/name
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
  not. A seeded region also carries a pre-filled label (e.g. "KCMH logo" vs
  "Sticker (Name/HN/AN)") in `renderRegionList`'s editable field, since a template can
  place *two* redact boxes at once and the nurse needs to tell them apart while checking —
  the label is still never read by `redactor.js` or fed into `state.results`, purely a
  display convenience (see "Redact region labels now editable", 2026-07-20, below).
- **Pages with no identifying fields aren't listed** — e.g. the Intake & Output Record page
  has no logo or sticker box on it at all, so it isn't a template option; `manual` is used
  for it same as the original single-label workflow (the wizard still requires at least one
  `redact: true` region to continue, unchanged).
- **Known limitation**: capture is still the OS-native camera app via
  `<input type="file" capture="environment">` (see `camera-capture.js`) — there is no live
  in-app preview to show an alignment guide while shooting (the static example-framing card
  that used to sit above the shutter button on the Capture step was removed 2026-07-20; see
  "UI tweaks" below). So the seeded boxes are only as accurate as how closely the nurse's
  framing (distance, rotation, crop) matches the one reference photo
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

## UI tweaks (added 2026-07-20)

A batch of small UX changes to the Login, Capture, and Annotate steps, requested directly
by Praew after using the app:

- **Login hint shortened**: the paragraph above the Google Sign-In button on the Login step
  now just reads "เข้าสู่ระบบเพื่อ sync" — the longer explanation (login is optional, works
  offline, only needed at Sync) was cut for brevity. The full nuance still lives in this
  file and in `renderSyncUI()`'s hint text at the Export step, which is where a nurse
  actually hits the login-required moment.
- **Capture-step example card removed**: the static SVG card showing an idealized framing of
  the name/HN/DOB label (dashed outline + sample boxes) that used to sit above the shutter
  button is gone, along with its now-unused `.capture-guide` CSS. The plain-text hint above
  it (framing/lighting advice) stays.
- **Annotate step: pinch-to-zoom**: `canvas-annotator.js` now distinguishes touch gestures
  by finger count — one finger draws a redact/read box (unchanged behavior), a second finger
  switches to a pinch-zoom/pan on the photo instead (implemented as a CSS `transform` on a
  new `.zoom-surface` wrapper div around `workCanvas`/`overlayCanvas`, clamped to
  1x–4x zoom). This is a pure view transform — region coordinates stay in image-pixel space
  and `toImageCoords()` is unaffected, since it derives from the overlay canvas's *rendered*
  bounding rect regardless of any zoom applied to it. Lets a nurse zoom in for a more precise
  redact box on a small or far-away label without affecting the underlying pixel data. Ending
  a pinch (lifting a finger back down to one) does not resume drawing with the remaining
  finger — a fresh touch is required, to avoid an accidental box from a pinch release.
- **Redact region labels now editable**: `renderRegionList` (`app.js`) used to show a
  redact-flagged region's label as a static, non-editable span ("no need to name what's
  being blacked out," since `redactor.js` never read it). It's now an ordinary text input,
  same as a field/read region's — the nurse can optionally type what's under a given redact
  box (useful when a template seeds more than one, e.g. "KCMH logo" vs "Sticker"). Left
  blank, the box's overlay caption and region-list placeholder both fall
  back to the generic "พื้นที่ปิดทึบ" (was "ไม่ต้องตั้งชื่อ"). The redact-toggle button's
  on-state label also changed from "ปิดทึบ" to "ปิดทึบทั้งหมด" for clarity. None of this
  touches the privacy invariant — the label is still purely a display convenience, never
  read by the redact step or fed into `state.results`, and still never required for a
  redact region.
- **Codename pool swap**: see "Codename pool" under "Codename identity model" above —
  Echo replaced with Zulu.
- **Login step: Google button now shows a loading state** (`auth.js`'s `renderGoogleButton`).
  Praew reported "google login หายไป" (Google login disappeared) with a screenshot of the
  Login step showing only the hint text and the "ใช้อีเมลและรหัสผ่านแทน" link — the
  `#googleSignInContainer` div was empty. Root cause: the button was never actually gone —
  `renderGoogleButton` polls for `window.google.accounts.id` (Google Identity Services
  loads async/defer) for up to 10s before showing a "failed to load" message, and on a
  slow/flaky hospital connection the container just sits blank the whole time with zero
  feedback, which reads as broken rather than loading. Fixed by setting
  `container.textContent` to a "กำลังโหลด Google Sign-In…" placeholder immediately, before
  polling starts; the eventual failure message also now points at the email/password
  fallback link right below it. This is a pure UX fix — no change to when/whether the
  button ultimately renders, login is still fully optional, and offline redact/field-entry
  are unaffected.

## Local OCR removed (2026-07-20)

Tesseract.js on-device OCR was the original v1 approach for turning HN/DOB/ward/etc.
fields into text, but recognition quality on real chart photos (handwriting, glare,
low-contrast printed labels) was bad enough that nurses couldn't rely on it — it was
retried, reviewed, and generally slower than just typing the value. Removed entirely
rather than kept as an optional assist, to avoid maintaining a large, unreliable
dependency for a feature nobody trusted.

- **Removed**: `ocr-engine.js`, `vendor/tesseract/` (~17MB of vendored Tesseract.js
  core/worker/wasm/traineddata — see the old "Offline OCR engine" section this replaces),
  the `<script src="vendor/tesseract/tesseract.min.js">` and `<script src="ocr-engine.js">`
  tags in `index.html`, and the standalone "OCR progress" wizard step (`step-ocr` /
  `runOcr()`). `sw.js`'s OCR cache tier (`OCR_CACHE`/`OCR_FILES`) is gone too — one cache
  tier now, `CACHE_VERSION` bumped to `v7` so existing installs drop the old ~17MB cache on
  next activate.
- **Replacement flow**: `btnRedactConfirm`'s click handler (`app.js`) used to call
  `runOcr()` and route through the OCR step; it now builds `state.results` directly —
  `state.regions.filter(r => !r.redact).map(r => ({id, label, text: ''}))` — and goes
  straight to Review. The Review step's fields (`renderResults`) were always plain
  `<textarea>`s the nurse could edit (originally to *correct* OCR's guess); now they just
  start blank with a "พิมพ์ค่าที่เห็นในรูป" placeholder and she fills them in from scratch.
  The per-field "อ่านซ้ำอีกครั้ง" (re-run OCR on this region) retry button is gone along
  with it — nothing left to retry.
- **Everything downstream is unchanged**: `state.results`' shape (`{id, label, text}`) is
  identical to what OCR used to produce, so `export.js` and `sync.js` (and the Sheet
  columns / dashboard on the backend) needed zero changes — they never cared where `text`
  came from.
- **Wizard step count dropped from 6 to 5** (`codename, capture, annotate, review, export`)
  — update anything that assumed the old 6-step numbering (the step badge, this file's own
  step comments in `index.html`).
- **Privacy invariant simplified, not weakened**: with no OCR pass, there's no longer a
  separate "does this data-extraction step also get to see the pre-redaction image"
  question to defend against — see the rewritten "Privacy invariant" section below. The
  core guarantee (one working canvas, redact-before-any-output, no raw photo ever leaves
  the device) is unchanged.

## Multiple photos per codename (2026-07-20)

Previously the only way to capture a second photo for the same patient was to finish the
whole flow and start over from Codename, re-picking the same value from the grid. Now
there's a direct loop back to Capture that keeps the codename:

- **New button** on the Export step, `btnAddAnotherPhoto` ("ถ่ายรูปเพิ่มสำหรับรหัสนี้") —
  calls a new `resetPhotoState()` (`app.js`) that clears everything about the *current
  photo* (`state.regions`, `state.results`, `state.redacted`, `state.artifactId`, the
  annotator, the working canvas) but leaves `state.codename` and `state.templateId` alone,
  then jumps straight to the Capture step. `resetAll()` (the existing "เสร็จสิ้น — เริ่ม
  ผู้ป่วยรายถัดไป" button, `btnDone`) now calls the same `resetPhotoState()` plus clears
  `state.codename` and `state.photoCount` — the two buttons share the per-photo cleanup
  logic and differ only in whether the codename survives.
- **`state.photoCount`**: increments once per successful redact (in `btnRedactConfirm`),
  reset to 0 only by `resetAll()`. Shown on the Export step via `photoCountHint` ("รูปที่ N
  สำหรับรหัส {codename}") so the nurse has a visible confirmation she's still on the same
  patient across multiple captures, not a per-app-lifetime counter.
- **No backend changes needed**: multiple photos under one codename were already
  representable — Drive's `<codename>/<yyyy-MM-dd>/<syncId>.jpg` layout and the
  `Submissions` sheet both key by `syncId` per photo, grouped by `codename` (see "Codename
  identity model" above and the dashboard's grouped table). This feature is purely a
  client-side navigation shortcut to reach that same end state without re-selecting the
  codename each time.

## Repo layout (consolidated 2026-08-10)

The repo root is the PWA itself (`index.html` + its `<script src>` files) — that stays true,
nothing was nested. Alongside it:

- `backend/` — the GAS sync backend, its own clasp project (`.clasp.json` lives there, so
  run `clasp` from that folder). Was `nicu-tools/neoredact-sync/`.
- `tools/neoredact-ocr-routine/` — Phase 2 Claude-vision OCR of handwriting. **Not live**:
  `run.js` refuses to touch anything but its bundled synthetic sample unless `config.json`
  has both `"mode": "real"` and `"dpoApproved": true` set by hand. That gate is waiting on
  KCMH DPO sign-off for sending patient-derived images to a third-party API — don't flip it
  in code.
- `tools/neoredact-organizer/` — personal desktop tool that files exports from Downloads
  into `<codename>/<date>/` under LocalOnly. Browser-only, File System Access API.

All three were unversioned local folders under `nicu-tools/` until 2026-08-10. They were
consolidated here because they duplicate the codename list between them and had already
drifted apart unnoticed — see "Codename identity model" above.

**Nothing patient-derived belongs in this repo**, in any of these folders. The OCR
routine's `output-real/` and the organizer's destination are LocalOnly territory;
`.gitignore` covers the former, and the latter never writes inside the repo at all. The one
committed image (`tools/neoredact-ocr-routine/sample/sample-label.png`) is a synthetic
fixture, captioned as such on its face, with the name region blacked out.

## Stack

Vanilla JS, no bundler, single `index.html` entry, `<script src>` load order (NOT the
React+Babel-CDN pattern used by sibling apps — see reasoning below). CSS custom-property
tokens in `styles.css`. Google Fonts CDN (Sarabun for Thai, Source Sans 3 for English) —
these need internet on first load only; already-cached fonts are not required for the
offline guarantee since the app is legible without them.

**Why not React here:** this app is a strictly linear wizard, and its central operation is
a destructive, imperative canvas pixel mutation (blackout) that must complete before the
redacted photo is ever shown, exported, or synced. Framework re-renders touching the same
canvas would risk silently undoing or bypassing the blackout — an unacceptable risk for a
tool whose entire purpose is a privacy guarantee. Plain DOM + canvas removes that risk
class entirely.

## Privacy invariant — do not violate when editing this code

Redact-before-any-output, never-retain-original:

- There is exactly one working canvas/ImageData for the photo. No clone of the
  pre-redaction pixels is ever kept alive past the redact step.
- The wizard state machine (`app.js`) will not allow entry to the Review step until a
  `redacted = true` flag is set by `redactor.js` (`btnRedactConfirm`'s handler sets it
  immediately after `applyRedaction()` returns, before anything else touches the canvas).
- Zero network calls involving the **pre-redaction** image or the name, ever, under any
  code path. `sync.js` is the one intentional exception to "no network calls at all" — it
  only ever reads from the already-redacted canvas and the reviewed, manually-typed field
  values (same data `export.js` would download locally), never the original. If you touch
  `sync.js`, keep it that way: it must not gain access to anything upstream of the redact
  step.
- The raw pre-redaction photo is never exported, uploaded, or persisted under any code
  path. Only the already-redacted canvas can be serialized or synced.
- There used to be a second guard here specific to the (now-removed) OCR pass — see "Local
  OCR removed" above. With no data-extraction step reading the canvas at all anymore, the
  remaining surface to audit is just: redact, then display/export/sync from that same
  canvas. Keep it that simple if a future feature reads pixels from the canvas again.

## Sync + login (Phase 1 collection — `sync.js` + `auth.js`)

Backend lives at `backend/` in this repo (still its own clasp-managed Apps Script project —
`.clasp.json` sits in that folder, so run `clasp` from there, not the repo root; see its
README for setup/deploy steps). It's a stateless GAS REST API — Drive for the
redacted photos, a Sheet for everything else — same shape as `nicu-tools/los-pilot`.

NeoRedact is meant to be hosted on a **public** GitHub repo, so there is no static shared
secret anywhere in this app — a hardcoded token in public source doesn't hold up. Instead,
`auth.js` handles per-nurse login (Google Sign-In, or email/password for nurses without a
Google account) against `neoredact-sync`, which issues a session token. `sync.js` sends that
session token with every submission instead. Login is **optional up front** — the login step
has a "Skip for now" button, since redaction and manual field entry must keep working fully
offline without an account; a session is only required at the moment of actually hitting
Sync.

- **Config**: `index.html`'s config block has `NEOREDACT_GAS_URL` (the deployed
  `neoredact-sync` URL) and `NEOREDACT_CLIENT_ID` (a Google OAuth Client ID — see
  `backend/README.md` for reusing NeoFeed's or creating a new one).
- **Session**: `auth.js` stores `{name, role, email, token}` in `sessionStorage` (not
  `localStorage` — clears when the browser fully closes, the right call for a shared/BYOD
  device) under `neoredact_session_v1`.
- **What gets sent**: the already-redacted canvas (JPEG, base64) + the reviewed,
  manually-typed field labels/text from the Review step (minus anything HN/DOB/name-labeled
  — see "Codename identity model") + the selected codename + a client-generated `syncId`
  (UUID) + the session token. Nothing upstream of the redact step is ever touched by either
  module.
- **Offline handling**: `sync.js` keeps a `localStorage` retry queue
  (`neoredact_sync_queue_v1`). A failed POST (no connection, GAS down, expired session)
  queues the payload instead of losing it; the queue flushes automatically on page load and
  on the browser `online` event. The backend dedupes by `syncId`, so a flush that partially
  succeeded before, or double-fires, is harmless. If a queued item's session has expired by
  the time it flushes, `flushQueue()` stops and reports `needsLogin` rather than silently
  dropping the data — `sync.js` responds by clearing the stale session so the export step
  naturally prompts a fresh login next time, instead of retrying with a token that will
  never work again.
- **Auth caveat**: the JWT decode in `backend/Code.gs` does not verify Google's
  cryptographic signature (checks issuer/expiry/`email_verified` only) — acceptable because
  every login still goes through the `Staff` whitelist server-side, same tradeoff NeoFeed
  ships with. See `backend/README.md`'s Security section for the rest.
- **Phase 2 placeholder**: the Sheet has `ocr_status` / `ocr_data_json` columns reserved for
  a future Claude-vision pass over the handwritten fields — not built, gated on hospital
  approval. Nothing in this app or the backend calls any AI API today. This server-side,
  gated idea is unrelated to (and unaffected by) the on-device Tesseract.js OCR removed
  2026-07-20 — see "Local OCR removed" above; if it's ever built, it'd be the only
  automated field-extraction path left, since the client no longer has one at all.

## Known limitation: iOS Safari cache eviction

iOS can evict a PWA's Cache Storage / service worker after ~7 days of disuse. The "works
offline after install" guarantee can silently break on a phone that hasn't opened the app
in a while. `app.js`'s `swStatus` indicator (bottom of the file) already covers this
generically — it shows a "กำลังเตรียมแอปสำหรับใช้งานออฟไลน์" message until
`serviceWorker.ready` resolves, and a failure message if registration itself fails. This
used to be a bigger risk when the cache included the ~17MB Tesseract.js tier (see "Local
OCR removed" above); the app shell alone is much smaller and faster to re-cache, but the
underlying eviction behavior is unchanged, so don't assume "works offline" without
re-testing per the protocol below after a period of disuse.

## Local testing

Service workers require `http(s)://` — do not open via `file://`.

```
python -m http.server 8000
```

Then on a phone on the same LAN: `http://<dev-machine-LAN-IP>:8000/`.

**Offline test protocol (the core requirement — always run this before shipping a
change):**
1. Fresh load over Wi-Fi.
2. Run one full capture → redact → review (manually type a field) → export cycle (warms
   the SW cache).
3. Enable Airplane Mode.
4. Fully close the app from the app switcher (not just backgrounded).
5. Relaunch from the home-screen icon, still in airplane mode.
6. Run a full cycle again — capture, redact, type field values, and export must all still
   work. Also try "ถ่ายรูปเพิ่มสำหรับรหัสนี้" to capture a second photo under the same
   codename without leaving airplane mode.

Also: watch the Network tab through a full session and confirm zero outgoing requests
after the initial load.

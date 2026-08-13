# NeoRedact

An offline-first PWA for NICU nurses at King Chulalongkorn Memorial Hospital. A nurse
photographs a patient's chart page or ID label, blacks out the name **on the phone**, types
the remaining fields, and gets a redacted copy she can keep locally or sync to a central
NICU Sheet.

The interface is in Thai. Live at **https://valhalla-health.github.io/NeoRedact/** (served
from `main`, so any push to `main` is a release).

## The guarantee

The raw, pre-redaction photo and the patient's name never leave the phone — not to a server,
not to storage, not to any export. That is the whole point of the app, and it's enforced
structurally rather than by convention:

- There is exactly one working canvas for the photo. No copy of the pre-redaction pixels is
  kept alive past the redact step.
- The wizard will not advance to Review until `redactor.js` has actually applied the
  blackout and set its flag.
- The one network call the app makes (Sync) reads only from the already-redacted canvas and
  the manually-typed field values. It has no access to anything upstream of redaction.

Everything except Sync works with no connection at all, including after a cold relaunch in
airplane mode.

## Codenames, not names

The cloud side is never supposed to learn who a patient is. Before taking a photo the nurse
picks a **codename** from a fixed pool of 24 — the NATO phonetic alphabet, minus two names
and with one substituted, because a codename must not be mistakable for clinical content on
a chart ("Echo" reads as a cranial ultrasound, "November" as a date of birth). That codename
is the only identity that travels: `sync.js` strips any
HN/DOB/name/AN-labeled field client-side, and the backend re-strips them server-side. The
`Submissions` sheet has no column for them at all.

The mapping from codename back to a real patient lives only in the clinician's own private
records, outside this system entirely.

## How a run goes

`codename → capture → annotate → review → export`

Annotate is where the work happens: every box drawn defaults to *redact*, and the nurse
toggles a box to *read* for fields she wants to transcribe. For three known KCMH chart pages
a template can pre-seed the logo and ID-sticker boxes (`templates.js`) — seeded boxes are
still fully editable, and there's no way to skip past Annotate without a human looking at
them.

## Layout

| Path | What it is |
|---|---|
| repo root | the PWA — `index.html` plus its `<script src>` files. Vanilla JS, no bundler, no framework. |
| `backend/` | the Google Apps Script sync backend (Sheets + Drive). Its own clasp project — run `clasp` from that folder. See `backend/README.md`. |
| `tools/neoredact-organizer/` | a personal desktop tool that files exported photos into `<codename>/<date>/`. Browser-only, File System Access API. |
| `dashboard.html` | read-only, login-gated viewer of synced submissions, grouped by codename. |

Deliberately **not** in this repo: the Phase 2 handwriting-OCR routine. It's the only piece
that reads real patient-derived photos and sends them to a cloud AI, its configuration is
entirely machine-local, and its output belongs in local storage — so it lives on disk and is
git-ignored. Nothing patient-derived is committed here, and there are no images in the repo
at all.

## Why no framework

The app's central operation is a destructive, imperative canvas mutation that must complete
before the photo is displayed, exported or synced. A framework re-render touching that same
canvas could silently undo or bypass the blackout — an unacceptable risk class for a tool
whose entire purpose is a privacy guarantee. Plain DOM + canvas removes it.

## Running locally

Service workers need `http(s)://` — opening `index.html` via `file://` will not work.

```
python -m http.server 8000
```

Then from a phone on the same network: `http://<your-machine-LAN-IP>:8000/`

Before shipping any change, run the offline test: load over Wi-Fi, complete one full cycle,
turn on airplane mode, fully close the app, relaunch from the home-screen icon, and complete
another full cycle. Capture, redact, field entry and export must all still work.

## Contributing

`CLAUDE.md` in this repo is the detailed engineering document — architecture, the privacy
invariant in full, why the codename list exists in three copies with three deliberately
different lengths, and the decisions that should not be "fixed". Read it before changing
anything.

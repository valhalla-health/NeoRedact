# NeoRedact Organizer

Personal desktop tool. Sorts NeoRedact exports already sitting in your Downloads
folder into `<codename>/<date>/` subfolders under a destination you pick
(e.g. `C:\Users\USER\LocalOnly`). Does not touch redaction or OCR — those files
are already fully processed by the time this tool sees them.

Local only: no server, no account, no network call of any kind. Runs entirely
in your browser via the File System Access API.

## Requirements

- Chrome or Edge on Windows (the File System Access API this tool depends on
  isn't available in Firefox or Safari, and isn't reliable on mobile).

## Use

1. Double-click `start.bat`. It opens `http://localhost:8743/` in your
   default browser (needs a local server — `file://` can't use the File
   System Access API for security reasons).
2. **Choose folder** for Source → your Downloads folder (or wherever your
   browser saves NeoRedact exports).
3. **Choose folder** for Destination → `C:\Users\USER\LocalOnly` (or wherever
   you want the sorted copies).
4. Click **Scan** — lists every `neoredact-*` file found, with the codename
   and date parsed out of its filename.
5. Click **Organize** — copies each one into
   `<Destination>\<Codename>\<Date>\<filename>`, creating folders as needed.
   Originals stay in Downloads unless you tick "Delete originals" first.

Folder choices are remembered (via IndexedDB) — after the first run, Scan and
Organize just work without re-picking. Use "Forget saved folders" to reset.

## How it avoids re-organizing the same file twice

A small `.neoredact-organized.json` manifest is written into the destination
folder, tracking which source filenames have already been copied. Re-scanning
after a previous run only shows genuinely new files.

## Filename format this expects

Matches what `NeoRedact/export.js` produces:
`neoredact-[photo-]<Codename>-<YYYYMMDD>-<HHMMSS>-<id>.<png|txt|json>`

`<Codename>` is matched against `app.js`'s `CODENAMES` array (27 names,
including `X-ray`, which contains its own hyphen — parsed as one atomic
token, not split apart). Anything not matching this pattern is left alone and
flagged as "unrecognized" in the Scan table, never touched.

That array is deliberately a **superset** of the frontend's `../../codenames.js`
(24), and must only ever grow — it has to recognize every name that was ever
exported, not just the ones a nurse can pick today. `Echo` and `X-ray` (dropped
2026-07-20) and `November` (renamed to `Nomad` 2026-08-10) all still appear in
real files in Downloads. Trimming this list to match the frontend would make
those older exports unrecognized, so they'd silently never get filed. Add names
here when the frontend adds them; never remove.

## Personal tool, but public source

This is a personal admin tool, not something nurses install. It used to be kept
out of the repo for that reason; as of 2026-08-10 it lives in the public
NeoRedact repo at `tools/neoredact-organizer/` anyway, because it holds a third
copy of the codename list and keeping those copies apart is exactly what let
them drift out of sync.

Publishing the source is safe — it holds no credentials and no patient data, and
it never sends anything anywhere (no server, no account, no network call). What
it *organizes* is a different matter: the files it sorts are patient-derived and
belong in `LocalOnly`, never in this or any other repo.

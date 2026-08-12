# neoredact-ocr-routine

Local desktop tool (Phase 2 of NeoRedact): reads already-redacted flowsheet
photos and runs Claude-vision OCR to extract the handwritten fields that
on-device Tesseract can't read reliably (see `NeoRedact/CLAUDE.md`).

## PDPA — read before flipping to real mode

Redacting the patient's name is **not** enough on its own. HN and DOB are
still personal data (arguably quasi-identifying by themselves — a hospital
number is exactly what staff use to pull the real record), and health data is
*sensitive* personal data under Thailand's PDPA (Section 26), which needs a
stronger legal basis than ordinary notice. Sending any of it to Claude's API
is also a cross-border transfer (Section 28) to a US-based processor — a
separate question from whether the name is blacked out. The original
admission consent almost certainly doesn't cover this specific use.

This is a KCMH IT/legal/DPO decision, not a technical one. Don't set
`"dpoApproved": true` in `config.json` until that's actually been cleared.

## Safety gates built into `run.js`

- **Test mode is the default.** With `"mode": "test"` in `config.json`, the
  script only ever reads `sample/sample-label.png` (a synthetic test image,
  not a real patient) and writes to `output-test/`.
- **Real mode requires two explicit switches**, both by hand: `"mode": "real"`
  *and* `"dpoApproved": true`. If either is missing, the script refuses to run
  and prints the PDPA reminder above.

## Setup

```
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
```

## Running (test mode — safe, default)

```
node run.js
```

Reads the sample image, writes `output-test/<date>/sample-label.md` +
`.json`. Re-running skips already-processed files (tracked in
`processed.json`).

## Switching to real mode (only after DPO approval)

1. Install **Google Drive for Desktop** and mirror the `NeoRedact
   Submissions` folder (the one `neoredact-sync/Code.gs` creates) to a local
   folder on this PC.
2. In `config.json`, set:
   - `"mode": "real"`
   - `"dpoApproved": true`
   - `"sourceDir"` — the local mirrored Drive folder from step 1
   - `"outputDir"` — a folder under your OneDrive-synced Desktop, so the
     `.md`/`.json` output shows up in OneDrive automatically. Share that
     folder with whoever needs it via OneDrive's normal "Share" button —
     this tool doesn't touch OneDrive's sharing API.
3. `node run.js`

## Alternative: no API key needed

Instead of this script, you can ask Claude Code to do the same job interactively — say
"OCR วันนี้" or invoke `/neoredact-ocr`. It reads `config.json` and `processed.json` from
this same folder, so it shares state with `run.js` (either one picks up where the other
left off) and enforces the exact same `mode`/`dpoApproved` gate. Use this if you'd rather
not set up separate Anthropic API billing — it rides on your existing Claude Code access.
See `~/.claude/skills/neoredact-ocr/SKILL.md` for what it does step by step.

## What it writes

One `.md` and one `.json` per photo, in `<outputDir>/<yyyy-mm-dd>/`:

- `.md` — a small table of field → value, for reading.
- `.json` — the same data, for anything downstream that wants it.

The prompt sent to Claude explicitly tells it every blacked-out area is
permanently unreadable by design and to never guess or reconstruct a name,
even from a visible fragment — the same invariant the NeoRedact app itself
enforces before OCR ever runs.

## Aggregating to one CSV per patient

```
node aggregate-csv.js
```

Rolls the per-photo `.md`/`.json` files above into one CSV per codename, one
row per photo, written to `<outputDir>/csv/`. Reads only files this tool (or
the `/neoredact-ocr` skill) already wrote — never touches source photos and
never calls Claude, so it carries none of the PDPA gate above; whatever it
reads has already been through that gate (or, in test mode, is the synthetic
sample). Codename and the photo's original date aren't in the `.json` itself
(`writeOutputs()` never carried them over) — this script recovers both by
parsing the sibling `.md`'s "Source photo" line, anchored against
`config.sourceDir` so a coincidentally date-shaped ancestor folder (an old
backup directory, say) can't get misread as the real `<codename>/<yyyy-MM-dd>`
pair. `csv/` is gitignored, same reasoning as `output-real/`.

Each patient's CSV only has columns for fields Claude actually found on
*their* photos — two patients' CSVs won't necessarily have the same columns.
Fine for a per-patient file, but worth knowing before concatenating multiple
patients' CSVs into one analysis dataset later.

### Codename reuse

The codename pool is fixed at 24 names and is *meant* to be reused across
different patients over time — see CLAUDE.md's codename identity model.
"Date disambiguates a reused codename," but that mapping lives only in
Praew's private, off-system sheet; this script has no access to it and never
guesses when a codename has flipped to a new patient. Two things follow from
that:

- **Every CSV always has a `days_since_previous_photo` column**, computed
  within whatever the final output group is. A large gap is informational
  only, surfaced so it can be checked by hand — it is deliberately *not* used
  to auto-split. A long gap is normal for a real NICU/BPD stay (months, not
  days), so treating it as evidence of a new patient would misfire constantly
  for exactly this app's population.
- **Real splitting only happens if you tell it to**, via an optional
  `episodesFile` path in `config.json`:

  ```json
  {
    "Alpha": [
      { "start": "2026-01-01", "end": "2026-03-15", "label": "Alpha-1" },
      { "start": "2026-06-01", "end": null, "label": "Alpha-2" }
    ]
  }
  ```

  `end: null` means still ongoing. Fill this in from your private mapping —
  codename + date range + a label, never a real name or HN. A codename with
  no entry here is left as a single `<codename>.csv`, same as always. A photo
  whose date falls in a gap between defined ranges goes to
  `<codename>-unassigned.csv` rather than being dropped or guessed into the
  nearest episode — check those by hand. Like `sourceDir`/`outputDir`, this
  file should live outside the repo once it holds real episode boundaries —
  it's not identifying on its own, but it's still metadata about real
  admissions, so keep it with the rest of the real output rather than
  committing it. Overlapping ranges or a label reused across codenames print
  a warning (and use the first match) rather than failing silently.

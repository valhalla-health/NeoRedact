// Rolls run.js's (or the /neoredact-ocr skill's) per-photo .md+.json output
// into one CSV per patient, grouped by codename, one row per photo.
//
// This script never touches source photos and never calls Claude — it only
// reshapes .md/.json files that some earlier, gated run has already written
// to outputDir. It carries none of run.js's PDPA gate concerns because it
// can't cause a new disclosure: whatever it reads already passed through
// that gate (or, in test mode, is the synthetic sample).
//
// writeOutputs() in run.js doesn't put the codename or original photo date
// into the .json — only the sibling .md's "Source photo" line has the full
// path, which follows the app's documented Drive layout
// <codename>/<yyyy-MM-dd>/<syncId>.jpg. This script parses codename/date back
// out of that line rather than changing run.js's output format.
//
// CODENAME REUSE: the codename pool is fixed at 24 names and *is* meant to be
// reused across different patients over time — CLAUDE.md's codename identity
// model says "date is what disambiguates a reused codename," and that
// disambiguating mapping lives only in Praew's private, off-system sheet.
// This script has no access to that mapping and can't know on its own when a
// codename flipped to a new patient, so it never guesses:
//   - `days_since_previous_photo` is always computed and always shown, so a
//     suspiciously large gap is visible rather than silently smoothed over —
//     but it's informational only, never used to auto-split. A long gap is
//     normal for a real NICU/BPD stay, not evidence of a new patient.
//   - If (and only if) an `episodesFile` is configured in config.json, its
//     manually-entered codename+date-range+label boundaries (sourced from
//     Praew's private mapping, never containing real names/HN) are used to
//     split a reused codename's rows into separate, correctly-labeled CSVs.
//     No episodesFile entry for a codename means no split, same as before.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(HERE, 'config.json'), 'utf8'));

const outputDir = config.mode === 'real' ? config.outputDir : path.join(HERE, 'output-test');
const csvDir = path.join(outputDir, 'csv');

function findJsonFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJsonFiles(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

// Anchored to config.sourceDir when possible: <codename>/<yyyy-MM-dd>/<file>
// means the first two segments of the path *relative to sourceDir* are
// codename and date, regardless of anything above sourceDir in the absolute
// path. Only falls back to scanning the whole path for a yyyy-MM-dd-shaped
// segment when there's no usable sourceDir to anchor to (test mode, or a
// source path that turns out to be outside the configured root) — that scan
// is kept as a last resort, not the primary method, because an ancestor
// directory (a dated backup folder, say) could coincidentally match and
// silently misattribute a photo's fields to the wrong patient.
export function extractCodenameAndDate(sourcePhoto, sourceDir) {
  if (!sourcePhoto) return { codename: 'unknown', sourceDate: '' };

  if (sourceDir && !sourceDir.includes('REPLACE_WITH')) {
    const rel = path.relative(sourceDir, sourcePhoto);
    const relSegments = rel.split(/[\\/]/).filter(Boolean);
    if (relSegments.length >= 3 && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { codename: relSegments[0], sourceDate: relSegments[1] };
    }
  }

  const segments = sourcePhoto.split(/[\\/]/);
  const dateIdx = segments.findIndex((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  if (dateIdx > 0) return { codename: segments[dateIdx - 1], sourceDate: segments[dateIdx] };
  return { codename: 'unknown', sourceDate: '' };
}

function parseSourceInfo(mdPath, sourceDir) {
  if (!existsSync(mdPath)) {
    return { codename: 'unknown', sourceDate: '', sourcePhoto: '', processedAt: '' };
  }
  const md = readFileSync(mdPath, 'utf8');
  const sourceMatch = md.match(/Source photo: `([^`]+)`/);
  const processedMatch = md.match(/Processed: (\S+)/);
  const sourcePhoto = sourceMatch ? sourceMatch[1] : '';
  const processedAt = processedMatch ? processedMatch[1] : '';
  const { codename, sourceDate } = extractCodenameAndDate(sourcePhoto, sourceDir);

  return { codename, sourceDate, sourcePhoto, processedAt };
}

// Whole calendar days between two yyyy-MM-dd strings (UTC, so no local-TZ/DST
// drift). Returns '' if either side is missing or unparseable, rather than
// NaN — an empty gap column means "can't tell," not "zero."
export function daysBetween(laterStr, earlierStr) {
  if (!laterStr || !earlierStr) return '';
  const later = Date.parse(`${laterStr}T00:00:00Z`);
  const earlier = Date.parse(`${earlierStr}T00:00:00Z`);
  if (Number.isNaN(later) || Number.isNaN(earlier)) return '';
  return Math.round((later - earlier) / 86400000);
}

function rangesOverlap(a, b) {
  const aEnd = a.end || '9999-12-31';
  const bEnd = b.end || '9999-12-31';
  return a.start <= bEnd && b.start <= aEnd;
}

// episodesFile format: { "<codename>": [{ "start": "yyyy-MM-dd", "end":
// "yyyy-MM-dd" | null, "label": "Alpha-1" }, ...] }. Manually maintained by
// Praew from her private codename+date mapping — never contains real
// names/HN, just boundaries. A codename with no entry here isn't split.
export function loadEpisodes(episodesFile) {
  if (!episodesFile || !existsSync(episodesFile)) return {};
  const raw = JSON.parse(readFileSync(episodesFile, 'utf8'));

  const seenLabels = new Map();
  for (const [codename, ranges] of Object.entries(raw)) {
    for (const r of ranges) {
      if (seenLabels.has(r.label)) {
        console.error(`Warning: episode label "${r.label}" used for both ${seenLabels.get(r.label)} and ${codename} in ${episodesFile} — labels must be unique.`);
      }
      seenLabels.set(r.label, codename);
    }
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        if (rangesOverlap(ranges[i], ranges[j])) {
          console.error(`Warning: ${codename} has overlapping episode ranges "${ranges[i].label}" and "${ranges[j].label}" in ${episodesFile} — first match wins per row; fix the ranges.`);
        }
      }
    }
  }
  return raw;
}

function matchEpisodeLabel(codename, sourceDate, episodes) {
  const ranges = episodes[codename];
  if (!ranges || !sourceDate) return null;
  for (const r of ranges) {
    const end = r.end || '9999-12-31';
    if (sourceDate >= r.start && sourceDate <= end) return r.label;
  }
  return null;
}

// Splits patient-grouped rows into final output groups. A codename with no
// episodesFile entry stays as one group (today's behavior, unchanged). A
// codename with entries gets split by date into each range's label, with
// anything matching no defined range going to "<codename>-unassigned"
// rather than being silently dropped or guessed into the nearest episode.
export function splitByEpisode(byPatient, episodes) {
  const byOutputGroup = new Map();
  for (const [codename, rows] of byPatient) {
    if (!episodes[codename]) {
      byOutputGroup.set(codename, rows);
      continue;
    }
    for (const row of rows) {
      const label = matchEpisodeLabel(codename, row.source_date, episodes) || `${codename}-unassigned`;
      if (!byOutputGroup.has(label)) byOutputGroup.set(label, []);
      byOutputGroup.get(label).push(row);
    }
  }
  return byOutputGroup;
}

function csvEscape(value) {
  let s;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  writeFileSync(filePath, lines.join('\n') + '\n');
}

function main() {
  const jsonFiles = findJsonFiles(outputDir);
  if (jsonFiles.length === 0) {
    console.log(`No OCR output found under ${outputDir}. Run "node run.js" (or /neoredact-ocr) first.`);
    return;
  }

  const episodes = loadEpisodes(config.episodesFile);
  const byPatient = new Map();

  for (const jsonPath of jsonFiles) {
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    const { codename, sourceDate, sourcePhoto, processedAt } = parseSourceInfo(mdPath, config.sourceDir);

    let fields;
    try {
      fields = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      console.error(`Skipping ${jsonPath}: ${err.message}`);
      continue;
    }

    const row = {
      codename,
      source_date: sourceDate,
      processed_at: processedAt,
      source_file: sourcePhoto ? path.basename(sourcePhoto) : path.basename(jsonPath),
      ...fields,
    };

    if (!byPatient.has(codename)) byPatient.set(codename, []);
    byPatient.get(codename).push(row);
  }

  const byOutputGroup = splitByEpisode(byPatient, episodes);

  mkdirSync(csvDir, { recursive: true });
  let totalRows = 0;

  for (const [label, rows] of [...byOutputGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.sort((a, b) => (a.source_date || '').localeCompare(b.source_date || ''));
    rows.forEach((row, i) => {
      row.days_since_previous_photo = i === 0 ? '' : daysBetween(row.source_date, rows[i - 1].source_date);
    });

    const fixedCols = ['codename', 'source_date', 'days_since_previous_photo', 'processed_at', 'source_file'];
    const fieldCols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => !fixedCols.includes(k))))].sort();
    const columns = [...fixedCols, ...fieldCols];

    writeCsv(path.join(csvDir, `${label}.csv`), rows, columns);
    totalRows += rows.length;
    console.log(`${label}.csv — ${rows.length} photo(s)`);
  }

  console.log(`\nDone. ${byOutputGroup.size} CSV(s), ${totalRows} row(s) total, written to ${csvDir}`);
  if (Object.keys(episodes).length > 0) {
    console.log(`Episode boundaries applied from ${config.episodesFile}.`);
  }
}

main();

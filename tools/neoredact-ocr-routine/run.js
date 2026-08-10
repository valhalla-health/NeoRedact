// Local desktop routine (Phase 2): reads already-redacted NeoRedact photos and
// runs Claude-vision OCR to pull out the handwritten fields Tesseract can't
// read reliably (see NeoRedact/CLAUDE.md — on-device OCR only handles printed
// text). Writes one .md + .json per photo.
//
// SAFETY GATE: config.json's "mode" must be "real" AND "dpoApproved" must be
// true before this will touch anything outside sample/sample-label.png. Both
// must be set by hand, on purpose, after hospital IT/legal/DPO clears sending
// redacted patient photos to a third-party AI API (Claude). See README.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(HERE, '.env'));

const config = JSON.parse(readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const PROCESSED_LOG = path.join(HERE, 'processed.json');

const EXTRACTION_PROMPT = `This is a photo of a NICU patient flowsheet or label. The patient's
name has already been permanently blacked out by the nurse who took the photo, before you ever
saw it. Do not attempt to guess, reconstruct, or output any name, even if a fragment looks
visible near a redaction box — treat every blacked-out area as fully unreadable, by design.

Read every other printed and handwritten field you can find (HN, DOB, ward, weight, vitals,
intake/output, diagnosis, dates, times, etc.) and return ONLY a JSON object mapping each field
name to its value as a string. Use null for anything illegible. No prose, no markdown fences —
just the JSON object.`;

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
}

function loadProcessedSet() {
  if (!existsSync(PROCESSED_LOG)) return new Set();
  try { return new Set(JSON.parse(readFileSync(PROCESSED_LOG, 'utf8'))); } catch { return new Set(); }
}

function saveProcessedSet(set) {
  writeFileSync(PROCESSED_LOG, JSON.stringify([...set], null, 2));
}

function findImages(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findImages(full));
    else if (/\.(jpe?g|png)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function mimeFor(file) {
  return file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

async function extractFields(client, model, imagePath) {
  const base64 = readFileSync(imagePath).toString('base64');
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeFor(imagePath), data: base64 } },
        { type: 'text', text: EXTRACTION_PROMPT },
      ],
    }],
  });
  const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  try {
    return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
  } catch (err) {
    return { _parse_error: err.message, _raw_response: text };
  }
}

function writeOutputs(outputDir, imagePath, fields) {
  const dateDir = path.join(outputDir, new Date().toISOString().slice(0, 10));
  mkdirSync(dateDir, { recursive: true });
  const base = path.basename(imagePath).replace(/\.[^.]+$/, '');

  const md = [
    `# ${base}`,
    '',
    `Source photo: \`${imagePath}\``,
    `Processed: ${new Date().toISOString()}`,
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(fields).map(([k, v]) => `| ${k} | ${v ?? '_(illegible)_'} |`),
    '',
  ].join('\n');

  writeFileSync(path.join(dateDir, `${base}.md`), md);
  writeFileSync(path.join(dateDir, `${base}.json`), JSON.stringify(fields, null, 2));
}

async function main() {
  const isReal = config.mode === 'real';

  if (isReal && !config.dpoApproved) {
    console.error(
      '\nRefusing to run in "real" mode: config.json has "dpoApproved": false.\n' +
      'This step sends redacted patient photos to Claude\'s API (a third-party US processor).\n' +
      'Set "dpoApproved": true only after KCMH IT/legal/DPO has actually cleared this — see README.md.\n'
    );
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const sourceDir = isReal ? config.sourceDir : path.join(HERE, 'sample');
  const outputDir = isReal ? config.outputDir : path.join(HERE, 'output-test');

  if (isReal && (sourceDir.includes('REPLACE_WITH') || !existsSync(sourceDir))) {
    console.error(`Set a real, existing "sourceDir" in config.json first (a local folder mirroring your Drive submissions).`);
    process.exit(1);
  }
  if (isReal && outputDir.includes('REPLACE_WITH')) {
    console.error(`Set a real "outputDir" in config.json first (put it under your OneDrive-synced Desktop folder).`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const processed = loadProcessedSet();
  const images = findImages(sourceDir);
  let done = 0;

  for (const imagePath of images) {
    const key = `${imagePath}:${statSync(imagePath).mtimeMs}`;
    if (processed.has(key)) continue;

    console.log(`Reading ${imagePath} ...`);
    const fields = await extractFields(client, config.model, imagePath);
    writeOutputs(outputDir, imagePath, fields);
    processed.add(key);
    done++;
  }

  saveProcessedSet(processed);
  console.log(`Done. Mode: ${config.mode}. Processed ${done} new image(s), skipped ${images.length - done} already-seen.`);
  console.log(`Output written to: ${outputDir}`);
}

main().catch((err) => {
  console.error('Routine failed:', err);
  process.exit(1);
});

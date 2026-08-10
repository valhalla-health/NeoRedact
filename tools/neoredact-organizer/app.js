// Personal desktop tool: sorts NeoRedact exports already sitting in Downloads
// into <codename>/<date>/ folders under a chosen destination (e.g. LocalOnly).
// Never touches redaction/OCR — those files are already fully processed by
// the time this tool sees them. Copy-by-default, delete-originals is opt-in.
'use strict';

// Deliberately NOT the same list as ../../codenames.js — this one is a
// superset and must only ever GROW.
//
// The frontend list is "what a nurse may pick today" (24). This one is "what
// may appear in a filename that already exists on disk", which includes every
// name ever shipped: Echo and X-ray (dropped 2026-07-20) and November (renamed
// to Nomad 2026-08-10) are all still sitting in real exports in Downloads. Trim
// this list to match the frontend and those older files stop being recognized
// and silently never get filed.
//
// So: when a codename is added to the frontend, add it here too. When one is
// removed from the frontend, leave it here. 27 = the 26 NATO names + Nomad.
const CODENAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'Nomad', 'November', 'Oscar',
  'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor',
  'Whiskey', 'X-ray', 'Yankee', 'Zulu'
];
const NO_CODENAME = 'no-codename';

// "X-ray" contains a literal hyphen, same as the date/time/id separators in
// the filename — a naive split-on-"-" would misparse it. Match against the
// known codename list as one atomic alternative instead.
const NAME_ALTERNATION = [...CODENAMES, NO_CODENAME]
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const FILENAME_RE = new RegExp(
  `^neoredact-(?:photo-)?(${NAME_ALTERNATION})-(\\d{8})-(\\d{6})-([0-9a-f]+|noid)\\.(png|txt|json)$`,
  'i'
);

function parseFilename(name) {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  const ymd = m[2];
  return {
    codename: m[1],
    dateFolder: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
    id: m[4],
    ext: m[5],
  };
}

// --- IndexedDB: remember picked folder handles across sessions -----------

const DB_NAME = 'neoredact-organizer';
const STORE = 'handles';
const MANIFEST_NAME = '.neoredact-organized.json';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function ensurePermission(handle, mode) {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

// --- Folder scanning / organizing ------------------------------------------

async function scanSource(sourceHandle) {
  const items = [];
  for await (const [name, entryHandle] of sourceHandle.entries()) {
    if (entryHandle.kind !== 'file') continue;
    if (!/^neoredact-/i.test(name)) continue; // ignore unrelated Downloads clutter
    items.push({ name, entryHandle, parsed: parseFilename(name) });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

async function readManifest(destHandle) {
  try {
    const fh = await destHandle.getFileHandle(MANIFEST_NAME);
    const file = await fh.getFile();
    return JSON.parse(await file.text());
  } catch (e) {
    return {};
  }
}

async function writeManifest(destHandle, manifest) {
  const fh = await destHandle.getFileHandle(MANIFEST_NAME, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(manifest, null, 2));
  await w.close();
}

async function copyFileTo(entryHandle, destDirHandle, name) {
  const file = await entryHandle.getFile();
  const destFh = await destDirHandle.getFileHandle(name, { create: true });
  const w = await destFh.createWritable();
  await w.write(file);
  await w.close();
}

async function organizeAll(sourceHandle, destHandle, items, deleteOriginals, onProgress) {
  const manifest = await readManifest(destHandle);
  let done = 0, skipped = 0, errors = 0;

  for (const item of items) {
    if (!item.parsed) {
      skipped++;
      onProgress(`skip (unrecognized name): ${item.name}`, 'err');
      continue;
    }
    if (manifest[item.name]) {
      skipped++;
      onProgress(`skip (already organized): ${item.name}`);
      continue;
    }
    try {
      const codenameDir = await destHandle.getDirectoryHandle(item.parsed.codename, { create: true });
      const dateDir = await codenameDir.getDirectoryHandle(item.parsed.dateFolder, { create: true });
      await copyFileTo(item.entryHandle, dateDir, item.name);
      if (deleteOriginals) await sourceHandle.removeEntry(item.name);
      manifest[item.name] = {
        organizedAt: new Date().toISOString(),
        destPath: `${item.parsed.codename}/${item.parsed.dateFolder}/${item.name}`,
      };
      done++;
      onProgress(`moved: ${item.name} -> ${item.parsed.codename}/${item.parsed.dateFolder}/`, 'ok');
    } catch (err) {
      errors++;
      onProgress(`error on ${item.name}: ${err.message}`, 'err');
    }
  }

  await writeManifest(destHandle, manifest);
  return { done, skipped, errors };
}

// --- UI ---------------------------------------------------------------------

(function () {
  const el = {
    compatWarning: document.getElementById('compatWarning'),
    sourceFolderName: document.getElementById('sourceFolderName'),
    destFolderName: document.getElementById('destFolderName'),
    btnPickSource: document.getElementById('btnPickSource'),
    btnPickDest: document.getElementById('btnPickDest'),
    btnForgetFolders: document.getElementById('btnForgetFolders'),
    btnScan: document.getElementById('btnScan'),
    scanSummary: document.getElementById('scanSummary'),
    scanTable: document.getElementById('scanTable'),
    chkDeleteOriginals: document.getElementById('chkDeleteOriginals'),
    btnOrganize: document.getElementById('btnOrganize'),
    logBox: document.getElementById('logBox'),
  };

  let sourceHandle = null;
  let destHandle = null;
  let lastScan = [];

  function log(msg, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    el.logBox.appendChild(line);
    el.logBox.scrollTop = el.logBox.scrollHeight;
  }

  function updateButtons() {
    el.btnScan.disabled = !(sourceHandle && destHandle);
    el.btnOrganize.disabled = !(sourceHandle && destHandle && lastScan.length > 0);
  }

  function renderScanTable(items) {
    el.scanTable.innerHTML = '';
    if (!items.length) {
      el.scanSummary.textContent = 'No neoredact- files found in the source folder.';
      return;
    }
    const recognized = items.filter((i) => i.parsed);
    const unrecognized = items.filter((i) => !i.parsed);
    el.scanSummary.textContent =
      `${recognized.length} file(s) ready to organize` +
      (unrecognized.length ? `, ${unrecognized.length} unrecognized (left alone)` : '');

    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>File</th><th>Codename</th><th>Date</th></tr>';
    el.scanTable.appendChild(thead);
    const tbody = document.createElement('tbody');
    items.forEach((item) => {
      const tr = document.createElement('tr');
      if (!item.parsed) {
        tr.className = 'unrecognized';
        tr.innerHTML = `<td>${item.name}</td><td colspan="2">not a NeoRedact export filename</td>`;
      } else {
        tr.innerHTML = `<td>${item.name}</td><td>${item.parsed.codename}</td><td>${item.parsed.dateFolder}</td>`;
      }
      tbody.appendChild(tr);
    });
    el.scanTable.appendChild(tbody);
  }

  el.btnPickSource.addEventListener('click', async () => {
    try {
      sourceHandle = await window.showDirectoryPicker();
      await idbSet('source', sourceHandle);
      el.sourceFolderName.textContent = sourceHandle.name;
      updateButtons();
    } catch (e) { /* user cancelled the picker */ }
  });

  el.btnPickDest.addEventListener('click', async () => {
    try {
      destHandle = await window.showDirectoryPicker();
      await idbSet('dest', destHandle);
      el.destFolderName.textContent = destHandle.name;
      updateButtons();
    } catch (e) { /* user cancelled the picker */ }
  });

  el.btnForgetFolders.addEventListener('click', async () => {
    await idbDelete('source');
    await idbDelete('dest');
    sourceHandle = null;
    destHandle = null;
    el.sourceFolderName.textContent = 'not set';
    el.destFolderName.textContent = 'not set';
    lastScan = [];
    el.scanTable.innerHTML = '';
    el.scanSummary.textContent = '';
    updateButtons();
  });

  el.btnScan.addEventListener('click', async () => {
    el.btnScan.disabled = true;
    el.scanSummary.textContent = 'Scanning…';
    lastScan = await scanSource(sourceHandle);
    renderScanTable(lastScan);
    updateButtons();
  });

  el.btnOrganize.addEventListener('click', async () => {
    el.btnOrganize.disabled = true;
    el.logBox.textContent = '';
    log(`Organizing ${lastScan.length} file(s)…`);
    const result = await organizeAll(
      sourceHandle,
      destHandle,
      lastScan,
      el.chkDeleteOriginals.checked,
      log
    );
    log(`Done: ${result.done} moved, ${result.skipped} skipped, ${result.errors} errors.`, result.errors ? 'err' : 'ok');
    lastScan = await scanSource(sourceHandle); // refresh so already-organized files drop off
    renderScanTable(lastScan);
    updateButtons();
  });

  async function restoreFolders() {
    const savedSource = await idbGet('source');
    if (savedSource && (await ensurePermission(savedSource, 'readwrite'))) {
      sourceHandle = savedSource;
      el.sourceFolderName.textContent = sourceHandle.name;
    }
    const savedDest = await idbGet('dest');
    if (savedDest && (await ensurePermission(savedDest, 'readwrite'))) {
      destHandle = savedDest;
      el.destFolderName.textContent = destHandle.name;
    }
    updateButtons();
  }

  if (!window.showDirectoryPicker) {
    el.compatWarning.style.display = 'block';
    [el.btnPickSource, el.btnPickDest, el.btnScan, el.btnOrganize].forEach((b) => (b.disabled = true));
  } else {
    restoreFolders();
  }
})();

#!/usr/bin/env node
// Static checks for a repo with no build step.
//
// These apps ship exactly what is committed: the .jsx files are transpiled in
// the browser by @babel/standalone, and the .gs files are pushed to Apps
// Script as-is. There is no compile step between a commit and the ward, so a
// syntax error or a renamed file is only discovered when a page fails to load.
// These checks are the cheapest guard against that.
//
// Run locally with:  node tools/ci-verify.cjs
const { execSync } = require('child_process');
const { readFileSync, existsSync } = require('fs');
const path = require('path');

// Google Identity Services is served from an unversioned, rolling URL and
// cannot carry a Subresource Integrity hash. Everything else pinned to a CDN
// must have one.
const SRI_EXEMPT = [/^https:\/\/accounts\.google\.com\/gsi\/client$/];

const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const problems = [];
const parser = require('@babel/parser');

const code = tracked.filter((f) => /\.(js|jsx|gs)$/.test(f));
for (const f of code) {
  try {
    parser.parse(readFileSync(f, 'utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] });
  } catch (e) {
    problems.push(`${f}: ${String(e.message).split('\n')[0]}`);
  }
}

const json = tracked.filter((f) => f.endsWith('.json'));
for (const f of json) {
  try { JSON.parse(readFileSync(f, 'utf8')); }
  catch (e) { problems.push(`${f}: ${String(e.message).split('\n')[0]}`); }
}

let localRefs = 0, externalScripts = 0;
for (const f of tracked.filter((x) => x.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  const dir = path.posix.dirname(f);
  for (const m of html.matchAll(/<(script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
    const [tag, kind, url] = [m[0], m[1].toLowerCase(), m[2]];
    if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('#')) {
      if (kind !== 'script') continue;
      externalScripts++;
      if (!/\bintegrity=/i.test(tag) && !SRI_EXEMPT.some((re) => re.test(url))) {
        problems.push(`${f}: external script without integrity= -> ${url}`);
      }
      continue;
    }
    localRefs++;
    const target = path.posix.normalize(path.posix.join(dir, url.split(/[?#]/)[0]));
    if (!existsSync(target)) problems.push(`${f}: references a file that does not exist -> ${url}`);
  }
}

console.log(`parsed ${code.length} js/jsx/gs, ${json.length} json; checked ${localRefs} local refs and ${externalScripts} external scripts`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('all checks passed');

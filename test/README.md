# Tests

Plain Node, no dependencies, no install step. Node 18+:

```bash
node test/verify-auth.cjs
node test/verify-submit-input.cjs
node test/verify-dashboard-escaping.cjs
```

All three are run by `.github/workflows/test.yml` on every push and pull request.

- **`verify-auth.cjs`** — the security contract of `backend/Code.gs`: a Google
  ID token is trusted only after Google confirms it and only if it was issued
  for this app; signing in never creates a staff account; the dashboard is
  admin-only; the `Staff` sheet is re-read on every request so deactivating a
  row takes effect at once; and an unusable session still answers
  `not authenticated`, which is the wording `sync.js` keys on to re-login
  instead of dropping a queued photo. Since the follow-up, also the password
  path — five failures lock an address for 15 minutes, each attempt counted
  under the script lock before its password is hashed (checked with twenty
  overlapping requests); an address with no password behind it answers the
  same, at the same cost; passwords are stored stretched and old ones upgraded
  on login — and that an internal failure never shows the caller its detail.

- **`verify-submit-input.cjs`** — what a submission can make the backend
  write: nothing a phone sends is stored as a live formula, and a `syncId` is
  refused unless it has a shape the app mints. The accepted shapes come from
  the real `sync.js`, run in a `vm` with and without `crypto.randomUUID`, so a
  client change that mints a new shape fails here before it strands photos in
  phones' offline queues.

- **`verify-dashboard-escaping.cjs`** — loads `dashboard.js` against a small
  fake DOM and asserts that no submitted value (ward, field label, field text,
  codename) is ever handed to `innerHTML`, and that only a real Drive URL
  becomes a link. Admin-only access is worth little if a submitted row can run
  script in the admin's browser.

The backend harnesses load the real `backend/Code.gs` into a Node `vm`, with
`gas-stubs.cjs` standing in for Sheets, Cache, Properties, Lock, Drive,
Utilities and `UrlFetchApp`. Point them at an older revision to watch them
fail there:

```bash
git show 735a0a7:backend/Code.gs > /tmp/before-pr8.gs   # main before PR #8
git show 60d5b83:backend/Code.gs > /tmp/pr8.gs          # PR #8, before its follow-up
NEOREDACT_GAS_SRC=/tmp/before-pr8.gs node test/verify-auth.cjs          # 21 failures
NEOREDACT_GAS_SRC=/tmp/pr8.gs        node test/verify-auth.cjs          # 11 failures
NEOREDACT_GAS_SRC=/tmp/pr8.gs        node test/verify-submit-input.cjs  #  2 failures
```

What still passes there is on purpose: the two static checks (the
`script.external_request` scope, and the client ID matching
`index.html`/`dashboard.html`) always read the working tree, and the guards pin
what a fix must not break — a nurse can still log in and submit, a password
stored the old way still works, typos don't add up to a lockout, an escaped
value reads back unchanged, every `syncId` the app mints is accepted.

These do not replace the offline test protocol in `CLAUDE.md`, and they say
nothing about what is actually deployed — the backend only changes on an
explicit `clasp` deploy.

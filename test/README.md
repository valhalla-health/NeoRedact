# Tests

Plain Node, no dependencies, no install step. Node 18+:

```bash
node test/verify-auth.cjs
node test/verify-dashboard-escaping.cjs
```

Both are run by `.github/workflows/test.yml` on every push and pull request.

- **`verify-auth.cjs`** — the security contract of `backend/Code.gs`: a Google
  ID token is trusted only after Google confirms it and only if it was issued
  for this app; signing in never creates a staff account; the dashboard is
  admin-only; the `Staff` sheet is re-read on every request so deactivating a
  row takes effect at once; and an unusable session still answers
  `not authenticated`, which is the wording `sync.js` keys on to re-login
  instead of dropping a queued photo.

  It loads the real `backend/Code.gs` into a Node `vm` with `gas-stubs.cjs`
  standing in for Sheets, Cache, Drive, Utilities and `UrlFetchApp`. Point it
  at another revision to watch it fail there:

  ```bash
  git show main:backend/Code.gs > /tmp/old.gs
  NEOREDACT_GAS_SRC=/tmp/old.gs node test/verify-auth.cjs   # 10 failures
  ```

  (The two static checks — the `script.external_request` scope and the
  client ID matching `index.html`/`dashboard.html` — always read the working
  tree, so they pass regardless of `NEOREDACT_GAS_SRC`.)

- **`verify-dashboard-escaping.cjs`** — loads `dashboard.js` against a small
  fake DOM and asserts that no submitted value (ward, field label, field text,
  codename) is ever handed to `innerHTML`, and that only a real Drive URL
  becomes a link. Admin-only access is worth little if a submitted row can run
  script in the admin's browser.

These do not replace the offline test protocol in `CLAUDE.md`, and they say
nothing about what is actually deployed — the backend only changes on an
explicit `clasp` deploy.

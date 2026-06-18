# CLAUDE.md — developer notes for agents

This is the dev-facing context for working on easycaddy. For *using* the tool,
see `README.md`. This file documents the non-obvious things that will bite you
when editing the code.

## What this is

A tiny web editor for Caddy config. Single Bun process (`server.ts`), no
database, no `node_modules`, no build step. The source of truth is the plain
Caddyfile + `snippets/*.caddy` + `sites/*.caddy` under `/etc/caddy`. RAM ~30 MB.
Keep it that way — do not add dependencies, a database, or a bundler.

## Files

- `server.ts` — the whole backend: Bun HTTP server, session auth, file CRUD,
  and the **entire frontend HTML/CSS/JS embedded as one big template-literal
  string** (`const HTML = \`...\``).
- `hosts.js` — the "Hosts" form layer (client-side JS). Served at
  `/hosts.js` as a static file (loaded into `HOSTS_JS` at startup).
- `favicon.png`, `install.sh`, `uninstall.sh`, `examples/`.

## ⚠️ The template-literal trap (read this before editing the frontend)

The frontend in `server.ts` lives inside a backtick template literal. JavaScript
*cooks* escape sequences in template literals, so any JS you write **inside that
string** is mangled before the browser ever sees it:

- `\n` becomes a real newline → breaks string literals / can break the JS.
- `\t`, `\s`, `\d`, `\.`, `\{` etc. lose their backslash → `split(/\s+/)`
  silently becomes `split(/s+/)` (splits on the letter "s"!), `/\.caddy$/`
  becomes `/.caddy$/`, and so on.

That is exactly why **`hosts.js` is a separate file** — it is normal JS with
normal escaping. **Put any non-trivial frontend logic in `hosts.js`, not in the
`HTML` string.** If you must add JS to the `HTML` string, avoid backslash
escapes (no `\n`, `\s`, `\.`), or double them (`\\s`, `\\n`) so the cooked
output is correct. Keep additions to the inline `<script>` minimal.

## Frontend load order (matters)

In the `HTML` string the scripts load as:

```html
<script src="/hosts.js"></script>   <!-- defines setView, parser, hosts UI -->
<script> ...inline... </script>     <!-- defines $$, esc, api, modal, setStatus,
                                          loadFiles, openFile, etc.; ends with an
                                          IIFE that calls showApp() -> setView() -->
```

`hosts.js` loads first but only *defines* functions; the helpers it calls
(`$$`, `esc`, `api`, `modal`, `setStatus`, `loadFiles`, `loadVersion`,
`openFile`) come from the inline script and are only touched at call time, after
the inline script has run. Don't call those helpers at the top level of
`hosts.js`.

## Hosts form layer — how it works

Pure client-side. `hosts.js`:
1. `GET /api/sites` → all `sites/*.caddy` contents in one shot.
2. `scanBlocks()` splits a file into top-level site blocks (quote/comment/brace
   aware). `blockToHost()` parses one block into a structured host object;
   recognized directives map to form fields, everything else goes into
   `advanced` (kept verbatim). `hostToText()` regenerates a Caddyfile block.
3. Saving writes one block per file via the existing `POST /api/file` (which
   auto-runs `caddy fmt`). New hosts get a new file named after the sanitized
   first domain.

**Invariants / limits — keep these:**
- One site = one file. A file with **>1 block** is marked `editable:false`
  ("raw only") so the form never clobbers sibling blocks. Don't break this.
- Filename stems must match `^[a-zA-Z0-9_-]+$` (server `NAME_RE`) — **no dots**,
  so domains are sanitized to e.g. `app-example-com`. The real domain lives
  inside the block, not in the filename.
- `multi` detection in `blockToHost`: a directive is a sub-block only if it
  spans multiple lines or its first line ends with `{`. A bare `{...}` inside a
  value (e.g. the `{uri}` placeholder in `redir`) is NOT a block. Don't regress
  this — it's the reason redirects parse correctly.

## Backend endpoints added for the Hosts view

- `GET /api/sites` — `{sites:[{path,content}]}` for `sites/*.caddy`.
- `GET /api/snippets` — `{snippets:[name,...]}` parsed from `(name) {` definitions
  in `snippets/*.caddy`. The Hosts form renders one "import" checkbox per
  detected snippet — do NOT hardcode snippet names. Bare `import <name>` is
  form-managed; `import <name> args` / globs are kept verbatim in Advanced so
  nothing is lost. Unknown imports (snippet not in the dir) still render as a
  checked box so the user can keep them.
- `POST /api/hash` — `{password}` → `{ok,hash}` via `caddy hash-password`
  (for basic auth). Requires a session like every endpoint except `/api/login`.

## Running / testing locally

- Run: `USER_NAME=admin PASS=secret bun run server.ts` (listens on :8091).
  `PORT` and `CADDY_DIR` are read from env (defaults: `8091`, `/etc/caddy`).
  Point `CADDY_DIR` at a local fixture dir to smoke-test file APIs off Linux;
  otherwise the file APIs just return empty (errors are swallowed).
- Syntax check: `bun build server.ts --target=bun >/dev/null` and
  `node --check hosts.js`.
- The parser/generator are pure functions — unit-test them by stubbing the
  browser globals (`document`, `esc`) and `vm.runInThisContext(hosts.js)`, then
  calling `scanBlocks` / `blockToHost` / `hostToText` directly.

## Deploying changes to the VPS

The systemd service runs `bun run /opt/easycaddy/server.ts`. After editing:

```bash
# copy server.ts AND hosts.js into /opt/easycaddy/ (install.sh copies both)
sudo systemctl restart easycaddy
journalctl -u easycaddy -n 50 --no-pager   # check it came up
```

If you add a new static asset, remember to copy it in `install.sh` too
(it currently copies `server.ts`, `favicon.png`, and `hosts.js`).

## Updating an existing install from GitHub (agent self-update on the VPS)

If you are an agent running ON the VPS and the user just points you at
`https://github.com/ttvn91/easycaddy` and asks you to update the running
instance, follow this. The repo is public (no auth needed) and its history was
rewritten once, so prefer `reset --hard` over `git pull`.

1. Detect whether the install dir is a git clone:
   ```bash
   git -C /opt/easycaddy rev-parse --is-inside-work-tree 2>/dev/null
   ```
2. **If it IS a clone** — fetch and hard-reset (history was rewritten; `pull`
   would error with "unrelated histories"):
   ```bash
   sudo git -C /opt/easycaddy fetch origin
   sudo git -C /opt/easycaddy reset --hard origin/main
   ```
3. **If it is NOT a clone** (files were copied in) — clone to a temp dir and copy
   the runtime files over. `hosts.js` is REQUIRED and is the file most often
   forgotten:
   ```bash
   tmp=$(mktemp -d)
   git clone --depth 1 https://github.com/ttvn91/easycaddy "$tmp"
   sudo cp "$tmp"/server.ts "$tmp"/hosts.js "$tmp"/favicon.png /opt/easycaddy/
   rm -rf "$tmp"
   ```
4. Restart and verify it came up:
   ```bash
   sudo systemctl restart easycaddy
   systemctl is-active easycaddy
   journalctl -u easycaddy -n 30 --no-pager
   ```
5. Sanity-check the new code is live:
   ```bash
   ls -l /opt/easycaddy/hosts.js                       # must exist
   grep -c "api/snippets" /opt/easycaddy/server.ts     # expect > 0
   ```
6. **Do NOT** modify credentials or anything under `/etc/caddy` during an update.
   If the service fails to start, the usual cause is the credential guard — the
   systemd unit must still define `USER_NAME` and `PASS` (see below). Updating
   the code never changes those; leave them as they are.

## Releasing a new version (drives self-update)

The in-app updater (`/api/update/check` + `/api/update/apply`, "Update" button in
the top bar) tracks **GitHub Releases**, not commits to `main`. To ship an update
that running instances will offer:

1. Bump the `VERSION` constant in `server.ts` (semver, e.g. `1.1.0`). This is the
   single source of truth for "what version am I running".
2. Commit and push to `main`.
3. Create the matching release/tag:
   `gh release create v1.1.0 --title "v1.1.0" --notes "..."`
   The tag must be `v<VERSION>`; `apply` downloads files from
   `raw.githubusercontent.com/<repo>/<tag>/{server.ts,hosts.js,favicon.png}`.

If you forget step 1, `check` compares the release tag against a stale `VERSION`
and either never offers the update or offers it forever. If you forget step 3,
nothing happens — there's no release to find. `apply` only ever overwrites those
three runtime files and sanity-checks `server.ts` (must contain `Bun.serve`)
before writing; it then restarts via `systemd-run` so the live process can reply
first. Sessions are in-memory, so users are logged out across the restart (the
client polls `/favicon.png` and reloads to the login screen) — expected.

## Credentials & onboarding (how to help a user set a password)

There are **no default credentials**. `server.ts` reads `USER_NAME` and `PASS`
from the environment and `process.exit(1)`s if either is missing. Never reuse the
old `adam`/`changeme` defaults and never hardcode or commit a credential.

When a user clones this repo and asks you to get it running / set a password:

1. **Generate a strong password** for them (don't invent a weak one):
   `openssl rand -hex 16`
2. **Ask for the username** — do not assume one (no identifying placeholder like
   a person's name). Let them choose; suggest something neutral like `admin`.
3. **Wire it in** depending on how they run it:
   - Full install: `sudo EASYCADDY_USER=<user> EASYCADDY_PASS=<pass> ./install.sh`
     (the installer writes `USER_NAME`/`PASS` into the systemd unit). With no env
     vars it prompts for the user and generates a random password itself.
   - Existing systemd service: edit `/etc/caddy`'s unit at
     `/etc/systemd/system/easycaddy.service`
     (`Environment=USER_NAME=...`, `Environment=PASS=...`), then
     `sudo systemctl daemon-reload && sudo systemctl restart easycaddy`.
   - Manual/dev: `USER_NAME=<user> PASS=<pass> bun run server.ts`.
4. **Tell the user the credentials once** and remind them it lives only on their
   machine/server — never put it in the repo, a commit, or a chat log you persist.

## Security constraints (don't loosen)

- Every endpoint except `/api/login` requires a valid session cookie.
- `safePath()` / `NAME_RE` reject path traversal and exotic names — keep all new
  file operations behind them.
- The service runs as root (needs to write `/etc/caddy` and reload Caddy). Treat
  any new shell-out (`$\`...\``) as a potential injection point: only pass values
  that have been validated, the way `/api/hash` and `safePath` do.

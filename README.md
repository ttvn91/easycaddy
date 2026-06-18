# easycaddy

A tiny, dependency-free web editor for [Caddy](https://caddyserver.com) server config files. Single Bun process, ~30 MB RAM, no Docker, no database.

Edit `/etc/caddy/Caddyfile` plus your `snippets/` and `sites/` directly in the browser. Validate, reload, and inspect certs / upstreams / access logs — all from one screen.

![easycaddy](https://img.shields.io/badge/runtime-Bun-black) ![caddy](https://img.shields.io/badge/Caddy-v2.11%2B-1f88c0) ![license](https://img.shields.io/badge/license-MIT-green)

## Install in one command

On a fresh Debian/Ubuntu server, run **this single command** — no cloning, no Docker, no extra setup:

```bash
curl -fsSL https://raw.githubusercontent.com/ttvn91/easycaddy/main/install.sh | sudo bash
```

That's it. The installer downloads everything from the latest GitHub release,
installs Caddy + Bun if missing, and **interactively asks you to set the admin
username and password** (leave the password blank to auto-generate a strong one).
When it finishes it prints the URL and login. Open `http://<server-ip>:8091`.

<details>
<summary>Options (version pin, unattended/CI, ports)</summary>

```bash
# Pin a specific version (tag or branch)
curl -fsSL https://raw.githubusercontent.com/ttvn91/easycaddy/main/install.sh | sudo EASYCADDY_REF=v1.0.0 bash

# Fully unattended — set credentials up front so there are no prompts
curl -fsSL https://raw.githubusercontent.com/ttvn91/easycaddy/main/install.sh \
  | sudo EASYCADDY_USER=admin EASYCADDY_PASS='your-strong-secret' EASYCADDY_PORT=8091 bash
```

`SKIP_CADDY_INSTALL=1` / `SKIP_BUN_INSTALL=1` skip those if already managed elsewhere.
</details>

After install, easycaddy can **update itself** from the in-app **Update** button
when a new release is published — see [Updating](#updating).

## Why easycaddy instead of caddymanager?

|                  | easycaddy                                | caddymanager                                   |
| ---------------- | ---------------------------------------- | ---------------------------------------------- |
| RAM (idle)       | ~30 MB                                   | ~234 MB (Docker: backend + frontend + daemon)  |
| Disk             | ~80 MB (Bun + source)                    | ~150 MB images                                 |
| Dependencies     | None — just Bun                          | Docker + MongoDB/SQLite                        |
| Source of truth  | Plain Caddyfile (git-friendly)           | JSON inside a database                         |
| Reload mechanism | `systemctl reload caddy` (real reload)   | Push via admin API                             |
| Install          | One command                              | docker-compose + DB setup                      |

## Features

- **Hosts view** — a form-based editor for your `sites/`:
  - Add/edit reverse proxies, redirections, and static/file-server sites via forms — no hand-writing Caddyfile syntax
  - Cards show each site's domain, target, TLS mode, and badges (gzip / HSTS / auth)
  - TLS options: automatic HTTPS, `tls internal`, or custom cert/key; optional HSTS and HTTP basic auth (hashed via `caddy hash-password`)
  - Anything the form doesn't cover goes in an **Advanced** box, kept verbatim
  - Still backed by plain `.caddy` files (one site per file) — no database, no lock-in. Hand-written blocks that the form can't safely round-trip are flagged and open in the raw editor
  - Toggle to the **Files** view any time for full raw editing
- Edit `Caddyfile`, `snippets/*.caddy`, and `sites/*.caddy` from the browser
- File tree sidebar with create / rename / delete
- **Validate** button — runs `caddy validate` before reload
- **Reload** button — `systemctl reload caddy`, applied live
- Auto-format on save — `caddy fmt --overwrite`
- Cookie session auth (`HttpOnly`, `Secure` when behind HTTPS, `SameSite=Strict`, 7-day TTL)
- Bottom panel with three tabs:
  - **Certs** — list of issued certificates with days-until-expiry (>30 green, 14–30 yellow, <14 red)
  - **Upstreams** — backend health from Caddy admin API (request count + failures)
  - **Logs** — tail of the access log, auto-refreshes every 5 s
- Caddy version badge in the toolbar
- Keyboard shortcut: `Ctrl/Cmd + S` to save

## Install from source (clone)

The one-command install above is the recommended path. To install from a local
clone instead (e.g. for development):

```bash
git clone https://github.com/ttvn91/easycaddy.git
cd easycaddy
sudo ./install.sh
```

The installer will:

1. Install Caddy from the official Cloudsmith apt repo (if not already present)
2. Install the Bun runtime (if not already present)
3. Create a default `/etc/caddy/` skeleton with `snippets/` and `sites/` directories
4. Copy easycaddy into `/opt/easycaddy/`
5. Create and start a `easycaddy` systemd service
6. Print the URL and admin credentials

**Supported OS:** Debian and Ubuntu (uses `apt`).

## Credentials

> **There are no built-in default credentials.** The server reads the admin
> username and password from the `USER_NAME` and `PASS` environment variables and
> **refuses to start if either is missing** — so a misconfigured instance can
> never be reachable with a guessable login.

How the two layers fit together:

| Where you set it                  | Variable name              | Notes                                              |
| --------------------------------- | -------------------------- | -------------------------------------------------- |
| `install.sh` (install time)       | `EASYCADDY_USER` / `EASYCADDY_PASS` | Optional. If unset, prompts for the username and password (blank password = random 16-byte hex). The installer writes the result into the systemd unit as `USER_NAME` / `PASS`. |
| systemd unit (running service)    | `USER_NAME` / `PASS`       | What the server actually reads at runtime.          |
| `bun run server.ts` (manual/dev)  | `USER_NAME` / `PASS`       | Required — the process exits with an error if unset. |

**Generate a strong password** (16 random bytes, hex):

```bash
openssl rand -hex 16
```

**Run manually without the installer** (e.g. local dev or a custom setup):

```bash
USER_NAME=admin PASS="$(openssl rand -hex 16)" bun run server.ts
# the password you pass in is the one you log in with — note it down
```

The credentials live only in your systemd unit / shell environment on the
server. **Nothing secret is committed to the repo**, so cloning from GitHub gives
you the code but never anyone's login.

## Install options

By default the installer **prompts for both the admin username and password** (a blank password auto-generates a random 16-byte hex one). The username — and the password if it was generated — are printed at the end. You can skip the prompts by passing the values as environment variables — useful for unattended installs:

```bash
sudo EASYCADDY_USER=alice \
     EASYCADDY_PASS='my-secure-pass' \
     EASYCADDY_PORT=8091 \
     ./install.sh
```

When piped from `curl`, the installer reads the prompt from `/dev/tty`, so you can still answer interactively:

```bash
curl -fsSL https://raw.githubusercontent.com/ttvn91/easycaddy/main/install.sh | sudo bash
# → "Admin username for easycaddy: _"
```

If you need a fully non-interactive install (e.g. CI), pass `EASYCADDY_USER` explicitly.

To change the password later:

```bash
sudo sed -i 's|Environment=PASS=.*|Environment=PASS=new_pass|' /etc/systemd/system/easycaddy.service
sudo systemctl daemon-reload && sudo systemctl restart easycaddy
```

Skip flags (useful when Caddy or Bun is already managed elsewhere):

- `SKIP_CADDY_INSTALL=1`
- `SKIP_BUN_INSTALL=1`

## Reverse proxy via Caddy (HTTPS)

The recommended way to expose easycaddy is behind Caddy itself, so you get automatic Let's Encrypt certificates and don't have to open the editor port to the internet.

`/etc/caddy/sites/easycaddy.caddy`:

```caddyfile
caddy.yourdomain.com {
    reverse_proxy localhost:8091
}
```

Reload Caddy, then open `https://caddy.yourdomain.com`. easycaddy detects the HTTPS forwarding (via `X-Forwarded-Proto`) and sets the `Secure` flag on the session cookie automatically.

## API endpoints

All endpoints (except `/api/login`) require a valid session cookie.

| Method   | Path                       | Body / Query              | Notes                                  |
| -------- | -------------------------- | ------------------------- | -------------------------------------- |
| `POST`   | `/api/login`               | `{user, password}`        | Sets session cookie                    |
| `POST`   | `/api/logout`              | —                         | Clears session                         |
| `GET`    | `/api/whoami`              | —                         | Returns current user or 401            |
| `GET`    | `/api/files`               | —                         | List Caddyfile + snippets + sites      |
| `GET`    | `/api/sites`               | —                         | All `sites/*.caddy` contents (Hosts view) |
| `GET`    | `/api/snippets`            | —                         | Snippet names defined in `snippets/`   |
| `POST`   | `/api/hash`                | `{password}`              | `caddy hash-password` for basic auth   |
| `GET`    | `/api/file`                | `?path=...`               | Read file content                      |
| `POST`   | `/api/file`                | `{path, content}`         | Save and auto-format                   |
| `DELETE` | `/api/file`                | `?path=...`               | Delete file (Caddyfile is protected)   |
| `POST`   | `/api/create`              | `{dir, name}`             | Create empty `.caddy` in snippets/sites |
| `POST`   | `/api/rename`              | `{oldPath, newName}`      | Rename a snippet or site file          |
| `POST`   | `/api/validate`            | —                         | Run `caddy validate`                   |
| `POST`   | `/api/reload`              | —                         | `systemctl reload caddy`               |
| `GET`    | `/api/info`                | —                         | Caddy version                          |
| `GET`    | `/api/certs`               | —                         | Issued certificates with expiry        |
| `GET`    | `/api/upstreams`           | —                         | Reverse-proxy upstream health          |
| `GET`    | `/api/log`                 | `?lines=N` (1–1000)       | Tail of the Caddy access log           |
| `GET`    | `/api/update/check`        | —                         | Compare running version vs latest release |
| `POST`   | `/api/update/apply`        | —                         | Download latest release and self-restart |

## Updating

easycaddy can update itself from its GitHub Releases. When a newer release is
published, an **Update** button appears in the top bar; clicking it downloads the
release's `server.ts` / `hosts.js` / `favicon.png` over HTTPS and restarts the
service (you'll be logged out and sign in again).

The update tracks **tagged releases**, not every commit to `main`, so updates are
deliberate. The running version is the `VERSION` constant in `server.ts`.

> **Security note:** the update fetches code from GitHub and runs it as **root**
> (the service runs as root). Only enable/use this if you trust the repo and its
> account. It downloads exclusively over HTTPS from `raw.githubusercontent.com`
> at a pinned release tag and sanity-checks `server.ts` before overwriting, but a
> compromised upstream would still mean root code execution. To disable
> self-update entirely, the endpoints can be removed — manual update (git or
> file copy) always works.

## Uninstall

```bash
sudo ./uninstall.sh
```

This removes the systemd service and `/opt/easycaddy/`. Caddy itself and `/etc/caddy/` are left untouched.

## Security notes

- The service runs as **root** because it needs to write `/etc/caddy/*` and run `systemctl reload caddy`. Treat the admin password like the root password of the box.
- File names are restricted to `[A-Za-z0-9_-]+\.caddy`. Path-traversal and exotic names are rejected on both list and write paths.
- The session cookie is `HttpOnly` and `SameSite=Strict`. The `Secure` flag is set automatically when the request arrives over HTTPS (directly or via `X-Forwarded-Proto`).
- Sessions are kept in memory and are lost on restart. Re-logging in is the expected flow for a single-admin tool.
- For production use, put easycaddy behind Caddy with HTTPS rather than exposing port `8091` directly.

## Stack

- [Bun](https://bun.sh) — runtime and HTTP server, no `node_modules`
- [Caddy](https://caddyserver.com) v2.11+
- Plain HTML + vanilla JS + CSS, no build step

## License

[MIT](LICENSE)

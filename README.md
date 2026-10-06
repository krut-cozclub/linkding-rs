# linkding-rs

A tiny, very fast rewrite of [linkding](https://github.com/sissbruecker/linkding) in Rust.
One static binary (~11 MB image), ~2 MB RAM idle, SQLite / PostgreSQL / MySQL, a dependency-free HTML + JS frontend that uses linkding's own stylesheets, so it looks and behaves like the original.

**Compatible with:** the official linkding browser extensions (Chrome/Firefox), the bookmarklet, the linkding REST API
(`/api/bookmarks/`, `/api/tags/`, `/api/user/profile/`, `check`, archive/unarchive, upsert-by-URL, token auth), and
linkding's Netscape-HTML import/export (including `[linkding-notes]`, `TOREAD`, `PRIVATE` and the `linkding:bookmarks.archived` tag).

**Features:** bookmarks with tags, notes (Markdown), unread/shared flags, archive, bundles (with live preview and drag-to-reorder), bulk edit, details view, search with autocomplete and saved preferences (`#tag`, `!unread`, `and/or/not`, parentheses), tag management and merge, alphabetical tag cloud, API tokens, bookmarklet, import/export, light/dark/auto theme, custom CSS.

**Not implemented (yet):** assets/snapshots (singlefile), favicon/preview image storage, feeds, OIDC / auth-proxy, auto-tagging rules, multi-user admin UI.


## One-click deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/krut-cozclub/linkding-rs)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/github?repo=https://github.com/krut-cozclub/linkding-rs)

Prebuilt multi-arch image: `ghcr.io/krut-cozclub/linkding-rs:latest` (amd64 + arm64). Static binaries for Linux, macOS and Windows are on the [Releases](https://github.com/krut-cozclub/linkding-rs/releases) page.

```sh
docker run -p 9090:9090 -v ld-data:/data \
  -e LD_SUPERUSER_NAME=admin -e LD_SUPERUSER_PASSWORD=change-me \
  ghcr.io/krut-cozclub/linkding-rs:latest
```

## Run it

```sh
docker build -t linkding-rs .
docker run -p 9090:9090 -v ld-data:/data \
  -e LD_SUPERUSER_NAME=admin -e LD_SUPERUSER_PASSWORD=change-me linkding-rs
```
Open http://localhost:9090 → **Settings → Browser extension & API** to create an API token for the extension
(Base URL = your server URL, no trailing slash needed).

## Configuration (environment variables)

### Required

| Variable | Example | Why |
|---|---|---|
| `LD_SUPERUSER_NAME` | `admin` | Username of the first account. It is created on startup if it doesn't exist. Without it there is no way to log in. |
| `LD_SUPERUSER_PASSWORD` | `a-long-random-password` | Password for that account (only used when the account is created). |

### Required only for Postgres / MySQL

| Variable | Example | Why |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` or `mysql://user:pass@host:3306/db` | Selects the database by URL scheme. **Leave it unset to use SQLite**, but then mount a persistent volume at `/data`, otherwise bookmarks are lost on every redeploy. |

On Railway use `${{Postgres.DATABASE_URL}}` (or the MySQL equivalent). On Render use the database's connection string (the blueprints wire this up for you).

### Optional

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `9090` | Railway and Render set this automatically; don't set it there. |
| `LD_SERVER_HOST` | `::` | Bind address. Falls back to `0.0.0.0` if IPv6 is unavailable. |
| `LD_DB_POOL` | `5` | Max database connections. |
| `LD_DISABLE_URL_VALIDATION` | off | Set to `true` to accept any URL scheme (default allows http, https, ftp, ftps). |
| `LD_ALLOWED_INTERNAL_HOSTS` | – | Hosts the metadata scraper may reach on private networks (`*` = all). Blocked by default (SSRF protection). |
| `LD_SESSION_COOKIE_AGE` | `1209600` | Login session lifetime in seconds (14 days). |
| `LD_CORS_ALLOWED_ORIGINS` | – | Comma-separated origins allowed to call `/api/` from a browser. |

Minimal examples:

```sh
# SQLite (needs a volume at /data)
LD_SUPERUSER_NAME=admin  LD_SUPERUSER_PASSWORD=change-me

# Postgres
LD_SUPERUSER_NAME=admin  LD_SUPERUSER_PASSWORD=change-me  DATABASE_URL=postgres://user:pass@host:5432/linkding
```

Metadata scraping is SSRF-protected: private, loopback and link-local addresses are blocked unless allow-listed.

## Deploy

**Railway** – New project → Deploy from repo (uses `railway.json` + `Dockerfile`).
* SQLite: add a Volume mounted at `/data`.
* Postgres/MySQL: add the database plugin and set `DATABASE_URL` to its connection variable (`${{Postgres.DATABASE_URL}}`).
* Set `LD_SUPERUSER_NAME` and `LD_SUPERUSER_PASSWORD`.

**Render** – a web service on Render, pick the variant that fits (Blueprint = New → Blueprint → select the repo; choose a variant via *Blueprint file path*):

| Variant | File | Notes |
|---|---|---|
| Docker build from source (default, one-click button above) | `render.yaml` | SQLite on a persistent disk (paid plan) |
| Prebuilt image, no build step | `deploy/render/image.yaml` | Fastest deploys; uses `ghcr.io/krut-cozclub/linkding-rs` (image must be public) |
| Free tier + free Postgres | `deploy/render/free-postgres.yaml` | Service sleeps when idle; free DB expires after 30 days |
| Native Rust runtime (no Docker) | `deploy/render/native-rust.yaml` | Render compiles it for you |

Set `LD_SUPERUSER_PASSWORD` when prompted. Render supplies `PORT`; the app binds to it automatically.

## Development

```sh
cargo test                       # unit tests (search grammar, import/export format, scraper)
cargo run                        # needs a C toolchain; or use Docker (see below)
scripts/smoke.sh http://localhost:9090 admin change-me   # end-to-end API test, works on every database
```

## Credits

The look and feel (stylesheets, icons, markup structure) come from [linkding](https://github.com/sissbruecker/linkding) by Sascha Ißbrücker, MIT licensed — see `THIRD_PARTY_LICENSE_linkding.txt`.

## Why it is fast

* Single binary, no ORM, hand-written SQL, prepared-statement caching, SQLite in WAL mode.
* Bookmark tags are loaded for a whole page in one query; list + count run concurrently.
* Token and session lookups are cached in memory; the web UI shell is embedded in the binary with ETags and immutable caching.
* The frontend is ~25 KB of dependency-free JS with optimistic updates and debounced search.

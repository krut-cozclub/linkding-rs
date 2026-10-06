# linkding-rs

A tiny, very fast rewrite of [linkding](https://github.com/sissbruecker/linkding) in Rust.
One static binary (~11 MB image), ~2 MB RAM idle, SQLite / PostgreSQL / MySQL, plain HTML + JS frontend.

**Compatible with:** the official linkding browser extensions (Chrome/Firefox), the bookmarklet, the linkding REST API
(`/api/bookmarks/`, `/api/tags/`, `/api/user/profile/`, `check`, archive/unarchive, upsert-by-URL, token auth), and
linkding's Netscape-HTML import/export (including `[linkding-notes]`, `TOREAD`, `PRIVATE` and the `linkding:bookmarks.archived` tag).

**Not implemented (yet):** bundles, assets/snapshots (singlefile), favicon/preview image storage, feeds, OIDC / auth-proxy, auto-tagging rules, multi-user admin UI.


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

## Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `sqlite://data/db.sqlite3` | `sqlite://…`, `postgres://…` / `postgresql://…`, `mysql://…` |
| `PORT` | `9090` | Railway / Render set this automatically |
| `LD_SUPERUSER_NAME` / `LD_SUPERUSER_PASSWORD` | – | Created on first start if missing |
| `LD_SERVER_HOST` | `::` | Falls back to `0.0.0.0` if IPv6 is unavailable |
| `LD_DB_POOL` | `5` | Max DB connections |
| `LD_DISABLE_URL_VALIDATION` | off | Accept any URL scheme |
| `LD_ALLOWED_INTERNAL_HOSTS` | – | Hosts the metadata scraper may reach on private networks (`*` = all) |
| `LD_SESSION_COOKIE_AGE` | `1209600` | Seconds |
| `LD_CORS_ALLOWED_ORIGINS` | – | Comma separated |

Metadata scraping is SSRF-protected: private, loopback and link-local addresses are blocked unless allow-listed.

## Deploy

**Railway** – New project → Deploy from repo (uses `railway.json` + `Dockerfile`).
* SQLite: add a Volume mounted at `/data`.
* Postgres/MySQL: add the database plugin and set `DATABASE_URL` to its connection variable (`${{Postgres.DATABASE_URL}}`).
* Set `LD_SUPERUSER_NAME` and `LD_SUPERUSER_PASSWORD`.

**Render** – New → Blueprint, point at the repo (`render.yaml`). Defaults to SQLite on a persistent disk; the file shows
how to switch to Render Postgres. Set `LD_SUPERUSER_PASSWORD` when prompted.

## Development

```sh
cargo test                       # unit tests (search grammar, import/export format, scraper)
cargo run                        # needs a C toolchain; or use Docker (see below)
scripts/smoke.sh http://localhost:9090 admin change-me   # end-to-end API test, works on every database
```

## Why it is fast

* Single binary, no ORM, hand-written SQL, prepared-statement caching, SQLite in WAL mode.
* Bookmark tags are loaded for a whole page in one query; list + count run concurrently.
* Token and session lookups are cached in memory; the web UI shell is embedded in the binary with ETags and immutable caching.
* The frontend is ~25 KB of dependency-free JS with optimistic updates and debounced search.

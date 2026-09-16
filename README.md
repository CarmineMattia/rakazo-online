# Rakazo Online

Self-hosted **Rakazo** tip used on Host-002 — our divergent “online” batch.

Upstream app images still come from the published Rakazo stack; this repo keeps **our overlays and patches** (API, auth, web dist UI, computer/supervisor) plus compose helpers so we can evolve social features (user search, profile images, humans in groups) without waiting on upstream.

## What’s here

- `docker-compose.images.yml` / `docker-compose.override.yml` — image-based run + bind-mounted patches
- `patches/` — API, auth, contracts, supervisor, and web `dist` UI tip
- `computer/` — local computer image bits (e.g. PCManFM)
- `bootstrap-rakazo.sh` / `install-images.sh` — host bootstrap helpers
- `.env.images.example` — copy to `.env` and fill secrets locally (**never commit `.env`**)

## Quick start (host with Docker)

```bash
cp .env.images.example .env
# edit .env: BETTER_AUTH_*, WEB_ORIGIN, SMTP, etc.
./install-images.sh   # or follow bootstrap-rakazo.sh
docker compose -f docker-compose.images.yml -f docker-compose.override.yml up -d
```

Web UI typically on `:5173`, API on `:3100`.

## Current UI tip (patches/web/dist)

- Composer cyan loader = **model context usage** (tap → modal)
- Bot options panel = **computer RAM / memory**
- Mobile options panel scrolls to the bottom (`rk-scroll` + flex min-height fixes)

## Social (next)

Planned on this repo:

1. Find users by `@username` or email  
2. Profile images  
3. Invite humans into groups alongside bots (builds on `patches/api/space-invites.ts`)

## Safety

Do not commit real `.env` values, SMTP keys, or auth secrets. Keep LAN/tunnel origins in local env only.

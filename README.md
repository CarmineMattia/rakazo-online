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

## Social

The Host-002 overlay now provides a working first social slice:

1. **Find registered humans** by `@username` or email from **Share → People & invites**.
2. **Profile images** from an `http(s)` URL or a local image. Browser uploads are cropped to
   256×256 WebP and stored in Better Auth's existing nullable `user.image` field (256 KB maximum).
   Images appear in the sidebar profile control, search results, and space member list.
3. **Targeted human invites** into the active space. The recipient sees the pending invitation in
   their own People panel and can join or decline. Link invites remain available for people who do
   not have an account yet.

Rakazo currently models humans at the **space** boundary and bots inside a **chat group**. Accepting
a targeted invite creates the existing organization + space memberships, so the human appears
alongside the space's bot groups without adding a second authorization model. Upstream group and
bot repositories still filter content by its owning user; cross-owner bot/group collaboration is
therefore a follow-up, not something this overlay claims to bypass. A safe follow-up needs upstream
group ACLs plus changes to thread-target, artifact, bot, and group authorization—not only another
join table.

### API surface

The image-compatible HTTP routes used by `patches/web/dist/social-overlay.js` are:

- `GET /api/users/search?q=@name` (also accepts an exact email address)
- `GET /api/profile`
- `PATCH /api/profile` with `{ "image": "https://…" }`, a bounded raster data URL, or `null`
- `POST /api/space-invites/direct` with `{ "userId": "…" }`
- `GET /api/space-invites/received`
- `POST /api/space-invites/decline` with `{ "token": "…" }`
- Existing `POST /api/space-invites/redeem` accepts both link and targeted invites and prevents a
  different account from redeeming a targeted invite.

Equivalent typed contract hooks live in `patches/contracts/rpc.ts` under `users.search`,
`preferences.update`, and `spaces.invites.{direct,received,decline}`.

All discovery and profile routes require an authenticated space member. Search returns at most ten
results, is limited to 30 requests/minute per account, excludes the caller and synthetic messaging
accounts, and only returns an email when that exact email was queried. Existing/pending members are
marked so duplicate invites are idempotent. Avatar inputs reject scriptable SVG, non-HTTP URLs,
embedded credentials, and oversized data.

The directory is deployment-wide by design for this single-host social tip. Treat separate
organizations on one database as mutually discoverable; a future multi-tenant deployment should
add an explicit directory/tenant policy before enabling this feature.

### Mounting and database update

`docker-compose.override.yml` bind-mounts the additive `patches/api/social.ts` module along with the
existing app/router/contracts overlays. The full patched web `dist` remains one read-only bind
mount; its `index.html` loads the auth, invite, and social overlays.

`patches/api/space-invites.ts` applies the two additive columns (`target_user_id`, `declined_at`) and
index with idempotent DDL on first invite/search use. `patches/api/space-invites.sql` contains the
same SQL for operators who prefer to apply it explicitly before restarting.

### Manual social test

1. Start the normal image stack with both Compose files and create two accounts with distinct
   `@human` names.
2. As account A, open **Share**, type account B's `@username`, invite it, and verify a repeated
   search says **Invited** rather than creating a duplicate.
3. As account B, open **Share**, accept **Invitations for you**, and verify the active space switches
   to A's space and both humans appear under **In this space**.
4. From either account, choose a local PNG/JPEG/WebP/GIF (or save an `http(s)` avatar URL), reload,
   and verify the image remains in the sidebar and people list. Remove it and verify initials return.
5. Create a normal link invite and confirm preview/redeem still works. Try its targeted token while
   signed in as a third account and verify the API returns `403`.

Pure validation/search helper coverage is in `patches/api/social.test.ts`; it is intended to be
copied beside `social.ts` when validating the overlay against the matching upstream source tree.

## Safety

Do not commit real `.env` values, SMTP keys, or auth secrets. Keep LAN/tunnel origins in local env only.

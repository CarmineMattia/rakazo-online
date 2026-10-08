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

The current UI uses **Share → People & invites** to invite people by link and list space members.
Username search and profile-image editing are implemented but intentionally hidden by the social
overlay styles. The available backend features are:

1. **Find registered humans** by `@username` or exact email through the authenticated API.
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

### Manual browser test

1. Start the normal image stack with both Compose files and sign in as account A.
2. Open **Share → People & invites**, create an invitation and copy its link.
3. Open that link as account B. If signed out, choose **Sign in**; switching to **Sign up** and back
   must retain the invitation in the `next` query. Complete the emailed magic-link login.
4. Accept the invitation and verify both people appear under **In this space**. Existing chats and
   bots remain private to their owners; joining a space does not grant access to them.
5. Repeat acceptance and verify it does not create a second membership.

Targeted invitations and username search are covered by the two-account API check below; their
creation controls are not visible in the current UI. Magic-link delivery and signed-in browser
acceptance still require a separate manual check.

Pure validation/search helper coverage is in `patches/api/social.test.ts`; it is intended to be
copied beside `social.ts` when validating the overlay against the matching upstream source tree.

### Verified social flow (2026-10-08)

Fixed two failures reproduced against the running image stack: the nested Prisma email filter
rejected `mode`, and deserializing the advisory lock's PostgreSQL `void` result prevented direct
invites. Search now applies case-insensitive mode at the outer email filter; invite creation
executes the lock without deserializing its result.

Four helper tests and a live two-account API check passed: signup, password sign-in, username
search without exposing email, targeted invite, duplicate invite protection, acceptance,
shared-space membership and repeated acceptance. The API check removes the accounts it creates.

With a local stack running and registrations open, reproduce it with:

```bash
node tests/social-smoke.mjs
# Optional local port override:
RAKAZO_TEST_URL=http://127.0.0.1:5173 node tests/social-smoke.mjs
```

This check creates disposable accounts with `example.invalid` addresses. Use a local test stack
with email delivery disabled; it does not test magic-link delivery or browser interaction.

The current local containers bind-mount `/home/cr1m3/projects/rakazo/patches`, while this tracked
repository is `rakazo-online`. The two corrected API modules were copied to the mounted directory
and the API restarted for verification. Other deployment differences (including Rakijazio branding)
were retained. Check mounts before applying future changes; editing this checkout alone does not
update that running stack.

### Invite login navigation (2026-10-08)

The invite page now links directly to `/sign-in?next=/invite/…`. Auth links preserve that return
path across sign-in/sign-up, existing-account redirects and login errors. New accounts arriving
from an invite return to it after email verification. Callback paths must resolve to the same
origin, including protection against protocol-relative and backslash host changes.

Three DOM tests passed for login destinations, registration destinations and unsafe redirects.
In the running browser, switching from sign-in to sign-up and back preserved the invitation.
The Share panel text now states the actual ownership behavior instead of promising shared bots.
Full email delivery and signed-in invitation acceptance have not yet been verified in the browser.

Run `node --test tests/auth-invite-navigation.test.mjs` in an environment with `jsdom` installed.
`RAKAZO_JSDOM_PATH` can point to an existing jsdom package and `RAKAZO_AUTH_OVERLAY` to the overlay
under test. The tests mock email requests and send no mail. These web changes were also applied
to the mounted runtime while retaining its existing magic-link sent-state improvements.

### Magic-link form submission (2026-10-08)

The upstream required password input was hidden by the magic-link overlay but still participated
in native browser validation. This prevented the submit event and no email request reached the
API. The overlay now disables that unused input and removes its required flag. The change is
applied to the tracked overlay and the local mounted runtime.

The three auth DOM tests now use a required password fixture, assert native form validity and
submit with `requestSubmit()` instead of bypassing browser validation. All passed. The running
browser also confirmed the password is disabled and optional. SMTP and sender are configured;
actual inbox delivery still requires a user retry after refreshing the page.

## Safety

Do not commit real `.env` values, SMTP keys, or auth secrets. Keep LAN/tunnel origins in local env only.

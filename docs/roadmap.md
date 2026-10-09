# 🗺️ Roadmap (full)

The README has a one-line summary per item; this is the full list. Items are **planned, not
done** unless ticked. Bigger items have a design doc in `docs/` with an **Open questions** list.

> 🚧 **Pending PRs:** PR #7 adds the M2a status (My hardware) and PR #8 adds **Device control
> mode** and **Live voice mode**. Their roadmap entries will be moved into this file when they
> merge.


## Next steps

- [x] Bring the live runtime back in sync: move the **Rakijazios** rebrand and the newer magic-auth
      overlay (`?v=sentfix1`) from `~/projects/rakazo` into this repo.
- [x] Commit the group sharing work and open a PR from `codex/fix-social-invites` to `main`
      (merge still pending).
- [x] Test group sharing for real: a second user in a real browser, talking to a real bot with a
      real model reply.
- [x] Verify link-invite acceptance through the `/invite/…` page by a second browser account
      (signed-out → magic link → back on the invite → joined).
- [ ] **Set password** flow in Settings for magic-only users (login and sign-up stay magic-link only).
- [ ] Verified email domain for Resend and a matching `EMAIL_FROM`, so magic links reach every user.

## Conversation model

- [ ] Keep **both** conversation types as first-class:
  - **Mixed groups** of humans and bots.
  - **Private 1:1 chats** between one human and one bot.

  This is explicitly *not* a groups-only model.

## Bot visibility

- [ ] Bots are **private by default**: a private bot is only reachable inside its own group or
      private chat and never appears in search.
- [ ] The owner can **publish** a bot (and unpublish it). Published bots appear in search for
      everyone.

## Share your local AI

- [ ] Let any user offer models that run on **their own computer** (Ollama / llama.cpp /
      OpenAI-compatible on localhost) as the backend for their bots, including in shared
      groups — without opening inbound ports. A small outbound runner pairs with a code;
      Rakazo only sends inference requests. Design: [`docs/share-local-ai.md`](share-local-ai.md).
  - [x] **M1 — same-host prototype (owner only):** outbound runner ([`runner/`](../runner/README.md)),
        api gateway, and a `shared-local` provider for one operator test bot. No pairing UI yet.
        See [`docs/share-local-ai.md` → M1 as built](share-local-ai.md#m1-as-built-2026-10-08).
  - [ ] **M2 —** pairing UI, revoke/rotate, grants for shared groups.
  - [ ] **M3 —** limits and usage.

## Bot marketplace

- [ ] A **marketplace of published bots**, with everything that follows:
  - Listing and discovery (browse and search published bots).
  - Publish / unpublish controls for owners.
  - Adding a public bot to your own private chat or group.

  Open design questions:
  - Whose models, integrations and computer run a public bot when someone else uses it? Today a
    shared bot always runs as its owner.
  - Who pays for usage: the owner, the user, or a quota/limit set by the owner?
  - What permissions and approvals apply when a public bot runs in someone else's chat
    (tools, computer access, memory and credentials)?
  - What happens to existing chats/groups using a bot when its owner unpublishes or changes it?

## Device node app (M5, long-term)

- [ ] An installable **Rakijazios app** for Linux/Windows/macOS (desktop) and Android/iOS: chat client
      + one-click local model (bundled llama.cpp, model chosen by device RAM) + the built-in runner
      that pairs the device to a Rakijazios server. Each device becomes a node running its owner's
      bots, so groups can mix humans and bots running on different hardware. Phones are mainly chat
      clients and light nodes while in the foreground. Vision:
      [`docs/share-local-ai.md` §13](share-local-ai.md#13-vision-rakijazios-app-as-a-device-node-m5).

-- Space invite links (self-host). Safe to re-run.
CREATE TABLE IF NOT EXISTS space_invites (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  target_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  redeemed_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL
);
ALTER TABLE space_invites ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE space_invites
  ADD COLUMN IF NOT EXISTS target_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS space_invites_space_id_idx ON space_invites(space_id);
CREATE INDEX IF NOT EXISTS space_invites_token_idx ON space_invites(token);
CREATE INDEX IF NOT EXISTS space_invites_target_user_idx
  ON space_invites(target_user_id, expires_at);

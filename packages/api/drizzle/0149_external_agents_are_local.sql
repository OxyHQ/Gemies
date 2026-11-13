-- oxy:deploy-phase=post
--
-- ADR 0036: an external agent has no Oxy account. Every live one becomes a `local` gemie: its name and
-- colour move onto its row, and it stops naming the `bot` account pairing used to mint for it. Post
-- phase, so the image that still read `oxy_account_id` as always present has drained; the image this
-- rollout ships reads either identity.
--
-- The name and colour are what pairing gave the account: `<CLI> · <computer>` and the CLI's colour
-- (`EXTERNAL_AGENT_CLI_LABELS` and `EXTERNAL_AGENT_CLI_COLORS` in `domain/external-agent.ts`, which
-- pairing now writes to the row). Measured before this was written: production held one live external
-- agent (and one revoked, whose row is gone), and its account still carried exactly those, unedited.
--
-- A `local` gemie is its owner's alone (`agents_local_identity_check`): private, unlisted, no mailbox,
-- nobody's own assistant, and owned by the person who paired it, who is the link's owner. Revoked links
-- are skipped: their agents were deleted on revoke (ADR 0032).
UPDATE "agents" AS a SET
  "identity" = 'local',
  "local_name" = CASE l."cli"
      WHEN 'claude' THEN 'Claude Code'
      WHEN 'codex' THEN 'Codex'
      WHEN 'opencode' THEN 'OpenCode'
    END || ' · ' || l."host_name",
  "local_color" = CASE l."cli"
      WHEN 'claude' THEN 'orange'
      WHEN 'codex' THEN 'graphite'
      WHEN 'opencode' THEN 'teal'
    END,
  "oxy_account_id" = NULL,
  "owner_oxy_account_id" = l."owner_oxy_user_id",
  "is_published" = false,
  "access" = 'private',
  "mailbox" = false,
  "reach" = 'grants',
  "updated_at" = now()
FROM "external_agent_links" AS l
WHERE l."agent_id" = a."id" AND l."revoked_at" IS NULL AND a."identity" = 'oxy';

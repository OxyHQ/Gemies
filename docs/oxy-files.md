# Alia on Oxy Files

How Alia stores bytes under oxy ADR 0043 (application-owned files, references,
lifecycle), how existing bytes move out of Alia's own bucket, and when that
bucket can be retired. The decision is [ADR 0019](./adr/0019-alia-stores-files-in-oxy-files.md);
the code is `packages/api/src/lib/files/`.

## Who owns what

| What | Owner | Visibility | Reference (`entityType`/`entityId`) | Where today |
|---|---|---|---|---|
| A library upload | **the person** | private | `library_file`/row id | **Oxy Files** (`uploadUserMedia` for media ≤ 40 MiB, else `uploadUserMediaLarge`) |
| A spoken clip (TTS cache) | **Alia** (a cache Alia expires) | private | `speech_clip`/cache key | **Oxy Files** (`uploadAppFile`, audio) |
| A catalogue skill's bundled file | **Alia** | private | `skill_file`/row id | **Oxy Files** (`uploadAppFileLarge`; small media streamed) |
| A person's own skill's bundled file | **the person** | private | `skill_file`/row id | **Oxy Files** (`uploadUserMediaLarge`; small media streamed) |
| Media sent on a channel | **the person** | private | its message's `file` part | **Oxy Files** only, under the channel's task (`storeChannelMedia`) |

- **A spoken clip is Alia's, not the person's.** It is a 30-day cache that Alia
  deletes when unused and with its conversation. An account's file is never
  deleted behind its owner's back (ADR 0043 D5), so a clip owned by the person
  could never expire; it would pile up as "not in use" in their file manager.
  As Alia's, releasing the reference IS the expiry: Oxy trashes an unreferenced
  application file after 24 hours and purges it 30 days later.
- **Podcast covers are not Gemies' any more.** Podcast generation belongs to
  Syra (a gemie reaches it through the Syra connector), so Gemies draws and
  stores no cover. Migration `0170` dropped the series and released, through the
  outbox below, each cover reference Gemies held; Syra keeps its own reference
  on the same file. The outbox still admits that entity class
  (`RELEASE_ONLY_OXY_FILE_ENTITY_TYPES`) until production holds no row of it.

## How a use reaches Oxy

Every row that names an Oxy file records the use in the **same transaction** as
the row (`oxy_file_reference_sync`, `db/files/oxyFileRepository.ts`): a desired
state, `present` or `absent`, per (file, entity). Writing the row and telling
Oxy can therefore never disagree after a crash. The worker
(`lib/files/oxy-file-sync.ts`) drains it on every task under leases into
`references.add` / `references.remove`, backing off 1 minute doubling to 6 hours
and dead-lettering after 16 attempts. `not_found` on an add (the file is gone, or
not one Alia may use) is not retried; the next reconciliation reports it as
`refused`.

Upload → reference is one flow: the bytes are stored first (never inside a
database transaction), the row and its reference commit together. If the row
never commits, the stored bytes are named by nothing, and each kind is collected
by construction:

- an Oxy file **Alia** owns has no reference, so Oxy trashes it after 24 hours;
- a legacy object was marked in `storage_gc_candidates` **before** it was
  written, with an hour's grace; the collector deletes it once no row names it;
- a **person's** Oxy file stays theirs, shown as "not in use" — ADR 0043 D5 —
  never deleted behind their back.

This is what fixes the skill store's old "uploaded, then the transaction
failed" orphan (and the leak of every deleted skill's objects, which the
deterministic keys never covered): skill rows and their file references commit
together, and keys are unique per upload so the collector can never take a key
another import is rewriting.

**Nightly reconciliation** (ADR 0043 D6) sends Oxy the full inventory of each
entity type, streamed from Postgres in keyset pages. It runs once a day per type
on the trigger-engine leader, claimed through `oxy_file_reconcile_runs` (which
also records the last result), so restarts and several tasks still run it once.
Every entity type in use is reconciled: `library_file`, `speech_clip` and
`skill_file`.

## File events

`POST /webhooks/oxy-files` receives Oxy's file events, mounted above
`express.json()` because the `oxy-signature` HMAC covers the raw bytes, and
verified with `verifyFileEventSignature` from `@oxy.so/core/server`.

1. In Oxy Console → Alia → Webhooks → **File events** (or
   `PUT https://api.oxy.so/applications/6a2f851751b784a86fd0e934/files-webhook`
   `{ "url": … }` as an owner or admin of the application's account), set
   `https://api.gemies.ai/webhooks/oxy-files`. Oxy sends a `webhook.challenge`
   that the endpoint echoes — before Alia holds any secret, since registering
   is what issues it; the `whsec_…` secret is shown **once**. Every successful
   registration issues a NEW secret, so changing the URL is also a rotation.
2. Write it to SSM: `/oxy/alia/OXY_FILES_WEBHOOK_SECRET`, then bind it in the
   task definition (SSM first, then the binding — `docs/deployment.md`) and
   roll the service so the tasks read it. Without the secret the route answers
   the challenge and 404 to everything else; until the tasks hold the new
   secret, events are refused and Oxy retries them (1 minute doubling, 16
   attempts).

Registered at `https://api.gemies.ai/webhooks/oxy-files` on 2026-11-13, with the
secret bound from `oxy-alia:758`.

| Event | What Alia does |
|---|---|
| `file.deleted`, `file.blocked` | every row of Alia that used the file lets go of it: a library file or a spoken clip loses its row; a skill's bundled file is logged as an error (a published version cannot drop a file; the file route answers 404 for it) |
| `file.trashed`, `file.restored`, `file.unblocked`, `file.visibility_changed` | logged |

Delivery is at least once. An event is remembered (`oxy_file_events`, 30 days)
only after it was handled, so a failure answers 500 and is delivered again.

## Moving what is already stored

`src/scripts/migrate-to-oxy-files.ts`, bundled to
`packages/api/dist/scripts/migrate-to-oxy-files.js`. It acts as Alia through the
task role's attested identity, which a checkout does not have, so it runs as an
ECS one-shot on the live task definition (the same networking and role as the
service), with the command overridden:

```bash
TD=$(aws ecs describe-services --cluster oxy-cluster --services alia \
  --query 'services[0].taskDefinition' --output text)
NET=$(aws ecs describe-services --cluster oxy-cluster --services alia \
  --query 'services[0].networkConfiguration' --output json)
aws ecs run-task --cluster oxy-cluster --launch-type FARGATE --task-definition "$TD" \
  --network-configuration "$NET" --overrides '{"containerOverrides":[{"name":"alia",
  "command":["bun","packages/api/dist/scripts/migrate-to-oxy-files.js",
  "--target-database=alia","--kind","library"]}]}'
```

The report (one JSON line per item) goes to the task's log; the summary line is
the last one. Preview is the default; `--apply` writes. Every run names its database
(`--target-database`), reads each item, hashes it, and copies it only if the
hash Oxy reports equals the hash of what was read (a skill file must also match
the sha256 its row was written with). Reports are JSON lines with sha256
hashes, never URLs. The work list is "rows naming a legacy object and no Oxy
file", and an applied item sets its Oxy column and reference in one
transaction, so a stopped run resumes where it stopped. The legacy copy is kept
as the read fallback until the bucket is retired.

An apply is paced to Oxy's upload budget: Oxy lets an application make 30
uploads a minute, a large upload spends two (start and complete), and the run
spends at most 24 of them (`MIGRATION_UPLOADS_PER_MINUTE`) so Alia's live writes
keep the rest. An item Oxy answers 429 waits a minute and is tried again; it is
reported `failed` only after eleven 429s in a row.

### Library files, spoken clips, skill files

New writes go to Oxy with no switch (stage 4c, OxyHQ/oxy#1774, is in
production). A write that fell back logs `Oxy did not take private content;
storing it in the legacy bucket` with its `kind` and `reason` (CloudWatch
`/oxy/ecs`, streams `alia/…`), and leaves a row on legacy storage that
`--status` counts (`rowsOnLegacyStorage`). The process counters
(`alia_oxy_files_fallback_writes_total`, `alia_legacy_storage_reads_total`) are
not scraped — the API serves no `/metrics` — so the log and `--status` are what
to watch. A steady `not_private` or `oxy_404` means Oxy stopped serving 4c, an
incident on Oxy's side; every such write still lands in the bucket and is moved
by the next backfill.

Backfill each kind, preview first, then a canary, then the rest (arguments to
the one-shot above):

```bash
--target-database=alia --kind library                    # preview
--target-database=alia --kind library --apply --limit 20 # canary
--target-database=alia --kind library --apply
```

and the same for `--kind speech` and `--kind skills`. An item Oxy does not take
(below) is reported `failed` and stays on legacy storage; the next run tries it
again. A PERSON's file (every `library` item, a person's own skill file) is
reported `skipped`: Oxy stores it only with that person's requester proof, and
a backfill acts for nobody, so it stays on legacy storage.

## How private content is stored (stage 4c)

Everything is in ONE module, `packages/api/src/lib/files/oxy-files.ts`; a test
fails if any other source stores bytes in Oxy or reads them back.

- **Always `visibility: 'private'`.** A person's file is theirs (the library,
  their own skills): Oxy writes Alia a consent grant when Alia stores it for
  them, so `linkedDownloadUrls` serves it back to Alia — until the person
  revokes Alia's access in their file manager. Alia's own files (clips,
  catalogue skills) are always readable by Alia.
- **As the person, with their own proof.** Oxy stores user media for a
  first-party workload only into the account its verified requester proof
  names (`requireUserMediaOwner`); the owner Alia names is never enough. A
  person's file is uploaded through `assets.withRequester(proof)`: their
  session bearer on their own request (the library, their skills;
  `ownSessionProof`), or the channel's task for media that arrived on a
  channel. With no proof Oxy is not asked: the write falls back (reason
  `no_requester`), and a channel's media is not kept.
- **Which upload.** Media (image, video, audio) of at most 40 MiB is streamed
  (`uploadAppFile` / `uploadUserMedia`); anything else — PDFs, documents, text,
  archives, skill binaries, files over 40 MiB — is a resumable large upload
  (`uploadAppFileLarge` / `uploadUserMediaLarge`, up to 8 GiB).
- **Checked before it is recorded.** Oxy must report the sha256 of the bytes
  sent and `private`. A deduplicated file comes back as it was, and an Oxy
  without stage 4c stores a person's small upload public, so either check
  failing means the row is not pointed at that file.
- **Falls back, never fails a person's action.** A write Oxy does not take — a type its content policy refuses (executables and active
  documents, 415), an API without stage 4c, a file not stored private, an
  SVG (stored sanitized, so another hash), Oxy unreachable — is written to the
  legacy bucket instead, logged and counted in
  `alia_oxy_files_fallback_writes_total{kind,reason}`. The one exception is
  taken-down bytes (451 `CONTENT_BLOCKED`): the upload fails, as it would for
  any owner.
- **Reads.** The Oxy file first; the legacy copy when there is no Oxy file, or
  when Oxy fails to answer during the move (counted as a legacy read). When
  Oxy REFUSES — the person revoked Alia's access, the file is gone or taken
  down — the answer stands and the legacy copy is not read around it.

## Retiring the bucket

The bucket (`AWS_S3_BUCKET`) is retired only when BOTH hold, measured with
`migrate:oxy-files --status --window-days 14`:

- **zero legacy reads** for 14 consecutive days in `legacy_storage_reads`
  (the durable count; the process counter `alia_legacy_storage_reads_total` is
  not scraped) — every read
  served from the bucket by `/media`, the skill file route and the dual-read
  fallback is counted there;
- **zero rows still on legacy storage** (`rowsOnLegacyStorage`: library files,
  clips and skill files with a key and no Oxy file), and an empty reference
  outbox (`referenceOutbox`).

Then, in order: a `post` migration dropping the legacy key columns
(`library_files.url`/`thumbnail`,
`speech_clips.object_key`, `skill_files.s3_key`) together with the code paths
that read them, `lib/s3.ts` and the garbage collector; then empty and delete
the bucket and remove `AWS_S3_BUCKET` and the IAM grant.
`audio_job` reads are the retired audio-generation feature's results; their rows
expire after a day, so that kind reaches zero by itself.

## Scopes and configuration

Alia's Oxy application (internal tier, granted by staff): `files:app:write`
(clips, catalogue skill files), `files:app:delete`,
`files:references:write` (outbox, reconciliation), `files:read` (no caller in
this repository since the cover handover went), `files:linked:read` (read-back),
and `files:user-media:write` (staff-granted act-as: the library and a person's
own skill files, stored for them as their private files — the grant Oxy's
consent for Alia to read them back rests on). Since Alia is a first-party
workload, each such write also needs that person's own requester proof (above);
no scope stands in for it.

| Variable | Default | Meaning |
|---|---|---|
| `OXY_FILES_WEBHOOK_SECRET` | unset → route 404 | the file-events endpoint's `whsec_…` secret (SSM) |

# Direct Kaana inference: boundary review, 2026-11-13

**Status: source review and migration preparation; no deployment asserted.**
The owner's direction is that Alia/Gemies inference payloads go directly to
Kaana. The owner explicitly confirmed on November 13 that Kaana processes inference,
authorizes spending and invoices, while Oxy retains identity only. The existing public Kaana transport can remove
Oxy's payload proxy while its content-free authorization and ledger remain
temporarily in use. This note distinguishes that transport migration from the
unbuilt financial migration; it approves no new economic terms.

## Current ownership and source

Gemies owns the backend and its deployment, including the Alia gemie, under
[ADR 0034](../adr/0034-gemies-and-alia.md). Alia's app calls `api.gemies.ai`;
backend changes belong in `OxyHQ/Gemies`, not the former Alia API worktree.
This review inspected Gemies `bffc08ab1bb43efb7a25f93dd8828d2a583e8f92`,
Oxy `4e5175e2a63cffcef9c50c23f590174a2b452f69`, Kaana
`dd89dae18af8dcb99610abb6944052a40ec94b91`, and Alia
`53b93d398ffec0e36d13b58db854562204f0d259`. Source presence does not establish
the deployed workload identity or successful production inference.

| Responsibility | Reviewed baseline at `bffc08ab` |
| --- | --- |
| Product turns, conversations, tools, actor memory and product credit charging | Gemies backend; Alia is one gemie |
| Own workload identity, accounts, applications and credentials | Oxy; service tokens have a destination-specific audience |
| Text inference transport in Gemies | `OxyInferenceClient`, `audience: 'oxy-api'`, payload sent to `api.oxy.so` |
| Voice and dictation transport in Gemies | `kaanaForOxyService(oxy, { attribution: { accountId } })`, direct `https://kaana.ai/v1`, `audience: 'kaana.ai'` |
| Public Kaana catalogue, capability/power classes, provider selection and execution | Kaana; Oxy's grant reads the declared catalogue and qualifies it against caller policy |
| Public Kaana caller authorization, policy, holds, rating, inference ledger, receipts and invoices | Oxy; Kaana calls private authorization and settlement endpoints with content-free facts |

The migration uses `getHostedKaanaClient(accountId?, machineCredential?)` in
[`lib/kaana/transport.ts`](../../packages/api/src/lib/kaana/transport.ts).
Own calls use the published SDK's `kaanaForOxyService` with immutable account
attribution. Verified external `oxy_sk_` credentials retain their own payer;
an inbound audience-bound service JWT is not forwarded as a machine key.
The AI SDK adapter is
[`kaana-language-model.ts`](../../packages/api/src/lib/inference/kaana-language-model.ts).
Text, structured output, one-shots, catalogue reads, speech and receipt reads
use the canonical Kaana origin. Voice and dictation retain their existing
shared transport. No provider key or local grant-signing implementation is
introduced. Health reports configuration readiness, not proof of a successful
paid or live inference request.

## The direct path that exists today

Gemies sends content to Kaana using its own workload token for `kaana.ai`.
Kaana forwards the caller's bearer and bounded facts, rather than its prompt,
to Oxy's `POST /internal/kaana/v1/authorizations`. Only Kaana's workload may
call that endpoint, with audience `oxy-api:kaana-control`. Oxy validates live
authority and policy, reserves when applicable and returns a signed grant.
Kaana chooses and executes within the grant, then reports measured units to
`POST /internal/kaana/v1/settlements`. The grant binds the request body hash;
this is not a grant endpoint Gemies should call or impersonate Kaana to use.

This removes Oxy from the content transport while retaining per-request
control-plane availability and economic enforcement. See the pinned
[grant/settlement contract](https://github.com/OxyHQ/oxy/blob/4e5175e2a63cffcef9c50c23f590174a2b452f69/docs/inference/kaana-grants.md)
and [Kaana's SDK workload helper](https://github.com/OxyHQ/Kaana/blob/dd89dae18af8dcb99610abb6944052a40ec94b91/packages/sdk/src/server.ts).
The grant documentation marks product-agent token exchange as unfinished;
inference attribution is not authority to access the person's tools or data.

## Two policy issues a transport migration does not solve

1. **The backend retains its established identity.** At `bffc08ab`,
   `packages/server/src/identity.ts` sets `GEMIES_APPLICATION_ID` to the former
   Alia application ID. A November 13 read-only production probe confirmed
   the same active, unexpired internal application binding on the backend's
   workload. The deployed Oxy policy file matched reviewed source `f0ae4196`:
   that identity receives `alia-kaana` internal metering. The probe executed no
   inference and changed no balances; its task finished successfully.
   The new, separate Gemies application registration is not the backend's
   principal. An earlier source review conflated those identities; source and
   production are consistent. No identity migration is required for this
   transport change, and the new registration must not inherit the old policy
   automatically.
2. **Direct grants retain the existing internal limits.** For an actual Alia
   internal principal, the public Kaana grant path rejects a missing output
   limit or a request above 2048 with `output_limit_exceeded`; the old Oxy edge
   instead clamps it. A direct URL therefore does not remove that policy.
   Any replacement economic terms need their own decision, not a silent
   consequence of changing transport.

Evidence: Oxy's [identity seed](https://github.com/OxyHQ/oxy/blob/4e5175e2a63cffcef9c50c23f590174a2b452f69/packages/api/src/scripts/seedOxyApplicationsSpecs.ts),
[economic resolver](https://github.com/OxyHQ/oxy/blob/4e5175e2a63cffcef9c50c23f590174a2b452f69/packages/api/src/config/inferenceEconomicPolicy.ts)
and [grant enforcement](https://github.com/OxyHQ/oxy/blob/4e5175e2a63cffcef9c50c23f590174a2b452f69/packages/api/src/services/kaanaGrant.service.ts).

## Moving financial authority

[Kaana ADR 0010](https://github.com/OxyHQ/Kaana/blob/dd89dae18af8dcb99610abb6944052a40ec94b91/docs/adr/0010-kaana-sells-and-invoices.md)
records the owner's November 12 direction; its implementation is still
proposed. The November 13 decision is more precise: Oxy supplies identity,
while Kaana owns inference policy, spend authorization and invoicing. A new
identity-only operation must not carry economic limits or grant spending.
The current content-free Oxy economic path is an interim dependency.

Existing Oxy-authorized operations keep their original financial authority
through settlement and historical reads. Kaana-native admissions need a
persisted authority and idempotency fence to prevent a timeout or cutover retry
from executing or charging twice. First-party enrollment must bind the verified
workload, with reviewed terms; it cannot be inferred from a brand name.
Gemies product credits remain separate from this upstream inference ledger.

Read-only November 13 checks confirmed an approved, active Oxy platform merchant
with tax configuration already present, while Kaana's own production application
mapping was absent. That missing mapping does not imply a missing legal seller:
Peable's existing first-party platform/MoR configuration is the source to reuse.
The transport change creates neither that application mapping nor customer
bindings, invoice-close/payment reconciliation or a migration of funded balances.
Use Kaana's own authorized mapping; do not borrow another product's authority or
claim commercial invoice readiness from SDK availability.

## Candidate and acceptance status

- [Alia #1084](https://github.com/OxyHQ/Alia/pull/1084) is closed **unmerged**;
  its head `c29a43b9cc879c1441be2819eb57e2f513ff3d9a` was preserved as
  `archive/feat/agent-authored-reactions`. Its old backend base must not be
  deployed over the Gemies split or treated as current production.
- [Oxy #2256](https://github.com/OxyHQ/oxy/pull/2256), head
  `ba2b36150d937e4e924f6ed7a5349bb1478f7798`, is closed **unmerged** and
  preserved at `archive/fix/alia-planning-output-policy-20261113`. The 8192
  pilot-ceiling workaround was superseded by the owner's identity-only Oxy
  direction. Its source and tests are evidence only, not a migration
  dependency or accepted policy.
- Transport acceptance must cover direct text/structured
  output/tools/stream cancellation, catalogue and power-level semantics,
  idempotency, usage/receipt reconciliation, actual Gemies workload identity
  and payer treatment. Existing direct voice/dictation must continue working.
  No successful production migration or live inference is asserted here.


## Temporary transport release hold — November 13

PR #49 (`a3bd50f94`) moved hosted text and receipt reads to the public Kaana lane before its native spend authority was ready. The existing Oxy-backed grant lane rejects an explicit output request above the first-party 2048-token ceiling. The previous text edge bounded that request instead. Gemies normally requests 16384 output tokens, and even its utility allowance is 2560; transport-level tests did not exercise this actual workload policy difference.

PR #58 temporarily restored the pre-#49 text transport and associated receipt path so later automatic API deployments could not reintroduce that incompatible transition. Voice remains on its established direct Kaana transport. Other changes merged after #49 are retained. This is a release-order correction, **not a reversal of the owner's decision**: Kaana must process requests, authorize spending and bill, with Oxy supplying identity only. Neither the Oxy ceiling workaround nor a product-side clamp/fallback is introduced.

Reapply the direct transport only after reviewed native Kaana policy, identity, durable admission/settlement and historical-key fencing are available for the exact deployed workload. Before enabling Gemies traffic, test the effective output allowance and price/context limits through the actual workload authority, then verify structured output, tools, streaming/cancellation and receipt reads. Preserve outstanding legacy receipts and permanent idempotency fences across the transition. A passing transport unit test or the presence of the public SDK is not sufficient activation evidence.

This note describes the source release hold. Deployment, rollback completion and production health must be verified separately; it does not claim a successful production rollback.


## Prepared reapplication gate

The direct transport is prepared again on current main, retaining later account/card changes. Its merge and deployment remain gated on the exact workload's native Kaana activation and permanent legacy idempotency fence. No activation is asserted by this source change. The already built direct image may bridge the bounded cutover window; subsequent normal deployment must use this reapplied source so an older hold build cannot overwrite it after fencing. PR54's authored reactions remain a separate held change.

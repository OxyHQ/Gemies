import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkProductionChatCanary } from './check-production-chat-canary.mjs';

const sources = {
  workflow: readFileSync(
    new URL('../.github/workflows/production-chat-canary.yml', import.meta.url),
    'utf8',
  ),
  // The runner and the QA person it is (`canary-qa-person.ts`), read as one.
  runner: ['production-chat-canary.ts', 'canary-qa-person.ts']
    .map((file) =>
      readFileSync(new URL(`../packages/api/src/scripts/${file}`, import.meta.url), 'utf8'),
    )
    .join('\n'),
  build: readFileSync(new URL('../packages/api/build.ts', import.meta.url), 'utf8'),
};
assert.deepEqual(checkProductionChatCanary(sources), []);
const mutations = [
  ['workflow', "if: github.ref == 'refs/heads/main'", 'if: true'],
  ['workflow', 'QA_USER_ID: ${{ vars.ALIA_CANARY_OXY_USER_ID }}', 'QA_USER_ID: ${{ inputs.user }}'],
  [
    'workflow',
    '{name:"ALIA_CANARY_OXY_USER_ID",value:$user}',
    '{name:"ALIA_CANARY_OXY_USER_ID",value:"owner"}',
  ],
  ['workflow', 'expected_live_image_digest', 'mutable_tag'],
  ['workflow', 'stop-task', 'echo'],
  ['runner', 'const accountId = env.ALIA_CANARY_OXY_USER_ID;', 'const accountId = "owner";'],
  ['runner', 'const accessToken = env.ALIA_CANARY_SESSION_TOKEN;', 'const accessToken = "stored";'],
  ['runner', 'const qa = canarySession(process.env);', 'const qa = { accessToken: "x" };'],
  ['runner', 'env: apiEnvironment(process.env),', 'env: process.env,'],
  ['runner', 'authorization: `Bearer ${await bearer()}`', "'x-oxy-user-id': qa.accountId"],
  [
    'runner',
    "await fetch('http://127.0.0.1:3001/alia/chat', {",
    "await handler('http://127.0.0.1:3001/alia/chat', {",
  ],
  ['workflow', 'QA_KEY: ${{ secrets.ALIA_CANARY_OXY_QA_KEY }}', 'QA_KEY: ${{ inputs.key }}'],
  ['workflow', 'bun canary-qa-session.mjs open', 'echo "$STORED_SESSION"'],
  ['workflow', '::add-mask::', '::debug::'],
  ['workflow', 'bun canary-qa-session.mjs close', 'true'],
  ['runner', 'conversationId: null', 'conversationId: "persisted"'],
  ['runner', 'markerMatched', 'arbitraryOutput'],
  ['runner', 'expectTool: true', 'expectTool: false'],
  ['build', "entryPoints: ['src/scripts/production-chat-canary.ts']", 'entryPoints: []'],
];
for (const [key, before, after] of mutations) {
  assert.ok(sources[key].includes(before), `fixture missing: ${before}`);
  const mutated = { ...sources, [key]: sources[key].replaceAll(before, after) };
  assert.ok(checkProductionChatCanary(mutated).length > 0, `gate accepted mutation: ${before}`);
}
for (const forbidden of [
  'handleChatCompletions',
  'x-oxy-user-id',
  'createGemieTransportForOxyService(oxy, { actingFor })',
]) {
  assert.ok(
    checkProductionChatCanary({ ...sources, runner: `${sources.runner}\n${forbidden}` }).length > 0,
  );
}
process.stdout.write(
  `Production canary gate: baseline and ${mutations.length + 3} mutations passed.\n`,
);

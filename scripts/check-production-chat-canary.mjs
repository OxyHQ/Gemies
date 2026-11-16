import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkProductionChatCanary({ workflow, runner, build }) {
  const failures = [];
  const requireText = (source, value, message) => {
    if (!source.includes(value)) failures.push(message);
  };
  requireText(workflow, "if: github.ref == 'refs/heads/main'", 'workflow is not main-only');
  // An environment changes the OIDC subject to one the deploy role does not
  // trust: the canary could never assume it.
  if (/^\s+environment:/m.test(workflow))
    failures.push(
      'workflow runs in an environment, whose OIDC subject oxy-github-deploy does not trust',
    );
  requireText(
    workflow,
    'QA_USER_ID: ${{ vars.ALIA_CANARY_OXY_USER_ID }}',
    'QA identity is not a closed protected variable',
  );
  requireText(
    workflow,
    'command:["bun","packages/api/dist/scripts/production-chat-canary.js"]',
    'workflow does not run the shipped private entrypoint',
  );
  requireText(workflow, '.taskDefinition', 'workflow is not bound to the live task definition');
  requireText(
    workflow,
    'expected_live_image_digest',
    'workflow is not bound to an immutable live image',
  );
  requireText(workflow, 'stop-task', 'workflow has no EXIT cleanup for its task');
  requireText(workflow, '.synthetic', 'workflow does not fail synthetic HTTP-200 answers');
  for (const label of ['default-1', 'arithmetic-1', 'research-1'])
    requireText(runner, label, `${label} is absent`);
  for (const label of ['search-tool', 'controlled-refusal', 'recovery'])
    requireText(runner, label, `${label} is absent`);
  requireText(runner, 'conversationId: null', 'the no-persistence result contract is absent');
  requireText(
    workflow,
    'QA_USER_ID: ${{ vars.ALIA_CANARY_OXY_USER_ID }}',
    'QA account is not a closed protected variable',
  );
  requireText(
    workflow,
    '{name:"ALIA_CANARY_OXY_USER_ID",value:$user}',
    'workflow does not pass the protected QA account',
  );
  for (const binding of [
    'const accountId = env.ALIA_CANARY_OXY_USER_ID;',
    'const accessToken = env.ALIA_CANARY_SESSION_TOKEN;',
    'const qa = canarySession(process.env);',
    'env: apiEnvironment(process.env),',
  ])
    requireText(runner, binding, `runner lost its QA session binding: ${binding}`);
  requireText(
    runner,
    "await fetch('http://127.0.0.1:3001/alia/chat', {",
    'runner does not enter real HTTP authentication',
  );
  requireText(
    runner,
    'authorization: `Bearer ${await bearer()}`',
    'runner does not call as the QA person with the session opened for this run',
  );
  if (/x-oxy-user-id|x-oxy-requester|createGemieTransportForOxyService|actingFor/i.test(runner))
    failures.push('runner acts for someone instead of being the QA person');
  // The QA session: opened fresh by the workflow, masked, closed when the run ends.
  for (const [value, message] of [
    ['QA_KEY: ${{ secrets.ALIA_CANARY_OXY_QA_KEY }}', 'QA key is not a repository secret'],
    ['bun canary-qa-session.mjs open', 'workflow does not open a fresh QA session'],
    ['::add-mask::', 'workflow does not mask the QA session'],
    ['bun canary-qa-session.mjs close', 'workflow does not close the QA session'],
    [
      '{name:"ALIA_CANARY_SESSION_TOKEN",value:$session}',
      'workflow does not hand the run its QA session',
    ],
  ])
    requireText(workflow, value, message);
  if (runner.includes('handleChatCompletions'))
    failures.push('runner bypasses HTTP authentication by importing the handler');
  requireText(runner, 'markerMatched', 'runner accepts arbitrary non-empty model output');
  requireText(runner, 'expectTool: true', 'search case does not require tool evidence');
  requireText(
    build,
    "entryPoints: ['src/scripts/production-chat-canary.ts']",
    'the runtime image does not build the canary',
  );
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workflow = readFileSync(
    new URL('../.github/workflows/production-chat-canary.yml', import.meta.url),
    'utf8',
  );
  // The runner and the QA person it is (`canary-qa-person.ts`), read as one.
  const runner = ['production-chat-canary.ts', 'canary-qa-person.ts']
    .map((file) =>
      readFileSync(new URL(`../packages/api/src/scripts/${file}`, import.meta.url), 'utf8'),
    )
    .join('\n');
  const build = readFileSync(new URL('../packages/api/build.ts', import.meta.url), 'utf8');
  const failures = checkProductionChatCanary({ workflow, runner, build });
  if (failures.length) {
    process.stderr.write(`Production chat canary gate failed:\n- ${failures.join('\n- ')}\n`);
    process.exit(1);
  }
  process.stdout.write(
    'Production chat canary remains private, live-image-bound, closed-identity and full-matrix.\n',
  );
}

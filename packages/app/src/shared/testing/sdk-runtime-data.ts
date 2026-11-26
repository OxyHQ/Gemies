/**
 * The SDK's account-data helpers (`answerSource`, `useAnswer`, `ACCOUNT`, `gemieRead`), for a
 * suite that mocks `@gemies/sdk/runtime`.
 *
 * The app's own account data (`myAgents`, `spaces`, a thread's stretch) is built on them, so a
 * suite that replaces the SDK's runtime barrel with a few stubs must still hand the real helpers
 * over, or the module under test dies at import. They come from the SDK's source rather than the
 * barrel, which reaches native modules. Used from `vi.mock` factories:
 * `vi.mock('@gemies/sdk/runtime', async () => ({ ...(await import('@/shared/testing/sdk-runtime-data')), … }))`.
 */
export { answerSource, useAnswer } from '../../../../sdk/src/runtime/data/answer';
export { ACCOUNT, gemieRead } from '../../../../sdk/src/runtime/data/read';

/**
 * The shape of the app's own account data that the account's bloom-data store copies to disk
 * (`persist: { version: PERSISTED_DATA_VERSION }`): the person's agents (`useMyAgents`) and spaces
 * (`useSpaces`), which a returning person's sidebar draws before they are read again.
 *
 * A stored answer is drawn before it is refreshed, so it must be read in the shape it was written
 * in: when this changes, the store drops those rows when it opens. Bump it with any change to that
 * shape. `__tests__/persisted-data-version.test.ts` fingerprints the declarations those answers are
 * read with and fails until it is bumped, so a forgotten bump is a red test, never a crash in the
 * field. The conversations, collections, agent profiles and threads are the SDK's (`@gemies/sdk`
 * versions its own).
 */
export const PERSISTED_DATA_VERSION = 1;

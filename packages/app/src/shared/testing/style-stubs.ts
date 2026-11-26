/**
 * What a test's stand-ins need for the app's style sheets: the screens build theirs with React
 * Native's `StyleSheet` and Bloom's `createTokenStyles` (as `@gemies/sdk` does,
 * `packages/sdk/tests/support/style-stubs.ts`). Spread first into a mock, so the mock's own
 * entries (its `Platform`) win.
 */

/** React Native's `StyleSheet` and `Platform`, the styles as written. */
export const reactNativeStyles = {
  StyleSheet: {
    create: <T>(styles: T): T => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
  },
  Platform: {
    OS: 'ios',
    select: <T>(options: { ios?: T; native?: T; default?: T }) =>
      options.ios ?? options.native ?? options.default,
  },
};

/** Each Bloom colour token as its own name (`t.primary` is `'primary'`). */
const tokens: Readonly<Record<string, string>> = new Proxy(
  {},
  { get: (_target, name) => String(name) },
);

/** Bloom's `createTokenStyles`, `useColorTokens` and `tokenAlpha` (`@oxy.so/bloom/theme`). */
export const bloomTokenStyles = {
  useColorTokens: () => tokens,
  tokenAlpha: (color: string, opacity: number) => `${color}@${opacity}`,
  createTokenStyles<T>(build: (t: Readonly<Record<string, string>>) => T): () => T {
    const sheet = build(tokens);
    return () => sheet;
  },
};

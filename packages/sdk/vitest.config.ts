import { defineConfig } from 'vitest/config';

/**
 * Bloom, and the packages Bloom's own modules reach for, are processed by vite rather than handed
 * to node: node resolves Bloom's `react-native` export condition to its raw `src/*.ts`, which the
 * runner will not parse. Inlined, a suite can mount the real Bloom component (the composer's key
 * rules are Bloom's, and `GemieComposer.keys.test.tsx` proves them against the real panel).
 */
export default defineConfig({
  test: {
    setupFiles: ['./tests/support/inert-socket.ts'],
    server: {
      deps: {
        inline: [/@oxy\.so[\\/]bloom/],
      },
    },
  },
});

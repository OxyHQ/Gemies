const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

// The preset owns the monorepo watch folder and block list, symlink +
// package-exports resolution, the font/wasm asset extensions and the base face
// of a React Native `Text` that names no family. The app lists no NativeWind,
// so the preset applies none (app-preset 6.9, "An app without NativeWind").
const config = createOxyMetroConfig(__dirname);

// A fixtures build (EXPO_PUBLIC_ALIA_FIXTURES=1, see fixtures/entry.tsx)
// inlines a different value into every module that reads it, so its
// transforms must never be served to an ordinary build from the shared
// cache, nor the other way round. A distinct cache version keys them apart.
if (process.env.EXPO_PUBLIC_ALIA_FIXTURES === '1') {
  config.cacheVersion = `${config.cacheVersion ?? ''}:alia-fixtures`;
}

module.exports = config;

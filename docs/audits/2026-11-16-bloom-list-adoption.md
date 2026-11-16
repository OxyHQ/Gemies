# Gemies shared list adoption

The app composes Bloom's List/ListItem for its sidebar tree, catalogue rows, agent threads,
notifications, workspace files and group picker. Projects and folders are nested canonical tree
items with controlled disclosure and shared selection/context menus, rather than separate folder
action triggers. SDK 9.1 migration landed separately in PR #138;
this continuation preserves that SDK, its passive pointer handling and complete settings labels.

The isolated `/__fixtures/sidebar` route mounts the production `SidebarView` inside AiChatShell,
under the real app providers. Its Gemie menus and animated avatars are production components;
its records and action callbacks are synthetic. It never signs in, intercepts authentication or
writes server data. Fixture routes are included only in a fixture export.

Reproduce the browser checks from `packages/app`:

```sh
EXPO_PUBLIC_ALIA_FIXTURES=1 bunx expo export --platform web --output-dir dist-fixtures
bun run visual:sidebar # headed Chromium; use xvfb-run -a on a headless Linux host
```

The harness starts a local export server and writes screenshots plus JSON evidence to the printed
temporary directory. The runner asserts actual hover/fine-pointer and touch/coarse-pointer
capabilities. Chromium desktop 1440×1000/light verifies avatar hover selection and
right-click commands. Chromium touch 390×844/dark verifies long press followed by release selects
without navigation or a context menu. Both verify avatar selection, the selected-row PageHeader
menu using the existing callback exactly once, cancellation, normal navigation, folder expansion,
grouped avatars, no horizontal overflow and no page errors. Unselected touch rows have no ellipsis.
These are web checks; touch emulation is not a native-device result.

The first registry-backed run used Bloom 22.0.1 and Services 14.22.0. App typecheck and 1,623 tests,
SDK typecheck and 1,124 tests, its 18 independent entry checks and entry isolation passed. The
production web export and its no-Skia/no-stray-WASM gate passed. Repository lint passed with its
existing warnings. Package and runtime checks are repeated after the final dependency alignment.

The Services 14.23.0 integration pass used official npm Bloom 22.1.1, with one resolved instance
across the root, app, SDK and integrations workspaces. App typecheck, 134 suites / 1,623 tests,
repository lint, the production export (1,082 chunks) and both sidebar browser cases passed.
The review branch currently pins official Bloom 22.1.3 and Services 14.23.0. The final package
alignment and runtime pass are pending the published Bloom trailing-control fix; this is not
yet final release acceptance. Gemies retains its own unchanged SDK 9.1.0 workspace, rather than
installing a second SDK from npm.

The expanded project/folder tests pass app TypeScript and 134 suites / 1,625 tests. Their real
touch fixture exposed a shared Bloom issue: selection changes the header's height, moving a
different row under the finger. The original Pressable remains mounted and receives touchend,
but Chromium sends its compatibility click to the new row, causing navigation after long press.
The fixture preserves this failing case; there is no application height or event workaround.
Final browser acceptance requires the published Bloom owner fix. The app does not wire tree
drag/drop today; menu-based moves and disclosure preserve the existing application behavior.

Native inventory found emulator-5580 available but no Gemies or Expo development client installed;
this app's existing fixture entry is web-only. Native application adoption remains unverified by
this fixture. Shared Bloom owner checks are separate evidence and do not imply a Gemies device run.

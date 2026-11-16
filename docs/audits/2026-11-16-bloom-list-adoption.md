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
EXPO_PUBLIC_ALIA_FIXTURES=1 bunx expo export --platform web --clear --output-dir dist-fixtures
bun run visual:sidebar # headed Chromium; use xvfb-run -a on a headless Linux host
```

The harness starts a local export server and writes screenshots plus JSON evidence to the printed
temporary directory. The runner asserts actual hover/fine-pointer and touch/coarse-pointer
capabilities. Chromium desktop 1440×1000/light verifies avatar hover selection and
right-click commands. Chromium touch 390×844/dark verifies long press followed by release selects
without navigation or a context menu. Both verify avatar selection, the selected-row PageHeader
menu using the existing callback exactly once, cancellation, normal navigation, folder expansion,
grouped avatars, no horizontal overflow and no page errors. After project selection and cancellation,
the touch case sends a new CDP touch start/end over the group and asserts exactly one navigation;
the desktop case checks its corresponding click. Unselected touch rows have no ellipsis.
These are web checks; touch emulation is not a native-device result.

The final integration uses official npm Bloom **22.1.5** and Services **14.23.0**. The root,
app, SDK and integrations workspaces resolve one instance of each package. All 32,092 installed
Bloom files were compared byte-for-byte with the official registry tarball, whose SHA-512 integrity
matched its published metadata. No source aliases, local mirrors or candidate packages remain.
Gemies retains its unchanged SDK **9.1.0 workspace** from PR #138; this is not an npm SDK install.

On this final combination, app TypeScript and **134 suites / 1,625 tests** pass. Repository lint
passes with its existing warnings. The production web export rebuilt with `--clear` contains
1,082 chunks; its PWA and no-Skia/no-stray-WASM gates pass. The fixture also rebuilt with `--clear`
and passed both headed browser cases above, with no page errors or horizontal overflow. Captures
were visually reviewed in both themes.

The project/folder fixture preserves a regression exposed on Bloom 22.1.3: selection changes the
header's height, moving a different row under the finger. The original Pressable remains mounted
and receives touchend, but Chromium sent its compatibility click to the newly positioned row.
Bloom's shared fix cancels that compatibility click after a consumed long press. With official
22.1.5 the header still moves the project row by 40px, the trigger remains connected, release does
not navigate, and the following CDP touch opens the group exactly once. There is no application
height or event workaround. The app does not wire tree drag/drop today; menu-based moves and
disclosure preserve its existing behavior.

Before publication, the same regression and subsequent touch passed with immutable diagnostic
candidate `22.1.4-long-press.0` (tarball SHA-1 `dd440653f85c9d29051398aeeb4038a2307f2242`);
all 32,059 installed candidate files matched that tarball. The official dependencies and exact
manifest/lock bytes were restored after that run. Final acceptance above was repeated using the
published 22.1.5 package, independently of the candidate result.

Native inventory found emulator-5580 available but no Gemies or Expo development client installed;
this app's existing fixture entry is web-only. Native application adoption remains unverified by
this fixture. Shared Bloom owner checks are separate evidence and do not imply a Gemies device run.

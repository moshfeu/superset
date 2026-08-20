# Development

Run the dev server without env validation or auth:

```bash
SKIP_ENV_VALIDATION=1 bun run dev
```

This skips environment variable validation and the sign-in screen. Desktop chat also falls back to local-only session bootstrap in this mode, so you can test chat/streaming without the cloud API as long as you have local model credentials configured.

# Release

When building for release, make sure `node-pty` is built for the correct architecture with `bun run install:deps`, then run `bun run release`.

# macOS local build

From `apps/desktop`:

```bash
bun run package:local
```

Use this instead of the plain `build`/`package` scripts for a locally packaged
macOS app. It gives the local build its own bundle identifier
(`com.superset.desktop.local`) and signs it with a stable local certificate,
so it doesn't collide with an installed production `Superset.app` on macOS
permission grants (Documents folder, etc.). See
`docs/MACOS_LOCAL_BUILD_TCC_PROMPTS.md` if macOS keeps re-prompting for
Documents folder access on a local build.

# Linux (AppImage) local build

From `apps/desktop`:

```bash
bun run clean:dev
bun run compile:app
bun run package -- --publish never --config electron-builder.ts
```

Expected outputs in `apps/desktop/release/`:

- `*.AppImage`
- `*-linux.yml` (Linux auto-update manifest)

# Linux auto-update verification (local)

From `apps/desktop` after packaging:

```bash
ls -la release/*.AppImage
ls -la release/*-linux.yml
```

If both files exist, packaging produced the Linux artifact + updater metadata that `electron-updater` expects.

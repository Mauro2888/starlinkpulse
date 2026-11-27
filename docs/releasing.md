# Releasing StarlinkPulse

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. The
workflow builds macOS (universal), Windows (`.msi` + NSIS `.exe`) and Linux (`.AppImage` +
`.deb`) and creates a **draft** GitHub Release. Nothing is published until a maintainer
reviews the draft and publishes it.

## One-time setup (before the first release)

### 1. Replace the `OWNER` placeholder

Replace `OWNER` with the GitHub user or organisation that hosts the repository in:

- `src-tauri/Cargo.toml` → `repository = "https://github.com/OWNER/StarlinkPulse"`
- `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`
  (`https://github.com/OWNER/StarlinkPulse/releases/latest/download/latest.json`)

While the endpoint still contains `/OWNER/`, the app reports `updaterConfigured: false` and
never checks for updates.

The "Open releases page" button opens `<repository>/releases`, using the `repository` value
from `Cargo.toml` built into the app. While that value still contains `OWNER`, the button
returns `invalid_input`.

### 2. Create the updater signing key

Updates are verified with a minisign key pair: the **public** key is embedded in the app, and
the **private** key signs the release artifacts in CI.

> Never commit the private key or its password. Keep a backup in a password manager. If the
> key is lost, existing installations can no longer verify updates, and users must
> reinstall manually.

Generate the key on your machine, outside the repository:

```sh
npx tauri signer generate -w ~/.tauri/starlinkpulse.key
```

- The command asks for a password. Use a strong one and store it in your password manager.
- It writes the private key to `~/.tauri/starlinkpulse.key` and the public key to
  `~/.tauri/starlinkpulse.key.pub`, and prints the public key.

### 3. Put the public key in the app config

Copy the full content of `~/.tauri/starlinkpulse.key.pub` into
`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, then commit it. The public key is
not secret.

### 4. Add the GitHub Actions secrets

In GitHub, open **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | full content of `~/.tauri/starlinkpulse.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 2 |

The release workflow checks that the signing secret and the public key are configured
together:

- **Both present:** the workflow builds the `.sig` files and uploads `latest.json`.
- **Neither present:** the workflow builds without updater files.
- **Only one present:** the build fails, so you never publish updates the app cannot verify.

Optional macOS signing and notarization secrets are listed at the top of `release.yml`.

## Release checklist

1. **Make sure CI is green on `main`.**
2. **Tag and push:** `git tag vX.Y.Z && git push origin vX.Y.Z`. No version bump commit: the
   workflow sets the version from the tag (`scripts/set-version.mjs`) in `package.json`,
   `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` before building, and after a
   successful build the `bump-version` job commits the same change (plus lockfiles) to `main`
   as `chore: release vX.Y.Z [skip ci]`. Run `git pull` afterwards.
3. **Wait for the Release workflow,** on all three platforms.
4. **Review the draft release on GitHub:**
   - all installers are attached (`.dmg`, `.app.tar.gz`, `.msi`, `.exe`, `.AppImage`, `.deb`);
   - if the updater is configured, `latest.json` and the `.sig` files are attached, and
     `latest.json` shows the new version and the platform URLs;
   - edit the release notes. The notes become the update notes the app shows.
5. **Smoke-test** at least one installer in read-only mode against a dish, or in Mock Mode.
6. **Publish the draft.** From then on, installed apps with a configured updater see the
   update in *Settings → Check for updates*.

## Notes

- The update endpoint is `releases/latest/download/latest.json`, so only the newest
  **published** (non-draft, non-prerelease) release is offered.
- Unsigned macOS and Windows builds trigger Gatekeeper / SmartScreen warnings. The README
  explains how users can open them.

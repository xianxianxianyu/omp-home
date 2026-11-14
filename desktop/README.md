# omp-home desktop

Tauri 2 wraps the loopback hub; there is no second frontend dev server. macOS arm64 is the supported distribution target. The application bundles the official Node 26.11.1 runtime, the hub and the built web UI. `omp` must already be installed and logged in; the hub imports the user's login-shell environment for Finder launches.

## Build

Requirements: Apple Silicon Mac running macOS 13.5+, Xcode command-line tools, Rust 1.90+, Node 26.11.1 and pnpm. From the repository root:

```sh
pnpm install
# First release only. Keep the private key outside the repository and back it up securely.
pnpm tauri signer generate --ci -p '' -w ~/.config/omp-home-release/updater.key
# If generating a new key, replace plugins.updater.pubkey in src-tauri/tauri.conf.json
# with the contents of updater.key.pub before distributing any app.
pnpm build:app   # set OMP_HOME_RELEASE_REPOSITORY=owner/repo when publishing from a fork
```

A signing keypair has already been generated on this workstation at `~/.config/omp-home-release/updater.key`; its public half is committed in `src-tauri/tauri.conf.json`. Do not overwrite that key when publishing updates for installations using that public key. The private key is not in the repository. Key generation uses an empty password; set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if using a password-protected replacement.

`build:app` runs `scripts/build-hub.mjs` (which builds Vite), verifies the official Node archive against Node's HTTPS `SHASUMS256.txt`, unpacks it from `~/.cache/omp-home`, copies resources and runs Tauri's ad-hoc signed build. `Entitlements.plist` retains `allow-jit` for Node's V8 runtime; re-signing without it prevents Node from starting. It uses `TAURI_SIGNING_PRIVATE_KEY` (path or contents), or the local key path above when unset. Output:

- `desktop/src-tauri/target/release/bundle/macos/omp-home.app`
- `desktop/src-tauri/target/release/bundle/dmg/*.dmg`
- `desktop/src-tauri/target/release/bundle/macos/omp-home.app.tar.gz` and `.sig`

The app version comes from root `package.json`; `OMP_HOME_APP_VERSION` overrides it only for a particular build, without modifying repository files. `OMP_HOME_RELEASE_REPOSITORY` configures the updater's GitHub owner/repo. Its default is `xianxianxianyu/omp-home`; set it when publishing from a fork. `OMP_HOME_UPDATER_ENDPOINT` replaces the endpoint at build time. Only HTTPS or `http://127.0.0.1:<port>/…` is accepted; insecure transport is enabled only for the explicit loopback override. Subsequent builds without that override restore the normal HTTPS endpoint; the source config is never rewritten.

## First launch

Drag the app from the DMG into Applications. It is ad-hoc signed, not Apple-notarized. Only for a download you trust, remove quarantine before opening:

```sh
xattr -dr com.apple.quarantine /Applications/omp-home.app
open /Applications/omp-home.app
```

Closing the window hides it. The menu-bar icon offers **Open omp-home**, **Check for updates…**, and **Quit omp-home**. A second launch focuses the existing window. Quit sends SIGTERM to an owned hub and waits up to ten seconds for it to stop its omp children. An attached, independently started hub is never stopped by the desktop app. A crashed owned hub restarts with bounded exponential backoff and reloads the window. If an attached hub disappears, the app starts a replacement only after its existing lock is free.

Logs are appended to `~/Library/Logs/omp-home/desktop.log` with owner-only permissions. They include app version, hub PID, hub stdout/stderr, the authenticated local URL, window loading and update results. Treat the log as sensitive because the URL contains an installation token. Configuration defaults to `~/.config/omp-home`; use `OMP_HOME_CONFIG_DIR` to isolate another installation. The loading screen is embedded in the app and remains available when the hub is restarting.

## Signed releases

1. Change root `package.json` version, install dependencies if needed, commit, and tag the same version (`v0.1.0`, for example).
2. Set GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` to the **contents** of the matching private key. Optionally set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; omit it for the current unencrypted key.
3. Push the tag. `.github/workflows/release.yml` installs dependencies, runs tests and typechecking, builds the app, and uploads the DMG, updater archive, signature and `latest.json` to a **draft** release. The workflow uses `github.repository` for the updater endpoint. It runs on `macos-15` (arm64): GitHub's current hosted-runner catalog has retired `macos-14`.
4. Review and publish the draft. Only then can `/releases/latest/download/latest.json` discover it.

To generate a manifest locally:

```sh
pnpm updater:json
# Overrides: --bundle-dir DIR --url URL --notes TEXT --output FILE
```

The generator reads the actual built app's Info.plist, not a potentially changed source package version. The updater checks 15 seconds after launch, every six hours, and on request. It asks through a native dialog, verifies the downloaded archive's signature, installs and restarts after graceful hub shutdown. Notifications and the native update workflow are available to the loopback renderer; it has no shell, filesystem or arbitrary process privileges.

## Repeatable local acceptance and update proof

```sh
node desktop/verify.mjs
```

This builds version A with a temporary loopback update endpoint, installs A under a temporary `Applications` directory, builds A+patch with the default HTTPS endpoint, serves B's signed archive and `latest.json`, and exercises the actual app. It verifies the loaded window title and tray construction logs, `/api/state`, crash recovery, single-instance behavior, a real idle omp RPC child in a temporary home repo, graceful shutdown, signed update installation, automatic relaunch, the running version and installed Info.plist. It saves logs, state and `evidence.txt` under the printed temporary directory. It never configures `/Volumes/NVMe2T/project/home` or the user's real omp-home configuration. It starts no model turn.

On hosts without Accessibility or Screen Recording grants, the proof uses native page-load/title/tray-construction logs plus the real hub API instead of synthetic clicks or a screenshot. The following explicit test/operations switches are read only at app launch:

- `OMP_HOME_UPDATE_ASSUME_YES=1`: consent in advance to installing a signed update without the native dialog. Do not set this for ordinary interactive launches.
- `OMP_HOME_UPDATE_CHECK_DELAY_SECS=N`: replace the initial 15-second delay. The recurring interval stays six hours.

Both switches are inherited on updater relaunch. Unset them for normal use. Normal builds and launches always retain the native confirmation dialog. A loopback endpoint never weakens signature verification.

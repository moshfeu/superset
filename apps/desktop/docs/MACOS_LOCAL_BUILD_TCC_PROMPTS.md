# macOS: local build repeatedly prompting for Documents folder access

## Symptom

macOS keeps showing "'Superset Local' would like to access files in your
Documents folder", even after repeatedly clicking Allow. It can happen on the
production `Superset.app` too, seemingly at random, whenever a locally built
"Superset Local" app is also installed and in use.

## Root cause

`apps/desktop/electron-builder.ts` sets `appId: "com.superset.desktop"`.
Historically, a locally built "Superset Local.app" (built with the default
`bun run build` / `bun run package`, not `package:local`) was packaged with
that same `appId` and installed side-by-side with production `Superset.app`
in `/Applications`, under a different folder name but an identical bundle
identifier.

macOS TCC (the Documents/Photos/etc. permission system) records one grant per
`(bundle identifier, service)` pair. With two different apps sharing
`com.superset.desktop`, there is only one slot for
`kTCCServiceSystemPolicyDocumentsFolder`:

- Approving one app writes its code-signing requirement into that slot.
- Launching the *other* app presents a different signature (a different
  Developer ID for production vs. an ad-hoc/local signature for a dev build),
  which no longer satisfies what's stored → macOS re-prompts.
- Clicking Allow there overwrites the slot again, invalidating the first
  app's grant.

Using both apps back and forth causes constant re-prompting. This was
confirmed live via `log stream --predicate 'subsystem == "com.apple.TCC"'`,
which showed:

```
Failed to match existing code requirement for subject com.superset.desktop and service kTCCServiceSystemPolicyDocumentsFolder
  identifier "com.superset.desktop" and anchor apple generic and certificate leaf[subject.OU] = "<production Team ID>"
  identifier "com.superset.desktop" and certificate leaf = H"<local build's cert hash>"
```
i.e. two different signing identities fighting over one recorded rule for
the same bundle ID.

A secondary factor: a plain local build (`bun run build`, which sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`) is signed **ad-hoc**. An ad-hoc
signature's designated requirement is pinned to the exact content hash, so
even without the collision above, every local rebuild would produce a "new"
app as far as TCC is concerned and would need to be re-approved.

## Fix

1. **Give local builds their own bundle identifier.** Added
   `apps/desktop/electron-builder.local.ts` (mirrors the existing
   `electron-builder.canary.ts` pattern) with
   `appId: "com.superset.desktop.local"` and product name "Superset Local".
   Build local packages with:
   ```bash
   bun run package:local   # from apps/desktop
   ```
   instead of the plain `build`/`package` scripts. This keeps its TCC (and
   Gatekeeper) identity fully separate from production, permanently.

2. **Sign local builds with a real, stable identity instead of ad-hoc**, so
   grants survive rebuilds. `package:local` passes
   `CSC_NAME="Superset Local Dev"`, referencing a local self-signed
   code-signing certificate. To (re)create this certificate on a machine:
   ```bash
   # generate a self-signed cert with a Code Signing EKU
   openssl req -x509 -newkey rsa:2048 -keyout priv.pem -out cert.pem -days 3650 -nodes \
     -subj "/CN=Superset Local Dev" \
     -addext "keyUsage=critical,digitalSignature" \
     -addext "extendedKeyUsage=critical,codeSigning" \
     -addext "basicConstraints=critical,CA:false"

   # package and import into your login keychain
   openssl pkcs12 -export -out bundle.p12 -inkey priv.pem -in cert.pem -passout pass:<any-password>
   security import bundle.p12 -k ~/Library/Keychains/login.keychain-db -P <any-password> -T /usr/bin/codesign

   # mark it trusted for code signing (macOS will show an interactive
   # authorization dialog here — this step cannot be scripted headlessly)
   security add-trusted-cert -d -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem
   ```
   Confirm with `security find-identity -v -p codesigning` — it should list
   "Superset Local Dev" as a valid identity.

3. **If you already have a colliding "Superset Local.app" installed**, you
   don't need to rebuild to fix it — repair the installed bundle directly:
   ```bash
   /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.superset.desktop.local" \
     "/Applications/Superset Local.app/Contents/Info.plist"
   codesign --force --deep --sign "Superset Local Dev" \
     --identifier "com.superset.desktop.local" \
     "/Applications/Superset Local.app"
   ```
   Then quit and relaunch it, and grant Documents access one more time — this
   should be the last time, since it's now a distinct, stably-signed app.

## If it comes back

- Check both apps' bundle identifiers are still different:
  `codesign -dv "/Applications/Superset.app" 2>&1 | grep Identifier` and the
  same for `Superset Local.app`. If a local rebuild used the plain
  `build`/`package` script instead of `package:local`, it will have
  regressed back to `com.superset.desktop` and ad-hoc signing.
- Confirm the local build didn't fall back to ad-hoc signing (no matching
  `CSC_NAME` identity found in the keychain):
  `codesign -dv --verbose=4 "/Applications/Superset Local.app" | grep Authority`
  should show `Superset Local Dev`, not be absent (ad-hoc/adhoc flag).
- To watch a fresh repro live: `log stream --predicate 'subsystem == "com.apple.TCC"'`
  while triggering the prompt, then look for `AUTHREQ_SUBJECT` /
  `Failed to match existing code requirement` lines mentioning
  `com.superset.desktop`.

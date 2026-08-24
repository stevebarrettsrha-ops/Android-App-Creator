# Packr

Turns a web address, a folder of HTML files, or a single `.html` file into an installable
Android package. Runs entirely on your own machine — nothing is uploaded anywhere.

```
node server.js
```

Then open **http://localhost:4477**.

---

## What you need installed first

Packr generates an Android project and drives Gradle. It cannot replace the Android
toolchain, so two things must be on the machine.

### 1. A JDK, version 17 or newer

Packr looks in `JAVA_HOME`, then inside an Android Studio installation, then on `PATH`.
If you install Android Studio you already have one — its bundled JDK is found automatically.

### 2. The Android SDK

**Easy route.** Install Android Studio, open it once, and let it download the SDK. Packr
finds it at the default location without any configuration.

**Lean route.** Download the *command line tools only* package from the Android developer
site, unpack it to a folder, then from `cmdline-tools/latest/bin`:

```
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

Set `ANDROID_HOME` to the SDK folder. On Windows:

```
setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
```

Gradle itself is not a prerequisite — Packr downloads the Gradle wrapper on first use.

The status rail across the top of the interface shows exactly what was found. If a lamp is
red, builds will not start.

---

## The two source modes

**Files on this computer.** Everything is bundled into the APK and works with no network at
all. Assets are served over `https://appassets.androidplatform.net/` rather than `file://`,
which matters: a `file://` origin is not a secure context, so `localStorage`, `fetch`,
service workers and the crypto APIs all misbehave there. Point Packr at a folder (it looks
for `index.html`) or at a single `.html` file.

**Web address.** The app opens the URL on every launch. Simpler to update — you change the
site, every installed app sees it — but it needs a connection, and a plain `http://` address
will make Packr enable cleartext traffic and warn you.

---

## Signing, and why it is not optional

- **Debug** builds are signed with a throwaway key. Fine for sideloading onto a test phone.
  They cannot be published.
- **Release** builds need your own keystore. Create one in section 05 of the docket; it lands
  in `keystores/` next to this tool.

**Back that keystore up, in more than one place.** If you publish an app and then lose the
key, you cannot ship an update to it. Ever. There is no recovery process. The only way
forward is a new listing under a new package ID, and your existing users do not migrate.

The package ID has the same permanence. Once an app is live under `jm.org.example.payroll`,
that string is fixed for the life of the app.

---

## Before you plan on the Play Store

Two things worth knowing before you build a distribution plan around this.

**Google Play restricts wrapper apps.** The Spam and Minimum Functionality policy targets
apps whose only function is to display a website. A WebView shell around a public site is
squarely in scope and gets rejected routinely. What passes review is an app that either does
something a browser cannot — offline data, hardware access, notifications, a genuine
installed-app experience — or ships as a Trusted Web Activity over a site that is a real,
audited PWA. Packr's bundled-files mode with offline assets and file export is a much better
position to argue from than the live-address mode.

For internal distribution — staff phones, a training centre, an organisation's own devices —
none of this applies. Sideloading an APK, or using Play's managed private-app channel, is
straightforward and is where a tool like this earns its keep.

**Play requires app bundles, not APKs, for new listings.** Choose AAB in section 05 for
anything going to the Play Console. Keep APK for direct install.

**APK is Android only.** An iPhone cannot install one. Reaching the Apple App Store means a
different toolchain entirely — Xcode, a Mac (or a hosted macOS build runner), and a paid
Apple Developer account. Nothing in this project moves you toward it.

---

## What the generated app actually does

The WebView host is not a bare `loadUrl`. It handles:

- Hardware back button mapped to page history
- File uploads from `<input type="file">`, single and multiple
- Downloads, including `blob:` and `data:` URLs — the ones a browser-side CSV or XLSX export
  produces, which a naive WebView silently drops. Saved through MediaStore on Android 10+.
- Camera, microphone and geolocation permission prompts wired to real runtime permissions
- Cookies, DOM storage and IndexedDB persisted across launches
- An offline page with a retry button instead of the grey "webpage not available" screen
- Optional pull-to-refresh, pinch zoom, orientation lock, and external links opening in the
  real browser

Layout of a generated project is a normal Gradle project under `work/`. If you outgrow the
docket, open that folder in Android Studio and take it from there.

---

## Files

```
server.js                local server and API
lib/env.js               JDK / SDK / Gradle detection
lib/project.js           docket validation, project generation
lib/icons.js             launcher icons (dependency-free PNG writer)
lib/keystore.js          keytool wrapper
lib/build.js             Gradle invocation, artefact collection
public/index.html        the interface
template/                the Android project skeleton
work/                    generated projects
output/                  finished APK and AAB files
keystores/               signing keys — back these up
test-materialise.js      node test-materialise.js
```

## Optional

Installing `sharp` improves icon quality — without it, a supplied PNG is copied at its
original size to every density rather than being properly downscaled.

```
npm install sharp
```

## Troubleshooting

**"SDK has no platforms installed"** — run the `sdkmanager` line above.

**First build takes many minutes** — Gradle is downloading the Android Gradle Plugin and
dependencies. Subsequent builds are much faster.

**"INSTALL_FAILED_UPDATE_INCOMPATIBLE" on the phone** — you are installing a build signed
with a different key over an existing one. Uninstall the old app first.

**Blank white screen** — usually a missing `index.html`, or a page loading assets over an
absolute `file://` or `http://localhost` path. Connect the phone by USB and inspect the
WebView at `chrome://inspect` (debug builds have remote debugging enabled).

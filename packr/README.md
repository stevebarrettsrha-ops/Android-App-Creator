# Packr

Turns a web address, a folder of HTML files, or a single `.html` file into an installable
Android package. Runs entirely on your own machine — nothing is uploaded anywhere.

```
node server.js
```

Then open **http://localhost:4477**.

After a build finishes, every APK gets an **Install on a phone · QR** button: point the
phone's camera at the code and the APK downloads straight from your machine over the local
network. The same screen generates a signed AAB for the Google Play Console and a complete
Xcode project for the Apple App Store.

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

## Buttons and app chrome

Section 05 of the docket gives the app its own controls instead of leaving it a bare
web page:

- **A title bar** with the app's name, in your theme colour.
- **A button bar** of up to five buttons. Each button gets an icon (26 built in — drawn
  as vector drawables on Android and matched to SF Symbols on iOS), a label, and an
  action: go to the start page, back, forward, reload, share the current page, open a
  specific page or URL, open a link in the real browser, call a phone number, compose
  an email, or open the premium screen.

Buttons are native — not injected into your page — so they work even while the page is
loading or offline. Real chrome also matters for store review: both stores reject apps
that are indistinguishable from a browser tab.

---

## Paid features

Section 06 adds a premium tier that works completely offline, with no store account and
no server:

1. Switch **paid features** on, write the pitch and price, and (optionally) add a
   payment link — Stripe, PayPal, anything. The link opens in the phone's real browser.
2. **Generate unlock codes.** The codes are created in your browser and only their
   SHA-256 fingerprints are built into the app. Download the codes file and keep it —
   you sell or hand out codes however you like (after a payment, in person, by email).
3. Mark any button **premium** (the crown toggle). Tapping it before unlocking opens
   the paywall screen; after a valid code is entered on that screen, everything opens.
   Unlocking is per device and survives restarts.

Your own web content can gate features too — both shells inject a bridge:

```js
window.PackrApp.isPremium()        // true once unlocked (always true if premium is off)
await Promise.resolve(window.PackrApp.unlock(code))  // true if the code was valid
window.PackrApp.openPaywall()      // show the premium screen
window.PackrApp.openExternal(url)  // open a link in the system browser
window.PackrApp.goHome()           // load the start page
```

(The `Promise.resolve` wrapper smooths over the platforms: Android answers
synchronously, iOS with a Promise.)

**Selling through the stores?** Google Play and the Apple App Store require their own
billing (Google Play Billing / Apple In-App Purchase) for digital goods inside
store-distributed apps — payment links and unlock codes there can get an app rejected.
This system is aimed at the QR-install / sideload route, internal distribution, and
apps selling real-world goods or services. For store IAP, extend the generated projects
with the store SDKs.

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

**Play requires app bundles, not APKs, for new listings.** Choose AAB in section 06 for
anything going to the Play Console. Keep APK for direct install.

---

## Installing on a phone with the QR code

The server listens on your local network as well as on localhost, but other devices can
reach **only** finished build downloads (`/dl/<token>` links) — the interface, the build
API and your file system stay loopback-only. Set `PACKR_HOST=127.0.0.1` before starting
the server to switch network sharing off entirely.

For the QR install to work:

1. The phone and this computer must be on the same network (same Wi-Fi).
2. Scan the code, open the link, and let the browser download the APK.
3. Android asks once to allow installs from the browser ("install unknown apps") —
   that prompt is normal for any sideloaded APK.

If the phone cannot reach the link, a firewall on this machine is usually blocking
inbound connections to port 4477, or the Wi-Fi has client isolation enabled (common on
guest networks).

---

## The Apple App Store

**An APK is Android-only — an iPhone cannot install one, and Apple cannot accept one.**
What Packr does instead: section 07 generates a complete **Xcode project** of the same
app — a Swift WKWebView shell with your bundled files or live address, your icon,
colours, orientation and permission strings — zipped and ready to move to a Mac.

What it honestly still needs, because Apple allows iOS builds from nowhere else:

- **Xcode on a Mac.** Any Mac with Xcode 15+ works, including a cloud one
  (GitHub Actions macOS runners, Xcode Cloud, MacStadium, AWS EC2 Mac).
- **An Apple Developer Program membership**, US$99/year, for the upload.

Step-by-step instructions are generated into the download as `APP-STORE-STEPS.md`,
including the archive/upload flow and an `ExportOptions.plist` for command-line builds.
Apple's review is stricter than Google's about wrapper apps (Guideline 4.2, Minimum
Functionality) — bundled offline content and device features materially improve your odds;
a bare wrapper around a public website will usually be rejected by both stores.

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
lib/project.js           docket validation, Android project generation
lib/icons.js             launcher + App Store icons (dependency-free PNG writer)
lib/keystore.js          keytool wrapper
lib/build.js             Gradle invocation, artefact collection
lib/qr.js                QR code generator for install links (dependency-free)
lib/zip.js               ZIP writer for the iOS project export (dependency-free)
lib/ios.js               Xcode project generation for the Apple App Store
lib/appui.js             button icons/actions, app chrome, paywall + unlock codes
public/index.html        the interface
template/                the Android project skeleton
template-ios/            the Xcode project skeleton
work/                    generated projects
output/                  finished APK, AAB and iOS zip files
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

# Android App Creator (Packr)

Turn a web page — a folder of HTML files, a single `.html` file, or a live web address —
into a real, installable mobile app. Everything runs **locally on your own computer**;
nothing is uploaded anywhere.

What you get from one docket of settings:

- **APK** files that install directly on Android phones, with a **QR code** any phone on
  your Wi-Fi can scan to download and install the build straight from your machine.
- **AAB** app bundles, signed with your own keystore — the format the
  **Google Play Store** requires for new listings.
- A complete **Xcode project** of the same app for the **Apple App Store** (Apple only
  permits iOS apps to be built and uploaded from Xcode on a Mac — the generated project
  plus the included `APP-STORE-STEPS.md` covers that path end to end).

## Download and run

1. **Get the code** — either clone it or grab the ZIP:
   ```
   git clone https://github.com/stevebarrettsrha-ops/Android-App-Creator.git
   ```
   (or *Code → Download ZIP* on GitHub, then unpack it.)

2. **Install the two prerequisites** for building Android apps (one-time):
   - [Node.js](https://nodejs.org) 18 or newer — runs the tool itself.
   - A JDK 17+ and the Android SDK — easiest is installing
     [Android Studio](https://developer.android.com/studio) and opening it once.
     Details and a leaner path are in [`packr/README.md`](packr/README.md).

3. **Start it:**
   ```
   cd Android-App-Creator/packr
   node server.js
   ```
   Then open **http://localhost:4477** in your browser. The status lamps across the top
   show whether Java and the Android SDK were found.

The generated iOS project needs no compiler on this machine — building it happens later,
in Xcode on a Mac.

## What's in this repository

| Path | What it is |
| --- | --- |
| `packr/` | The app itself: local build server, web interface, Android + iOS project templates. |
| `index.html` | A standalone, browser-only edition: generates an Android project ZIP (built later via GitHub Actions or Android Studio) without needing Node or the SDK installed. Open it directly in a browser. |

The full manual — signing keys and why you must back them up, the two source modes,
QR install details, and what the app stores will and won't accept — is in
[`packr/README.md`](packr/README.md).

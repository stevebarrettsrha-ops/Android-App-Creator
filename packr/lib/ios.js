'use strict';

const fs = require('fs');
const path = require('path');
const { stageWebAssets, copyTree, escapeXml } = require('./project');
const { iconPngBuffer } = require('./icons');
const { zipDirectory } = require('./zip');

const TEMPLATE_DIR = path.join(__dirname, '..', 'template-ios');

const ORIENTATION_SETS = {
  unspecified: {
    iphone: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    ipad: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    locked: false,
  },
  portrait: {
    iphone: ['UIInterfaceOrientationPortrait'],
    ipad: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'],
    locked: true,
  },
  sensorPortrait: {
    iphone: ['UIInterfaceOrientationPortrait'],
    ipad: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'],
    locked: true,
  },
  landscape: {
    iphone: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    ipad: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    locked: true,
  },
};

const USAGE_DESCRIPTIONS = {
  camera: ['NSCameraUsageDescription', 'The camera is used by features of this app that take photos or scan.'],
  microphone: ['NSMicrophoneUsageDescription', 'The microphone is used by features of this app that record audio.'],
  location: ['NSLocationWhenInUseUsageDescription', 'Your location is used by features of this app that need it.'],
};

/** App name reduced to something safe for a target/product/module name. */
function safeProjectName(appName) {
  const cleaned = String(appName).replace(/[^A-Za-z0-9]+/g, '');
  const named = cleaned || 'PackrApp';
  return /^[0-9]/.test(named) ? `App${named}` : named;
}

/** Apple bundle IDs allow letters, digits, dots and hyphens — no underscores. */
function bundleIdFor(packageId) {
  const id = String(packageId).replace(/_/g, '-');
  return { id, changed: id !== packageId };
}

function escapeSwift(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function substituteFile(filePath, replacements) {
  let text = fs.readFileSync(filePath, 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  fs.writeFileSync(filePath, text, 'utf8');
}

function plistStrings(values, indent = '\t\t') {
  return values.map((value) => `${indent}<string>${value}</string>`).join('\n');
}

function offlineHtml(config) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(config.appName)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,system-ui,sans-serif; background:${config.themeColor}; color:#fff; }
  .card { text-align:center; padding:32px; }
  h1 { font-size:22px; margin:0 0 8px; }
  p { opacity:.75; margin:0 0 24px; }
  a { display:inline-block; padding:12px 28px; border:1px solid rgba(255,255,255,.5);
      border-radius:8px; color:#fff; text-decoration:none; font-weight:600; }
</style>
</head>
<body>
  <div class="card">
    <h1>No connection</h1>
    <p>${escapeXml(config.appName)} needs a network connection.</p>
    <a href="packr-retry://now">Try again</a>
  </div>
</body>
</html>
`;
}

/**
 * Generate a complete Xcode project for the same app. Building and uploading
 * it still needs Xcode on a Mac — this produces everything that machine needs.
 */
async function materialiseIos(config, projectDir) {
  const notes = [];
  const name = safeProjectName(config.appName);
  const bundle = bundleIdFor(config.packageId);

  if (bundle.changed) {
    notes.push(
      `Apple bundle IDs cannot contain underscores, so ${config.packageId} became ${bundle.id}.`
    );
  }

  fs.rmSync(projectDir, { recursive: true, force: true });
  copyTree(TEMPLATE_DIR, projectDir);
  fs.renameSync(
    path.join(projectDir, 'App.xcodeproj'),
    path.join(projectDir, `${name}.xcodeproj`)
  );

  // The www folder ships inside the app bundle in both modes; in live-address
  // mode it carries only the offline fallback page.
  let entry = 'index.html';
  if (config.mode === 'local') {
    const staged = stageWebAssets(config, projectDir);
    entry = staged.entry;
    notes.push(...staged.warnings);
    notes.push(`Packaged ${staged.fileCount} file(s) into the iOS project.`);
  } else {
    fs.mkdirSync(path.join(projectDir, 'www'), { recursive: true });
  }
  const offlinePath = path.join(projectDir, 'www', 'offline.html');
  if (!fs.existsSync(offlinePath)) {
    fs.writeFileSync(offlinePath, offlineHtml(config), 'utf8');
  }

  const startUrl = config.mode === 'local' ? '' : config.source;
  const orientations = ORIENTATION_SETS[config.orientation] || ORIENTATION_SETS.unspecified;
  const usageLines = config.permissions
    .filter((permission) => USAGE_DESCRIPTIONS[permission])
    .flatMap((permission) => {
      const [key, text] = USAGE_DESCRIPTIONS[permission];
      return [`\t<key>${key}</key>`, `\t<string>${text}</string>`];
    })
    .join('\n');

  const needsCleartext =
    config.allowCleartext || (config.mode === 'url' && config.source.startsWith('http://'));
  const atsBlock = needsCleartext
    ? '\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>\n\t</dict>'
    : '';
  if (needsCleartext) {
    notes.push('App Transport Security was opened up for plain http. Apple review may ask why.');
  }
  const fullscreenBlock = orientations.locked
    ? '\t<key>UIRequiresFullScreen</key>\n\t<true/>'
    : '';

  substituteFile(path.join(projectDir, `${name}.xcodeproj`, 'project.pbxproj'), {
    __SAFE_NAME__: name,
    __BUNDLE_ID__: bundle.id,
    __VERSION_NAME__: config.versionName,
    __VERSION_CODE__: String(config.versionCode),
  });

  substituteFile(path.join(projectDir, 'App', 'Info.plist'), {
    __APP_NAME__: escapeXml(config.appName),
    __ORIENTATIONS_IPHONE__: plistStrings(orientations.iphone),
    __ORIENTATIONS_IPAD__: plistStrings(orientations.ipad),
    __FULLSCREEN_BLOCK__: fullscreenBlock,
    __ATS_BLOCK__: atsBlock,
    __USAGE_DESCRIPTIONS__: usageLines,
  });

  substituteFile(path.join(projectDir, 'App', 'Config.swift'), {
    __APP_NAME__: escapeSwift(config.appName),
    __START_URL__: escapeSwift(startUrl),
    __LOCAL_MODE__: config.mode === 'local' ? 'true' : 'false',
    __LOCAL_ENTRY__: escapeSwift(entry),
    __EXTERNAL_LINKS_IN_BROWSER__: config.externalLinksInBrowser ? 'true' : 'false',
    __PULL_TO_REFRESH__: config.pullToRefresh ? 'true' : 'false',
    __ALLOW_ZOOM__: config.allowZoom ? 'true' : 'false',
    __THEME_COLOR__: config.themeColor,
  });

  const icon = await iconPngBuffer(1024, config);
  notes.push(...icon.notes);
  fs.writeFileSync(
    path.join(projectDir, 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png'),
    icon.buffer
  );

  fs.writeFileSync(
    path.join(projectDir, 'APP-STORE-STEPS.md'),
    appStoreGuide(config, name, bundle.id),
    'utf8'
  );

  return { projectDir, name, bundleId: bundle.id, notes };
}

/** Materialise and zip in one step; returns the zip artefact description. */
async function buildIosZip(config, workDir, outputDir) {
  const result = await materialiseIos(config, workDir);
  const zipName = `${result.name}-${config.versionName}-ios.zip`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const zipPath = path.join(outputDir, zipName);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });
  const archive = zipDirectory(workDir, zipPath, `${result.name}-iOS`);
  return {
    path: zipPath,
    name: zipName,
    bytes: archive.bytes,
    kind: 'ios',
    notes: result.notes,
    bundleId: result.bundleId,
  };
}

function appStoreGuide(config, name, bundleId) {
  return `# Getting ${config.appName} onto the Apple App Store

This folder is a complete Xcode project. Packr generated it on your machine, but
Apple only allows iOS apps to be built and uploaded from Xcode on a Mac. If you do
not own one, a cloud Mac (MacStadium, AWS EC2 Mac, Scaleway) or a CI service with
macOS runners (GitHub Actions \`macos-latest\`, Xcode Cloud) fills the gap.

## What you need

1. **A Mac** with Xcode 15 or newer, from the Mac App Store.
2. **An Apple Developer Program membership** — US$99/year at
   https://developer.apple.com/programs/enroll/. Uploading is impossible without it.

## Build and upload

1. Copy this whole folder to the Mac and open \`${name}.xcodeproj\` in Xcode.
2. Select the ${name} target → Signing & Capabilities → tick
   **Automatically manage signing** and pick your team. Xcode creates the
   certificates and provisioning profile for bundle ID \`${bundleId}\`.
3. Pick **Any iOS Device (arm64)** as the destination, then
   **Product → Archive**.
4. When the Organizer opens, press **Distribute App → App Store Connect →
   Upload**. (The command-line equivalent uses \`ExportOptions.plist\` in this
   folder: \`xcodebuild -project ${name}.xcodeproj -scheme ${name} archive ...\`)
5. In https://appstoreconnect.apple.com create the app record: same bundle ID,
   name "${config.appName}", version ${config.versionName}. Attach the uploaded
   build, add screenshots, a description, a privacy policy URL and the App
   Privacy answers, then **Submit for Review**.

## Before you submit — read this once

- **Guideline 4.2 (Minimum Functionality).** Apple rejects apps that are only a
  website in a shell, more aggressively than Google does. Bundled offline
  content, real navigation, and features that use the device (camera, files,
  notifications) materially improve your odds. A wrapper around a public
  website will usually be rejected.
- **TestFlight first.** After the upload, the build appears in TestFlight —
  install it on a real iPhone and check everything works before submitting.
- The app icon here ${config.iconPath ? 'was scaled from your icon' : 'is a generated placeholder'};
  the 1024px version lives at \`App/Assets.xcassets/AppIcon.appiconset/icon-1024.png\`.
- Version updates: bump the version in the Packr docket, regenerate, and re-run
  the steps above. CFBundleVersion (${config.versionCode}) must increase with
  every upload.
`;
}

module.exports = { materialiseIos, buildIosZip, safeProjectName, bundleIdFor, TEMPLATE_DIR };

'use strict';

const fs = require('fs');
const path = require('path');
const { writeIcons } = require('./icons');
const appui = require('./appui');

const TEMPLATE_DIR = path.join(__dirname, '..', 'template');

const ORIENTATIONS = new Set(['unspecified', 'portrait', 'landscape', 'sensorPortrait']);

const PERMISSION_LINES = {
  camera: [
    '    <uses-permission android:name="android.permission.CAMERA" />',
    '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
  ],
  microphone: ['    <uses-permission android:name="android.permission.RECORD_AUDIO" />'],
  location: [
    '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
    '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  ],
  storage: [
    '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"',
    '        android:maxSdkVersion="28" />',
  ],
  vibrate: ['    <uses-permission android:name="android.permission.VIBRATE" />'],
};

// ------------------------------------------------------------------ validation

function validate(input) {
  const errors = [];
  const config = {};

  config.mode = input.mode === 'local' ? 'local' : 'url';
  config.source = String(input.source || '').trim();

  if (!config.source) {
    errors.push(config.mode === 'url' ? 'Enter a web address.' : 'Enter a file or folder path.');
  } else if (config.mode === 'url') {
    if (!/^https?:\/\/.+/i.test(config.source)) {
      errors.push('The web address must start with http:// or https://');
    }
  } else if (!fs.existsSync(config.source)) {
    errors.push(`Nothing found at ${config.source}`);
  }

  config.appName = String(input.appName || '').trim();
  if (!config.appName) {
    errors.push('Enter an app name.');
  } else if (config.appName.length > 50) {
    errors.push('Keep the app name to 50 characters or fewer.');
  }

  config.packageId = String(input.packageId || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(config.packageId)) {
    errors.push(
      'The package ID needs at least two lowercase parts separated by dots, e.g. jm.org.cestis.payroll'
    );
  } else if (JAVA_KEYWORDS.some((word) => config.packageId.split('.').includes(word))) {
    errors.push('The package ID contains a reserved Java word. Rename that part.');
  }

  config.versionName = String(input.versionName || '1.0.0').trim();
  if (!/^\d+(\.\d+){0,3}$/.test(config.versionName)) {
    errors.push('The version name should look like 1.0.0');
  }

  config.versionCode = Number.parseInt(input.versionCode, 10);
  if (!Number.isInteger(config.versionCode) || config.versionCode < 1) {
    errors.push('The version code must be a whole number, 1 or higher.');
  }

  config.orientation = ORIENTATIONS.has(input.orientation) ? input.orientation : 'unspecified';
  config.themeColor = normaliseHex(input.themeColor, '#101822');
  config.iconBackground = normaliseHex(input.iconBackground, config.themeColor);
  config.iconPath = String(input.iconPath || '').trim() || null;

  config.externalLinksInBrowser = input.externalLinksInBrowser !== false;
  config.pullToRefresh = Boolean(input.pullToRefresh);
  config.allowZoom = Boolean(input.allowZoom);
  config.allowCleartext = Boolean(input.allowCleartext);

  config.permissions = Array.isArray(input.permissions)
    ? input.permissions.filter((p) => Object.prototype.hasOwnProperty.call(PERMISSION_LINES, p))
    : [];

  config.buildType = input.buildType === 'debug' ? 'debug' : 'release';
  config.outputs = Array.isArray(input.outputs) && input.outputs.length ? input.outputs : ['apk'];
  config.outputs = config.outputs.filter((o) => o === 'apk' || o === 'aab');
  if (!config.outputs.length) config.outputs = ['apk'];

  const ui = appui.validateAppUi(input, errors);
  config.topBar = ui.topBar;
  config.navButtons = ui.navButtons;
  config.premium = ui.premium;

  config.keystore = input.keystore && input.keystore.path ? { ...input.keystore } : null;
  if (config.buildType === 'release' && config.outputs.includes('aab') && !config.keystore) {
    errors.push('An app bundle for Play Store must be signed. Add a keystore or build debug.');
  }
  if (config.keystore && !fs.existsSync(config.keystore.path)) {
    errors.push(`No keystore at ${config.keystore.path}`);
  }

  return { config, errors };
}

const JAVA_KEYWORDS = [
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'true', 'false', 'null',
];

function normaliseHex(value, fallback) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return match ? `#${match[1].toUpperCase()}` : fallback;
}

// --------------------------------------------------------------- file copying

function copyTree(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (skip(source, entry)) continue;
    if (entry.isDirectory()) {
      copyTree(source, target, skip);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}

function substitute(filePath, replacements) {
  let text = fs.readFileSync(filePath, 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  fs.writeFileSync(filePath, text, 'utf8');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// -------------------------------------------------------------- web payload

const WEB_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.txt', '.xml', '.svg', '.png', '.jpg',
  '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3',
  '.mp4', '.webm', '.ogg', '.wav', '.m4a', '.pdf', '.csv', '.wasm', '.webmanifest',
]);

function stageWebAssets(config, assetsDir) {
  const wwwDir = path.join(assetsDir, 'www');
  fs.rmSync(wwwDir, { recursive: true, force: true });
  fs.mkdirSync(wwwDir, { recursive: true });

  const stats = fs.statSync(config.source);
  const warnings = [];

  if (stats.isFile()) {
    if (path.extname(config.source).toLowerCase() !== '.html' &&
        path.extname(config.source).toLowerCase() !== '.htm') {
      warnings.push('The chosen file is not .html — the app may show a blank screen.');
    }
    fs.copyFileSync(config.source, path.join(wwwDir, 'index.html'));
    return { entry: 'index.html', fileCount: 1, warnings };
  }

  let fileCount = 0;
  copyTree(config.source, wwwDir, (source, entry) => {
    if (entry.isDirectory()) {
      return ['node_modules', '.git', '.github', 'dist-android', '__pycache__'].includes(entry.name);
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!WEB_EXTENSIONS.has(ext)) return true;
    fileCount++;
    return false;
  });

  let entry = 'index.html';
  if (!fs.existsSync(path.join(wwwDir, 'index.html'))) {
    const firstHtml = fs
      .readdirSync(wwwDir)
      .find((name) => /\.html?$/i.test(name));
    if (firstHtml) {
      entry = firstHtml;
      warnings.push(`No index.html found; using ${firstHtml} as the start page.`);
    } else {
      warnings.push('No HTML file found in that folder — the app will open to a blank screen.');
    }
  }

  return { entry, fileCount, warnings };
}

// ------------------------------------------------------------ materialisation

/** Build a complete, buildable Gradle project in `projectDir`. */
async function materialise(config, projectDir) {
  const notes = [];

  fs.rmSync(projectDir, { recursive: true, force: true });
  copyTree(TEMPLATE_DIR, projectDir, (source, entry) =>
    entry.isFile() && entry.name === 'gradle-wrapper.jar'
  );

  const mainDir = path.join(projectDir, 'app', 'src', 'main');
  const resDir = path.join(mainDir, 'res');

  // Move MainActivity into its package directory.
  const packagePath = config.packageId.split('.');
  const javaDir = path.join(mainDir, 'java', ...packagePath);
  fs.mkdirSync(javaDir, { recursive: true });
  fs.renameSync(
    path.join(mainDir, 'java', 'MainActivity.java'),
    path.join(javaDir, 'MainActivity.java')
  );

  // Work out the start URL.
  let startUrl;
  if (config.mode === 'local') {
    const staged = stageWebAssets(config, path.join(mainDir, 'assets'));
    notes.push(...staged.warnings);
    notes.push(`Packaged ${staged.fileCount} file(s) from ${config.source}`);
    startUrl = `https://appassets.androidplatform.net/assets/www/${staged.entry}`;
  } else {
    fs.mkdirSync(path.join(mainDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'assets', '.keep'), '');
    startUrl = config.source;
    if (startUrl.startsWith('http://')) {
      config.allowCleartext = true;
      notes.push('That address is plain http, so cleartext traffic was enabled automatically.');
    }
  }

  const permissionLines = config.permissions
    .flatMap((name) => PERMISSION_LINES[name])
    .join('\n');

  const replacements = {
    __PACKAGE_ID__: config.packageId,
    __APP_NAME__: escapeXml(config.appName),
    __VERSION_NAME__: config.versionName,
    __VERSION_CODE__: String(config.versionCode),
    __ORIENTATION__: config.orientation,
    __CLEARTEXT__: config.allowCleartext ? 'true' : 'false',
    __EXTRA_PERMISSIONS__: permissionLines,
    __THEME_COLOR__: config.themeColor,
    __ICON_BACKGROUND__: config.iconBackground,
  };

  const templated = [
    path.join(projectDir, 'app', 'build.gradle'),
    path.join(mainDir, 'AndroidManifest.xml'),
    path.join(javaDir, 'MainActivity.java'),
    path.join(resDir, 'values', 'strings.xml'),
    path.join(resDir, 'values', 'colors.xml'),
    path.join(resDir, 'xml', 'network_security_config.xml'),
  ];
  for (const file of templated) substitute(file, replacements);

  // BuildConfig fields carry runtime behaviour into the app.
  const gradleFile = path.join(projectDir, 'app', 'build.gradle');
  const buildConfigFields = [
    `        buildConfigField "String", "START_URL", ${gradleString(startUrl)}`,
    `        buildConfigField "boolean", "EXTERNAL_LINKS_IN_BROWSER", "${config.externalLinksInBrowser}"`,
    `        buildConfigField "boolean", "PULL_TO_REFRESH", "${config.pullToRefresh}"`,
    `        buildConfigField "boolean", "ALLOW_ZOOM", "${config.allowZoom}"`,
    `        buildConfigField "boolean", "LOCAL_MODE", "${config.mode === 'local'}"`,
  ].join('\n');

  let gradleText = fs.readFileSync(gradleFile, 'utf8');
  gradleText = gradleText.replace(
    `versionName "${config.versionName}"`,
    `versionName "${config.versionName}"\n\n${buildConfigFields}`
  );
  fs.writeFileSync(gradleFile, gradleText, 'utf8');

  // gradle.properties carries the signing config without putting it on the command line.
  if (config.keystore) {
    const properties = [
      '',
      `PACKR_KEYSTORE=${config.keystore.path.replace(/\\/g, '/')}`,
      `PACKR_STORE_PASSWORD=${config.keystore.storePassword || ''}`,
      `PACKR_KEY_ALIAS=${config.keystore.alias || ''}`,
      `PACKR_KEY_PASSWORD=${config.keystore.keyPassword || config.keystore.storePassword || ''}`,
      '',
    ].join('\n');
    fs.appendFileSync(path.join(projectDir, 'gradle.properties'), properties, 'utf8');
  }

  const iconNotes = await writeIcons(resDir, config);
  notes.push(...iconNotes);

  // App chrome: runtime config, the premium screen, and button icon drawables.
  const packrAssets = path.join(mainDir, 'assets', '_packr');
  fs.mkdirSync(packrAssets, { recursive: true });
  fs.writeFileSync(path.join(packrAssets, 'app-config.json'), appui.appConfigJson(config), 'utf8');
  fs.writeFileSync(path.join(packrAssets, 'paywall.html'), appui.paywallHtml(config), 'utf8');

  const drawableDir = path.join(resDir, 'drawable');
  fs.mkdirSync(drawableDir, { recursive: true });
  for (const icon of appui.usedIcons(config.navButtons)) {
    fs.writeFileSync(path.join(drawableDir, `pk_${icon}.xml`), appui.vectorDrawableXml(icon), 'utf8');
  }
  if (config.navButtons.length) {
    notes.push(`Button bar: ${config.navButtons.map((b) => b.label).join(' · ')}`);
  }
  if (config.premium.enabled) {
    notes.push(`Paid features on, ${config.premium.codeHashes.length} unlock code(s) baked in.`);
  }

  return { projectDir, startUrl, notes };
}

function gradleString(value) {
  return `"\\"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}\\""`;
}

module.exports = {
  validate,
  materialise,
  stageWebAssets,
  copyTree,
  escapeXml,
  TEMPLATE_DIR,
};

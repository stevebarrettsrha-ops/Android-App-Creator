'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { validate, materialise } = require('./lib/project');
const { materialiseIos, buildIosZip, safeProjectName, bundleIdFor } = require('./lib/ios');
const { zipDirectory } = require('./lib/zip');
const qrlib = require('./lib/qr');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'packr-test-'));
let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${error.message}`);
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

(async () => {
  // ------------------------------------------------------------ validation

  console.log('\nvalidation');

  check('rejects a one-part package id', () => {
    const { errors } = validate({ mode: 'url', source: 'https://x.org', appName: 'X', packageId: 'payroll', versionCode: 1 });
    assert.ok(errors.some((e) => /package ID/i.test(e)), 'expected a package id error');
  });

  check('rejects a reserved java word in the package id', () => {
    const { errors } = validate({ mode: 'url', source: 'https://x.org', appName: 'X', packageId: 'org.new.app', versionCode: 1 });
    assert.ok(errors.some((e) => /reserved Java word/i.test(e)));
  });

  check('rejects an aab release with no keystore', () => {
    const { errors } = validate({
      mode: 'url', source: 'https://x.org', appName: 'X', packageId: 'org.demo.x',
      versionCode: 1, outputs: ['aab'], buildType: 'release',
    });
    assert.ok(errors.some((e) => /signed/i.test(e)));
  });

  check('accepts a well-formed docket', () => {
    const { errors } = validate({
      mode: 'url', source: 'https://example.org/app/', appName: 'Payroll Manager',
      packageId: 'jm.org.cestis.payroll', versionName: '1.2.0', versionCode: 4,
    });
    assert.deepStrictEqual(errors, []);
  });

  // -------------------------------------------------------------- local mode

  console.log('\nlocal-file mode');

  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><h1>Payroll</h1>');
  fs.writeFileSync(path.join(site, 'assets', 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(site, 'assets', 'style.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(site, 'notes.docx'), 'binary-ish');
  fs.mkdirSync(path.join(site, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(site, 'node_modules', 'junk', 'index.html'), 'nope');

  const localInput = {
    mode: 'local',
    source: site,
    appName: "Rush's Payroll & Co",
    packageId: 'jm.org.cestis.payroll',
    versionName: '1.2.0',
    versionCode: 4,
    orientation: 'portrait',
    themeColor: '#101822',
    permissions: ['camera', 'storage'],
    allowZoom: true,
    pullToRefresh: false,
    outputs: ['apk'],
    buildType: 'release',
  };

  const localValidated = validate(localInput);
  assert.deepStrictEqual(localValidated.errors, [], localValidated.errors.join('; '));

  const localDir = path.join(tmp, 'project-local');
  const localResult = await materialise(localValidated.config, localDir);

  check('start url points at the bundled asset loader', () => {
    assert.strictEqual(
      localResult.startUrl,
      'https://appassets.androidplatform.net/assets/www/index.html'
    );
  });

  check('MainActivity lands in its package directory', () => {
    const target = path.join(localDir, 'app/src/main/java/jm/org/cestis/payroll/MainActivity.java');
    assert.ok(fs.existsSync(target), 'MainActivity.java not in package path');
    assert.ok(
      fs.readFileSync(target, 'utf8').startsWith('package jm.org.cestis.payroll;'),
      'package declaration not substituted'
    );
  });

  check('no placeholder tokens survive anywhere', () => {
    const offenders = walk(localDir)
      .filter((f) => /\.(gradle|xml|java|properties)$/.test(f))
      .filter((f) => /__[A-Z_]+__/.test(fs.readFileSync(f, 'utf8')));
    assert.deepStrictEqual(offenders, [], `tokens left in ${offenders.join(', ')}`);
  });

  check('web assets copied, junk excluded', () => {
    const www = path.join(localDir, 'app/src/main/assets/www');
    assert.ok(fs.existsSync(path.join(www, 'index.html')));
    assert.ok(fs.existsSync(path.join(www, 'assets/app.js')));
    assert.ok(fs.existsSync(path.join(www, 'assets/style.css')));
    assert.ok(!fs.existsSync(path.join(www, 'notes.docx')), 'non-web file was copied');
    assert.ok(!fs.existsSync(path.join(www, 'node_modules')), 'node_modules was copied');
  });

  check('app name with an ampersand and apostrophe is escaped for xml', () => {
    const strings = fs.readFileSync(
      path.join(localDir, 'app/src/main/res/values/strings.xml'), 'utf8'
    );
    assert.ok(strings.includes('&amp;'), 'ampersand not escaped');
    assert.ok(!/name="app_name">[^<]*&(?!amp;|apos;|lt;|gt;|quot;)/.test(strings), 'raw entity');
  });

  check('manifest carries orientation and requested permissions', () => {
    const manifest = fs.readFileSync(
      path.join(localDir, 'app/src/main/AndroidManifest.xml'), 'utf8'
    );
    assert.ok(manifest.includes('android:screenOrientation="portrait"'));
    assert.ok(manifest.includes('permission.CAMERA'));
    assert.ok(manifest.includes('permission.WRITE_EXTERNAL_STORAGE'));
    assert.ok(!manifest.includes('RECORD_AUDIO'), 'unrequested permission present');
    assert.ok(manifest.includes('jm.org.cestis.payroll.fileprovider'));
  });

  check('buildConfig fields are injected with valid groovy string escaping', () => {
    const gradle = fs.readFileSync(path.join(localDir, 'app/build.gradle'), 'utf8');
    assert.ok(
      gradle.includes(
        'buildConfigField "String", "START_URL", "\\"https://appassets.androidplatform.net/assets/www/index.html\\""'
      ),
      'START_URL field malformed'
    );
    assert.ok(gradle.includes('buildConfigField "boolean", "ALLOW_ZOOM", "true"'));
    assert.ok(gradle.includes('buildConfigField "boolean", "LOCAL_MODE", "true"'));
    assert.ok(gradle.includes('versionCode 4'));
  });

  check('launcher icons written at every density as real pngs', () => {
    const res = path.join(localDir, 'app/src/main/res');
    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      for (const name of ['ic_launcher.png', 'ic_launcher_foreground.png']) {
        const file = path.join(res, `mipmap-${density}`, name);
        assert.ok(fs.existsSync(file), `missing ${density}/${name}`);
        const head = fs.readFileSync(file).subarray(0, 8);
        assert.deepStrictEqual(
          [...head],
          [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
          `${density}/${name} is not a PNG`
        );
      }
    }
  });

  // ---------------------------------------------------------------- url mode

  console.log('\nlive-address mode');

  const urlValidated = validate({
    mode: 'url',
    source: 'http://mph.local/dashboard',
    appName: 'MPH Assets',
    packageId: 'jm.gov.serha.mphassets',
    versionName: '2.0',
    versionCode: 12,
    outputs: ['apk'],
    buildType: 'release',
  });
  assert.deepStrictEqual(urlValidated.errors, [], urlValidated.errors.join('; '));

  const urlDir = path.join(tmp, 'project-url');
  const urlResult = await materialise(urlValidated.config, urlDir);

  check('plain http switches cleartext on and says so', () => {
    assert.strictEqual(urlResult.startUrl, 'http://mph.local/dashboard');
    const manifest = fs.readFileSync(path.join(urlDir, 'app/src/main/AndroidManifest.xml'), 'utf8');
    assert.ok(manifest.includes('android:usesCleartextTraffic="true"'));
    const netConfig = fs.readFileSync(
      path.join(urlDir, 'app/src/main/res/xml/network_security_config.xml'), 'utf8'
    );
    assert.ok(netConfig.includes('cleartextTrafficPermitted="true"'));
    assert.ok(urlResult.notes.some((n) => /cleartext/i.test(n)));
  });

  check('no www folder is bundled for a live address', () => {
    assert.ok(!fs.existsSync(path.join(urlDir, 'app/src/main/assets/www')));
  });

  // ------------------------------------------------------------ single file

  console.log('\nsingle-file mode');

  const single = path.join(tmp, 'besorah.html');
  fs.writeFileSync(single, '<!doctype html><title>Besorah</title>');
  const singleValidated = validate({
    mode: 'local', source: single, appName: 'Besorah',
    packageId: 'org.besorah.reader', versionName: '1.0.0', versionCode: 1,
  });
  const singleDir = path.join(tmp, 'project-single');
  await materialise(singleValidated.config, singleDir);

  check('a lone html file becomes index.html', () => {
    const file = path.join(singleDir, 'app/src/main/assets/www/index.html');
    assert.ok(fs.existsSync(file));
    assert.ok(fs.readFileSync(file, 'utf8').includes('Besorah'));
  });

  // ------------------------------------------------------------------- qr

  console.log('\nqr codes');

  check('a share url encodes into a well-formed matrix', () => {
    const code = qrlib.encode('http://192.168.1.50:4477/dl/AbCd12Ef');
    assert.strictEqual(code.size, code.version * 4 + 17);
    // Finder pattern corners are dark; the module next to them is light.
    assert.strictEqual(code.get(0, 0), true);
    assert.strictEqual(code.get(code.size - 1, 0), true);
    assert.strictEqual(code.get(0, code.size - 1), true);
    assert.strictEqual(code.get(7, 7), false);
    // Timing pattern alternates.
    assert.notStrictEqual(code.get(8, 6), code.get(9, 6));
  });

  check('svg rendering produces a drawable document', () => {
    const svg = qrlib.toSvg('hello packr');
    assert.ok(svg.startsWith('<svg'), 'not svg');
    assert.ok(svg.includes('<path'), 'no path data');
    assert.ok(/viewBox="0 0 (\d+) \1"/.test(svg), 'not square');
  });

  check('too-long payloads are refused, not silently truncated', () => {
    assert.throws(() => qrlib.encode('x'.repeat(4000)), /too long/i);
  });

  // ------------------------------------------------------------------ zip

  console.log('\nzip writer');

  const zipSource = path.join(tmp, 'zip-src');
  fs.mkdirSync(path.join(zipSource, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(zipSource, 'hello.txt'), 'hello zip');
  fs.writeFileSync(path.join(zipSource, 'sub', 'data.bin'), Buffer.from([0, 1, 2, 250]));
  const zipTarget = path.join(tmp, 'out.zip');
  zipDirectory(zipSource, zipTarget, 'Rooted');

  check('archive has the right magic, count and extractable content', () => {
    const buffer = fs.readFileSync(zipTarget);
    assert.strictEqual(buffer.readUInt32LE(0), 0x04034b50, 'no local header magic');
    const eocd = buffer.length - 22;
    assert.strictEqual(buffer.readUInt32LE(eocd), 0x06054b50, 'no end record');
    assert.strictEqual(buffer.readUInt16LE(eocd + 10), 2, 'wrong entry count');

    // Extract the first entry by hand and compare.
    const nameLength = buffer.readUInt16LE(26);
    const extraLength = buffer.readUInt16LE(28);
    const method = buffer.readUInt16LE(8);
    const compressedSize = buffer.readUInt32LE(18);
    const name = buffer.toString('utf8', 30, 30 + nameLength);
    const data = buffer.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.strictEqual(name, 'Rooted/hello.txt');
    assert.strictEqual(content.toString('utf8'), 'hello zip');
  });

  // ------------------------------------------------------------------ ios

  console.log('\nios project');

  check('names and bundle ids are made apple-safe', () => {
    assert.strictEqual(safeProjectName("Rush's Payroll & Co"), 'RushsPayrollCo');
    assert.strictEqual(safeProjectName('99 Problems'), 'App99Problems');
    assert.deepStrictEqual(bundleIdFor('jm.org.pay_roll'), { id: 'jm.org.pay-roll', changed: true });
  });

  const iosValidated = validate({
    mode: 'local', source: site, appName: "Rush's Payroll & Co",
    packageId: 'jm.org.cestis.payroll', versionName: '1.2.0', versionCode: 4,
    orientation: 'portrait', permissions: ['camera'], buildType: 'debug', outputs: ['apk'],
  });
  assert.deepStrictEqual(iosValidated.errors, [], iosValidated.errors.join('; '));
  const iosDir = path.join(tmp, 'project-ios');
  const iosResult = await materialiseIos(iosValidated.config, iosDir);

  check('xcode project lands under the safe name with no tokens left', () => {
    const pbx = path.join(iosDir, 'RushsPayrollCo.xcodeproj', 'project.pbxproj');
    assert.ok(fs.existsSync(pbx), 'project.pbxproj missing');
    const offenders = walk(iosDir)
      .filter((f) => /\.(pbxproj|plist|swift|md)$/.test(f))
      .filter((f) => /__[A-Z_]+__/.test(fs.readFileSync(f, 'utf8')));
    assert.deepStrictEqual(offenders, [], `tokens left in ${offenders.join(', ')}`);
    assert.strictEqual(iosResult.bundleId, 'jm.org.cestis.payroll');
  });

  check('web assets and offline page are staged for the bundle', () => {
    assert.ok(fs.existsSync(path.join(iosDir, 'www', 'index.html')));
    assert.ok(fs.existsSync(path.join(iosDir, 'www', 'offline.html')));
    assert.ok(!fs.existsSync(path.join(iosDir, 'www', 'notes.docx')), 'non-web file copied');
  });

  check('swift config carries the docket settings', () => {
    const swift = fs.readFileSync(path.join(iosDir, 'App', 'Config.swift'), 'utf8');
    assert.ok(swift.includes('let localMode = true'));
    assert.ok(swift.includes('let appName = "Rush\'s Payroll & Co"'));
  });

  check('info.plist declares camera usage and portrait lock, nothing else', () => {
    const plist = fs.readFileSync(path.join(iosDir, 'App', 'Info.plist'), 'utf8');
    assert.ok(plist.includes('NSCameraUsageDescription'));
    assert.ok(!plist.includes('NSMicrophoneUsageDescription'));
    assert.ok(plist.includes('UIRequiresFullScreen'));
    assert.ok(!plist.includes('__'), 'unfilled token in plist');
  });

  check('app store icon is an opaque rgb png at 1024', () => {
    const icon = fs.readFileSync(
      path.join(iosDir, 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png')
    );
    assert.deepStrictEqual([...icon.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.strictEqual(icon.readUInt32BE(16), 1024, 'wrong width');
    assert.strictEqual(icon[25], 2, 'has an alpha channel — the App Store rejects that');
  });

  const iosZip = await buildIosZip(
    iosValidated.config, path.join(tmp, 'ios-zip-work'), path.join(tmp, 'ios-zip-out')
  );
  check('the whole project zips up for the trip to a mac', () => {
    assert.strictEqual(iosZip.kind, 'ios');
    const head = fs.readFileSync(iosZip.path).readUInt32LE(0);
    assert.strictEqual(head, 0x04034b50);
    assert.ok(iosZip.bytes > 5000, 'zip suspiciously small');
  });

  // -------------------------------------------- app chrome & paid features

  console.log('\napp chrome & paid features');

  const appui = require('./lib/appui');

  check('bad buttons are rejected with pointed errors', () => {
    const { errors } = validate({
      mode: 'url', source: 'https://x.org', appName: 'X', packageId: 'org.demo.x', versionCode: 1,
      navButtons: [
        { label: '', icon: 'nope', action: 'mystery' },
        { label: 'Shop', icon: 'cart', action: 'page' },
        { label: 'Mail', icon: 'mail', action: 'email', value: 'not-an-email' },
      ],
    });
    assert.ok(errors.some((e) => /give it a label/i.test(e)), 'missing label not caught');
    assert.ok(errors.some((e) => /unknown icon/i.test(e)), 'bad icon not caught');
    assert.ok(errors.some((e) => /unknown action/i.test(e)), 'bad action not caught');
    assert.ok(errors.some((e) => /needs a value/i.test(e)), 'missing page value not caught');
    assert.ok(errors.some((e) => /email address/i.test(e)), 'bad email not caught');
  });

  check('premium mismatches are rejected', () => {
    const base = { mode: 'url', source: 'https://x.org', appName: 'X', packageId: 'org.demo.x', versionCode: 1 };
    const locked = validate({
      ...base,
      navButtons: [{ label: 'Pro', icon: 'crown', action: 'home', premium: true }],
    });
    assert.ok(locked.errors.some((e) => /paid features are off/i.test(e)));
    const noCodes = validate({ ...base, premium: { enabled: true, codeHashes: [] } });
    assert.ok(noCodes.errors.some((e) => /no unlock codes/i.test(e)));
  });

  const chromeInput = {
    mode: 'local', source: site, appName: 'Chrome App', packageId: 'org.demo.chromeapp',
    versionName: '1.0.0', versionCode: 1, topBar: true,
    navButtons: [
      { label: 'Home', icon: 'home', action: 'home' },
      { label: 'Shop', icon: 'cart', action: 'page', value: 'shop.html', premium: true },
      { label: 'Call', icon: 'phone', action: 'call', value: '+1 876 555 0100' },
    ],
    premium: {
      enabled: true, paymentUrl: 'https://buy.example.org/x', priceText: 'US$4.99',
      pitch: "Everything & more — you'll love it.", codeHashes: ['ab'.repeat(32)],
    },
  };
  const chromeValidated = validate(chromeInput);
  assert.deepStrictEqual(chromeValidated.errors, [], chromeValidated.errors.join('; '));
  const chromeDir = path.join(tmp, 'project-chrome');
  await materialise(chromeValidated.config, chromeDir);

  check('button icons land as vector drawables', () => {
    const drawables = path.join(chromeDir, 'app/src/main/res/drawable');
    for (const icon of ['pk_home.xml', 'pk_cart.xml', 'pk_phone.xml']) {
      const file = path.join(drawables, icon);
      assert.ok(fs.existsSync(file), `${icon} missing`);
      assert.ok(fs.readFileSync(file, 'utf8').includes('android:pathData='), `${icon} has no path`);
    }
  });

  check('runtime config ships as a parseable asset with sf symbol names', () => {
    const configPath = path.join(chromeDir, 'app/src/main/assets/_packr/app-config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(parsed.topBar, true);
    assert.strictEqual(parsed.navButtons.length, 3);
    assert.strictEqual(parsed.navButtons[1].premium, true);
    assert.strictEqual(parsed.navButtons[1].sf, 'cart.fill');
    assert.deepStrictEqual(parsed.premium, { enabled: true, codeHashes: ['ab'.repeat(32)] });
    assert.ok(!('paymentUrl' in parsed.premium), 'payment url does not belong in the shell config');
  });

  check('the paywall page is generated with the offer, escaped', () => {
    const paywall = fs.readFileSync(
      path.join(chromeDir, 'app/src/main/assets/_packr/paywall.html'), 'utf8'
    );
    assert.ok(paywall.includes('US$4.99'));
    assert.ok(paywall.includes('Everything &amp; more'), 'pitch not xml-escaped');
    assert.ok(paywall.includes('https://buy.example.org/x'));
    assert.ok(paywall.includes('PackrApp'), 'paywall does not use the bridge');
  });

  const chromeIosDir = path.join(tmp, 'project-chrome-ios');
  await materialiseIos(chromeValidated.config, chromeIosDir);
  check('ios bundle gets _packr config and paywall', () => {
    const configPath = path.join(chromeIosDir, 'www/_packr/app-config.json');
    assert.ok(fs.existsSync(configPath), 'ios app-config.json missing');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(parsed.navButtons[0].sf, 'house.fill');
    assert.ok(fs.existsSync(path.join(chromeIosDir, 'www/_packr/paywall.html')));
  });

  check('every icon in the set has drawable-safe path data', () => {
    for (const [name, icon] of Object.entries(appui.ICONS)) {
      assert.ok(icon.path.length > 10, `${name} path too short`);
      assert.ok(/^[MmLlHhVvZzAaCcQqSsTt0-9 .,-]+$/.test(icon.path), `${name} has odd characters`);
      assert.ok(icon.sf, `${name} has no SF Symbol mapping`);
      assert.strictEqual(appui.vectorDrawableXml(name).includes(icon.path), true);
    }
  });

  console.log(
    failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();

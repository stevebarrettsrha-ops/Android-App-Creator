'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { validate, materialise } = require('./lib/project');

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

  console.log(
    failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();

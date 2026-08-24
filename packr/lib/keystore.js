'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Create an upload keystore. Google Play signing keys should be valid well past
 * any expected app lifetime, so the validity is deliberately long.
 */
function createKeystore(keytoolPath, options) {
  const {
    storePath,
    alias,
    storePassword,
    keyPassword,
    commonName,
    organisation,
    country = 'JM',
    validityDays = 10950, // 30 years
  } = options;

  if (!keytoolPath) {
    throw new Error('keytool was not found. It ships with the JDK — check JAVA_HOME.');
  }
  if (fs.existsSync(storePath)) {
    throw new Error(`A keystore already exists at ${storePath}. Pick a different path.`);
  }
  if (!storePassword || storePassword.length < 6) {
    throw new Error('The keystore password must be at least 6 characters.');
  }

  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  const dname = [
    `CN=${sanitise(commonName || alias)}`,
    `O=${sanitise(organisation || commonName || alias)}`,
    `C=${sanitise(country)}`,
  ].join(', ');

  const result = spawnSync(
    keytoolPath,
    [
      '-genkeypair',
      '-v',
      '-keystore', storePath,
      '-alias', alias,
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', String(validityDays),
      '-storetype', 'PKCS12',
      '-storepass', storePassword,
      '-keypass', keyPassword || storePassword,
      '-dname', dname,
    ],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    throw new Error(`keytool failed:\n${result.stderr || result.stdout}`);
  }

  return {
    storePath,
    alias,
    fingerprint: readFingerprint(keytoolPath, storePath, storePassword, alias),
  };
}

function readFingerprint(keytoolPath, storePath, storePassword, alias) {
  const result = spawnSync(
    keytoolPath,
    ['-list', '-v', '-keystore', storePath, '-storepass', storePassword, '-alias', alias],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) return null;
  const match = /SHA256:\s*([0-9A-F:]+)/i.exec(result.stdout || '');
  return match ? match[1] : null;
}

function sanitise(value) {
  // Commas and equals signs break the -dname argument.
  return String(value || 'app').replace(/[,=+<>#;\\"]/g, ' ').trim() || 'app';
}

module.exports = { createKeystore, readFingerprint };

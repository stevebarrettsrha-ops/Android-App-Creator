'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';

const WRAPPER_JAR_URL =
  'https://raw.githubusercontent.com/gradle/gradle/v8.9.0/gradle/wrapper/gradle-wrapper.jar';

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function onPath(binary) {
  const probe = spawnSync(IS_WINDOWS ? 'where' : 'which', [binary], {
    encoding: 'utf8',
    shell: false,
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  return probe.stdout.split(/\r?\n/)[0].trim() || null;
}

/** Locate a JDK 17+ installation. */
function findJava() {
  const home = process.env.JAVA_HOME;
  const fromHome = home ? path.join(home, 'bin', `java${EXE}`) : null;

  const studioBundles = IS_WINDOWS
    ? [
        'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe',
        'C:\\Program Files\\Android\\Android Studio\\jre\\bin\\java.exe',
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java',
          '/Applications/Android Studio.app/Contents/jre/Contents/Home/bin/java',
        ]
      : ['/opt/android-studio/jbr/bin/java'];

  const found = firstExisting([fromHome, ...studioBundles]) || onPath('java');
  if (!found) return { ok: false, reason: 'No java executable found.' };

  const version = spawnSync(found, ['-version'], { encoding: 'utf8' });
  const text = `${version.stderr || ''}${version.stdout || ''}`;
  const match = text.match(/version "(\d+)/);
  const major = match ? Number(match[1]) : 0;

  if (major && major < 17) {
    return {
      ok: false,
      path: found,
      major,
      reason: `Java ${major} found, but the Android Gradle Plugin needs Java 17 or newer.`,
    };
  }
  return { ok: true, path: found, major, home: path.dirname(path.dirname(found)) };
}

/** Locate the Android SDK. */
function findAndroidSdk() {
  const explicit = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const defaults = IS_WINDOWS
    ? [path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')]
    : process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Android', 'sdk')]
      : [path.join(os.homedir(), 'Android', 'Sdk'), '/usr/lib/android-sdk'];

  const root = firstExisting([explicit, ...defaults]);
  if (!root) {
    return { ok: false, reason: 'Android SDK not found. Set ANDROID_HOME.' };
  }

  const platforms = path.join(root, 'platforms');
  const buildTools = path.join(root, 'build-tools');
  const installedPlatforms = fs.existsSync(platforms) ? fs.readdirSync(platforms) : [];
  const installedBuildTools = fs.existsSync(buildTools) ? fs.readdirSync(buildTools) : [];

  if (installedPlatforms.length === 0) {
    return {
      ok: false,
      root,
      reason: `SDK at ${root} has no platforms installed. Install "platforms;android-35".`,
    };
  }
  if (installedBuildTools.length === 0) {
    return {
      ok: false,
      root,
      reason: `SDK at ${root} has no build-tools installed. Install "build-tools;35.0.0".`,
    };
  }
  return { ok: true, root, platforms: installedPlatforms, buildTools: installedBuildTools };
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'packr' } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        response.resume();
        return download(response.headers.location, destination).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
      }
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
      file.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(60000, () => request.destroy(new Error('Download timed out.')));
  });
}

/**
 * Work out how to invoke Gradle for a generated project, preferring the wrapper.
 * Downloads the wrapper jar on first use so no global Gradle install is required.
 */
async function resolveGradle(projectDir, java, log) {
  const wrapperJar = path.join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');

  if (!fs.existsSync(wrapperJar)) {
    const systemGradle = onPath(IS_WINDOWS ? 'gradle.bat' : 'gradle');
    if (systemGradle) {
      log('Using Gradle from PATH to generate the wrapper.');
      const result = spawnSync(systemGradle, ['wrapper', '--gradle-version', '8.9'], {
        cwd: projectDir,
        encoding: 'utf8',
        shell: IS_WINDOWS,
      });
      if (result.status !== 0) {
        log('Gradle wrapper generation failed; falling back to direct download.');
      }
    }
  }

  if (!fs.existsSync(wrapperJar)) {
    log('Downloading the Gradle wrapper (one time only)...');
    fs.mkdirSync(path.dirname(wrapperJar), { recursive: true });
    await download(WRAPPER_JAR_URL, wrapperJar);
  }

  // This is exactly what the gradlew shell script does, minus the shell script.
  return {
    command: java.path,
    baseArgs: ['-classpath', wrapperJar, 'org.gradle.wrapper.GradleWrapperMain'],
  };
}

/** Locate keytool, which ships alongside java. */
function findKeytool(java) {
  if (java && java.path) {
    const sibling = path.join(path.dirname(java.path), `keytool${EXE}`);
    if (fs.existsSync(sibling)) return sibling;
  }
  return onPath('keytool');
}

function inspect() {
  const java = findJava();
  const sdk = findAndroidSdk();
  return {
    platform: process.platform,
    java,
    sdk,
    keytool: findKeytool(java),
    ready: java.ok && sdk.ok,
  };
}

module.exports = { inspect, findJava, findAndroidSdk, findKeytool, resolveGradle, IS_WINDOWS };

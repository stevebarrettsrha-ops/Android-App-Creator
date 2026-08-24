'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveGradle } = require('./env');

function tasksFor(config) {
  const variant = config.buildType === 'debug' ? 'Debug' : 'Release';
  const tasks = [];
  if (config.outputs.includes('apk')) tasks.push(`assemble${variant}`);
  if (config.outputs.includes('aab')) tasks.push(`bundle${variant}`);
  return tasks;
}

function runGradle(gradle, tasks, projectDir, environment, log) {
  return new Promise((resolve, reject) => {
    const args = [...gradle.baseArgs, ...tasks, '--console=plain', '--no-daemon', '--stacktrace'];
    log(`> gradle ${tasks.join(' ')}`);

    const child = spawn(gradle.command, args, {
      cwd: projectDir,
      env: environment,
      windowsHide: true,
    });

    let tail = '';
    const collect = (buffer) => {
      const text = buffer.toString();
      tail = (tail + text).slice(-8000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) log(line);
      }
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Gradle exited with code ${code}.\n${tail.slice(-2000)}`));
    });
  });
}

function collectArtefacts(projectDir, config, outputDir) {
  const variant = config.buildType;
  const found = [];

  const apkDir = path.join(projectDir, 'app', 'build', 'outputs', 'apk', variant);
  const aabDir = path.join(projectDir, 'app', 'build', 'outputs', 'bundle', variant);

  const safeName = `${config.appName}-${config.versionName}`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  fs.mkdirSync(outputDir, { recursive: true });

  for (const [dir, extension] of [[apkDir, '.apk'], [aabDir, '.aab']]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(extension)) continue;
      const target = path.join(outputDir, `${safeName}-${variant}${extension}`);
      fs.copyFileSync(path.join(dir, name), target);
      found.push({
        path: target,
        name: path.basename(target),
        bytes: fs.statSync(target).size,
        kind: extension.slice(1),
      });
    }
  }
  return found;
}

async function build(config, projectDir, outputDir, environment, log) {
  const gradle = await resolveGradle(projectDir, environment.java, log);

  const childEnv = { ...process.env };
  if (environment.java && environment.java.home) {
    childEnv.JAVA_HOME = environment.java.home;
  }
  if (environment.sdk && environment.sdk.root) {
    childEnv.ANDROID_HOME = environment.sdk.root;
    childEnv.ANDROID_SDK_ROOT = environment.sdk.root;
  }

  // local.properties is what AGP actually reads for the SDK location.
  if (environment.sdk && environment.sdk.root) {
    fs.writeFileSync(
      path.join(projectDir, 'local.properties'),
      `sdk.dir=${environment.sdk.root.replace(/\\/g, '\\\\')}\n`,
      'utf8'
    );
  }

  await runGradle(gradle, tasksFor(config), projectDir, childEnv, log);

  const artefacts = collectArtefacts(projectDir, config, outputDir);
  if (!artefacts.length) {
    throw new Error('Gradle finished but produced no APK or AAB. Check the log above.');
  }
  return artefacts;
}

module.exports = { build, tasksFor };

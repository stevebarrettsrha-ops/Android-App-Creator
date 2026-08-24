#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID, randomBytes } = require('crypto');

const env = require('./lib/env');
const { validate, materialise } = require('./lib/project');
const { build } = require('./lib/build');
const { createKeystore } = require('./lib/keystore');
const { buildIosZip } = require('./lib/ios');
const qr = require('./lib/qr');
const appui = require('./lib/appui');

const PORT = Number(process.env.PACKR_PORT || 4477);
// The server binds all interfaces so a phone on the same Wi-Fi can fetch a
// finished APK through its QR code. Only /dl/<token> answers those requests —
// every other route is refused unless the caller is this machine. Set
// PACKR_HOST=127.0.0.1 to switch the sharing off entirely.
const HOST = process.env.PACKR_HOST || '0.0.0.0';
const ROOT = __dirname;
const WORK_DIR = path.join(ROOT, 'work');
const OUTPUT_DIR = path.join(ROOT, 'output');
const KEYSTORE_DIR = path.join(ROOT, 'keystores');

const jobs = new Map();
const shares = new Map(); // token -> { path, name, kind }

const DOWNLOAD_TYPES = {
  apk: 'application/vnd.android.package-archive',
  aab: 'application/octet-stream',
  ios: 'application/zip',
};

function isLoopback(request) {
  const address = request.socket.remoteAddress || '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

function lanAddresses() {
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const info of addresses || []) {
      if (info.family === 'IPv4' && !info.internal) {
        found.push({ interface: name, address: info.address });
      }
    }
  }
  return found;
}

function createShare(artefact) {
  const token = randomBytes(6).toString('base64url');
  shares.set(token, { path: artefact.path, name: artefact.name, kind: artefact.kind });
  if (shares.size > 200) {
    shares.delete(shares.keys().next().value);
  }
  return token;
}

// ------------------------------------------------------------------ plumbing

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Request too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('Could not read that request.'));
      }
    });
    request.on('error', reject);
  });
}

// ---------------------------------------------------------------------- jobs

function createJob() {
  const id = randomUUID();
  const job = {
    id,
    status: 'running',
    lines: [],
    artefacts: [],
    notes: [],
    error: null,
    listeners: new Set(),
    startedAt: Date.now(),
  };
  jobs.set(id, job);

  // Keep memory bounded if someone leaves the tool running for days.
  if (jobs.size > 40) {
    const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    jobs.delete(oldest.id);
  }
  return job;
}

function pushLine(job, line) {
  const entry = String(line);
  job.lines.push(entry);
  if (job.lines.length > 4000) job.lines.splice(0, job.lines.length - 4000);
  for (const listener of job.listeners) {
    listener({ type: 'log', line: entry });
  }
}

function finishJob(job, patch) {
  Object.assign(job, patch);
  const snapshot = {
    type: 'done',
    status: job.status,
    artefacts: job.artefacts,
    notes: job.notes,
    error: job.error,
  };
  for (const listener of job.listeners) listener(snapshot);
  job.listeners.clear();
}

async function runBuild(job, config) {
  const slug = `${config.packageId}-${config.versionCode}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const projectDir = path.join(WORK_DIR, slug);
  const outputDir = path.join(OUTPUT_DIR, slug);

  try {
    const toolchain = env.inspect();
    if (!toolchain.java.ok) throw new Error(toolchain.java.reason);
    if (!toolchain.sdk.ok) throw new Error(toolchain.sdk.reason);

    pushLine(job, `Java: ${toolchain.java.path}`);
    pushLine(job, `Android SDK: ${toolchain.sdk.root}`);
    pushLine(job, 'Generating the Android project...');

    const result = await materialise(config, projectDir);
    job.notes = result.notes;
    for (const note of result.notes) pushLine(job, `Note: ${note}`);
    pushLine(job, `Start URL: ${result.startUrl}`);
    pushLine(job, 'Starting Gradle. The first build downloads dependencies and can take a while.');

    const artefacts = await build(config, projectDir, outputDir, toolchain, (line) =>
      pushLine(job, line)
    );

    job.artefacts = artefacts.map((artefact) => ({
      name: artefact.name,
      kind: artefact.kind,
      bytes: artefact.bytes,
      href: `/api/artefact/${job.id}/${encodeURIComponent(artefact.name)}`,
      share: `/dl/${createShare(artefact)}`,
      diskPath: artefact.path,
    }));

    pushLine(job, 'Build finished.');
    finishJob(job, { status: 'done' });
  } catch (error) {
    pushLine(job, `Build failed: ${error.message}`);
    finishJob(job, { status: 'failed', error: error.message });
  }
}

// ------------------------------------------------------------------- routing

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  try {
    // Phones on the network may only fetch shared artefacts.
    if ((request.method === 'GET' || request.method === 'HEAD') && route.startsWith('/dl/')) {
      const share = shares.get(route.slice('/dl/'.length));
      if (!share || !fs.existsSync(share.path)) {
        return sendJson(response, 404, { error: 'That link has expired. Build again.' });
      }
      const stat = fs.statSync(share.path);
      response.writeHead(200, {
        'Content-Type': DOWNLOAD_TYPES[share.kind] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${share.name}"`,
        'Cache-Control': 'no-store',
      });
      if (request.method === 'HEAD') return response.end();
      return fs.createReadStream(share.path).pipe(response);
    }

    if (!isLoopback(request)) {
      return sendJson(response, 403, {
        error: 'Only APK download links are reachable from other devices.',
      });
    }

    if (request.method === 'GET' && (route === '/' || route === '/index.html')) {
      const file = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': file.length,
      });
      return response.end(file);
    }

    if (request.method === 'GET' && route === '/api/environment') {
      const toolchain = env.inspect();
      return sendJson(response, 200, {
        ready: toolchain.ready,
        platform: toolchain.platform,
        java: {
          ok: toolchain.java.ok,
          path: toolchain.java.path || null,
          major: toolchain.java.major || null,
          reason: toolchain.java.reason || null,
        },
        sdk: {
          ok: toolchain.sdk.ok,
          root: toolchain.sdk.root || null,
          platforms: toolchain.sdk.platforms || [],
          buildTools: toolchain.sdk.buildTools || [],
          reason: toolchain.sdk.reason || null,
        },
        keytool: Boolean(toolchain.keytool),
        keystores: listKeystores(),
        home: os.homedir(),
        port: PORT,
        sharing: HOST !== '127.0.0.1',
        lan: lanAddresses(),
      });
    }

    // The button icon set and available actions, for the docket's editor.
    if (request.method === 'GET' && route === '/api/icons') {
      const icons = {};
      for (const [name, icon] of Object.entries(appui.ICONS)) icons[name] = icon.path;
      return sendJson(response, 200, {
        icons,
        actions: appui.ACTIONS,
        maxButtons: appui.MAX_BUTTONS,
      });
    }

    // A scannable install link: /api/qr?token=<share>&address=<lan-ip>
    if (request.method === 'GET' && route === '/api/qr') {
      const token = url.searchParams.get('token') || '';
      const address = url.searchParams.get('address') || '';
      if (!shares.has(token)) {
        return sendJson(response, 404, { error: 'Unknown share token.' });
      }
      if (!/^[0-9a-zA-Z.:\-]+$/.test(address)) {
        return sendJson(response, 400, { error: 'Bad address.' });
      }
      const link = `http://${address}:${PORT}/dl/${token}`;
      const svg = qr.toSvg(link, { ecl: 'M' });
      return sendJson(response, 200, { link, svg });
    }

    // Generate the matching Xcode project as a zip, for the Apple App Store
    // path. No compiler needed here — building it happens in Xcode on a Mac.
    if (request.method === 'POST' && route === '/api/ios') {
      const body = await readBody(request);
      // Signing fields are Android-only; neutralise them before validating.
      const { config, errors } = validate({
        ...body,
        outputs: ['apk'],
        buildType: 'debug',
        keystore: null,
      });
      if (errors.length) {
        return sendJson(response, 400, { errors });
      }
      const slug = `${config.packageId}-${config.versionCode}-ios`.replace(
        /[^A-Za-z0-9._-]+/g,
        '-'
      );
      const artefact = await buildIosZip(
        config,
        path.join(WORK_DIR, slug),
        path.join(OUTPUT_DIR, slug)
      );
      return sendJson(response, 200, {
        name: artefact.name,
        bytes: artefact.bytes,
        bundleId: artefact.bundleId,
        notes: artefact.notes,
        href: `/dl/${createShare(artefact)}`,
      });
    }

    if (request.method === 'POST' && route === '/api/inspect-path') {
      const body = await readBody(request);
      return sendJson(response, 200, inspectPath(body.path));
    }

    if (request.method === 'POST' && route === '/api/keystore') {
      const body = await readBody(request);
      const toolchain = env.inspect();
      const storePath = path.join(
        KEYSTORE_DIR,
        `${String(body.name || 'upload').replace(/[^A-Za-z0-9._-]+/g, '-')}.jks`
      );
      const created = createKeystore(toolchain.keytool, {
        storePath,
        alias: String(body.alias || 'upload').trim(),
        storePassword: String(body.storePassword || ''),
        keyPassword: String(body.keyPassword || body.storePassword || ''),
        commonName: body.commonName,
        organisation: body.organisation,
        country: body.country,
      });
      return sendJson(response, 200, created);
    }

    if (request.method === 'POST' && route === '/api/build') {
      const body = await readBody(request);
      const { config, errors } = validate(body);
      if (errors.length) {
        return sendJson(response, 400, { errors });
      }
      const job = createJob();
      runBuild(job, config);
      return sendJson(response, 202, { id: job.id });
    }

    if (request.method === 'GET' && route.startsWith('/api/stream/')) {
      const job = jobs.get(route.slice('/api/stream/'.length));
      if (!job) return sendJson(response, 404, { error: 'Unknown build.' });

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const write = (payload) => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      for (const line of job.lines) write({ type: 'log', line });

      if (job.status !== 'running') {
        write({
          type: 'done',
          status: job.status,
          artefacts: job.artefacts,
          notes: job.notes,
          error: job.error,
        });
        return response.end();
      }

      job.listeners.add(write);
      const heartbeat = setInterval(() => response.write(': ping\n\n'), 15000);
      request.on('close', () => {
        clearInterval(heartbeat);
        job.listeners.delete(write);
      });
      return undefined;
    }

    if (request.method === 'GET' && route.startsWith('/api/artefact/')) {
      const [, , , jobId, encodedName] = route.split('/');
      const job = jobs.get(jobId);
      if (!job) return sendJson(response, 404, { error: 'Unknown build.' });
      const name = decodeURIComponent(encodedName || '');
      const artefact = job.artefacts.find((item) => item.name === name);
      if (!artefact || !fs.existsSync(artefact.diskPath)) {
        return sendJson(response, 404, { error: 'That file is no longer on disk.' });
      }
      const stat = fs.statSync(artefact.diskPath);
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${artefact.name}"`,
      });
      return fs.createReadStream(artefact.diskPath).pipe(response);
    }

    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

// ------------------------------------------------------------------ helpers

function listKeystores() {
  if (!fs.existsSync(KEYSTORE_DIR)) return [];
  return fs
    .readdirSync(KEYSTORE_DIR)
    .filter((name) => /\.(jks|keystore|p12)$/i.test(name))
    .map((name) => ({ name, path: path.join(KEYSTORE_DIR, name) }));
}

function inspectPath(input) {
  const target = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!target) return { ok: false, message: 'Enter a path.' };
  if (!fs.existsSync(target)) return { ok: false, message: `Nothing found at ${target}` };

  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return {
      ok: true,
      kind: 'file',
      resolved: path.resolve(target),
      message: `Single file, ${formatBytes(stat.size)}. It will become index.html in the app.`,
    };
  }

  const names = fs.readdirSync(target);
  const hasIndex = names.some((name) => name.toLowerCase() === 'index.html');
  const htmlCount = names.filter((name) => /\.html?$/i.test(name)).length;
  return {
    ok: true,
    kind: 'folder',
    resolved: path.resolve(target),
    hasIndex,
    message: hasIndex
      ? `Folder with index.html and ${names.length - 1} other entries.`
      : htmlCount
        ? `Folder with ${htmlCount} HTML file(s) but no index.html — the first one will be the start page.`
        : 'No HTML file in that folder. The app would open to a blank screen.',
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

for (const dir of [WORK_DIR, OUTPUT_DIR, KEYSTORE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

server.listen(PORT, HOST, () => {
  const toolchain = env.inspect();
  console.log(`\n  Packr is running at http://localhost:${PORT}\n`);
  console.log(`  Java        ${toolchain.java.ok ? toolchain.java.path : 'NOT FOUND'}`);
  console.log(`  Android SDK ${toolchain.sdk.ok ? toolchain.sdk.root : 'NOT FOUND'}`);
  if (HOST !== '127.0.0.1') {
    const lan = lanAddresses();
    if (lan.length) {
      console.log(
        `  QR install  phones on this network can fetch builds via http://${lan[0].address}:${PORT}/dl/...`
      );
    }
  }
  if (!toolchain.ready) {
    console.log('\n  Builds will fail until both are in place. See README.md.\n');
  } else {
    console.log('');
  }
});

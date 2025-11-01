// electron/main.js
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

app.setName('barcode-offline');

const NEXT_PORT = Number(process.env.PORT || 3000);
const HOSTS = ['127.0.0.1', 'localhost'];

let win;
let child;
let lastStderr = '';

function readDotEnvFile(filePath) {
  const out = {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      // Allow quoted values
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch {}
  return out;
}

function waitForUrl(url, timeoutMs = 30000, intervalMs = 250) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tick() {
      const req = http.get(url, res => {
        res.resume();
        if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 500) return resolve(url);
        if (Date.now() - start > timeoutMs) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        setTimeout(tick, intervalMs);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for ${url}`));
        setTimeout(tick, intervalMs);
      });
      req.setTimeout(2000, () => { try { req.destroy(); } catch {} });
    })();
  });
}
async function waitForAnyHost(hosts, port) {
  for (const h of hosts) {
    try { return await waitForUrl(`http://${h}:${port}`); } catch {}
  }
  throw new Error(`No hosts reachable: ${hosts.map(h=>`http://${h}:${port}`).join(', ')}`);
}

function singleInstanceLock() {
  const got = app.requestSingleInstanceLock();
  if (!got) { app.quit(); return false; }
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  return true;
}

function createWindow(urlToLoad) {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Barcode Offline',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    }
  });
  if (app.isPackaged && process.env.DEBUG_ELECTRON === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(urlToLoad);
}

function logStream() {
  const logDir = app.getPath('userData');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  return fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });
}

// Content-type mapper
function contentTypeFor(p) {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.js': case '.mjs': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': case '.map': return 'application/json; charset=utf-8';
    case '.ico': return 'image/x-icon';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.webp': return 'image/webp';
    case '.wasm': return 'application/wasm';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    case '.eot': return 'application/vnd.ms-fontobject';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
function safePathJoin(root, reqPath) {
  const cleaned = (reqPath || '/').replace(/^\//, '').replace(/\.\./g, '');
  return path.join(root, cleaned);
}
// Serve a file if it exists
function tryServeFile(rootDir, reqPath, res, cacheHeader) {
  const abs = safePathJoin(rootDir, reqPath);
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return false;
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeFor(abs));
    if (cacheHeader) res.setHeader('Cache-Control', cacheHeader);
    fs.createReadStream(abs).pipe(res);
    return true;
  } catch { return false; }
}
// Simple reverse proxy to the Next server
function proxyToNext(req, res) {
  const opts = {
    hostname: HOSTS[0],
    port: NEXT_PORT,
    method: req.method,
    path: req.url,
    headers: req.headers,
  };
  const p = http.request(opts, pres => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  p.on('error', () => {
    res.statusCode = 502;
    res.end('Bad Gateway');
  });
  req.pipe(p);
}
// Start a HTTP server that serves static assets and proxies the rest to Next */
function startStaticShim(appRoot, log) {
  const publicDir = path.join(appRoot, 'public');

  const server = http.createServer((req, res) => {
    try {
      const originalUrl = req.url || '/';

      // Serve /_next/static/* regardless of basePath
      const marker = '/_next/static/';
      const pos = originalUrl.indexOf(marker);
      if (pos >= 0) {
        const tail = originalUrl.slice(pos + marker.length);
        const nextStaticDir = path.join(appRoot, '.next', 'static');
        if (tryServeFile(nextStaticDir, tail, res, 'public, max-age=31536000, immutable')) return;
      }

      // Also try serving from /public (strip leading slash)
      const pubCandidate = originalUrl.replace(/^\//, '').replace(/\?.*$/, '');
      if (pubCandidate && tryServeFile(publicDir, pubCandidate, res, 'public, max-age=3600')) return;

      // Everything else -> Next server
      proxyToNext(req, res);
    } catch (e) {
      log.write(`shim error: ${String(e)}\n`);
      res.statusCode = 500;
      res.end('Internal Error');
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const shimPort = addr && typeof addr === 'object' ? addr.port : 0;
      log.write(`static shim listening on 127.0.0.1:${shimPort}\n`);
      resolve({ server, shimPort });
    });
  });
}

function coerceAbsolute(filePath, baseDir) {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(baseDir, filePath);
}

async function startNextThenShim() {
  const log = logStream();

  const appRoot = path.join(process.resourcesPath, 'app');
  const standaloneDir = path.join(appRoot, '.next', 'standalone');
  const serverEntrypoint = path.join(standaloneDir, 'server.js');
  const cfgDir = path.join(appRoot, 'config');

  // Merge config env files if present
  const envA = readDotEnvFile(path.join(cfgDir, '.env.production'));
  const envB = readDotEnvFile(path.join(cfgDir, 'production.env'));
  const mergedEnv = { ...envB, ...envA };

  // Prefer a bundled service-account file automatically
  let saFile = mergedEnv.FOREMAN_SA_JSON_FILE;
  if (saFile) saFile = coerceAbsolute(saFile, appRoot);
  const defaultSa = path.join(cfgDir, 'service-account.json');
  if (!saFile && fs.existsSync(defaultSa)) saFile = defaultSa;

  const exists = {
    appRoot: fs.existsSync(appRoot),
    standaloneDir: fs.existsSync(standaloneDir),
    serverEntrypoint: fs.existsSync(serverEntrypoint),
    nextStatic: fs.existsSync(path.join(appRoot, '.next', 'static')),
    buildId: fs.existsSync(path.join(appRoot, '.next', 'BUILD_ID')),
    requiredServerFiles: fs.existsSync(path.join(appRoot, '.next', 'required-server-files.json')),
    publicDir: fs.existsSync(path.join(appRoot, 'public')),
    configDir: fs.existsSync(cfgDir),
    saFile: saFile ? fs.existsSync(saFile) : false,
  };

  log.write(`[${new Date().toISOString()}] startNextThenShim\n`);
  log.write(`exists: ${JSON.stringify(exists, null, 2)}\n`);
  if (saFile) log.write(`Using SA file: ${saFile}\n`);

  // Clean any stale SW/caches
  session.defaultSession.clearStorageData({ storages: ['serviceworkers'] }).catch(() => {});
  session.defaultSession.clearCache().catch(() => {});

  const baseEnv = {
    ...process.env,
    ...mergedEnv,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(NEXT_PORT),
  };
  if (saFile) baseEnv.FOREMAN_SA_JSON_FILE = saFile; // make sure API sees it

  // Run the traced Next server and front it with the static shim
  const modes = [
    { name: 'standalone-cwd-standalone', cwd: standaloneDir },
    { name: 'standalone-cwd-approot', cwd: appRoot },
  ];

  for (const mode of modes) {
    // (Re)spawn
    try { if (child && !child.killed) child.kill(); } catch {}
    lastStderr = '';

    log.write(`[${new Date().toISOString()}] START mode=${mode.name} cwd=${mode.cwd}\n`);
    try {
      child = spawn(process.execPath, [serverEntrypoint], {
        env: baseEnv,
        cwd: mode.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      log.write(`spawn error: ${String(err)}\n`);
      continue;
    }
    child.stdout.on('data', d => log.write(d));
    child.stderr.on('data', d => { lastStderr += d.toString(); if (lastStderr.length > 8000) lastStderr = lastStderr.slice(-8000); log.write(d); });
    child.on('exit', (code, signal) => {
      log.write(`[${new Date().toISOString()}] EXIT mode=${mode.name} code=${code} signal=${signal}\n`);
    });

    try {
      await waitForAnyHost(HOSTS, NEXT_PORT);
      log.write(`mode ${mode.name} is answering. Spinning up static shim.\n`);
      const { shimPort } = await startStaticShim(appRoot, log);
      return { shimUrl: `http://127.0.0.1:${shimPort}` };
    } catch (e) {
      log.write(`wait error in ${mode.name}: ${String(e)}\n`);
      // try next mode
    }
  }

  const msg = `
Failed to start internal server with working static/public mapping.

Tried modes:
  - standalone-cwd-standalone
  - standalone-cwd-approot

Last stderr:
${lastStderr || '(no stderr captured)'}
`;
  const w = new BrowserWindow({ width: 1000, height: 700 });
  if (app.isPackaged && process.env.DEBUG_ELECTRON === '1') {
    w.webContents.openDevTools({ mode: 'detach' });
  }
  w.loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent(msg)}`);
  return null;
}

app.whenReady().then(async () => {
  if (!singleInstanceLock()) return;

  if (!app.isPackaged) {
    // dev: assume Next is already running
    createWindow(`http://localhost:${NEXT_PORT}`);
    return;
  }

  const started = await startNextThenShim();
  if (!started) return;

  createWindow(started.shimUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(started.shimUrl);
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('quit', () => { try { if (child && !child.killed) child.kill(); } catch {} });

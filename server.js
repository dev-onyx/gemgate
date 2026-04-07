#!/usr/bin/env node

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import ngrok from '@ngrok/ngrok';
import MODELS from './models.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
process.title = pkg.name;

// .env
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
}

// Args
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const opt = (f, d) => { const i = argv.indexOf(`--${f}`); return (i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : d; };

if (has('help') || has('h')) {
  console.log(`
  ${chalk.bold(pkg.name)} ${chalk.dim(`v${pkg.version}`)}
  ${chalk.dim(pkg.description)}

  ${chalk.bold('USAGE')}
    $ ${pkg.name} [options]

  ${chalk.bold('OPTIONS')}
    --port <n>      Port to listen on              ${chalk.dim('default: 3777')}
    --no-tunnel     Skip ngrok, local-only mode
    --help          Show this message

  ${chalk.bold('ENVIRONMENT')}
    GEMGATE_KEY         Fixed API key
    GEMGATE_PROC        Fixed processor token
    NGROK_AUTHTOKEN     ngrok auth token
    PORT                Port number

  ${chalk.bold('EXAMPLES')}
    $ ${pkg.name}
    $ ${pkg.name} --port 8080
    $ ${pkg.name} --no-tunnel
`);
  process.exit(0);
}

// Config
const PORT = parseInt(opt('port', process.env.PORT || '3777'), 10);
if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
  console.error(chalk.red(`  ✗ Invalid port: ${opt('port', process.env.PORT)}`));
  process.exit(1);
}

const API_KEY = process.env.GEMGATE_KEY || crypto.randomBytes(24).toString('base64url');
const PROC_TOKEN = process.env.GEMGATE_PROC || crypto.randomBytes(24).toString('base64url');
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '120000', 10);
const MAX_BODY = 10 * 1024 * 1024;
const TUNNEL = !has('no-tunnel');

// Internals
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const ts = () => chalk.dim(new Date().toLocaleTimeString('en-GB', { hour12: false }));
function pad(s, n) { return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function latency(ms) {
  const s = `${ms}ms`;
  if (ms < 1000) return chalk.green(s);
  if (ms < 5000) return chalk.yellow(s);
  return chalk.red(s);
}
const log = {
  ok: (m) => console.log(`  ${chalk.green('✓')} ${m}`),
  info: (m) => console.log(`  ${chalk.dim('·')} ${m}`),
  warn: (m) => console.log(`  ${chalk.yellow('!')} ${m}`),
  err: (m) => console.log(`  ${chalk.red('✗')} ${m}`),
  req: (model, detail) => console.log(`  ${ts()}  ${chalk.dim('▶')}  ${pad(model, 28)} ${chalk.dim(detail)}`),
  res: (model, ms) => console.log(`  ${ts()}  ${chalk.green('✓')}  ${pad(model, 28)} ${latency(ms)}`),
  fail: (model, detail) => console.log(`  ${ts()}  ${chalk.red('✗')}  ${pad(model, 28)} ${chalk.red(detail)}`),
};

const processors = new Map();
const pending = new Map();
const stats = { reqs: 0, errs: 0, start: null };
const MODELS_BUF = JSON.stringify({ object: 'list', data: MODELS });
let spinner = null;
let halting = false;

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let sz = 0;
    req.on('data', c => { sz += c.length; if (sz > MAX_BODY) { req.destroy(); reject(new Error('Payload too large')); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function pick() { for (const [k, w] of processors) if (w.readyState === WebSocket.OPEN) return { ws: w, key: k }; return null; }
function emit(ws, d) { if (ws?.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(d)); } catch { } }
function sse(r, d) { r.write(`data: ${JSON.stringify(d)}\n\n`); }
function cleanup(id) { const r = pending.get(id); if (r?.timer) clearTimeout(r.timer); pending.delete(id); }

function err(res, code, msg, type = 'server_error') {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: msg, type, param: null, code: null } }));
}

function timer(id) {
  return setTimeout(() => {
    const r = pending.get(id); if (!r) return;
    if (!r.res.writableEnded) {
      if (r.stream) { sse(r.res, { error: { message: 'Request timed out', type: 'timeout' } }); r.res.write('data: [DONE]\n\n'); r.res.end(); }
      else err(r.res, 504, 'Request timed out');
    }
    cleanup(id);
  }, TIMEOUT);
}

function auth(req, res) {
  const h = req.headers['authorization'];
  if (!h?.startsWith('Bearer ')) { err(res, 401, 'Missing Authorization header', 'auth_error'); return false; }
  if (!safeEq(h.slice(7).trim(), API_KEY)) { err(res, 401, 'Invalid API key', 'auth_error'); return false; }
  return true;
}

function waiting() { spinner = ora({ text: chalk.dim('Waiting for processor…'), color: 'white', indent: 2 }).start(); }

// HTTP// CORS is intentionally permissive — this is a local relay accepting requests
// from any client (Cursor, Continue, Cody, custom scripts, etc.)
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const path = req.url?.split('?')[0];

  // Health
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', version: pkg.version, uptime: Math.floor((Date.now() - stats.start) / 1000), processors: processors.size }));
  }

  if (!auth(req, res)) return;

  // Models
  if (req.method === 'GET' && /^\/(?:v1\/)?models\/?$/.test(path)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(MODELS_BUF);
  }
  const mm = req.method === 'GET' && path?.match(/^\/(?:v1\/)?models\/(.+)$/);
  if (mm) {
    const id = decodeURIComponent(mm[1]).replace(/^models\//, '');
    const m = MODELS.find(x => x.id === id);
    if (m) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(m)); }
    return err(res, 404, `Model '${id}' not found`, 'not_found');
  }

  // Chat completions
  if (req.method === 'POST' && /^\/(?:v1\/)?chat(?:\/completions)?$/.test(path)) {
    let b; try { b = await body(req); } catch { return err(res, 400, 'Invalid request body'); }
    const proc = pick();
    if (!proc) return err(res, 503, 'No processor connected', 'unavailable');

    const id = `req_${crypto.randomBytes(12).toString('hex')}`;
    const strm = b.stream === true;
    const mdl = b.model || 'gemini-flash-latest';

    stats.reqs++;
    pending.set(id, { res, key: proc.key, stream: strm, timer: timer(id), model: mdl, t0: Date.now() });
    if (strm) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });

    log.req(mdl, strm ? 'stream' : 'sync');
    emit(proc.ws, { type: 'process_request', requestId: id, payload: b, stream: strm });
    req.on('close', () => { if (pending.has(id)) cleanup(id); });
    return;
  }

  // Embeddings
  if (req.method === 'POST' && /^\/(?:v1\/)?embeddings$/.test(path)) {
    let b; try { b = await body(req); } catch { return err(res, 400, 'Invalid request body'); }
    const proc = pick();
    if (!proc) return err(res, 503, 'No processor connected', 'unavailable');

    const id = `emb_${crypto.randomBytes(12).toString('hex')}`;
    stats.reqs++;
    pending.set(id, { res, key: proc.key, stream: false, timer: timer(id), model: b.model, t0: Date.now() });

    log.req('embeddings', b.model || '?');
    emit(proc.ws, { type: 'process_request', requestId: id, payload: { ...b, _endpoint: 'embeddings' }, stream: false });
    return;
  }

  // Images
  if (req.method === 'POST' && /^\/(?:v1\/)?images\/generations$/.test(path)) {
    let b; try { b = await body(req); } catch { return err(res, 400, 'Invalid request body'); }
    const proc = pick();
    if (!proc) return err(res, 503, 'No processor connected', 'unavailable');

    const id = `img_${crypto.randomBytes(12).toString('hex')}`;
    stats.reqs++;
    pending.set(id, { res, key: proc.key, stream: false, timer: timer(id), model: b.model, t0: Date.now() });

    log.req('images', b.model || '?');
    emit(proc.ws, { type: 'process_request', requestId: id, payload: { ...b, _endpoint: 'images' }, stream: false });
    return;
  }

  err(res, 404, `${req.method} ${path} not found`, 'not_found');
});

// WebSocket
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 });

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.authed = false;
  ws.on('pong', () => { ws.alive = true; });
  const t = setTimeout(() => { if (!ws.authed) ws.close(1008, 'Auth timeout'); }, 10_000);

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'ping') return emit(ws, { type: 'pong' });

    if (m.type === 'register_processor') {
      if (!safeEq(m.token, PROC_TOKEN)) { ws.close(1008, 'Bad token'); return; }
      clearTimeout(t);
      const key = crypto.randomBytes(16).toString('hex');
      ws.key = key; ws.authed = true;
      processors.set(key, ws);
      if (spinner) { spinner.stop(); spinner = null; }
      log.ok(`Processor connected ${chalk.dim(key.slice(0, 8))}`);
      console.log('');
      return emit(ws, { type: 'registered', sessionKey: key });
    }

    if (!ws.authed) return ws.close(1008, 'Not authenticated');

    if (m.type === 'processor_response') {
      const r = pending.get(m.requestId);
      if (!r || r.res.writableEnded) { cleanup(m.requestId); return; }
      if (r.stream) { sse(r.res, m.data); r.res.write('data: [DONE]\n\n'); r.res.end(); }
      else { r.res.writeHead(200, { 'Content-Type': 'application/json' }); r.res.end(JSON.stringify(m.data)); }
      log.res(r.model, Date.now() - r.t0);
      cleanup(m.requestId);
      return;
    }

    if (m.type === 'processor_chunk') {
      const r = pending.get(m.requestId);
      if (!r || r.res.writableEnded) { cleanup(m.requestId); return; }
      if (r.stream) sse(r.res, m.chunk);
      if (m.isComplete) { r.res.write('data: [DONE]\n\n'); r.res.end(); log.res(r.model, Date.now() - r.t0); cleanup(m.requestId); }
      return;
    }

    if (m.type === 'error') {
      const r = pending.get(m.requestId);
      if (!r || r.res.writableEnded) { cleanup(m.requestId); return; }
      const e = { error: { message: m.message || 'Processing error', type: m.code || 'server_error', param: null, code: m.code || null } };
      if (r.stream) { sse(r.res, e); r.res.write('data: [DONE]\n\n'); r.res.end(); }
      else { r.res.writeHead(m.httpStatus || 500, { 'Content-Type': 'application/json' }); r.res.end(JSON.stringify(e)); }
      stats.errs++;
      log.fail(r.model, m.message?.slice(0, 80));
      cleanup(m.requestId);
    }
  });

  ws.on('close', () => {
    clearTimeout(t);
    if (!ws.key) return;
    processors.delete(ws.key);
    log.warn(`Processor disconnected ${chalk.dim(ws.key.slice(0, 8))}`);
    const orphans = [...pending.entries()].filter(([, r]) => r.key === ws.key && !r.res.writableEnded).map(([id]) => id);
    for (const id of orphans) {
      const r = pending.get(id);
      if (r.stream) { sse(r.res, { error: { message: 'Processor disconnected', type: 'unavailable' } }); r.res.write('data: [DONE]\n\n'); r.res.end(); }
      else err(r.res, 503, 'Processor disconnected');
      cleanup(id);
    }
    waiting();
  });
});

// Heartbeat
const hb = setInterval(() => { wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }); }, 30_000);

// Tunnel
async function tunnel() {
  let tok = process.env.NGROK_AUTHTOKEN;
  if (!tok) {
    for (const p of [
      join(process.env.LOCALAPPDATA || '', 'ngrok', 'ngrok.yml'),
      join(process.env.HOME || '', '.config', 'ngrok', 'ngrok.yml'),
      join(process.env.HOME || '', 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
    ]) {
      try { const m = readFileSync(p, 'utf-8').match(/authtoken:\s*["']?([^\s"']+)/); if (m) { tok = m[1]; break; } } catch { }
    }
  }
  if (!tok) throw new Error('No ngrok authtoken. Set NGROK_AUTHTOKEN or run: ngrok config add-authtoken <token>');
  return (await ngrok.forward({ addr: PORT, authtoken: tok })).url();
}

// Shutdown
function uptime() {
  const s = Math.floor((Date.now() - stats.start) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function halt() {
  if (halting) return; halting = true;
  if (spinner) spinner.stop();
  console.log('');
  console.log(`  ${chalk.dim(stats.reqs)} ${chalk.dim('requests')}  ${chalk.dim('·')}  ${stats.errs > 0 ? chalk.red(stats.errs + ' errors') : chalk.dim('0 errors')}  ${chalk.dim('·')}  ${chalk.dim(uptime())}`);
  console.log('');
  clearInterval(hb);
  wss.clients.forEach(w => w.terminate());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGINT', halt);
process.on('SIGTERM', halt);
process.on('uncaughtException', (e) => { console.error(`\n  ${chalk.red('✗')} ${e.message}`); halt(); });
process.on('unhandledRejection', (e) => { console.error(`\n  ${chalk.red('✗')} ${e}`); halt(); });

// Boot
console.clear();
const t0 = Date.now();

server.listen(PORT, async () => {
  stats.start = Date.now();

  console.log('');
  console.log(`  ${chalk.bold(pkg.name)} ${chalk.dim(`v${pkg.version}`)}`);

  let url = null;
  if (TUNNEL) {
    const s = ora({ text: chalk.dim('Connecting tunnel…'), color: 'white', indent: 2 }).start();
    try { url = await tunnel(); s.stop(); }
    catch (e) {
      s.stop();
      log.err(`Tunnel failed — ${e.message}`);
      log.info(`Run ${chalk.bold('ngrok config add-authtoken <token>')} to fix`);
      console.log('');
    }
  }

  const httpBase = url || `http://localhost:${PORT}`;
  const wsBase = url ? url.replace(/^http/, 'ws') : `ws://localhost:${PORT}`;

  console.log('');
  console.log(`  ${chalk.dim('Endpoint')}    ${chalk.white(httpBase)}`);
  console.log(`  ${chalk.dim('API Key')}     ${chalk.white(API_KEY)}`);
  console.log('');
  console.log(`  ${chalk.dim('Processor')}   ${chalk.white(wsBase)}`);
  console.log(`  ${chalk.dim('Token')}       ${chalk.white(PROC_TOKEN)}`);
  console.log('');

  if (!TUNNEL) {
    log.info('Local mode — no tunnel');
  }
  log.info(`Processor → ${chalk.underline('https://ai.studio/apps/4bf06673-9b53-4f03-9002-3822741dcd88?fullscreenApplet=true')}`);
  console.log('');

  waiting();
});


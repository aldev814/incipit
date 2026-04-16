'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const GLOBAL_KEY = '__cceBadge';
const POLL_INTERVAL_MS = 1500;
const JSONL_SUFFIX = '.jsonl';

function attachComm(comm) {
  const state = getOrCreateState();
  state.comms.add(comm);
  wrapShutdown(comm, state);
  sendLatest(state, comm);
  startPolling(state);
}

function getOrCreateState() {
  const globalRef = globalThis;
  if (globalRef[GLOBAL_KEY]) return globalRef[GLOBAL_KEY];
  const state = createState();
  globalRef[GLOBAL_KEY] = state;
  return state;
}

function createState() {
  return {
    comms: new Set(),
    latest: null,
    started: false,
    patchedFs: false,
    ourFile: null,
    cache: { path: null, mtimeMs: 0, payload: null },
    log(message) {
      try { console.log(`[cceBadge] ${message}`); } catch (_) {}
    },
  };
}

function wrapShutdown(comm, state) {
  if (!comm || comm.__cceBadgeWrapped) return;
  if (typeof comm.shutdown !== 'function') {
    throw new Error('[cceBadge] attachComm expected a comm with shutdown()');
  }
  const original = comm.shutdown;
  comm.__cceBadgeWrapped = true;
  comm.shutdown = async function wrappedShutdown() {
    state.comms.delete(comm);
    return original.apply(this, arguments);
  };
}

function startPolling(state) {
  if (state.started) return;
  state.started = true;
  patchFs(state);
  state.tick = () => poll(state);
  state.tick();
  state.timer = setInterval(state.tick, POLL_INTERVAL_MS);
}

function patchFs(state) {
  if (state.patchedFs) return;
  state.patchedFs = true;
  const root = projectsRoot();
  wrapFsMethod('appendFile', state, root);
  wrapFsMethod('appendFileSync', state, root);
  wrapFsMethod('writeFile', state, root);
  wrapFsMethod('writeFileSync', state, root);
  wrapFsMethod('createWriteStream', state, root);
}

function wrapFsMethod(name, state, root) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  fs[name] = function wrapped(filePath) {
    trackSessionFile(state, root, filePath);
    return original.apply(fs, arguments);
  };
}

function trackSessionFile(state, root, filePath) {
  if (!isSessionFilePath(root, filePath)) return;
  if (state.ourFile === filePath) return;
  state.ourFile = filePath;
  state.log(`ourFile=${filePath}`);
}

function isSessionFilePath(root, filePath) {
  return (
    typeof filePath === 'string' &&
    filePath.startsWith(root) &&
    filePath.toLowerCase().endsWith(JSONL_SUFFIX)
  );
}

function poll(state) {
  try {
    const target = resolveTargetFile(state);
    if (!target || !fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (isCacheHit(state, target, stat.mtimeMs)) {
      broadcast(state, state.cache.payload);
      return;
    }
    const payload = parseUsageFile(target, stat.mtimeMs);
    if (!payload) return;
    state.cache = { path: target, mtimeMs: stat.mtimeMs, payload };
    broadcast(state, payload);
  } catch (error) {
    state.log(`tick error: ${error}`);
  }
}

function resolveTargetFile(state) {
  if (state.ourFile) return state.ourFile;
  const workspaces = getWorkspaceFolders();
  if (!workspaces?.length) return null;
  const cwd = workspaces[0].uri.fsPath;
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(projectsRoot(), encoded);
  if (!fs.existsSync(dir)) return null;
  return newestJsonlFile(dir);
}

function newestJsonlFile(dir) {
  const files = fs.readdirSync(dir).filter(name => name.endsWith(JSONL_SUFFIX));
  let latestPath = null;
  let latestMtime = 0;
  for (const name of files) {
    const fullPath = path.join(dir, name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs <= latestMtime) continue;
      latestMtime = stat.mtimeMs;
      latestPath = fullPath;
    } catch (_) {}
  }
  return latestPath;
}

function isCacheHit(state, filePath, mtimeMs) {
  return (
    state.cache.path === filePath &&
    state.cache.mtimeMs === mtimeMs &&
    state.cache.payload
  );
}

function parseUsageFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const requests = collectRequests(text);
  if (!requests.length) return null;
  const totals = collectTotals(requests);
  const recent = collectRecent(requests);
  const last = requests[requests.length - 1].usage;
  const ctx = totalContextTokens(last);
  return {
    ctx,
    hit: ctx > 0 ? (last.cache_read_input_tokens || 0) / ctx : 0,
    input: last.input_tokens || 0,
    cc: last.cache_creation_input_tokens || 0,
    cr: last.cache_read_input_tokens || 0,
    out: last.output_tokens || 0,
    ts: Date.now(),
    src: filePath,
    recent,
    totals,
  };
}

function collectRequests(text) {
  const byRequest = new Map();
  const order = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const entry = parseUsageEntry(line);
    if (!entry) continue;
    const requestId = entry.requestId || `idx${index}`;
    if (!byRequest.has(requestId)) order.push(requestId);
    byRequest.set(requestId, { usage: entry.message.usage, ts: entry.timestamp || '' });
  }
  return order.map(requestId => byRequest.get(requestId));
}

function parseUsageEntry(line) {
  try {
    const entry = JSON.parse(line);
    if (!entry || entry.type !== 'assistant') return null;
    if (!entry.message?.usage) return null;
    return entry;
  } catch (_) {
    return null;
  }
}

function collectTotals(requests) {
  const totals = { requests: requests.length, fresh: 0, cw: 0, cr: 0, out: 0, durationMs: 0 };
  for (const { usage } of requests) {
    totals.fresh += usage.input_tokens || 0;
    totals.cw += usage.cache_creation_input_tokens || 0;
    totals.cr += usage.cache_read_input_tokens || 0;
    totals.out += usage.output_tokens || 0;
  }
  const totalContext = totals.fresh + totals.cw + totals.cr;
  totals.hitOverall = totalContext > 0 ? totals.cr / totalContext : 0;
  if (requests.length >= 2) {
    const first = Date.parse(requests[0].ts);
    const last = Date.parse(requests[requests.length - 1].ts);
    if (!Number.isNaN(first) && !Number.isNaN(last)) totals.durationMs = last - first;
  }
  return totals;
}

function collectRecent(requests) {
  return requests.slice(-5).map(({ usage, ts }) => {
    const ctx = totalContextTokens(usage);
    return {
      ts,
      ctx,
      hit: ctx > 0 ? (usage.cache_read_input_tokens || 0) / ctx : 0,
      output: usage.output_tokens || 0,
    };
  });
}

function totalContextTokens(usage) {
  return (
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  );
}

function broadcast(state, payload) {
  state.latest = payload;
  for (const comm of state.comms) sendPayload(comm, payload);
}

function sendLatest(state, comm) {
  if (!state.latest) return;
  sendPayload(comm, state.latest);
}

function sendPayload(comm, payload) {
  try {
    if (!comm.webview || typeof comm.webview.postMessage !== 'function') {
      throw new Error('[cceBadge] attachComm expected a comm.webview.postMessage()');
    }
    comm.webview.postMessage({ __cceBadge: true, payload });
  } catch (_) {}
}

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function getWorkspaceFolders() {
  try {
    return require('vscode').workspace?.workspaceFolders;
  } catch (_) {
    return null;
  }
}

module.exports = { attachComm };

'use strict';
/**
 * 能力沙箱：require 白名单 + fs 路径 glob + process/console 收窄。
 *
 * 能挡：越权 API（child_process / net / 任意 fs 路径）、process.exit、环境变量泄露。
 * 不能挡：同步死循环、CPU/内存耗尽（需要进程隔离，见文档「安全模型」）。
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ALWAYS_OK = new Set([
  'path', 'util', 'crypto', 'os', 'events', 'stream', 'buffer',
  'string_decoder', 'url', 'querystring', 'zlib', 'assert', 'punycode', 'timers', 'tty'
]);
const NET_MODULES = new Set(['net', 'dgram', 'tls', 'http', 'https', 'http2', 'dns', 'dns/promises']);
const SUBPROCESS_MODULES = new Set(['child_process', 'worker_threads', 'cluster']);

function globToRegex(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

const spec = (list) => (Array.isArray(list) ? list : []).map(globToRegex);
const deny = (op, target) => Object.assign(new Error('sandbox denied ' + op + ': ' + target), { code: 'EPERM' });

function createGuardedFs(perms) {
  const readRe = spec(perms.fs_read);
  const writeRe = spec(perms.fs_write);
  const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/');
  const canRead = (p) => readRe.some((r) => r.test(norm(p)));
  const canWrite = (p) => writeRe.some((r) => r.test(norm(p)));

  const api = { constants: fs.constants };
  const READ = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'readFile', 'readdir', 'stat', 'lstat', 'createReadStream'];
  const WRITE = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'copyFileSync', 'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'copyFile', 'createWriteStream'];
  const RW = ['renameSync', 'rename'];

  for (const k of READ) if (typeof fs[k] === 'function') api[k] = (...a) => { if (!canRead(a[0])) throw deny(k, a[0]); return fs[k](...a); };
  for (const k of WRITE) if (typeof fs[k] === 'function') api[k] = (...a) => { if (!canWrite(a[0])) throw deny(k, a[0]); return fs[k](...a); };
  for (const k of RW) if (typeof fs[k] === 'function') api[k] = (...a) => {
    if (!canRead(a[0])) throw deny(k + ' src', a[0]);
    if (!canWrite(a[1])) throw deny(k + ' dst', a[1]);
    return fs[k](...a);
  };
  return api;
}

function createSandboxRequire(dir, manifest, cache = new Map()) {
  const perms = manifest.permissions || {};
  const guardedFs = createGuardedFs(perms);

  return function sandboxRequire(id) {
    if (typeof id !== 'string') throw new Error('require() expects a string');
    if (cache.has(id)) return cache.get(id);

    const bare = id.replace(/^node:/, '');
    let mod;

    if (bare === 'fs' || bare === 'fs/promises') {
      if (!perms.fs_read && !perms.fs_write) throw deny('require', id);
      mod = guardedFs;
    } else if (SUBPROCESS_MODULES.has(bare)) {
      if (!perms.subprocess) throw deny('require', id);
      mod = require(bare);
    } else if (NET_MODULES.has(bare)) {
      if (!perms.network) throw deny('require', id);
      mod = require(bare);
    } else if (ALWAYS_OK.has(bare)) {
      mod = require(bare);
    } else if (bare.startsWith('./') || bare.startsWith('../') || path.isAbsolute(bare)) {
      const resolved = require.resolve(path.resolve(dir, bare));
      const rel = path.relative(dir, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw deny('require outside plugin dir', id);
      mod = require(resolved);
    } else {
      throw deny('require', id);
    }

    cache.set(id, mod);
    return mod;
  };
}

function buildProcessShim(manifest) {
  const allow = new Set((manifest.sandbox && manifest.sandbox.allow_env) || ['HOME']);
  const env = {};
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    env,
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    versions: { node: process.versions.node },
    pid: process.pid,
    cwd: () => process.cwd(),
    uptime: () => process.uptime(),
    hrtime: process.hrtime,
    nextTick: (fn, ...a) => process.nextTick(fn, ...a),
    on() { return this; },
    exit() { throw new Error('sandbox: process.exit is disabled'); }
  };
}

function buildConsoleShim(name, sink) {
  const prefix = '[' + name + '] ';
  const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  const emit = (level) => (...args) => {
    const line = prefix + args.map(fmt).join(' ');
    if (sink) sink(level, line);
    else (console[level] || console.log)(line);
  };
  return { log: emit('log'), info: emit('log'), warn: emit('warn'), error: emit('error'), debug: emit('log') };
}

/** 在沙箱中加载插件，返回 { name, dir, manifest, exports } */
function loadPlugin(name, dir, manifest, opts = {}) {
  const entry = path.join(dir, manifest.entry || 'index.js');
  if (!fs.existsSync(entry)) throw new Error('entry not found: ' + entry);

  const src = fs.readFileSync(entry, 'utf8');
  const moduleShim = { exports: {}, id: entry, filename: entry, loaded: false };
  const context = vm.createContext({});

  const fn = vm.compileFunction(
    src,
    ['exports', 'require', 'module', '__filename', '__dirname', 'process', 'console', 'Buffer',
     'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
    { parsingContext: context, filename: entry }
  );

  fn(
    moduleShim.exports,
    createSandboxRequire(dir, manifest),
    moduleShim,
    entry,
    dir,
    buildProcessShim(manifest),
    buildConsoleShim(name, opts.log),
    Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask
  );

  moduleShim.loaded = true;
  return { name, dir, manifest, exports: moduleShim.exports };
}

/** 调用命令；timeout 只保证「不无限等待返回」，无法打断同步死循环 */
async function invoke(loaded, cmd, args = [], timeoutMs = 10000) {
  const fn = loaded.exports[cmd];
  if (typeof fn !== 'function') throw new Error('unknown command: ' + cmd);
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('command timeout after ' + timeoutMs + 'ms: ' + cmd)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => fn(...args)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { loadPlugin, invoke, createGuardedFs, createSandboxRequire, globToRegex, ALWAYS_OK, NET_MODULES, SUBPROCESS_MODULES, buildProcessShim };

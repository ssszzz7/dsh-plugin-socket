'use strict';
/**
 * PluginManager —— 插件插座的“配电盘”
 * 目录约定： <home>/plugins/<name>/{manifest.json,index.js,...}
 *           <home>/plugins/catalog.json   插件清单
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const sandbox = require('./sandbox');
const ipc = require('./socket');

function resolveHome(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.dsh');
}

const toPosix = (p) => p.replace(/\\/g, '/');

class PluginManager {
  constructor(opts = {}) {
    this.home = resolveHome(opts.home);
    this.pluginsDir = opts.pluginsDir || path.join(this.home, 'plugins');
    this.catalogPath = opts.catalogPath || path.join(this.pluginsDir, 'catalog.json');
  }

  // --- 基础 ---
  ensureDirs() { fs.mkdirSync(this.pluginsDir, { recursive: true }); }

  pluginDir(name) { return path.join(this.pluginsDir, name); }

  list() {
    if (!fs.existsSync(this.pluginsDir)) return [];
    return fs.readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => fs.existsSync(path.join(this.pluginDir(n), 'manifest.json')))
      .sort();
  }

  manifest(name) {
    try { return JSON.parse(fs.readFileSync(path.join(this.pluginDir(name), 'manifest.json'), 'utf8')); }
    catch { return null; }
  }

  catalog() {
    try { return JSON.parse(fs.readFileSync(this.catalogPath, 'utf8')); }
    catch { return { schema_version: '1.0', name: 'dsh-plugin-catalog', plugins: [] }; }
  }

  saveCatalog(catalog) {
    this.ensureDirs();
    fs.writeFileSync(this.catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    return catalog;
  }

  // --- 安装 ---
  install(name, opts = {}) {
    if (!name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error('invalid plugin name: ' + name);
    this.ensureDirs();
    if (fs.existsSync(this.pluginDir(name))) throw new Error('plugin already exists: ' + name);

    const dir = this.pluginDir(name);
    fs.mkdirSync(dir, { recursive: true });

    const manifest = {
      name,
      version: opts.version || '1.0.0',
      description: opts.description || 'DSH plugin: ' + name,
      entry: 'index.js',
      api_version: '1.0',
      permissions: {
        fs_read: [toPosix(this.pluginsDir) + '/**'],
        fs_write: [toPosix(dir) + '/**'],
        socket: true,
        network: false,
        subprocess: false
      },
      dependencies: [],
      commands: { hello: { description: 'Say hello', usage: 'dsh-plugin run ' + name + ' hello' } },
      socket: { enabled: true, port: 0, protocol: 'json' },
      sandbox: { isolated: true, allow_env: ['HOME', 'DSH_PLUGIN_DIR'] }
    };

    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const tpl = fs.readFileSync(path.join(__dirname, 'templates', 'plugin-index.js.tpl'), 'utf8');
    fs.writeFileSync(path.join(dir, 'index.js'), tpl.replace(/\{\{name\}\}/g, name));

    const catalog = this.catalog();
    if (!catalog.plugins.some((p) => p.name === name)) catalog.plugins.push({ name, version: manifest.version });
    this.saveCatalog(catalog);

    return { name, dir, manifest };
  }

  // --- 体检 / 冲突 ---
  inspect(name) {
    const manifest = this.manifest(name);
    if (!manifest) return null;
    const entry = path.join(this.pluginDir(name), manifest.entry || 'index.js');
    return {
      name,
      manifest,
      entryExists: fs.existsSync(entry),
      entry,
      commands: Object.keys(manifest.commands || {}),
      perms: manifest.permissions || {}
    };
  }

  /** 跨插件冲突：命令重名 / 固定端口撞车 / 依赖缺失 */
  conflicts(names) {
    const plugins = (names || this.list())
      .map((n) => ({ name: n, manifest: this.manifest(n) }))
      .filter((p) => p.manifest);

    const issues = [];
    const cmdOwner = new Map();
    const portOwner = new Map();
    const present = new Set(plugins.map((p) => p.name));

    for (const { name, manifest } of plugins) {
      for (const cmd of Object.keys(manifest.commands || {})) {
        const key = cmd.toLowerCase();
        if (cmdOwner.has(key)) {
          issues.push({ level: 'conflict', kind: 'command', detail: 'command "' + cmd + '" is claimed by both ' + cmdOwner.get(key) + ' and ' + name });
        } else cmdOwner.set(key, name);
      }

      const port = manifest.socket && manifest.socket.port;
      if (port) {
        if (portOwner.has(port)) issues.push({ level: 'conflict', kind: 'port', detail: 'port ' + port + ' is used by both ' + portOwner.get(port) + ' and ' + name });
        else portOwner.set(port, name);
      }

      for (const dep of manifest.dependencies || []) {
        const depName = typeof dep === 'string' ? dep : dep && dep.name;
        if (depName && !present.has(depName)) {
          issues.push({ level: 'error', kind: 'dependency', detail: name + ' requires missing plugin: ' + depName });
        }
      }
    }
    return issues;
  }

  check(name) {
    const names = name ? [name] : this.list();
    const rows = names.map((n) => {
      const info = this.inspect(n);
      if (!info) return { name: n, ok: false, message: 'NOT FOUND' };
      const perms = info.perms;
      const flags = [perms.fs_write && 'fs:write', perms.network && 'network', perms.subprocess && 'subprocess']
        .filter(Boolean).join(',') || 'read-only';
      return {
        name: n,
        ok: info.entryExists,
        message: (info.entryExists ? 'OK' : 'MISSING ENTRY') + '  entry=' + (info.manifest.entry || 'index.js') +
          '  commands=[' + (info.commands.join(', ') || '-') + ']  perms=' + flags,
        info
      };
    });

    const issues = name ? [] : this.conflicts();
    return { rows, issues, ok: rows.every((r) => r.ok) && issues.length === 0 };
  }

  // --- 执行 ---
  load(name) {
    const info = this.inspect(name);
    if (!info) throw new Error('plugin not found: ' + name);
    if (!info.entryExists) throw new Error('entry not found: ' + info.entry);
    return sandbox.loadPlugin(name, this.pluginDir(name), info.manifest);
  }

  async run(name, cmd, args = [], opts = {}) {
    if (!cmd) throw new Error('command name is required');
    const info = this.inspect(name);
    if (!info) throw new Error('plugin not found: ' + name);

    if (opts.unsafe) {
      if (!info.entryExists) throw new Error('entry not found: ' + info.entry);
      const mod = require(info.entry);
      if (typeof mod[cmd] !== 'function') throw new Error('unknown command: ' + cmd);
      return mod[cmd](...args);
    }

    const loaded = sandbox.loadPlugin(name, this.pluginDir(name), info.manifest, { log: opts.log });
    return sandbox.invoke(loaded, cmd, args, opts.timeout || 10000);
  }

  /** 起插件 IPC 服务；port=0 自动分配，永不撞端口 */
  async serve(name, opts = {}) {
    const info = this.inspect(name);
    if (!info) throw new Error('plugin not found: ' + name);
    const loaded = sandbox.loadPlugin(name, this.pluginDir(name), info.manifest, { log: () => {} });
    const timeout = opts.timeout || 10000;

    const handle = await ipc.createServer(async (req) => {
      if (!req || typeof req.cmd !== 'string') throw new Error('bad request: {cmd, args}');
      return sandbox.invoke(loaded, req.cmd, req.args || [], timeout);
    }, { port: opts.port != null ? opts.port : ((info.manifest.socket && info.manifest.socket.port) || 0), host: opts.host });

    return { ...handle, name };
  }
}

module.exports = { PluginManager, resolveHome };

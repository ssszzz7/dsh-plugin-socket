#!/usr/bin/env node
'use strict';
const { PluginManager } = require('../lib/plugins');
const { doctor } = require('../lib/doctor');

const USAGE = `dsh-plugin — plugin socket for DSH

Usage:
  dsh-plugin [--home DIR] <command> [options]

Commands:
  list                          List installed plugins
  check [name]                  Health check + cross-plugin conflict detection
  install <name>                Scaffold a new plugin
  run <name> <cmd> [args...]    Invoke a command inside the sandbox
                                (--unsafe disables sandbox, --timeout MS)
  socket <name> [--port N]      Serve a plugin over JSON-over-TCP
  doctor [--dsh-root DIR]       Audit the real DSH profile (duplicate ids, missing plugins, tool budget)
  help                          Show this help

Options:
  --home DIR     DSH home (default: $DSH_HOME or ~/.dsh)
  --json         Machine-readable output
`;

function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') out.flags.home = argv[++i];
    else if (a === '--port') out.flags.port = Number(argv[++i]);
    else if (a === '--timeout') out.flags.timeout = Number(argv[++i]);
    else if (a === '--unsafe') out.flags.unsafe = true;
    else if (a === '--json') out.flags.json = true;
    else if (a === '--dsh-root') out.flags['dsh-root'] = argv[++i];
    else out._.push(a);
  }
  return out;
}

(async () => {
  const { _, flags } = parse(process.argv.slice(2));
  const [cmd, ...rest] = _;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }

  const pm = new PluginManager({ home: flags.home });
  const json = flags.json;
  const print = (v) => console.log(json ? JSON.stringify(v, null, 2) : (typeof v === 'string' ? v : JSON.stringify(v, null, 2)));

  switch (cmd) {
    case 'list': {
      const names = pm.list();
      if (json) return print(names.map((n) => ({ name: n, version: (pm.manifest(n) || {}).version })));
      if (!names.length) return print('No plugins installed.');
      print('Installed plugins (' + names.length + '):\n' + names.map((n) => {
        const m = pm.manifest(n) || {};
        return '  - ' + n + ' (v' + (m.version || '?') + ') ' + (m.description || '');
      }).join('\n'));
      return;
    }

    case 'check': {
      const res = pm.check(rest[0]);
      if (json) return print(res);
      const lines = res.rows.map((r) => r.name + ': ' + r.message);
      if (res.issues.length) {
        lines.push('', 'Conflicts:');
        for (const i of res.issues) lines.push('  [' + i.level + '/' + i.kind + '] ' + i.detail);
      }
      print(lines.join('\n'));
      if (!res.ok) process.exitCode = 1;
      return;
    }

    case 'install': {
      const info = pm.install(rest[0], { description: flags.description });
      print(json ? info : 'Installed plugin: ' + info.name + '  ->  ' + info.dir);
      return;
    }

    case 'run': {
      const [name, command, ...args] = rest;
      const value = await pm.run(name, command, args, { unsafe: flags.unsafe, timeout: flags.timeout });
      print(value === undefined ? null : value);
      return;
    }

    case 'doctor': {
      const rep = doctor({ home: flags.home, dshRoot: flags['dsh-root'] });
      if (json) return print(rep);
      const lines = rep.profiles.map((p) => p.name + ': ' + p.entries + ' 条目 / ' + p.inserted + ' 插入 / ' + p.disabled + ' 禁用 / ' + p.mcpServers + ' 个 MCP');
      if (rep.issues.length) {
        lines.push('', '问题 (' + rep.issues.length + '):');
        for (const i of rep.issues) lines.push('  [' + i.level + '/' + i.kind + '] ' + i.detail);
      } else {
        lines.push('', '未发现静态冲突。');
      }
      print(lines.join('\n'));
      if (rep.issues.some((i) => i.level === 'error')) process.exitCode = 1;
      return;
    }

    case 'socket': {
      const name = rest[0];
      const handle = await pm.serve(name, { port: flags.port });
      console.log('Plugin socket listening on ' + handle.host + ':' + handle.port + ' for ' + name);
      return;
    }

    default:
      console.error('Unknown command: ' + cmd);
      console.log(USAGE);
      process.exitCode = 1;
  }
})().catch((err) => {
  console.error('ERROR: ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});

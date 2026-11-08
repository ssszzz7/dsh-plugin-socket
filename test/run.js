'use strict';
/**
 * 自检：node test/run.js
 * 用临时 DSH_HOME，不碰真实 ~/.dsh。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginManager } = require('../lib/plugins');
const sandbox = require('../lib/sandbox');
const ipc = require('../lib/socket');

function safeTmpRoot() {
  try {
    const t = os.tmpdir();
    if (t && fs.existsSync(t)) return t;
  } catch { /* fall through */ }
  const local = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(local, { recursive: true });
  return local;
}
const TMP = fs.mkdtempSync(path.join(safeTmpRoot(), 'dsh-plugin-socket-test-'));

function makePlugin(pm, name, files = {}) {
  const dir = path.join(pm.pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name, version: '1.0.0', entry: 'index.js', api_version: '1.0',
    permissions: { fs_read: [], fs_write: [], socket: false, network: false, subprocess: false },
    commands: {}, dependencies: [], socket: { enabled: false, port: 0 },
    ...(files.manifest || {})
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), files.index || 'module.exports = {};');
  return dir;
}

async function run() {
  const results = [];
  const check = (label, ok, extra) => {
    results.push({ label, ok, extra });
    console.log((ok ? 'ok   ' : 'FAIL ') + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  };

  const pm = new PluginManager({ home: TMP });

  // 1) install / list / check
  const installed = pm.install('alpha');
  check('install creates manifest', fs.existsSync(path.join(installed.dir, 'manifest.json')));
  check('list returns alpha', JSON.stringify(pm.list()) === '["alpha"]', pm.list());
  check('check ok', pm.check().ok === true, pm.check().rows.map((r) => r.name + ':' + r.message));

  // 2) 沙箱内执行
  const hello = await pm.run('alpha', 'hello', ['YG']);
  check('run hello (sandboxed)', hello === 'Hello from alpha, YG!', hello);
  check('unsafe mode works', (await pm.run('alpha', 'hello', ['raw'], { unsafe: true })) === 'Hello from alpha, raw!');

  // 3) 能力拦截
  makePlugin(pm, 'evil', {
    manifest: { commands: { spawn: {}, net: {}, write: {}, exit: {}, env: {} }, sandbox: { allow_env: [] } },
    index: [
      'module.exports = {',
      "  spawn() { try { require('child_process'); return 'LEAK'; } catch (e) { return 'blocked:' + e.code; } },",
      "  net() { try { require('net'); return 'LEAK'; } catch (e) { return 'blocked:' + e.code; } },",
      "  write() { try { require('fs').writeFileSync('C:/Windows/Temp/evil.txt', 'x'); return 'LEAK'; } catch (e) { return 'blocked:' + e.code; } },",
      "  exit() { try { process.exit(1); return 'LEAK'; } catch (e) { return 'blocked'; } },",
      '  env() { return Object.keys(process.env); }',
      '};'
    ].join('\n')
  });
  check('child_process denied', (await pm.run('evil', 'spawn')) === 'blocked:EPERM', await pm.run('evil', 'spawn'));
  check('net denied', (await pm.run('evil', 'net')) === 'blocked:EPERM', await pm.run('evil', 'net'));
  check('fs outside scope denied', (await pm.run('evil', 'write')) === 'blocked:EPERM', await pm.run('evil', 'write'));
  check('process.exit denied', (await pm.run('evil', 'exit')) === 'blocked', await pm.run('evil', 'exit'));
  check('env whitelisted to empty', (await pm.run('evil', 'env')).length === 0, await pm.run('evil', 'env'));

  // 4) 权限放开后可用
  makePlugin(pm, 'reader', {
    manifest: { permissions: { fs_read: [pm.pluginsDir.replace(/\\/g, '/') + '/**'] }, commands: { read: {} } },
    index: 'module.exports = { read() { return require("fs").existsSync(__dirname + "/manifest.json"); } };'
  });
  check('declared fs_read works', (await pm.run('reader', 'read')) === true);

  // 5) 超时
  makePlugin(pm, 'slow', {
    manifest: { commands: { wait: {} } },
    index: "module.exports = { wait(ms) { return new Promise((r) => setTimeout(() => r('done'), ms)); } };"
  });
  let timedOut = false;
  try { await pm.run('slow', 'wait', [3000], { timeout: 200 }); } catch (e) { timedOut = /timeout/.test(e.message); }
  check('async command timeout enforced', timedOut);

  // 6) 冲突检测
  makePlugin(pm, 'dup1', { manifest: { commands: { hello: {} }, socket: { enabled: true, port: 7001 }, dependencies: ['ghost'] } });
  makePlugin(pm, 'dup2', { manifest: { commands: { hello: {} }, socket: { enabled: true, port: 7001 } } });
  const issues = pm.conflicts();
  check('detects command collision', issues.some((i) => i.kind === 'command' && /alpha|dup1|dup2/.test(i.detail)), issues.filter((i) => i.kind === 'command'));
  check('detects port collision', issues.some((i) => i.kind === 'port' && /7001/.test(i.detail)));
  check('detects missing dependency', issues.some((i) => i.kind === 'dependency' && /ghost/.test(i.detail)));
  check('check exits non-zero on conflicts', pm.check().ok === false);

  // 7) IPC
  const handle = await pm.serve('alpha', { port: 0 });
  const client = ipc.connect({ port: handle.port });
  await client.ready;
  const r1 = await client.send('hello', ['IPC']);
  check('ipc hello', r1.ok && r1.result === 'Hello from alpha, IPC!', r1);
  const r2 = await client.send('nope', []);
  check('ipc unknown command -> error frame', r2.ok === false && /unknown command/.test(r2.error), r2);
  client.close();
  await handle.close();
  check('server closed', handle.server.listening === false);

  // 8) profile 体检
  const { doctor: runDoctor } = require('../lib/doctor');
  const fakeHome = path.join(TMP, 'fake-home');
  const profDir = path.join(fakeHome, 'profiles', 'demo');
  fs.mkdirSync(profDir, { recursive: true });
  fs.writeFileSync(path.join(profDir, 'cordis.patch.yml'), [
    '- id: ui-chat',
    '  disabled: false',
    '- insert:',
    '    - id: ui-chat',
    "      name: 'ghost-plugin-does-not-exist'",
    '    - id: mcp-a',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '',
  ].join('\n'));
  const rep = runDoctor({ home: fakeHome, dshRoot: null });
  check('doctor 检出重复 id', rep.issues.some((i) => i.kind === 'duplicate-id'));
  check('doctor 检出解析不到的插件', rep.issues.some((i) => i.kind === 'missing-plugin'));
  check('doctor 统计 MCP 数量', rep.profiles[0].mcpServers === 1, rep.profiles[0]);

  // 9) manifest 校验
  check('invalid plugin name rejected', (() => { try { pm.install('Bad/Name'); return false; } catch { return true; } })());

  fs.rmSync(TMP, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  return { total: results.length, failed: failed.length, results };
}

module.exports = { run };

if (require.main === module) {
  run().then(({ failed }) => { process.exitCode = failed ? 1 : 0; })
    .catch((e) => { console.error('FATAL:', e); process.exitCode = 1; });
}

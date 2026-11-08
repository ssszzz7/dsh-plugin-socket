'use strict';
/**
 * doctor —— 体检真实 DSH profile，而不是只管自己的插件目录。
 *
 * 查四类"插件打架"：
 *   1. 重复 id（同一个 id 出现两次，后一个会覆盖前一个，且没人告诉你）
 *   2. 引用了装不上的插件（name 解析不到，DSH 启动时就 ERR_MODULE_NOT_FOUND）
 *   3. package.json 声明了但 node_modules 里没有（装了一半）
 *   4. 工具预算（MCP server 越多，单请求工具数越容易撞 128 上限）
 */
const fs = require('fs');
const path = require('path');

function readYamlLite(text) {
  // 只为拿到顶层条目与 insert 子条目的 id / name / disabled —— 不追求完整 YAML
  const entries = [];
  let cur = null, inInsert = false, child = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0 && t.startsWith('- ')) {
      if (cur) entries.push(cur);
      cur = { children: [], raw: t };
      inInsert = false; child = null;
      const m = t.match(/^-\s+id:\s*(.+)$/);
      if (m) cur.id = m[1].trim().replace(/^['"]|['"]$/g, '');
      const n = t.match(/^-\s+name:\s*(.+)$/);
      if (n) cur.name = n[1].trim().replace(/^['"]|['"]$/g, '');
      if (/^-\s+insert:\s*$/.test(t)) inInsert = true;
      continue;
    }
    if (!cur) continue;
    if (inInsert && /^\s*-\s+id:/.test(line) && indent <= 6) {
      const m = t.match(/^-\s+id:\s*(.+)$/);
      child = { id: m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined };
      cur.children.push(child);
      continue;
    }
    const idm = t.match(/^id:\s*(.+)$/);
    const nam = t.match(/^name:\s*(.+)$/);
    const dis = t.match(/^disabled:\s*(true|false)$/);
    const target = child || cur;
    if (idm && !target.id) target.id = idm[1].trim().replace(/^['"]|['"]$/g, '');
    if (nam && !target.name) target.name = nam[1].trim().replace(/^['"]|['"]$/g, '');
    if (dis) target.disabled = dis[1] === 'true';
  }
  if (cur) entries.push(cur);
  return entries;
}

function resolveName(name, profileDir, dshRoot) {
  if (!name) return null;
  const bases = [
    path.join(profileDir, 'node_modules'),
    dshRoot ? path.join(dshRoot, 'node_modules') : null
  ].filter(Boolean);
  for (const b of bases) {
    if (fs.existsSync(path.join(b, name, 'package.json'))) return path.join(b, name);
  }
  return null;
}

function doctor(opts = {}) {
  const home = opts.home || path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.dsh');
  const profilesDir = path.join(home, 'profiles');
  const dshRoot = opts.dshRoot || null;
  const report = { home, profiles: [], issues: [] };

  if (!fs.existsSync(profilesDir)) {
    return { ...report, error: 'no profiles dir: ' + profilesDir };
  }

  for (const name of fs.readdirSync(profilesDir)) {
    const dir = path.join(profilesDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;

    const patchPath = path.join(dir, 'cordis.patch.yml');
    const pkgPath = path.join(dir, 'package.json');
    const p = { name, dir, entries: 0, inserted: 0, disabled: 0, mcpServers: 0 };

    if (fs.existsSync(patchPath)) {
      const entries = readYamlLite(fs.readFileSync(patchPath, 'utf8'));
      p.entries = entries.length;
      const ids = new Map();
      const inserted = entries.flatMap((e) => e.children || []);

      for (const e of [...entries.filter((x) => x.id), ...inserted]) {
        const key = e.id;
        if (key) {
          if (ids.has(key)) report.issues.push({ level: 'conflict', profile: name, kind: 'duplicate-id', detail: 'id "' + key + '" 重复出现，后面的会覆盖前面的' });
          else ids.set(key, e);
        }
        if (e.disabled) p.disabled++;
      }
      p.inserted = inserted.length;

      for (const e of inserted) {
        if (e.name && !e.name.startsWith('@deepseek-ai/') && !resolveName(e.name, dir, dshRoot)) {
          report.issues.push({ level: 'error', profile: name, kind: 'missing-plugin', detail: (e.id || '?') + ' 引用的插件 "' + e.name + '" 在 node_modules 里找不到' });
        }
        if (e.name && /mcp-client/i.test(e.name) && !e.disabled) p.mcpServers++;
      }
    }

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies || {}) };
        for (const [dep, spec] of Object.entries(deps)) {
          const local = spec.startsWith('file:') ? spec.slice(5) : null;
          const installed = resolveName(dep, dir, dshRoot);
          if (!installed && !dep.startsWith('@deepseek-ai/') && !(local && fs.existsSync(local))) {
            report.issues.push({ level: 'error', profile: name, kind: 'not-installed', detail: dep + ' 声明了但没装上（' + spec + '）' });
          }
        }
      } catch (e) {
        report.issues.push({ level: 'warn', profile: name, kind: 'bad-package-json', detail: e.message });
      }
    }

    report.profiles.push(p);
  }

  return report;
}

module.exports = { doctor, readYamlLite };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_BUDGET = 128;
const SRC_RE = /\.(?:js|mjs|cjs|ts)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'dist', 'test']);
const NAME_RE = /name\s*:\s*['"`]([A-Za-z0-9_.:-]{2,64})['"`]/;
const REGISTER_RE = /tools\s*\.\s*register\s*\(/g;
const DEFINE_RE = /defineTool\s*\(\s*\{\s*name\s*:\s*['"`]([A-Za-z0-9_.:-]{2,64})['"`]/g;
const SECTION_RE = /systemPrompt\s*\.\s*section\s*\(/g;
const INJECT_RE = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/;

function walk(dir, out, depth) {
  const list = out || [];
  const level = depth || 0;
  if (level > 8) return list;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return list; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, list, level + 1);
    else if (SRC_RE.test(entry.name)) list.push(full);
  }
  return list;
}

function readSource(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function extractToolNames(source) {
  const names = new Set();
  REGISTER_RE.lastIndex = 0;
  let match;
  while ((match = REGISTER_RE.exec(source)) !== null) {
    const window = source.slice(match.index, match.index + 2000);
    const hit = window.match(NAME_RE);
    if (hit) names.add(hit[1]);
  }
  DEFINE_RE.lastIndex = 0;
  while ((match = DEFINE_RE.exec(source)) !== null) names.add(match[1]);
  return [...names];
}

function extractInject(source) {
  const hit = source.match(INJECT_RE);
  if (!hit) return [];
  return [...hit[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
}

function countSections(source) {
  SECTION_RE.lastIndex = 0;
  let total = 0;
  while (SECTION_RE.exec(source) !== null) total += 1;
  return total;
}

function scanPlugin(dir, id) {
  const files = walk(dir);
  const tools = new Set();
  let promptSections = 0;
  let inject = [];
  for (const file of files) {
    const source = readSource(file);
    if (!source) continue;
    for (const name of extractToolNames(source)) tools.add(name);
    promptSections += countSections(source);
    if (inject.length === 0) inject = extractInject(source);
  }
  return { id: id || path.basename(dir), dir, files: files.length, tools: [...tools].sort(), promptSections, inject };
}

function signature(tools) {
  return tools.length === 0 ? '' : tools.join('|');
}

function scan(dirs, options) {
  const opts = options || {};
  const budget = Number.isFinite(opts.budget) ? opts.budget : DEFAULT_BUDGET;
  const includeCopies = opts.includeCopies === true;
  const plugins = [];
  for (const dir of dirs || []) {
    if (!fs.existsSync(dir)) continue;
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (stat.isDirectory()) plugins.push(scanPlugin(dir));
  }

  const groups = new Map();
  for (const plugin of plugins) {
    const sig = signature(plugin.tools);
    plugin.signature = sig;
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(plugin.id);
  }
  const copies = [...groups.entries()]
    .filter(([sig, ids]) => sig !== '' && ids.length > 1)
    .map(([, ids]) => ({ owners: [...new Set(ids)] }));

  const copyOf = new Map();
  for (const [sig, ids] of groups) for (const id of ids) copyOf.set(id, sig);

  const owners = new Map();
  for (const plugin of plugins) {
    if (!includeCopies && copies.some((c) => c.owners.includes(plugin.id) && c.owners[0] !== plugin.id)) continue;
    for (const name of plugin.tools) {
      if (!owners.has(name)) owners.set(name, []);
      owners.get(name).push(plugin.id);
    }
  }
  const duplicates = [];
  for (const [name, ids] of owners) {
    const sigs = new Set(ids.map((id) => (includeCopies ? id : copyOf.get(id))));
    if (sigs.size > 1) duplicates.push({ name, owners: [...new Set(ids)] });
  }
  duplicates.sort((a, b) => a.name.localeCompare(b.name));

  const counted = new Set();
  for (const ids of owners.values()) for (const id of ids) counted.add(id);
  const uniqueNames = new Set([...owners.keys()]).size;
  const sectionOwners = plugins.filter((p) => p.promptSections > 0 && counted.has(p.id)).map((p) => p.id);

  return {
    plugins,
    copies,
    duplicates,
    uniqueNames,
    budget,
    headroom: budget - uniqueNames,
    sectionOwners,
    risky: duplicates.length > 0 || uniqueNames > budget,
  };
}

function discoverDirs(home) {
  const root = home || path.join(os.homedir(), '.dsh');
  const dirs = [];
  for (const sub of ['plugins', 'plugin-sources', 'installs']) {
    const base = path.join(root, sub);
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      dirs.push(path.join(base, entry.name));
    }
  }
  return dirs;
}

function readPatchNames(dshRoot, profile) {
  const file = path.join(dshRoot, 'profiles', profile, 'cordis.patch.yml');
  const source = readSource(file);
  if (!source) return { file, entries: [] };
  const entries = [];
  let current = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\s*-\s*insert:/.test(line)) { current = null; continue; }
    const name = line.match(/^\s*(?:-\s*)?name:\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (name) {
      current = { name: name[1], disabled: false };
      entries.push(current);
      continue;
    }
    if (current && /^\s*disabled:\s*true\s*$/.test(line)) current.disabled = true;
  }
  return { file, entries };
}

function resolveProfileDirs(dshRoot, profile, extraRoots) {
  const { file, entries } = readPatchNames(dshRoot, profile);
  const roots = [
    path.join(dshRoot, 'plugins'),
    path.join(dshRoot, 'plugin-sources'),
    path.join(dshRoot, 'installs'),
    path.join(dshRoot, 'node_modules'),
    ...(extraRoots || []),
  ];
  const dirs = [];
  const unresolved = [];
  const disabled = [];
  for (const entry of entries) {
    if (entry.disabled) { disabled.push(entry.name); continue; }
    const candidates = [];
    for (const root of roots) {
      const direct = path.join(root, entry.name);
      candidates.push(direct);
      candidates.push(path.join(direct, 'plugin'));
      candidates.push(path.join(root, path.basename(entry.name)));
    }
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) dirs.push(found);
    else unresolved.push(entry.name);
  }
  return { file, dirs, unresolved, disabled };
}

function formatScan(result) {
  const lines = [];
  lines.push('扫描 ' + result.plugins.length + ' 个插件，' + result.uniqueNames + ' 个工具名（去重后）');
  lines.push('工具预算 ' + result.budget + '，剩余 ' + result.headroom + (result.headroom < 0 ? '（已超）' : ''));
  const countedIds = new Set();
  for (const dup of result.duplicates) for (const id of dup.owners) countedIds.add(id);
  const copyIds = new Set(result.copies.flatMap((c) => c.owners.slice(1)));
  for (const plugin of result.plugins) {
    const bits = [plugin.tools.length + ' 工具'];
    if (plugin.promptSections) bits.push(plugin.promptSections + ' 段 prompt');
    if (plugin.inject.length) bits.push('inject: ' + plugin.inject.join('/'));
    if (copyIds.has(plugin.id)) bits.push('同份拷贝，已忽略');
    lines.push('  ' + plugin.id.padEnd(28) + ' ' + bits.join('，'));
  }
  if (result.copies.length) {
    for (const copy of result.copies) lines.push('重复拷贝：' + copy.owners.join(' = '));
  }
  if (result.duplicates.length === 0) lines.push('重名冲突：0');
  else {
    lines.push('重名冲突：' + result.duplicates.length);
    for (const dup of result.duplicates) lines.push('  ' + dup.name + ' <- ' + dup.owners.join(', '));
  }
  if (result.sectionOwners.length > 1) {
    lines.push('prompt 段来源：' + result.sectionOwners.join(', ') + '（顺序取决于加载顺序）');
  }
  lines.push(result.risky ? '结论：有静态冲突风险' : '结论：静态检查未见冲突');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_BUDGET,
  extractToolNames,
  extractInject,
  scanPlugin,
  scan,
  discoverDirs,
  readPatchNames,
  resolveProfileDirs,
  formatScan,
};

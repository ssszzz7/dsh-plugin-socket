'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractToolNames, extractInject, scan, formatScan, discoverDirs, readPatchNames, resolveProfileDirs } = require('../lib/scan.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log('ok   ' + name); }
  catch (error) { failures.push(name + ': ' + error.message); console.log('FAIL ' + name); }
}

const root = path.join(process.cwd(), '.tmp-scan-test');
function fixture(name, source) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), source, 'utf8');
  return dir;
}

fs.rmSync(root, { recursive: true, force: true });

test('extracts literal tool names', () => {
  assert.deepStrictEqual(extractToolNames('ctx.tools.register({ name: "alpha", description: "x" })'), ['alpha']);
});

test('extracts wrapped defineTool names', () => {
  const names = extractToolNames("ctx.tools.register(withErrors(defineTool({ name: 'beta', description: 'y' })))");
  assert.ok(names.includes('beta'));
});

test('handles repeated registers in one file', () => {
  const src = 'ctx.tools.register({ name: "a1" }); ctx.tools.register({ name: "a2" });';
  assert.deepStrictEqual(extractToolNames(src).sort(), ['a1', 'a2']);
});

test('ignores objects without tools.register', () => {
  assert.deepStrictEqual(extractToolNames('const x = { name: "nope" };'), []);
});

test('reads inject list', () => {
  assert.deepStrictEqual(extractInject('export const inject = ["systemPrompt", "tools"];'), ['systemPrompt', 'tools']);
});

const one = fixture('one', 'ctx.tools.register({ name: "shared_tool" }); ctx.tools.register({ name: "only_one" });');
const two = fixture('two', 'ctx.tools.register({ name: "shared_tool" });');

test('detects duplicate ownership', () => {
  const result = scan([one, two]);
  assert.strictEqual(result.duplicates.length, 1);
  assert.strictEqual(result.duplicates[0].name, 'shared_tool');
  assert.deepStrictEqual(result.duplicates[0].owners.sort(), ['one', 'two']);
  assert.strictEqual(result.risky, true);
});

test('unique names and headroom', () => {
  const result = scan([one, two], { budget: 128 });
  assert.strictEqual(result.uniqueNames, 2);
  assert.strictEqual(result.headroom, 126);
});

test('budget overflow is risky even without duplicates', () => {
  const result = scan([one], { budget: 1 });
  assert.strictEqual(result.duplicates.length, 0);
  assert.strictEqual(result.risky, true);
});

test('formatScan renders verdict lines', () => {
  const text = formatScan(scan([one, two]));
  assert.ok(text.includes('重名冲突：1'));
  assert.ok(text.includes('shared_tool'));
});

test('missing dirs are skipped', () => {
  const result = scan([path.join(root, 'nope')]);
  assert.strictEqual(result.plugins.length, 0);
  assert.strictEqual(result.risky, false);
});

test('discoverDirs finds plugin folders', () => {
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'plugins', 'p1'), { recursive: true });
  fs.mkdirSync(path.join(home, 'installs', 'p2'), { recursive: true });
  const dirs = discoverDirs(home);
  assert.strictEqual(dirs.length, 2);
  assert.ok(dirs.some((d) => d.endsWith('p1')));
});


test('identical copies are grouped, not reported as conflicts', () => {
  const copy = fixture('copy', 'ctx.tools.register({ name: "shared_tool" }); ctx.tools.register({ name: "only_one" });');
  const result = scan([one, copy]);
  assert.strictEqual(result.copies.length, 1);
  assert.strictEqual(result.duplicates.length, 0);
  assert.strictEqual(result.risky, false);
});

test('includeCopies reports copy clashes when forced', () => {
  const copy = fixture('copy2', 'ctx.tools.register({ name: "shared_tool" }); ctx.tools.register({ name: "only_one" });');
  const result = scan([one, copy], { includeCopies: true });
  assert.strictEqual(result.duplicates.length, 2);
});

test('different plugins sharing a name are still conflicts', () => {
  const other = fixture('other', 'ctx.tools.register({ name: "shared_tool" }); ctx.tools.register({ name: "third" });');
  const result = scan([one, other]);
  assert.strictEqual(result.copies.length, 0);
  assert.strictEqual(result.duplicates.length, 1);
  assert.strictEqual(result.duplicates[0].name, 'shared_tool');
  assert.strictEqual(result.risky, true);
});

test('parses profile patch names and disabled flags', () => {
  const home = path.join(root, 'profile-home');
  const dir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), [
    '- name: alpha',
    '  config: {}',
    '- name: beta',
    '  disabled: true',
    '- insert:',
    '    - name: gamma',
    '  disabled: true',
  ].join('\n'), 'utf8');
  const parsed = readPatchNames(home, 'desktop');
  assert.deepStrictEqual(parsed.entries.map((e) => e.name), ['alpha', 'beta', 'gamma']);
  assert.strictEqual(parsed.entries[1].disabled, true);
});

test('resolveProfileDirs maps names to folders and reports unresolved', () => {
  const home = path.join(root, 'resolve-home');
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(home, 'plugins', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    '- name: alpha\n- name: ghost\n', 'utf8');
  const resolved = resolveProfileDirs(home, 'desktop');
  assert.strictEqual(resolved.dirs.length, 1);
  assert.ok(resolved.dirs[0].endsWith('alpha'));
  assert.deepStrictEqual(resolved.unresolved, ['ghost']);
});

fs.rmSync(root, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) { for (const f of failures) console.error(' - ' + f); process.exitCode = 1; }

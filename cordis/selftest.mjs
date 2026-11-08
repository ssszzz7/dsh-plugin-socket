import assert from 'node:assert';
import { apply, createState, report } from './index.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('ok   ' + name); }
  catch (error) { console.log('FAIL ' + name + ' -> ' + error.message); process.exitCode = 1; }
}

function fakeCtx() {
  const registry = new Map();
  const registered = [];
  const sections = [];
  const ctx = {
    tools: {
      register(tool) {
        if (registry.has(tool.name)) throw new Error('tool "' + tool.name + '" is already registered');
        registry.set(tool.name, tool);
        registered.push(tool.name);
        return () => registry.delete(tool.name);
      },
      get(name) { return registry.get(name); },
    },
    systemPrompt: {
      section(text) { sections.push(text); return () => {}; },
    },
  };
  return { ctx, registry, registered, sections };
}

test('observe mode records registrations without changing them', () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, { mode: 'observe', log: false });
  ctx.tools.register({ name: 'alpha' });
  ctx.tools.register({ name: 'beta' });
  assert.deepStrictEqual(registered, ['socket_report', 'alpha', 'beta']);
});

test('guard mode drops the second registration and records a collision', () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, { mode: 'guard', log: false });
  ctx.tools.register({ name: 'dup' });
  ctx.tools.register({ name: 'dup' });
  assert.strictEqual(registered.filter((n) => n === 'dup').length, 1);
});

test('rename mode renames the later conflicting tool', () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, { mode: 'rename', prefix: 'x_', log: false });
  ctx.tools.register({ name: 'dup' });
  ctx.tools.register({ name: 'dup' });
  assert.deepStrictEqual(registered, ['socket_report', 'dup', 'x_dup']);
});

test('prompt sections are recorded in order', () => {
  const { ctx, sections } = fakeCtx();
  apply(ctx, { mode: 'observe', log: false });
  ctx.systemPrompt.section('first block');
  ctx.systemPrompt.section('second block');
  assert.deepStrictEqual(sections, ['first block', 'second block']);
});

test('report exposes verdict and collision list', () => {
  const state = createState();
  state.patched.push('tools.register');
  state.collisions.push({ name: 'dup' });
  const out = report(state, { mode: 'guard' });
  assert.strictEqual(out.verdict, 'collision');
  assert.strictEqual(out.patched[0], 'tools.register');
});

test('apply tolerates a ctx without tools', () => {
  const ctx = { systemPrompt: { section() {} } };
  apply(ctx, { mode: 'observe', log: false });
  assert.ok(typeof ctx.systemPrompt.section === 'function');
});

test('double apply does not double-wrap', () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, { mode: 'observe', log: false });
  apply(ctx, { mode: 'observe', log: false });
  ctx.tools.register({ name: 'once' });
  assert.strictEqual(registered.filter((n) => n === 'once').length, 1);
});

console.log('\n' + passed + ' passed');

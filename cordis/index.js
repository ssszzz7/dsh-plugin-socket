const NAME = 'dsh-plugin-socket';

export const name = NAME;
export const inject = ['tools', 'systemPrompt'];

function preview(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export function createState() {
  return { mode: 'observe', order: [], collisions: [], renamed: [], promptSections: [], patched: [] };
}

function readConfig(config) {
  const cfg = config || {};
  const mode = ['observe', 'guard', 'rename'].includes(cfg.mode) ? cfg.mode : 'observe';
  return { mode, prefix: typeof cfg.prefix === 'string' && cfg.prefix ? cfg.prefix : 'p_', log: cfg.log !== false };
}

function patchTools(service, state, cfg) {
  if (!service) return false;
  const original = service.register;
  if (typeof original !== 'function') return false;
  if (original.__socketPatched) { state.patched.push('tools.register(already)'); return true; }
  const wrapped = function register(tool, options) {
    const toolName = tool && tool.name ? String(tool.name) : undefined;
    if (!toolName) return original.call(this, tool, options);
    let exists;
    try { exists = typeof service.get === 'function' ? service.get(toolName) : undefined; } catch { exists = undefined; }
    if (exists !== undefined && exists !== null) {
      state.collisions.push({ name: toolName, mode: cfg.mode, at: Date.now() });
      if (cfg.mode === 'guard') return () => {};
      if (cfg.mode === 'rename') {
        const renamed = { ...tool, name: cfg.prefix + toolName };
        state.renamed.push({ from: toolName, to: renamed.name });
        state.order.push(renamed.name);
        return original.call(this, renamed, options);
      }
    }
    state.order.push(toolName);
    return original.call(this, tool, options);
  };
  wrapped.__socketPatched = true;
  try { service.register = wrapped; } catch { return false; }
  state.patched.push('tools.register');
  return service.register === wrapped;
}

function patchPrompt(service, state) {
  if (!service || typeof service.section !== 'function') return false;
  if (service.section.__socketPatched) { state.patched.push('systemPrompt.section(already)'); return true; }
  const original = service.section;
  const wrapped = function section(...args) {
    state.promptSections.push(preview(args[0]));
    return original.apply(this, args);
  };
  wrapped.__socketPatched = true;
  try { service.section = wrapped; } catch { return false; }
  state.patched.push('systemPrompt.section');
  return service.section === wrapped;
}

export function report(state, cfg) {
  return {
    mode: cfg ? cfg.mode : state.mode,
    patched: state.patched,
    registered: state.order.length,
    order: state.order,
    collisions: state.collisions,
    renamed: state.renamed,
    promptSections: state.promptSections,
    verdict: state.collisions.length ? 'collision' : 'clean',
  };
}

export function apply(ctx, config) {
  const cfg = readConfig(config);
  if (ctx && ctx.tools && ctx.tools.__socketState) return;
  const state = createState();
  state.mode = cfg.mode;
  patchTools(ctx.tools, state, cfg);
  patchPrompt(ctx.systemPrompt, state);
  if (!state.patched.length) return;

  const tools = ctx.tools;
  try { if (tools) tools.__socketState = state; } catch { /* service may be frozen */ }
  if (tools && typeof tools.register === 'function' && !state.registered) {
    state.registered = true;
    tools.register({
      name: 'socket_report',
      description: 'Report dsh-plugin-socket monitor state: registered tool order, name collisions, renamed tools, prompt sections.',
      parameters: {},
      async execute() {
        return { text: JSON.stringify(report(state, cfg), null, 2) };
      },
    });
  }
  if (cfg.log) {
    const summary = state.collisions.length ? state.collisions.length + ' 处冲突' : '无冲突';
    console.log('[dsh-plugin-socket] ' + cfg.mode + ' 模式已挂载（' + state.patched.join(', ') + '），' + summary);
  }
}

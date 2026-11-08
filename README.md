# dsh-plugin-socket

> **One slot per plugin.** A plugin manager for [DeepSeek Harness](https://github.com/deepseek-ai) that stops plugins from fighting each other: capability sandbox, cross-plugin conflict detection, and a JSON-over-TCP IPC surface.

[![CI](https://github.com/ssszzz7/dsh-plugin-socket/actions/workflows/ci.yml/badge.svg)](https://github.com/ssszzz7/dsh-plugin-socket/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

[中文说明](README.zh-CN.md)

---

## Why

Two plugins that both register a `hello` command, both bind port 5000, or both
monkey-patch the same global will break each other — and the failure surfaces
somewhere else entirely, hours later. `dsh-plugin-socket` fixes that at the root
by giving every plugin:

1. **Its own namespace** — commands, ports and dependencies are declared in a manifest and
   collisions are reported *before* anything runs.
2. **Its own capability set** — a plugin cannot reach `child_process`, the network, or files
   outside what it declared.
3. **Its own entry point** — in-process via a `vm` sandbox, or out-of-process behind a socket.

## Features

- **Conflict detection** — duplicate command names, fixed-port clashes, missing dependencies, reported in one call.
- **Capability sandbox** — `require` whitelist, glob-scoped `fs`, environment whitelist, `process.exit` disabled.
- **Zero-config IPC** — `port: 0` picks a free port, so plugins never fight over a number.
- **One dependency** — no runtime dependencies at all. Node >= 18.
- **Programmatic API** — the CLI is a thin layer over `PluginManager`.

## Install

```bash
npm install -g dsh-plugin-socket
# or run straight from a checkout
node bin/dsh-plugin.js --help
```

## Quick start

```bash
# scaffold a plugin into ~/.dsh/plugins
dsh-plugin install my-plugin

# what is installed, and does it collide with anything?
dsh-plugin check

# run a command inside the sandbox
dsh-plugin run my-plugin hello YG

# expose the plugin over JSON-over-TCP
dsh-plugin socket my-plugin
```

```text
$ dsh-plugin check
my-plugin: OK  entry=index.js  commands=[hello]  perms=read-only
other-plugin: OK  entry=index.js  commands=[hello]  perms=read-only

Conflicts:
  [conflict/command] command "hello" is claimed by both my-plugin and other-plugin
```

## Layout

```
~/.dsh/
  plugins/
    catalog.json          # plugin index
    my-plugin/
      manifest.json       # identity + permissions + commands
      index.js            # entry point
```

## Manifest

```json
{
  "name": "demo-plugin",
  "version": "1.0.0",
  "entry": "index.js",
  "api_version": "1.0",
  "permissions": {
    "fs_read":  ["C:/Users/me/.dsh/plugins/**"],
    "fs_write": ["C:/Users/me/.dsh/plugins/demo-plugin/**"],
    "socket": true,
    "network": false,
    "subprocess": false
  },
  "commands": { "hello": { "description": "Say hello" } },
  "socket": { "enabled": true, "port": 0, "protocol": "json" },
  "sandbox": { "allow_env": ["HOME"] }
}
```

### Permissions

| Field | Default | Effect when `false` |
|---|---|---|
| `subprocess` | `false` | `require('child_process')` throws `EPERM` |
| `network` | `false` | `net` / `http` / `https` / `tls` / `dns` throw `EPERM` |
| `fs_read` | `[]` | every `fs` read outside the globs throws `EPERM` |
| `fs_write` | `[]` | every `fs` write outside the globs throws `EPERM` |

## IPC protocol

Newline-delimited JSON over TCP. Request `{"cmd":"hello","args":["YG"]}`,
response `{"ok":true,"result":"Hello from demo-plugin, YG!"}` or
`{"ok":false,"error":"unknown command: nope"}`. Single message limit: 1 MB.

```js
const ipc = require('dsh-plugin-socket').ipc;
const client = ipc.connect({ port: 55123 });
await client.ready;
console.log(await client.send('hello', ['YG']));
client.close();
```

## Programmatic API

```js
const { PluginManager } = require('dsh-plugin-socket');

const pm = new PluginManager();                 // -> ~/.dsh
await pm.run('my-plugin', 'hello', ['YG']);     // sandboxed
pm.check();                                     // { rows, issues, ok }
pm.conflicts();                                 // [{ level, kind, detail }]
const handle = await pm.serve('my-plugin');     // { port, host, close }
```

## Auditing a real DSH install

`dsh-plugin` also ships a doctor for the *existing* profile — the plugins you already
have, not just the ones this tool manages:

```bash
dsh-plugin doctor
# desktop: 24 entries / 7 inserted / 8 disabled / 3 MCP servers
# 问题 (0): 未发现静态冲突。
```

It reports duplicate entry ids (the later one silently wins), plugins whose `name`
cannot be resolved in `node_modules` (DSH fails at startup with `ERR_MODULE_NOT_FOUND`),
declared-but-not-installed dependencies, and the MCP server count against the
128-tool request budget.

**Scope, honestly:** the doctor finds *static* conflicts. It cannot detect two plugins
patching the same global at runtime, nor reorder `systemPrompt` injections. Plugins that
do not go through `dsh-plugin` (i.e. everything currently loaded by DSH's own cordis
loader) are only audited, not sandboxed.

## Security model

This is a **capability sandbox**, not a hardened jail. It stops accidents and
casual overreach. It does **not** stop a synchronous `while(true)`, unbounded
CPU/memory use, or a determined escape via `vm` quirks. See [SECURITY.md](SECURITY.md).

For untrusted code, use `dsh-plugin socket <name>` and treat the IPC surface as
the trust boundary.

## Roadmap

- [ ] Process-per-plugin runtime (hard isolation)
- [ ] Manifest JSON Schema + editor validation
- [ ] `dsh-plugin link` for local development
- [ ] Signed manifests / checksum pinning

## License

MIT

## 静态扫描 `scan`

工具名是写死的字面量（`ctx.tools.register({ name: "purge_status" })`），所以不用先把插件跑起来就能查冲突。

```bash
dsh-plugin scan                                  # 扫 ~/.dsh 下的全部插件目录
dsh-plugin scan --profile desktop                # 只扫这个 profile 里启用中的插件
dsh-plugin scan DIR1 DIR2 --budget 128 --json    # 指定目录 / 改预算 / 机器可读
```

输出内容：

- 每个插件注册了多少工具名、几段 prompt、inject 了什么服务
- **重名冲突**：两个不同插件注册同一个工具名（同一份插件的两份拷贝会被识别成「重复拷贝」并忽略，不算冲突）
- **预算余量**：DeepSeek 单次请求上限 128 个工具，超了整轮对话直接失败
- 两个以上插件都往 systemPrompt 里塞段落时给出提示（顺序取决于加载顺序）

退出码：有风险 `1`，干净 `0`，方便进 CI。

## cordis 壳 `cordis/`

`scan` 只能抓静态重名。要在运行时真的兜住冲突，用 `cordis/index.js` —— 一个标准 cordis 插件，挂载后包住 `ctx.tools.register` 和 `ctx.systemPrompt.section`：

| mode | 行为 |
| --- | --- |
| `observe` | 只记录：谁按什么顺序注册了什么、有没有撞名、prompt 段落顺序。不改任何行为 |
| `guard` | 撞名时**丢弃后来者**的注册，并记账 |
| `rename` | 撞名时把后来者改名成 `<prefix><name>`，两个都留下 |

挂载方式见 `cordis/cordis.patch.yml`。挂上之后会多一个 `socket_report` 工具，随时把账本打出来。

尚未覆盖：静态扫不到「A 插件改了 tools 数组 / B 插件调换 prompt 顺序」这类副作用，`observe` 能观察到顺序，但不会替你修。

# dsh-plugin-socket

> **One slot per plugin.** A plugin manager for [DeepSeek Harness](https://github.com/deepseek-ai) that stops plugins from fighting each other: capability sandbox, cross-plugin conflict detection, and a JSON-over-TCP IPC surface.

[![CI](https://github.com/YOUR_NAME/dsh-plugin-socket/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_NAME/dsh-plugin-socket/actions/workflows/ci.yml)
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

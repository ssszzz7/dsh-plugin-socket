# Security Model

`dsh-plugin-socket` is a **capability sandbox**, not a security boundary against a
determined attacker running native code.

## What is enforced

| Vector | Control |
|---|---|
| Requiring `child_process` / `worker_threads` / `cluster` | `permissions.subprocess` must be `true`, otherwise `EPERM` |
| Requiring `net` / `http(s)` / `tls` / `dns` | `permissions.network` must be `true`, otherwise `EPERM` |
| Filesystem access | `fs` is proxied and every call is matched against `permissions.fs_read` / `permissions.fs_write` globs |
| Environment leakage | `process.env` only exposes keys listed in `sandbox.allow_env` |
| Forcible exit | `process.exit` throws |
| Loading arbitrary npm packages | `require` is whitelisted to stdlib + the plugin's own directory |

## What is NOT enforced

- **Synchronous infinite loops.** `while(true){}` blocks the host event loop; the
  `--timeout` option only rejects the *promise*, it cannot preempt sync code.
- **Resource exhaustion.** CPU and memory are unbounded.
- **Native addons / dynamic `import()` of CJS-from-ESM edge cases.**
- **A plugin that escapes via `Function`/prototype tricks.** The `vm` context is
  separate, but `vm` is not a hardened isolation boundary.

If you need hard isolation for untrusted code, run each plugin in its own process
(`dsh-plugin socket <name>`) and treat the IPC surface as the trust boundary.

## Reporting

Open an issue at the repository's issue tracker. Please do not file public issues
for unpatched bypasses; use GitHub's private vulnerability reporting.

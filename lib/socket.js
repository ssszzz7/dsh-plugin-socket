'use strict';
/**
 * JSON-over-TCP IPC：按行分隔，单条上限 1MB。
 * 请求 {"cmd":"hello","args":["x"]} -> 成功 {"ok":true,"result":...} / 失败 {"ok":false,"error":"..."}
 */
const net = require('net');

const MAX_MSG = 1024 * 1024;

function createServer(handler, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port == null ? 0 : opts.port;

  const server = net.createServer({ allowHalfOpen: false }, (sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_MSG) { sock.destroy(new Error('message too large')); return; }
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); }
        catch { sock.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); continue; }
        Promise.resolve(handler(req, sock))
          .then((result) => sock.write(JSON.stringify({ ok: true, result }) + '\n'))
          .catch((err) => sock.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }) + '\n'));
      }
    });
    sock.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, host, close: () => new Promise((r) => server.close(r)) }));
  });
}

function connect(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const timeout = opts.timeout || 5000;
  const sock = net.createConnection({ port: opts.port, host });
  sock.setEncoding('utf8');

  let buf = '';
  const pending = [];

  sock.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const waiter = pending.shift();
      if (!waiter) continue;
      try { waiter.resolve(JSON.parse(line)); } catch { waiter.resolve({ ok: false, error: 'bad json' }); }
    }
  });

  const ready = new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), timeout).unref?.();
  });

  function send(cmd, args = []) {
    return new Promise((resolve, reject) => {
      pending.push({ resolve });
      sock.write(JSON.stringify({ cmd, args }) + '\n');
      setTimeout(() => reject(new Error('request timeout: ' + cmd)), timeout).unref?.();
    });
  }

  return { ready, send, close: () => sock.end(), socket: sock };
}

module.exports = { createServer, connect, MAX_MSG };

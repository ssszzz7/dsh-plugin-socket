'use strict';
// 示例插件：所有命令都是纯函数，方便演示沙箱与 IPC
module.exports = {
  hello(name) {
    return 'Hello from demo-plugin' + (name ? ', ' + name : '') + '!';
  },
  status() {
    return {
      plugin: 'demo-plugin',
      node: process.version,
      platform: process.platform,
      env_keys: Object.keys(process.env),
      uptime: Math.round(process.uptime())
    };
  },
  echo(...args) {
    return args;
  },
  async slow(ms) {
    await new Promise((r) => setTimeout(r, ms));
    return 'slept ' + ms + 'ms';
  }
};

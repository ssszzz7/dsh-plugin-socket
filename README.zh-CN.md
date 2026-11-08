# dsh-plugin-socket · DSH 插件插座

> **一个插件一个插槽。** 让 DSH 的插件互不打架：能力沙箱 + 跨插件冲突检测 + JSON-over-TCP 服务接口。

[English](README.md)

---

## 它解决什么

两个插件都注册 `hello`、都绑 5000 端口、或者都去改同一个全局变量 —— 出问题时
报错往往在完全不相干的地方，几小时后才炸。`dsh-plugin-socket` 从根上拆开：

1. **命名空间**：命令、端口、依赖写在 manifest 里，运行前就把撞车的列出来。
2. **能力集**：没声明的权限拿不到 —— `child_process`、网络、越界文件一律 `EPERM`。
3. **独立入口**：进程内走 `vm` 沙箱，或进程外走 socket。

## 特性

- **冲突检测**：命令重名、固定端口冲突、依赖缺失，一条命令全报。
- **能力沙箱**：`require` 白名单 + `fs` 路径 glob + 环境变量白名单 + `process.exit` 禁用。
- **零配置 IPC**：`port: 0` 自动分配，永不撞端口。
- **零依赖**：不需要任何 npm 包，Node >= 18。

## 安装

```bash
npm install -g dsh-plugin-socket
```

## 快速开始

```bash
dsh-plugin install my-plugin      # 脚手架
dsh-plugin check                  # 体检 + 冲突检测
dsh-plugin run my-plugin hello YG # 沙箱内执行
dsh-plugin socket my-plugin       # 起 IPC 服务
```

```text
$ dsh-plugin check
my-plugin: OK  entry=index.js  commands=[hello]  perms=read-only
other-plugin: OK  entry=index.js  commands=[hello]  perms=read-only

Conflicts:
  [conflict/command] command "hello" is claimed by both my-plugin and other-plugin
```

## 目录约定

```
~/.dsh/
  plugins/
    catalog.json          # 插件清单
    my-plugin/
      manifest.json       # 身份 + 权限 + 命令
      index.js            # 入口
```

## 权限

| 字段 | 默认 | 为 `false` 时 |
|---|---|---|
| `subprocess` | `false` | `require('child_process')` 抛 `EPERM` |
| `network` | `false` | `net`/`http`/`https`/`tls`/`dns` 抛 `EPERM` |
| `fs_read` | `[]` | glob 之外的读取一律 `EPERM` |
| `fs_write` | `[]` | glob 之外的写入一律 `EPERM` |

## IPC 协议

TCP 上按行分隔的 JSON。请求 `{"cmd":"hello","args":["YG"]}`，
响应 `{"ok":true,"result":...}` 或 `{"ok":false,"error":...}`，单条上限 1MB。

## 安全模型（诚实说明）

这是**能力沙箱**，不是硬隔离牢笼。能挡：越权 API、越界文件、环境变量泄露、`process.exit`。
挡不住：同步死循环、CPU/内存耗尽、`vm` 层面的刻意逃逸。详见 [SECURITY.md](SECURITY.md)。

需要硬隔离的插件请用 `dsh-plugin socket <name>`，把 IPC 面当作信任边界。

## 开发

```bash
node test/run.js     # 20 项自检，用临时目录，不碰真实 ~/.dsh
```

## 许可证

MIT

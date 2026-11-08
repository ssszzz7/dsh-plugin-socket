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

## 体检已有的 DSH 配置

除了管自己的插件目录，`dsh-plugin doctor` 还会体检**你现有的 profile**：

```bash
dsh-plugin doctor
# desktop: 24 条目 / 7 插入 / 8 禁用 / 3 个 MCP
# 未发现静态冲突。
```

能查：重复 id（后一个静默覆盖前一个）、`name` 在 `node_modules` 里解析不到的插件
（DSH 启动会 `ERR_MODULE_NOT_FOUND`）、声明了但没装上的依赖、以及 MCP 数量对
128 工具上限的挤压。

**说清楚边界**：doctor 查的是**静态**冲突。它查不出两个插件在运行时抢同一个全局变量，
也管不了 `systemPrompt` 的注入顺序。不走 `dsh-plugin` 的插件（也就是你现在由 DSH 自己的
cordis 加载器加载的全部插件）只被体检，不被沙箱约束。

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

## 一行安装（不经过 npm）

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/ssszzz7/dsh-plugin-socket/main/install.ps1 | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/ssszzz7/dsh-plugin-socket/main/install.sh | sh
```

脚本做的事：`git clone` 到 `~/dsh-plugin-socket`（已有则 `git pull`），往 PATH 里写一个 `dsh-plugin` 启动器，然后跑一次冒烟测试。可用 `DSH_SOCKET_HOME` / `DSH_SOCKET_BIN` 改目录。

# 更新日志

## 0.1.4

- 包名从 `cortico-world-dsh` 改成 `cortico-world-dsh-launcher`：这个扩展只管起 / 开 / 关，
  叫「dsh」太大了，也会挡住以后真正的桥接。`id` 仍是 `dsh`，配置节 `worlds.dsh`、事件前缀 `dsh.*` 全都不变，
  已装好的部署无需改动（换了包名就要重新装一次）。
- 仓库地址同步改成 `github.com/Uesugikumo/cortico-world-dsh-launcher`。

## 0.1.3

- 改名：显示名从「DSH 桥接」改成「DSH 启动器」（en `DSH launcher`）。它现在只管起 / 开 / 关 / 看状态，
  不读 DSH 里的东西；`id` 仍是 `dsh`，配置节 `worlds.dsh` 与事件前缀 `dsh.*` 不变。
- 「关闭 DSH」改成关掉这台电脑上所有 `dsh web`（先按命令行找 `node … dsh/lib/bin.js web`，再用占用端口的 pid 兜底），
  不再只认 Coo 自己起的那个；回报里带 pid。工具 `dsh_stop` 仍需 `confirm: true`，会先问使用者。
- 删掉已经没用的桥接读取层：`dsh_recent` 工具、事件合批、`notify` / `minGapMs` 两项配置、桥接缓存 storage 模块。
  现在只有一种事件 `dsh.panel`。
- 配置只剩 `enabled` / `port` / `host` / `autostart`；环境提示词按「启动器」重写。

## 0.1.2

- 面板上按「启动 / 关闭 DSH」之后，结果改成由 Coo 用气泡说出来（新事件 `dsh.panel`，`tags: ['speak']`，
  立即投递、不受气泡粒度与合批间隔限制）；面板里的小字提示照样保留。
- 删掉两个没用的配置项：`bridgeDir` 与 `command`。事件目录固定按平台取（`%APPDATA%\coo-dsh-bridge`），
  启动命令固定先找 npm 全局安装的 `lib/bin.js`，再退回 PATH 上的 `dsh`。
- 环境提示词与工具描述去掉本机专属称呼，改成通用的「使用者」；补上 `dsh.panel` 该怎么说。
- `describe.json` 改为从 `definition.describe` + `ENV_PROMPT.md` 生成，避免两处写歪。

## 0.1.1

- 控制台加了「开关」面板：一个按钮启动 dsh web，一个按钮关掉 Coo 拉起来的那份；每 5 秒刷一次状态与地址。
- 面板数据面走 `invoke('control', 'status' | 'start' | 'stop')`；关闭只认自己起的进程，别人起的会告诉你占端口的 pid。
- 去掉没意义的「最近」badge 与桥接缓存 storage 行（没装桥接时恒为 0 条 / 未连）。
- `dsh_stop` 要先问过使用者（`confirm: true`）。


## 0.1.0

首个版本。

- 读 `@dsh-pet/bridge` 写的事件流（`dsh-<pid>.jsonl`），跟最新文件、从末尾接、不重放历史。
- 气泡事件：`dsh.start`、`dsh.done`、`dsh.failed`、`dsh.question`、`dsh.approval`、`dsh.activity`；
  紧急事件（提问、批准、出错）单独成条，不受合批间隔限制。
- 工具：`dsh_status`、`dsh_recent`、`dsh_start`、`dsh_open`、`dsh_stop`。
- 可选自动拉起 `dsh web --no-open`（`autostart`，默认关）。
- 配置组 `worlds.dsh`：端口、事件目录、气泡粒度、最小间隔、自定义启动命令。
- 自描述 `describe.json`：5 个工具、6 个事件、环境提示词。

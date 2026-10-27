# cortico-world-dsh

**DSH 启动器** —— Coo 的 World 扩展，替使用者把 **DeepSeek Harness（DSH）** 的 `dsh web` 拉起来、用浏览器打开、或者关掉。

- npm：`cortico-world-dsh`
- 契约：Cortico World `api: 6`

> 名字里的 `dsh` 是 DeepSeek Harness 这个程序。这个扩展**不是**「让 DSH 和 Coo 互相聊天」的桥梁：
> 它只碰本机进程与端口，不读 DSH 里的内容，也不往 DSH 里塞任何东西。
> 仓库里的 `dsh-bridge/` 是一份还没接上的 DSH 侧插件，留着以后做「真桥接」用；它不随包发布，也不参与当前功能。

## 做了什么

- **看状态**：探 `127.0.0.1:<port>` 通不通，报地址。
- **拉起**：`dsh web --port 3080 --host 127.0.0.1 --no-open`，已经在跑就跳过；起完等端口真通（最多 20 秒）再回话。
- **打开**：用默认浏览器打开界面；优先用 `dsh web` 打在日志里那串带 token 的地址（裸地址在新标签页里会被拒）。
- **关掉**：关掉这台电脑上**所有** `dsh web`（正常只有一个，不管是谁起的）。
- **四个工具**：`dsh_status`、`dsh_start`、`dsh_open`、`dsh_stop`。
- **控制台开关**：Coo 控制台里这个 World 有一页「开关」，两个按钮——启动 DSH / 关闭 DSH，每 5 秒刷一次状态和地址。
  按下去之后 Coo 会用气泡说一句结果（`dsh.panel` 事件），所以按完会有 1 秒到几秒的延迟，话也由它自己组织。

## 安装

在 Coopanion 的扩展目录（`data/extensions`）里：

```bash
pnpm add cortico-world-dsh
```

然后在部署的 `config.json` 里打开：

```jsonc
"worlds": {
  "dsh": { "enabled": true, "port": 3080 }
}
```

重启 Coopanion 生效。

## 配置（`config.json` → `worlds.dsh`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用 |
| `port` / `host` | `3080` / `127.0.0.1` | `dsh web` 监听地址，也是界面地址 |
| `autostart` | `false` | Coo 起来时顺手确保 `dsh web` 在跑（默认关：别在别人机器上擅自起进程） |

启动命令不做成可配项：先找 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`，再退回 PATH 上的 `dsh`。
启动日志写在 Coo 这个 World 的 `dataDir` 下（`dsh-web.log`，超过 4MB 轮转成 `.1`）。

## 边界与隐私

- **不发任何网络请求**，只探本机端口、只读写本机进程与自己的日志。
- 关之前会先问使用者，并且要求 `confirm: true` 才动手——他眼前那页界面可能就是这个 DSH。
- 不替人拍板：DSH 里的批准、回答问题、改配置都得自己来。
- `start()` 里全部包了 try/catch，定时器 `unref()`，端口探测失败也不影响 Coo 启动。

## 平台

在 Windows 上开发与验证（`dsh web` 的启动、`taskkill` 停止、`Get-CimInstance` 列举进程、`cmd /c start` 开浏览器都是 Windows 路径）。
macOS / Linux 有对应分支（`open` / `xdg-open`、`kill`），但**没有实测**；「关掉所有 dsh web」在非 Windows 上只按端口找。

## 许可

MIT。

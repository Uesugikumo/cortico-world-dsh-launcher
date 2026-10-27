import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type {
  ToolDef,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { dshConfigGroup, type DshConfigSection } from './config.ts';
import { text } from './strings.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 隔一会儿探一次端口，好让状态灯不撒谎。 */
const POLL_MS = 5000;
/** 端口探测超时。 */
const PROBE_MS = 700;
/** dsh_start 拉起来之后最多等这么久，等端口通。 */
const OPEN_WAIT_MS = 20_000;
/** dsh-web.log 涨到这么大就轮转成 .1（只留一份旧的） */
const WEB_LOG_MAX_BYTES = 4 * 1024 * 1024;

export interface DshWorldOptions {
  dataDir: string;
  cfg: DshConfigSection;
  timezone: string;
}

/** 一次「关全部」的结果。 */
export interface DshStopResult {
  /** 找到的 pid。 */
  pids: number[];
  /** 没关掉的 pid。 */
  failed: number[];
}

/**
 * DSH 启动器。
 *
 * 干三件事：把 `dsh web` 拉起来、用浏览器打开它的界面、把它关掉。
 * 只碰本机进程与端口，不注入消息、不改 DSH 配置、不联网。
 *
 * 名字里没有「桥接」：往 DSH 里塞一个插件、把事件读回来的那一半还没接上，
 * 现在这条链路只到「起 / 开 / 关 / 看状态」为止。
 */
export class DshWorld implements World {
  readonly id = 'dsh';

  private readonly cfg: DshConfigSection;
  private readonly timezone: string;
  private readonly dataDir: string;

  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private childPid: number | null = null;
  private listening = false;
  /** dsh web 启动时打印的带 token 的界面地址，等端口通了才有。 */
  private startupUrl = '';

  constructor(opts: DshWorldOptions) {
    this.cfg = { ...opts.cfg };
    this.timezone = opts.timezone;
    this.dataDir = opts.dataDir;
  }

  // ---------- World 接口 ----------

  envPromptVars(): Record<string, string> {
    const host = this.cfg.host === '0.0.0.0' ? '127.0.0.1' : this.cfg.host;
    return {
      dsh_url: `http://${host}:${this.cfg.port}`,
      dsh_port: String(this.cfg.port),
      dsh_state: this.stateLabel(),
    };
  }

  tools(): ToolDef[] {
    return [this.statusTool(), this.startTool(), this.openTool(), this.stopTool()];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const lamp: WorldLamp = this.listening
      ? { label: t.lampRunning, state: 'online', hint: t.lampRunningHint }
      : { label: t.lampMissing, state: 'offline', hint: t.lampMissingHint };

    return {
      label: t.moduleLabel,
      lamps: [lamp],
      badges: [{ label: t.badgeState, value: this.stateLabel(language), tone: this.listening ? 'on' : 'plain' }],
      panels: [{ id: 'control', title: t.panelTitle, description: t.panelDescription, getMethods: ['status'] }],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      config: [dshConfigGroup(language)],
      promptDocs: [
        {
          key: 'worlds.dsh.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.timer = setInterval(() => {
      void this.refreshListening();
    }, POLL_MS);
    // 定时器不该把进程钉住不让退出
    this.timer.unref?.();

    host.log.info(`dsh: 端口 ${this.cfg.host}:${this.cfg.port}`);

    if (this.cfg.autostart) {
      try {
        const running = await this.probe();
        this.listening = running;
        if (running) {
          host.log.info('dsh: 本地已经有 dsh web 在跑，不重复启动');
        } else {
          const started = this.spawnDsh();
          host.log.info(started ? 'dsh: 已拉起 dsh web' : 'dsh: 没找到可用的 dsh 命令，跳过启动');
          if (started) {
            void this.waitForListening(OPEN_WAIT_MS).then((ok) => {
              this.listening = ok;
              if (ok) void this.captureStartupUrl();
            });
          }
        }
      } catch (err) {
        host.log.warn(`dsh: 启动检查失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.host = null;
  }

  // ---------- 端口与进程 ----------

  private async refreshListening(): Promise<void> {
    try {
      this.listening = await this.probe();
    } catch {
      this.listening = false;
    }
  }

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ host: '127.0.0.1', port: Number(this.cfg.port) });
      const done = (ok: boolean): void => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(PROBE_MS);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }

  /** 拉起来之后等端口真正通，免得回一句「起了」结果打不开。 */
  private async waitForListening(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.probe()) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return this.probe();
  }

  /** 拉起 dsh web。force=true 时不管 autostart 设置（使用者/模型手动要求启动）。 */
  private spawnDsh(force = false): boolean {
    if (!force && !this.cfg.autostart) return false;
    const launch = resolveLaunch();
    if (!launch) return false;
    const args = [...launch.args, 'web', '--port', String(this.cfg.port), '--host', this.cfg.host, '--no-open'];
    // .cmd/.bat 必须过 cmd.exe，直接 spawn 在 Windows 上会 EINVAL
    const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(launch.cmd);
    const cmd = isBatch ? process.env.ComSpec || 'cmd.exe' : launch.cmd;
    const argv = isBatch ? ['/c', launch.cmd, ...args] : args;
    try {
      // 输出写日志：既能看出起没起来，也能从里面抠出带 token 的界面地址
      let out: number | 'ignore' = 'ignore';
      try {
        const logPath = this.prepareWebLog();
        out = logPath ? openSync(logPath, 'a') : 'ignore';
      } catch {
        out = 'ignore';
      }
      const child = spawn(cmd, argv, {
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
        cwd: homedir(),
      });
      if (typeof out === 'number') {
        try {
          closeSync(out);
        } catch {
          /* 关不掉也没关系 */
        }
      }
      child.once('error', () => {
        /* 记不到日志也不该炸 */
      });
      child.unref();
      this.childPid = child.pid ?? null;
      return true;
    } catch (err) {
      this.host?.log.warn(`dsh: 启动失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 这台电脑上所有 `dsh … web` 进程，不管是谁起的。
   * 正常机器只有一个；中了两个也一起关，免得「关了还在响」。
   */
  private async listDshPids(): Promise<number[]> {
    const found = new Set<number>();
    if (process.platform === 'win32') {
      const raw = await this.runCapture('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*dsh*lib*bin.js*' -and $_.CommandLine -like '* web*' } | ForEach-Object { $_.ProcessId }",
      ]);
      for (const line of raw.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) found.add(pid);
      }
    }
    const owner = await this.portOwnerPid();
    if (owner) found.add(owner);
    return [...found];
  }

  /** 关掉所有 dsh web。 */
  private async stopAll(): Promise<DshStopResult> {
    const pids = await this.listDshPids();
    const failed: number[] = [];
    for (const pid of pids) {
      if (!(await this.killPid(pid))) failed.push(pid);
    }
    if (pids.length) {
      this.childPid = null;
      this.listening = false;
      this.startupUrl = '';
    }
    return { pids, failed };
  }

  private stopReport(r: DshStopResult): string {
    if (!r.pids.length) return '没有在跑的 dsh。';
    const killed = r.pids.length - r.failed.length;
    if (!r.failed.length) return `关掉了 ${killed} 个 dsh（pid ${r.pids.join('、')}）。`;
    if (!killed) return `没关掉：pid ${r.failed.join('、')}（可能没权限，或者已经自己退了）。`;
    return `关掉 ${killed} 个；pid ${r.failed.join('、')} 没关掉。`;
  }

  private runCapture(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
      let out = '';
      let p;
      try {
        p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch {
        resolve('');
        return;
      }
      p.stdout?.on('data', (b: Buffer) => {
        out += b.toString('utf8');
      });
      p.once('error', () => resolve(''));
      p.once('close', () => resolve(out));
    });
  }

  /** 停掉指定 pid 的整棵进程树。 */
  private killPid(pid: number): Promise<boolean> {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid);
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    }
    return new Promise((resolve) => {
      const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      p.once('close', (c) => resolve(c === 0));
      p.once('error', () => resolve(false));
    });
  }

  /** 端口现在被哪个 pid 占着（兜底用：命令行匹配不到时至少能找到占端口的那个）。 */
  private portOwnerPid(): Promise<number | null> {
    if (process.platform !== 'win32') return Promise.resolve(null);
    return new Promise((resolve) => {
      let out = '';
      const p = spawn('netstat', ['-ano', '-p', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      p.stdout?.on('data', (b: Buffer) => {
        out += b.toString('utf8');
      });
      p.once('error', () => resolve(null));
      p.once('close', () => {
        const suffix = `:${this.cfg.port}`;
        for (const line of out.split(/\r?\n/)) {
          if (!line.includes('LISTENING')) continue;
          const cols = line.trim().split(/\s+/);
          if (cols.length < 5) continue;
          if (!cols[1]?.endsWith(suffix)) continue;
          const pid = Number(cols[4]);
          if (Number.isInteger(pid) && pid > 0) {
            resolve(pid);
            return;
          }
        }
        resolve(null);
      });
    });
  }

  /** 等 dsh web 把带 token 的地址打进日志（最多等 timeoutMs），拿到就存起来。 */
  private async captureStartupUrl(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = this.readStartupUrl();
      if (url) {
        this.startupUrl = url;
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private url(): string {
    const host = this.cfg.host === '0.0.0.0' ? '127.0.0.1' : this.cfg.host;
    return `http://${host}:${this.cfg.port}`;
  }

  private webLogPath(): string {
    return join(this.dataDir || homedir(), 'dsh-web.log');
  }

  /** 备好日志文件：超过 4MB 先把旧的挪成 `.1`（只留一份）。准备失败返回空串。 */
  private prepareWebLog(): string {
    const logPath = this.webLogPath();
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      if (existsSync(logPath) && statSync(logPath).size > WEB_LOG_MAX_BYTES) {
        const old = `${logPath}.1`;
        try {
          rmSync(old, { force: true });
        } catch {
          /* 删不掉就让下面的 rename 覆盖 */
        }
        renameSync(logPath, old);
      }
      return logPath;
    } catch {
      return '';
    }
  }

  /** 从启动日志里抠出 dsh web 打印的界面地址（带进程 token）。 */
  private readStartupUrl(): string {
    const logPath = this.webLogPath();
    try {
      const st = statSync(logPath);
      const start = Math.max(0, st.size - 64 * 1024);
      const len = st.size - start;
      if (len <= 0) return '';
      const buf = Buffer.alloc(len);
      const fd = openSync(logPath, 'r');
      try {
        readSync(fd, buf, 0, len, start);
      } finally {
        closeSync(fd);
      }
      const raw = buf.toString('utf8');
      const urls = [...raw.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/[.,;]+$/, ''));
      const withToken = urls.filter((u) => /[?&](token|t)=/.test(u));
      return withToken.at(-1) ?? urls.at(-1) ?? '';
    } catch {
      return '';
    }
  }

  // ---------- 展示 ----------

  private stateLabel(language: Language = 'zh'): string {
    const t = text(language);
    return this.listening ? t.stateRunning : t.stateOffline;
  }

  /**
   * 面板上按了按钮：立刻让 Coo 用气泡说一句。
   *
   * 正文写成使用者第一人称、末尾问一句，是因为纯描述式的「控制台按了…」会被模型
   * 当成系统日志，读完直接 end_turn，气泡永远不出现（2026-10-27 实测）。
   */
  private say(action: '启动' | '关闭', detail: string): void {
    const host = this.host;
    if (!host) return;
    const text = `我按了控制台的「${action} DSH」：${detail}。回我一句？`;
    void host
      .pushEvent(
        {
          type: 'dsh.panel',
          ts: new Date().toISOString(),
          source: this.id,
          text,
          tags: ['speak'],
          meta: { port: this.cfg.port, panel: 'control', action },
        },
        { trigger: 'flush' },
      )
      .catch((err) => {
        host.log.warn(`dsh: 气泡没送出去：${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** 面板按钮的数据面：只认 control 面板的 status / start / stop。 */
  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel !== 'control') throw new Error(`没有这个面板：${panel}`);
    void args;
    const running = await this.probe();
    this.listening = running;
    switch (method) {
      case 'status':
        return { running, url: this.url(), state: this.stateLabel(), busy: false };
      case 'start': {
        if (running) {
          this.say('启动', `本来就在跑，地址 ${this.url()}`);
          return { ok: true, running: true, url: this.url(), message: '已经在跑了' };
        }
        if (!this.spawnDsh(true)) {
          this.say('启动', '没找到 dsh 命令，没拉起来');
          return { ok: false, running: false, url: this.url(), message: '找不到 dsh 命令，没拉起来' };
        }
        const wait = Math.round(OPEN_WAIT_MS / 1000);
        const ok = await this.waitForListening(OPEN_WAIT_MS);
        if (!ok) {
          this.say('启动', `起了进程，但 ${wait} 秒还没通`);
          return { ok: false, running: false, url: this.url(), message: `起了进程，但 ${wait} 秒还没通` };
        }
        this.listening = true;
        this.startupUrl = this.readStartupUrl();
        if (!this.startupUrl) void this.captureStartupUrl();
        this.say('启动', `拉起来了，地址 ${this.url()}`);
        return { ok: true, running: true, url: this.url(), message: '拉起来了', address: this.url() };
      }
      case 'stop': {
        const result = await this.stopAll();
        const killed = result.pids.length - result.failed.length;
        const message = this.stopReport(result);
        this.say('关闭', !result.pids.length ? '本来就没在跑' : `关了 ${killed} 个`);
        return { ok: !result.failed.length, running: false, url: this.url(), message };
      }
      default:
        throw new Error(`control 面板没有这个方法：${method}`);
    }
  }

  // ---------- 工具 ----------

  private statusTool(): ToolDef {
    return {
      name: 'dsh_status',
      description:
        '看看 DSH 现在开着没有：端口通不通、界面地址是什么。使用者问「DSH 开着吗」「地址是多少」时用它。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        this.listening = await this.probe();
        return [`地址 ${this.url()}`, `状态 ${this.stateLabel()}`].join('\n');
      },
    };
  }

  private startTool(): ToolDef {
    return {
      name: 'dsh_start',
      description:
        '把 dsh web 拉起来（已经跑着就什么都不做）。使用者说「把 DSH 开起来」「桌面上那个 DSH 没了」时用它，' +
        '开完把地址告诉他就行。',
      tags: ['act'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        if (await this.probe()) return `已经在跑了：${this.url()}`;
        const started = this.spawnDsh(true);
        if (!started) return '没找到可用的 dsh 命令，起不来；让他自己开一下 dsh web 吧。';
        const ok = await this.waitForListening(OPEN_WAIT_MS);
        if (ok) {
          this.listening = true;
          this.startupUrl = this.readStartupUrl();
          // dsh web 的 `dsh web: <url>?token=…` 那行要等插件全加载完才打印，
          // 端口通了不代表打出来了，后台再盯一会儿
          if (!this.startupUrl) void this.captureStartupUrl();
        }
        return ok
          ? `拉起来了，地址 ${this.url()}，已经能打开。`
          : `起了进程但 ${Math.round(OPEN_WAIT_MS / 1000)} 秒还没通，可能还在启动或端口被占；地址 ${this.url()}`;
      },
    };
  }

  private openTool(): ToolDef {
    return {
      name: 'dsh_open',
      description: '用默认浏览器打开 DSH 的界面。使用者说「打开 DSH」「让我看看」时用它。',
      tags: ['act'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        if (!(await this.probe()) && !this.startupUrl) {
          return 'DSH 现在没在跑（那个端口没人应答），要先用 dsh_start 拉起来。';
        }
        // 每次开之前重读日志，尽量拿到带 token 的那串（裸地址在新浏览器里打不开）
        this.startupUrl = this.readStartupUrl() || this.startupUrl;
        // dsh web 打印的地址带一次性 token，优先用它；裸地址兜底
        const url = this.startupUrl || this.url();
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        try {
          const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
        } catch {
          return `打不开浏览器，地址是 ${this.url()}，让他自己点吧。`;
        }
        // 只报裸地址：带 token 的那串别进上下文
        return `打开了 ${this.url()}`;
      },
    };
  }

  private stopTool(): ToolDef {
    return {
      name: 'dsh_stop',
      description:
        '关掉这台电脑上所有 dsh web（通常只有一个，不管是谁起的）。' +
        '注意：那份 DSH 往往正显示着使用者的界面，停之前一定先问过使用者。',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          confirm: {
            type: 'boolean',
            description: '确认真的停：停掉后正在看的那页 DSH 会立刻断开。第一次调用不要设它。',
          },
        },
      },
      handler: async (args: { confirm?: boolean } = {}) => {
        if (args.confirm !== true) {
          // 这份 DSH 往往正承载着他眼前的界面，直接杀会把他的对话一起掐掉
          return '这个 dsh web 往往就是使用者眼前开着的那个界面，停了那一页会立刻断。真要停的话，先让使用者答应，再把 confirm 设成 true。';
        }
        return this.stopReport(await this.stopAll());
      },
    };
  }
}

// ---------- 辅助 ----------

/**
 * 找到能跑 dsh 的命令。
 * 优先 `node + lib/bin.js`：不经过 cmd 外壳，参数不用转义，Windows 上最稳。
 */
function resolveLaunch(): { cmd: string; args: string[] } | null {
  if (process.platform === 'win32') {
    const npmDirs = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const dir of npmDirs) {
      const bin = join(dir, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (existsSync(bin)) return { cmd: 'node', args: [bin] };
    }
  }
  return fallbackLaunch();
}

function fallbackLaunch(): { cmd: string; args: string[] } | null {
  // 非 Windows，或上面都没命中：交给 PATH 上的 dsh。
  // 顺手确认它真的存在——没装的时候返回 null，让调用方直接说「没找到 dsh」，
  // 而不是 spawn 一个不存在的命令、白等 20 秒再报「起了进程但没通」。
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh'] : ['dsh'];
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathVar = process.env.PATH || process.env.Path || '';
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      if (existsSync(join(dir, name))) return { cmd: name, args: [] };
    }
  }
  return null;
}

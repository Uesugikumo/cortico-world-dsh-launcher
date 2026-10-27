// DSH 桥接 · 控制面板
// 手写产物：只显示状态 + 两个按钮，真正干活的是 World 那边的 invoke('control', …)。
// 不 import 任何运行时代码（框架只把 ctx 注进来），所以不需要构建。

const REFRESH_MS = 5000;

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function mountControl(ctx) {
  const ui = ctx.ui;
  const sheet = ui.sheet({
    title: 'DSH 开关',
    desc: '启动会拉起 dsh web；关闭只关由 Coo 起来的这一份。',
  });

  const state = ui.pill('—', 'plain');
  const addr = ui.h('span', 'mono', '—');
  const message = ui.msgline('');
  const startBtn = ui.button('启动 DSH', { variant: 'primary', size: 'sm', onClick: () => void run('start') });
  const stopBtn = ui.button('关闭 DSH', { variant: 'danger', size: 'sm', onClick: () => void run('stop') });
  const bar = ui.rowbar();
  bar.append(startBtn, stopBtn);

  sheet.body.append(ui.field('状态', state), ui.field('地址', addr), bar, message);
  ctx.root.appendChild(sheet.el);

  let busy = false;

  function render(st) {
    const running = Boolean(st && st.running);
    const working = Boolean(st && st.busy);
    state.textContent = running ? (working ? '在跑 · 干活中' : '在跑') : '没在跑';
    state.className = running ? 'pill dsh-on on' : 'pill off';
    addr.textContent = (st && st.url) || '—';
    startBtn.disabled = busy || running;
    stopBtn.disabled = busy || !running;
  }

  function say(text, bad) {
    message.textContent = text || '';
    message.classList.toggle('bad', Boolean(bad));
  }

  async function refresh() {
    if (busy) return;
    try {
      const st = await ctx.invoke('status');
      if (ctx.signal && ctx.signal.aborted) return;
      render(st);
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      say(`读不到状态：${errText(err)}`, true);
    }
  }

  async function run(method) {
    if (busy) return;
    busy = true;
    render(null);
    startBtn.disabled = true;
    stopBtn.disabled = true;
    say(method === 'start' ? '正在拉起 dsh web，可能要十几秒…' : '正在关闭…', false);
    try {
      const res = await ctx.invoke(method);
      if (ctx.signal && ctx.signal.aborted) return;
      render(res);
      say(res && res.message ? res.message : '好了', res && res.ok === false);
      if (res && res.ok === false) ui.toast(res.message || '没成功', 'bad');
      else ui.toast(res && res.message ? res.message : '好了', 'ok');
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) return;
      say(`失败：${errText(err)}`, true);
      ui.toast('没成功', 'bad');
    } finally {
      busy = false;
      void refresh();
    }
  }

  void refresh();
  ctx.interval(() => {
    void refresh();
  }, REFRESH_MS);
}

const bundle = { panels: { control: { mount: mountControl } } };

export { bundle as default };

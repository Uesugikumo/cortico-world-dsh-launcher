// coo-dsh-bridge — Coo 的 DSH 侧桥接。
//
// 作用：把 DSH 里 agent 的状态（在不在干活）与过程（每一轮、每一步、用了什么工具、
// 有没有在等人回答/批准、有没有报错）写成本地 jsonl，给 Coo 的 cortico-world-dsh
// 扩展读。**只写本地文件，不发任何网络请求。**
//
// 文件：<bridgeDir>/dsh-<pid>.jsonl，每行一条 JSON：
//   { v: 1, ts: <秒.毫秒>, app: 'coo', event: '...', ... }
//
// 换目录：设置环境变量 COO_DSH_BRIDGE_DIR。默认 %APPDATA%\coo-dsh-bridge。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'coo-dsh-bridge';
// 不依赖模型、不依赖任何服务：没有配置模型时也应该能加载、能写状态。
export const inject = [];

const SCHEMA = 1;
const MAX_BYTES = 2 * 1024 * 1024;
const FLUSH_MS = 80;
const TEXT_MAX = 300;
const BEAT_MS = 60_000;
const QUESTION_TOOL = 'ask_user_question';

function bridgeDir() {
  const custom = process.env.COO_DSH_BRIDGE_DIR;
  if (custom) return custom;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'coo-dsh-bridge');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'coo-dsh-bridge');
  }
  return path.join(os.homedir(), '.config', 'coo-dsh-bridge');
}

const DIR = bridgeDir();
const FILE = path.join(DIR, `dsh-${process.pid}.jsonl`);

// ---------- 写盘 ----------

let pending = [];
let flushTimer = null;
let broken = false;

function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    broken = true;
  }
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(FILE);
    if (st.size > MAX_BYTES) fs.renameSync(FILE, `${FILE}.1`);
  } catch {
    // 文件还不存在，不用管
  }
}

function flush() {
  flushTimer = null;
  if (!pending.length || broken) return;
  const lines = pending.join('\n') + '\n';
  pending = [];
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(FILE, lines, 'utf8');
  } catch {
    broken = true;
  }
}

function record(fields) {
  if (broken) return;
  pending.push(
    JSON.stringify({ v: SCHEMA, ts: Date.now() / 1000, app: 'coo', pid: process.pid, ...fields }),
  );
  if (pending.length >= 64) {
    flush();
    return;
  }
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

// ---------- 小工具 ----------

function trunc(value, max = TEXT_MAX) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function messageText(data) {
  const msg = data?.message ?? data ?? {};
  const content = msg.content ?? data?.content;
  if (typeof content === 'string') return trunc(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text);
      }
    }
    return trunc(parts.join(' '));
  }
  if (typeof msg.text === 'string') return trunc(msg.text);
  return '';
}

function commandOf(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'url']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return trunc(v, 160);
  }
  return '';
}

function questionsOf(args) {
  if (!args || typeof args !== 'object') return [];
  const raw = args.questions;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof item.question === 'string') {
      out.push({ question: trunc(item.question, 160) });
    } else if (typeof item === 'string' && item.trim()) {
      out.push({ question: trunc(item, 160) });
    }
    if (out.length >= 5) break;
  }
  return out;
}

function sessionIdOf(session, event) {
  if (session && session.id) return String(session.id);
  const data = event?.data ?? {};
  if (data.sessionId) return String(data.sessionId);
  return '';
}

function stepOf(event) {
  const data = event?.data ?? {};
  if (data.step !== undefined && data.step !== null) return data.step;
  return null;
}

function metaOf(session) {
  const name = session?.title || session?.label || session?.name || '';
  const project = session?.workspace?.path || session?.cwd || '';
  return {
    sessionName: trunc(name, 80),
    projectName: project ? path.basename(String(project)) || trunc(project, 80) : '',
  };
}

// ---------- 状态聚合 ----------

const agentStates = new Map();
const sessionSeen = new Set();
const toolCallSeen = new Set();
const pendingQuestions = new Set();
let lastAggregate = null;

function aggregate() {
  const busy = [...agentStates.values()].some((s) => s === 'working');
  const next = busy ? 'working' : 'idle';
  if (next === lastAggregate) return;
  lastAggregate = next;
  record({ event: 'state', state: next });
}

// ---------- 插件入口 ----------

export function apply(ctx) {
  record({ event: 'hello', dir: DIR, pid: process.pid, platform: process.platform });

  const beat = setInterval(() => record({ event: 'beat' }), BEAT_MS);
  beat.unref?.();
  ctx.effect?.(() => () => clearInterval(beat), `${name}.beat()`);

  process.on('exit', flush);
  ctx.effect?.(() => () => flush(), `${name}.exit()`);

  ctx.on?.('agent/created', ({ agent } = {}) => {
    if (!agent) return;
    const sessionId = String(agent.session?.id || agent.id || '');
    agentStates.set(agent, 'idle');
    agent.ctx?.effect?.(() => {
      const stopStatus = agent.ctx.on?.('agent/status', ({ status } = {}) => {
        agentStates.set(agent, status === 'running' ? 'working' : 'idle');
        aggregate();
      });
      const stopError = agent.ctx.on?.('agent/request-error', ({ failure } = {}) => {
        record({
          event: 'error',
          sessionId,
          code: trunc(failure?.code ?? '', 48),
          message: trunc(failure?.message ?? ''),
        });
      });
      return () => {
        stopStatus?.();
        stopError?.();
        agentStates.delete(agent);
        aggregate();
      };
    }, `${name}.agent()`);
  });

  ctx.on?.('session/event', (session, event) => {
    try {
      handleSessionEvent(session, event);
    } catch {
      // 桥接自己出问题不该影响 DSH 干活
    }
  });
}

function handleSessionEvent(session, event) {
  const type = event?.type;
  if (!type) return;
  const sessionId = sessionIdOf(session, event);
  const step = stepOf(event);

  // 每个会话第一次露面时补一条元信息，让 Coo 知道是哪个项目/哪次会话
  if (sessionId && !sessionSeen.has(sessionId)) {
    sessionSeen.add(sessionId);
    record({ event: 'session/meta', sessionId, ...metaOf(session) });
  }

  switch (type) {
    case 'turn/start': {
      flush();
      record({ event: 'turn/start', sessionId, step, turn: event?.data?.turn ?? null });
      return;
    }
    case 'turn/end': {
      record({
        event: 'turn/end',
        sessionId,
        step,
        reason: trunc(event?.data?.reason?.kind ?? '', 48),
      });
      flush();
      return;
    }
    case 'step/start': {
      flush();
      record({ event: 'step/start', sessionId, step });
      return;
    }
    case 'user/message': {
      const data = event?.data ?? {};
      record({
        event: 'user/message',
        sessionId,
        step,
        sourceKind: trunc(data?.source?.kind ?? '', 32),
        text: messageText(data),
      });
      return;
    }
    case 'assistant/message': {
      const data = event?.data ?? {};
      const content = data?.message?.content ?? data?.content;
      let spoke = false;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block) continue;
          if (block.type === 'tool-call' && block.name) {
            noteToolCall(block.name, block.callId ?? block.id, block.arguments, sessionId, step);
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            spoke = true;
          }
        }
      }
      const text = messageText(data);
      if (spoke && text) record({ event: 'assistant/message', sessionId, step, text });
      return;
    }
    case 'tool/call': {
      const data = event?.data ?? {};
      if (data?.name) noteToolCall(data.name, data.callId, data.arguments, sessionId, step);
      return;
    }
    case 'tool/result': {
      const data = event?.data ?? {};
      const callId = String(
        data?.message?.callId ?? data?.message?.source?.callId ?? data?.callId ?? '',
      );
      if (callId && pendingQuestions.has(callId)) {
        pendingQuestions.delete(callId);
        record({ event: 'question/resolved', sessionId, callId });
      }
      return;
    }
    case 'approval/asked': {
      const data = event?.data ?? {};
      flush();
      record({
        event: 'approval/asked',
        sessionId,
        kind: trunc(data?.kind ?? data?.type ?? '', 48),
        detail: trunc(data?.command ?? data?.reason ?? data?.title ?? '', 160),
      });
      return;
    }
    case 'llm/retry': {
      const data = event?.data ?? {};
      record({
        event: 'llm/retry',
        sessionId,
        code: trunc(data?.code ?? data?.errorCode ?? '', 48),
      });
      return;
    }
    default:
      return;
  }
}

function noteToolCall(tool, callId, args, sessionId, step) {
  const id = String(callId ?? '');
  if (id && toolCallSeen.has(id)) return;
  if (id) {
    toolCallSeen.add(id);
    if (toolCallSeen.size > 2048) toolCallSeen.clear();
  }
  if (tool === QUESTION_TOOL) {
    flush();
    if (id) pendingQuestions.add(id);
    record({
      event: 'question/requested',
      sessionId,
      step,
      callId: id,
      questions: questionsOf(args),
    });
    return;
  }
  flush();
  record({
    event: 'tool/call',
    sessionId,
    step,
    tool: trunc(tool, 48),
    command: commandOf(args),
    callId: id,
  });
}

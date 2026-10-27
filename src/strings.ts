import type { Language } from 'cortico/core/language.ts';

export interface DshText {
  moduleLabel: string;
  lampRunning: string;
  lampMissing: string;
  lampRunningHint: string;
  lampMissingHint: string;
  badgeState: string;
  panelTitle: string;
  panelDescription: string;
  stateRunning: string;
  stateOffline: string;
  configTitle: string;
  configDescription: string;
  autostartTitle: string;
  autostartDescription: string;
  portTitle: string;
  portDescription: string;
  promptDocTitle: string;
  promptDocDescription: string;
}

const ZH: DshText = {
  moduleLabel: 'DSH 启动器',
  lampRunning: 'DSH 开着',
  lampMissing: 'DSH 没开',
  lampRunningHint: 'dsh web 在这个端口上应答',
  lampMissingHint: '这个端口没人应答，按一下「启动 DSH」就能拉起来',
  badgeState: '状态',
  panelTitle: '开关',
  panelDescription: '两个按钮：启动 dsh web、把它关掉（这台电脑上的都关）。',
  stateRunning: '开着',
  stateOffline: '没开',
  configTitle: 'DSH 启动器',
  configDescription: '只管起停与打开 DeepSeek Harness 的界面，不碰 DSH 里的内容。',
  autostartTitle: '随 Coo 启动 DSH',
  autostartDescription: 'Coo 起来时如果本地没有 dsh web 在跑，就顺手拉一个起来（不是每次都开新实例）。',
  portTitle: '监听端口',
  portDescription: 'dsh web 的端口，用来判断在不在跑。',
  promptDocTitle: 'DSH 启动器 · 环境提示词',
  promptDocDescription: '告诉 Coo 什么时候该拉起、打开或关掉 DSH。',
};

const EN: DshText = {
  moduleLabel: 'DSH launcher',
  lampRunning: 'DSH up',
  lampMissing: 'DSH down',
  lampRunningHint: 'dsh web answers on this port',
  lampMissingHint: 'Nothing answers on this port; press “Start DSH” to launch it',
  badgeState: 'State',
  panelTitle: 'On / off',
  panelDescription: 'Two buttons: start dsh web, or shut down every dsh web on this machine.',
  stateRunning: 'up',
  stateOffline: 'down',
  configTitle: 'DSH launcher',
  configDescription: 'Starts, opens and stops the DeepSeek Harness UI only; never touches DSH internals.',
  autostartTitle: 'Start DSH with Coo',
  autostartDescription: 'When Coo starts and no dsh web is listening, spawn one (never a second instance).',
  portTitle: 'Port',
  portDescription: 'Port of dsh web, used to detect liveness.',
  promptDocTitle: 'DSH launcher · environment prompt',
  promptDocDescription: 'Tells Coo when to start, open or stop DSH.',
};

export function text(language: Language): DshText {
  return language === 'zh' ? ZH : EN;
}

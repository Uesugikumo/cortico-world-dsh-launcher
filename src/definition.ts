import type { WorldDefinition } from 'cortico/world.ts';
import { DSH_DEFAULTS, type DshConfigSection } from './config.ts';
import { DshWorld } from './world.ts';

export const DSH: WorldDefinition<DshConfigSection> = {
  id: 'dsh',
  label: 'DSH 启动器',
  defaults: () => ({ ...DSH_DEFAULTS }),
  /**
   * 自描述（契约 v6）。给人和扩展市场看，不进提示词；
   * 内容与 world.ts 的 tools() 保持一致。
   */
  describe: {
    tools: [
      {
        name: 'dsh_status',
        tags: ['read'],
        summary: '看看 DSH 现在开着没有、地址是什么',
        description: '看看 DSH 现在开着没有：端口通不通、界面地址是什么。使用者问「DSH 开着吗」「地址是多少」时用它。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        name: 'dsh_start',
        tags: ['act'],
        summary: '把 dsh web 拉起来（已经跑着就什么都不做）',
        description:
          '把 dsh web 拉起来（已经跑着就什么都不做）。使用者说「把 DSH 开起来」「桌面上那个 DSH 没了」时用它，' +
          '开完把地址告诉他。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        name: 'dsh_open',
        tags: ['act'],
        summary: '用默认浏览器打开 DSH 界面',
        description: '用默认浏览器打开 DSH 的界面。使用者说「打开 DSH」「让我看看」时用它。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        name: 'dsh_stop',
        tags: ['act'],
        summary: '关掉这台电脑上所有 dsh web（要先问过使用者）',
        description:
          '关掉这台电脑上所有 dsh web（通常只有一个，不管是谁起的）。' +
          '那份 DSH 往往正显示着使用者的界面，停之前先问过使用者，确认后把 confirm 设成 true。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            confirm: { type: 'boolean', description: '确认真的停；第一次调用不要设它。' },
          },
        },
      },
    ],
    events: [
      { type: 'dsh.panel', tags: ['speak'], description: '使用者在控制台按了启动 / 关闭 DSH，正文里是结果与地址' },
    ],
  },
  create: (ctx) =>
    new DshWorld({
      dataDir: ctx.dataDir,
      cfg: ctx.cfg,
      timezone: ctx.timezone,
    }),
};

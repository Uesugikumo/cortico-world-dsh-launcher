import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { text } from './strings.ts';

/**
 * World 自有配置默认值；enabled 由部署装配决定。
 * 启动命令固定按 npm 全局安装位置找，不做成可配项。
 */
export const DSH_DEFAULTS = {
  enabled: false,
  /** dsh web 的监听地址，用来判断「在不在跑」 */
  port: 3080,
  host: '127.0.0.1',
  /** Coo 起来时如果本地没有 dsh web，就顺手拉一个起来（默认关：别在别人机器上擅自起进程） */
  autostart: false,
} as const;

/** config.json 的 `worlds.dsh` 节。 */
export interface DshConfigSection {
  enabled: boolean;
  port: number;
  host: string;
  autostart: boolean;
}

export function dshConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:dsh',
    owner: 'world:dsh',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.dsh.autostart': {
          type: 'boolean',
          title: t.autostartTitle,
          'x-hot': false,
          description: t.autostartDescription,
        },
        'worlds.dsh.port': {
          type: 'integer',
          title: t.portTitle,
          minimum: 1,
          maximum: 65535,
          'x-hot': true,
          description: t.portDescription,
        },
      },
    },
  };
}

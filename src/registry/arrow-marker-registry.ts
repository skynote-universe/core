/**
 * @file arrow-marker-registry.ts
 * @description 连线端点箭头标记注册表 (ArrowMarkerRegistry)
 */

import type { ArrowMarkerDefinition } from '../protocols/arrow-marker.protocol';

/** 经典内置箭头端点符号 */
const builtInMarkers: readonly ArrowMarkerDefinition[] = [
  {
    id: 'standard:arrow',
    label: '实心箭头',
    width: 10,
    height: 8,
    lineOffset: 8,
    d: 'M 0 0 L -8 -4 L -8 4 Z',
    fillRule: 'match-stroke'
  },
  {
    id: 'standard:triangle',
    label: '空心三角',
    width: 10,
    height: 8,
    lineOffset: 8,
    d: 'M 0 0 L -8 -4 L -8 4 Z',
    fillRule: 'match-background'
  },
  {
    id: 'standard:diamond',
    label: '菱形',
    width: 12,
    height: 8,
    lineOffset: 12,
    d: 'M 0 0 L -6 -4 L -12 0 L -6 4 Z',
    fillRule: 'match-stroke'
  },
  {
    id: 'standard:circle',
    label: '端点圆圈',
    width: 8,
    height: 8,
    lineOffset: 8,
    d: 'M 0 0 m -4 0 a 4 4 0 1 0 8 0 a 4 4 0 1 0 -8 0',
    fillRule: 'match-background'
  }
];

const ALIAS_MAP: Record<string, string> = {
  arrow: 'standard:arrow',
  triangle: 'standard:triangle',
  diamond: 'standard:diamond',
  circle: 'standard:circle'
};

export class ArrowMarkerRegistry {
  private readonly definitions = new Map<string, ArrowMarkerDefinition>();

  constructor() {
    this.registerDefaults();
  }

  /** 注册端点箭头定义 */
  register(definition: ArrowMarkerDefinition): void {
    if (!definition || !definition.id) {
      throw new Error('[ArrowMarkerRegistry] 注册失败：箭头定义缺少有效 id 字段');
    }
    this.definitions.set(definition.id, definition);
  }

  /** 注销指定箭头定义 */
  unregister(id: string): boolean {
    return this.definitions.delete(id);
  }

  /** 获取指定箭头定义 (支持标准 ID 与简写别名) */
  get(id: string): ArrowMarkerDefinition | undefined {
    const resolvedId = ALIAS_MAP[id] ?? id;
    return this.definitions.get(resolvedId);
  }

  /** 判断箭头是否已注册 */
  has(id: string): boolean {
    const resolvedId = ALIAS_MAP[id] ?? id;
    return this.definitions.has(resolvedId);
  }

  /** 获取全部已注册箭头定义 */
  getAll(): readonly ArrowMarkerDefinition[] {
    return Array.from(this.definitions.values());
  }

  /** 清空注册表并恢复内置默认标记 */
  clear(): void {
    this.definitions.clear();
    this.registerDefaults();
  }

  private registerDefaults(): void {
    for (let i = 0; i < builtInMarkers.length; i++) {
      this.register(builtInMarkers[i]);
    }
  }
}

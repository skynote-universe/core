/**
 * @file layout-registry.ts
 * @description 布局注册表 (ADR-130)
 *
 * 设计考量 (Why):
 * 布局插件可能晚于文档加载注册 (或被卸载)：注册表变化时通知订阅者 (文档仓库据此重新排版，
 * 依赖布局的插件据此刷新自身状态)；未注册的布局不排版，成员停在已保存的位置。
 */

import type { LayoutDefinition } from '../protocols/layout.protocol';

export class LayoutRegistry {
  private readonly definitions = new Map<string, LayoutDefinition>();
  private readonly listeners = new Set<() => void>();

  register(definition: LayoutDefinition): void {
    if (!definition?.id) throw new Error('[LayoutRegistry] 注册失败：布局定义缺少有效 id');
    this.definitions.set(definition.id, definition);
    this.notify();
  }

  /** 只在当前生效的仍是该定义时移除 (同 id 被重新注册后，旧插件卸载不影响新定义) */
  unregister(definition: LayoutDefinition): void {
    if (this.definitions.get(definition.id) !== definition) return;
    this.definitions.delete(definition.id);
    this.notify();
  }

  get(id: string): LayoutDefinition | undefined {
    return this.definitions.get(id);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

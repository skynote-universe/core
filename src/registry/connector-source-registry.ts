/**
 * @file connector-source-registry.ts
 * @description 派生连线来源注册表 (ADR-130)
 *
 * 设计考量 (Why):
 * 来源可能晚于文档注册、被卸载，或其依赖的外部条件变化 (如布局注册表变化)：都以「请求全量重算某来源」通知文档仓库，
 * 文档仓库据此增删派生连线并广播变更集。
 */

import type { DerivedConnectorSource } from '../protocols/connector-source.protocol';

export class ConnectorSourceRegistry {
  private readonly sources = new Map<string, DerivedConnectorSource>();
  private readonly listeners = new Set<(sourceId: string) => void>();

  register(source: DerivedConnectorSource): void {
    if (!source?.id || source.id.includes(':')) {
      throw new Error('[ConnectorSourceRegistry] 注册失败：来源 id 不能为空且不能含冒号');
    }
    this.sources.set(source.id, source);
    this.refresh(source.id);
  }

  /** 只在当前生效的仍是该来源时移除 (同 id 被重新注册后，旧插件卸载不影响新来源) */
  unregister(source: DerivedConnectorSource): void {
    if (this.sources.get(source.id) !== source) return;
    this.sources.delete(source.id);
    this.refresh(source.id);
  }

  get(id: string): DerivedConnectorSource | undefined {
    return this.sources.get(id);
  }

  all(): IterableIterator<DerivedConnectorSource> {
    return this.sources.values();
  }

  /** 请求全量重算某来源 (来源依赖的外部条件变化时调用) */
  refresh(sourceId: string): void {
    for (const listener of this.listeners) listener(sourceId);
  }

  onRefresh(listener: (sourceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

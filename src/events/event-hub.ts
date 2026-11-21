/**
 * @file event-hub.ts
 * @description 画布低频跨域事后通知中心 (CanvasEventHub)
 *
 * 设计考量 (Why):
 * 1. 统一承载内核、渲染器、插件与宿主之间的低频单向通知，避免各处重复维护监听器集合与异常隔离逻辑。
 * 2. 分发时迭代快照并隔离单监听器异常，确保故障订阅不会阻断其余监听者或破坏调用方流程。
 */

import type {
  CanvasEventDescriptor,
  CanvasEventHubReader,
  CanvasEventMap,
  CanvasEventMeta,
  CanvasEventName
} from '../protocols/event-hub.protocol';

type AnyEventListener = (payload: unknown) => void;

export class CanvasEventHub implements CanvasEventHubReader {
  private readonly listeners = new Map<string, Set<AnyEventListener>>();
  private readonly descriptors = new Map<string, CanvasEventDescriptor>();

  on<K extends CanvasEventName>(event: K, listener: (payload: CanvasEventMap[K]) => void): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    const fn = listener as AnyEventListener;
    bucket.add(fn);
    return () => {
      bucket.delete(fn);
      if (bucket.size === 0) this.listeners.delete(event);
    };
  }

  emit<K extends CanvasEventName>(event: K, payload: CanvasEventMap[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket || bucket.size === 0) return;
    for (const listener of [...bucket]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[SkyNote:EventHub] 事件 "${event}" 监听器执行异常:`, error);
      }
    }
  }

  define<K extends CanvasEventName>(event: K, meta: CanvasEventMeta): () => void {
    const descriptor: CanvasEventDescriptor = {
      name: event,
      description: meta.description,
      ...(meta.source !== undefined && { source: meta.source })
    };
    this.descriptors.set(event, descriptor);
    return () => {
      if (this.descriptors.get(event) === descriptor) this.descriptors.delete(event);
    };
  }

  list(): readonly CanvasEventDescriptor[] {
    return [...this.descriptors.values()];
  }

  clear(): void {
    this.listeners.clear();
    this.descriptors.clear();
  }
}

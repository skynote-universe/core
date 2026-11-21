/**
 * @file event-hub.protocol.ts
 * @description 画布低频跨域事后通知事件协议
 *
 * 设计考量 (Why):
 * 1. 只承载低频、单向的事后通知（不返回值、不驱动核心文档写入），高频热路径继续走 DocumentStore / SessionStore 专有通道。
 * 2. 通过 `CanvasEventMap` 模块扩展让外部插件与宿主获得强类型事件名与载荷，无需修改内核。
 * 3. `define()` / `list()` 提供可选的运行时事件说明登记，便于调试、文档校验与跨插件约定。
 */

import type { AssetTaskEvent } from './asset.protocol';

/**
 * 画布低频跨域事后通知事件表。
 * 外部插件或宿主可通过 `declare module '@skynote/core' { interface CanvasEventMap { ... } }` 扩展自定义事件。
 */
export interface CanvasEventMap {
  /** 宿主能力挂载或卸载 */
  'host:change': { readonly available: boolean };
  /** 异步资产任务开始、结束或前置拒绝 */
  'asset:task': AssetTaskEvent;
  /** 用户点击激活区或按键触发节点主动作（如打开视频弹窗或网页链接） */
  'node:activate': {
    readonly nodeId: string;
    readonly nodeType: string;
    readonly trigger: 'pointer' | 'keyboard';
  };
}

export type CanvasEventName = Extract<keyof CanvasEventMap, string>;

export interface CanvasEventDescriptor {
  readonly name: string;
  readonly description: string;
  readonly source?: string;
}

export interface CanvasEventMeta {
  readonly description: string;
  readonly source?: string;
}

export interface CanvasEventHubReader {
  /** 订阅指定事件，返回注销函数 */
  on<K extends CanvasEventName>(event: K, listener: (payload: CanvasEventMap[K]) => void): () => void;
  /** 发布单向事后通知；单个监听器异常会被隔离，不影响其余订阅者 */
  emit<K extends CanvasEventName>(event: K, payload: CanvasEventMap[K]): void;
  /** 登记事件说明元数据，返回注销函数 */
  define<K extends CanvasEventName>(event: K, meta: CanvasEventMeta): () => void;
  /** 列出当前已登记说明的全部事件 */
  list(): readonly CanvasEventDescriptor[];
}

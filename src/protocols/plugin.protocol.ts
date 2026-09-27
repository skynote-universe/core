/**
 * @file plugin.protocol.ts
 * @description SkyNote 插件生命周期与宿主装配契约
 * 
 * 设计考量 (Why):
 * 1. 插件绝对零感知：严禁在插件内通过探针引用其他插件的私有状态。
 * 2. 纯净生命周期：通过 install() 与 unmount() 完成监听挂载与彻底释放，杜绝内存静默泄露。
 */

import type { CanvasPointerEvent, CanvasWheelEvent } from './events.protocol';
import type { NodeTypeDefinition } from './node-type.protocol';
import type { InputScope } from './input-scope.protocol';
import type { ArrowMarkerDefinition } from './arrow-marker.protocol';
import type { ConnectorRouterDefinition } from './connector-router.protocol';
import type { CanvasDocumentView, NodeEntity, ConnectorEntity } from '../types';
import type { CommitOperationOptions } from '../types/operation';

/** 暴露给插件消费的画布上下文 API */
export interface CanvasPluginContext {
  /** 获取当前只读文档快照 */
  getDocument(): CanvasDocumentView;

  /** O(1) 瞬时查询单个节点实体 (只读) */
  getNode(id: string): Readonly<NodeEntity> | undefined;

  /** O(1) 瞬时查询单个连线实体 (只读) */
  getConnector(id: string): Readonly<ConnectorEntity> | undefined;

  /**
   * 提交原子事务变更
   * 状态流转唯一合法入口，严禁直接篡改实体对象
   */
  commitOperation<TPayload>(options: CommitOperationOptions<TPayload>): void;

  /** 注册自定义图元节点定义 */
  registerNodeType(definition: NodeTypeDefinition): void;

  /** 注册连线端点自定义箭头标记 */
  registerArrowMarker(definition: ArrowMarkerDefinition): void;

  /** 注册连线寻路算法定义 */
  registerConnectorRouter(definition: ConnectorRouterDefinition): void;

  /** 注册键盘快捷键作用域 */
  registerInputScope(scope: InputScope): () => void;

  /** 注册指针与滚轮交互监听 (返回解绑注销函数，支持 priority 优先级排序) */
  registerPointerHooks(hooks: {
    onPointerDown?(e: CanvasPointerEvent): void;
    onPointerMove?(e: CanvasPointerEvent): void;
    onPointerUp?(e: CanvasPointerEvent): void;
    onWheel?(e: CanvasWheelEvent): void;
  }, priority?: number): () => void;
}

/**
 * 通用插件契约接口
 */
export interface SkyNotePlugin {
  /** 插件全局唯一标识，如 '@skynote/interactions', '@skynote-pro/mindmap' */
  readonly id: string;
  /** 插件语义名称 */
  readonly name: string;
  /** 版本号 */
  readonly version: string;

  /** 插件装载 */
  install(ctx: CanvasPluginContext): void;

  /** 插件卸载释放 */
  unmount?(): void;

  /** 指针交互钩子 (选填) */
  onPointerDown?(e: CanvasPointerEvent): void;
  onPointerMove?(e: CanvasPointerEvent): void;
  onPointerUp?(e: CanvasPointerEvent): void;

  /** 滚轮手势钩子 (选填) */
  onWheel?(e: CanvasWheelEvent): void;
}

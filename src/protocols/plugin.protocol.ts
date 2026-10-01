/**
 * @file plugin.protocol.ts
 * @description 插件生命周期与插件上下文契约
 *
 * 设计考量 (Why):
 * 1. 零感知：插件只经上下文与内核交互，插件之间只通过会话选区与指针认领协作，不探测彼此状态。
 * 2. 能力收敛：读写文档只有 document (查询 + 语义命令，全部经事务提交)，派生读取 (实体索引、空间检索、拾取)
 *    与宿主能力各一个入口；插件经上下文注册的一切在卸载时自动释放。
 */

import type { NodeTypeDefinition } from './node-type.protocol';
import type { InputScope } from './input-scope.protocol';
import type { ArrowMarkerDefinition } from './arrow-marker.protocol';
import type { ConnectorRouterDefinition } from './connector-router.protocol';
import type { CanvasHost } from './host.protocol';
import type { Point } from '../types/geometry';
import type { NodeEntity } from '../types/node';
import type { ConnectorEntity } from '../types/connector';
import type { CanvasOperationRecord } from '../types/operation';
import type { DocumentChangeSet } from '../types/change-set';
import type { SessionController, SessionChange } from '../state/session-store';
import type { DocumentApi } from '../state/document-store';
import type { EntityReader } from '../state/entity-store';
import type { NodeSpatialQuery } from '../spatial/scene-spatial-index';
import type { PointerHooks } from '../input/pointer-dispatcher';
import type { NodeTypeReader } from '../registry/node-type-registry';

/** 插件上下文：插件可用的全部内核能力 */
export interface CanvasPluginContext {
  /** 文档查询与语义命令 (新建、移动、删除、改挂、层级、批处理、撤销重做)，全部经事务提交 */
  readonly document: DocumentApi;
  /** 实体只读索引 (世界矩阵、父子关系、依附连线) */
  readonly entities: EntityReader;
  /** 节点空间检索 (世界坐标) */
  readonly spatial: NodeSpatialQuery;
  /** 已注册的节点类型 (只读)：读取尺寸策略、缩放行为与轮廓 */
  readonly nodeTypes: NodeTypeReader;
  /** 本地会话 (视口、选区、主题)：不进入文档、不入撤销栈、不参与协同 */
  readonly session: SessionController;
  /** 宿主能力 (覆盖层、光标、指针捕获)；渲染器挂载前为空实现，插件卸载时其覆盖层会话自动清除 */
  readonly host: CanvasHost;

  /** 点选最上层节点：含旋转精判、裁剪型容器与层叠顺序；accept 限定只在满足条件的节点中拾取 */
  hitTestNode(point: Point, accept?: (node: Readonly<NodeEntity>) => boolean): Readonly<NodeEntity> | undefined;
  /** 连线拾取：点到路由的距离不超过 tolerancePx 屏幕像素 */
  hitTestConnector(point: Point, tolerancePx?: number): Readonly<ConnectorEntity> | undefined;

  /** 订阅文档增量变更集；只做单向通知，监听中严禁同步提交新事务引发级联 */
  onDocumentChange(listener: (changes: DocumentChangeSet, record: CanvasOperationRecord) => void): () => void;
  /** 订阅视口、选区与主题变化 */
  onSessionChange(listener: (change: SessionChange) => void): () => void;

  registerNodeType(definition: NodeTypeDefinition): void;
  registerArrowMarker(definition: ArrowMarkerDefinition): void;
  registerConnectorRouter(definition: ConnectorRouterDefinition): void;
  /** 注册键盘作用域 (焦点栈，ADR-005) */
  registerInputScope(scope: InputScope): () => void;
  /**
   * 注册指针与滚轮钩子：priority 越大越先接收 (默认 0)，高优先级认领指针后低优先级自动让路
   * 插件类自身实现 PointerHooks 时可直接传入 this
   */
  registerPointerHooks(hooks: PointerHooks, priority?: number): () => void;
}

/** 插件契约 */
export interface SkyNotePlugin {
  /** 全局唯一标识，如 '@skynote/plugins-basic/selection' */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  install(ctx: CanvasPluginContext): void;
  /** 卸载时释放插件自身状态；经上下文注册的资源由插件管理器自动释放 */
  unmount?(): void;
}

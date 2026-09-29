/**
 * @file engine.ts
 * @description SkyNote 平台中立核心引擎门面 (SkyNoteEngine)
 *
 * 设计考量 (Why):
 * 1. 唯一门面，统筹枢纽：将 DocumentStore、EntityStore、NodeTypeRegistry、SpatialIndex、
 *    InputScopeManager、PluginManager 与本地会话状态组装为一体。
 * 2. 空间拓扑与状态树自联动：消费 DocumentChangeSet 增量维护节点与连线两套空间索引，
 *    每次提交只触达变更实体，与画布总规模无关；渲染器与选框无需手动同步索引。
 * 3. 严格遵循四大红线：全文 0 DOM / 0 Canvas 依赖，纯内存图灵完备，可无缝运行于浏览器、Web Worker 或 Node.js。
 * 4. 连线路由统一求解：几何失效的连线在此求解路由并缓存，连线空间索引取真实路由包围盒；
 *    渲染器、导出与插件经 getConnectorRoute 共享结果。路由器晚于文档注册时自动重算对应类型的连线。
 * 5. 文本驱动的自动尺寸：注入 TextMeasurer 后，本地事务中的文本/宽度变更在同一事务内派生节点尺寸补丁，
 *    撤销文字修改时尺寸一并回退；未注入测量器时节点尺寸完全由用户与插件决定。
 */

import type { CanvasDocument, CanvasDocumentView, ViewportState } from './types/canvas';
import type { DocumentChangeSet } from './types/change-set';
import type { CanvasThemeConfig } from './types/theme';
import type { ComputedRoute } from './types/runtime';
import { computeNodeWorldBounds, isPointInNode, type RectBounds } from './utils/geometry';
import { compareHierarchicalNodes } from './layout/layer-order';
import { DETACHED_CANVAS_HOST, type CanvasHost } from './protocols/overlay.protocol';
import type { NodeEntity } from './types/node';
import type { CreateNodeRequest } from './protocols/node-type.protocol';
import { generateId } from './utils/id';
import type { Point } from './types/canvas';
import { computeConnectorRoute } from './routing/connector-route';
import type { TextMeasurer } from './protocols/text-measurer.protocol';
import type { CanvasOperationRecord } from './types/operation';
import { collectTextLayoutTargets, deriveTextLayoutPatches } from './layout/text-layout';
import { DocumentStore, createEmptyCanvasDocument } from './state/document-store';
import type { EntityReader } from './state/entity-store';
import { SessionStore, type ZoomRange } from './state/session-store';
import { NodeTypeRegistry } from './registry/node-type-registry';
import { ArrowMarkerRegistry } from './registry/arrow-marker-registry';
import { ConnectorRouterRegistry } from './registry/connector-router-registry';
import {
  type NodeSpatialQuery,
  type SpatialIndex,
  type SpatialIndexEntry,
  SceneSpatialIndex,
  RTreeSpatialIndex
} from './spatial';
import { InputScopeManager } from './input/input-scope-manager';
import { PointerDispatcher } from './input/pointer-dispatcher';
import { PluginManager } from './plugin/plugin-manager';
import type { SkyNotePlugin } from './protocols/plugin.protocol';

export interface SkyNoteEngineOptions {
  /** 初始画布文档 (默认创建空文档) */
  initialDoc?: CanvasDocument;
  /** 初始视口 (宿主可自行持久化上次浏览位置并在此恢复) */
  initialViewport?: Partial<ViewportState>;
  /** 视口缩放范围 (默认 DEFAULT_ZOOM_RANGE) */
  zoomRange?: ZoomRange;
  /** 画布主题 (默认浅色预设)，运行时通过 engine.session.setTheme() 显式切换 */
  theme?: CanvasThemeConfig;
  /** 文本测量器 (由渲染适配层提供，如 LeaferTextMeasurer)，缺省时不做文本驱动的自动尺寸 */
  textMeasurer?: TextMeasurer;
  /**
   * 节点空间索引工厂 (默认 R-Tree)：节点索引按容器分层 (ADR-114)，每个容器各建一个实例
   */
  createNodeSpatialIndex?: () => SpatialIndex;
  /** 自定义连线空间拓扑索引实现 (默认采用 R-Tree 层次包围盒) */
  connectorSpatialIndex?: SpatialIndex;
}

export class SkyNoteEngine {
  readonly documentStore: DocumentStore;
  readonly entityStore: EntityReader;
  /** 本地会话状态：视口与选区 */
  readonly session: SessionStore;
  readonly nodeTypes: NodeTypeRegistry;
  readonly arrowMarkers: ArrowMarkerRegistry;
  readonly routers: ConnectorRouterRegistry;
  /** 节点空间检索 (分层索引，由引擎按变更集维护) */
  readonly spatialIndex: NodeSpatialQuery;
  readonly connectorSpatialIndex: SpatialIndex;
  readonly inputScopes: InputScopeManager;
  readonly pointer: PointerDispatcher;
  readonly plugins: PluginManager;

  private readonly nodeSpatialIndex: SceneSpatialIndex;
  private currentHost: CanvasHost = DETACHED_CANVAS_HOST;
  private readonly unsubscribeDocument: () => void;
  private readonly unsubscribeRouters: () => void;
  /** 连线路由缓存：连线自身或两端节点几何变化时整体替换 */
  private readonly routes = new Map<string, ComputedRoute>();
  private textMeasurer: TextMeasurer | null = null;
  private isDestroyed = false;

  constructor(options?: SkyNoteEngineOptions) {
    const doc = options?.initialDoc ?? createEmptyCanvasDocument();

    this.documentStore = new DocumentStore(doc);
    this.entityStore = this.documentStore.entityStore;
    this.session = new SessionStore({
      viewport: options?.initialViewport,
      theme: options?.theme,
      zoomRange: options?.zoomRange
    });
    this.nodeTypes = new NodeTypeRegistry();
    this.arrowMarkers = new ArrowMarkerRegistry();
    this.routers = new ConnectorRouterRegistry();
    this.nodeSpatialIndex = new SceneSpatialIndex(
      this.entityStore,
      options?.createNodeSpatialIndex ?? (() => new RTreeSpatialIndex())
    );
    this.spatialIndex = this.nodeSpatialIndex;
    this.connectorSpatialIndex = options?.connectorSpatialIndex ?? new RTreeSpatialIndex();
    this.inputScopes = new InputScopeManager();
    this.pointer = new PointerDispatcher();

    this.plugins = new PluginManager({
      documentStore: this.documentStore,
      session: this.session,
      nodeTypeRegistry: this.nodeTypes,
      arrowMarkerRegistry: this.arrowMarkers,
      connectorRouterRegistry: this.routers,
      inputScopeManager: this.inputScopes,
      pointerDispatcher: this.pointer,
      entities: this.entityStore,
      spatial: this.spatialIndex,
      hitTestNode: (point) => this.hitTestNode(point),
      createNode: (request) => this.createNode(request),
      getHost: () => this.currentHost
    });

    this.nodeSpatialIndex.rebuild();
    this.updateConnectorRoutes(
      this.entityStore.getAllConnectors().map((runtimeConnector) => runtimeConnector.entity.id)
    );

    // 空间索引与选区都是文档的派生状态，由引擎统一维护一致性：
    // 实体删除（本地、远端或撤销）后选区不会残留指向不存在实体的 id
    this.unsubscribeDocument = this.documentStore.subscribe((_view, _record, changes) => {
      this.syncSpatialIndexes(changes);
      this.session.pruneSelection(changes.nodes.removed, changes.connectors.removed);
    });
    this.setTextMeasurer(options?.textMeasurer ?? null);

    this.unsubscribeRouters = this.routers.onChange((routerId) => {
      const affected = this.entityStore
        .getAllConnectors()
        .filter((runtimeConnector) => runtimeConnector.entity.connectorType === routerId)
        .map((runtimeConnector) => runtimeConnector.entity.id);
      this.updateConnectorRoutes(affected);
    });
  }

  /**
   * 安装插件
   */
  use(plugin: SkyNotePlugin): this {
    this.plugins.use(plugin);
    return this;
  }

  /** 当前挂载的宿主能力 (渲染器挂载前为空实现) */
  get host(): CanvasHost {
    return this.currentHost;
  }

  /**
   * 挂载宿主 (由渲染器在 mount 时调用)，返回卸载函数
   * 插件经上下文调用宿主能力时读取当前宿主，因此插件可以早于渲染器安装
   */
  attachHost(host: CanvasHost): () => void {
    this.currentHost = host;
    return () => {
      if (this.currentHost === host) this.currentHost = DETACHED_CANVAS_HOST;
    };
  }

  /**
   * 点选最上层节点：空间索引粗筛后按世界矩阵精判 (含自身与祖先旋转)；
   * 落在裁剪型祖先 (画框) 之外的部分不可拾取；候选返回顺序与层叠无关，必须显式比较层级
   */
  hitTestNode(point: Point): Readonly<NodeEntity> | undefined {
    const { entityStore, nodeTypes } = this;
    const chainCache = new Map<string, Readonly<NodeEntity>[]>();
    const getNode = (id: string) => entityStore.getNode(id)?.entity;
    const containsPoint = (node: Readonly<NodeEntity>) =>
      isPointInNode(point, node, entityStore.getWorldTransform(node.id)!);
    const isClippedOut = (node: Readonly<NodeEntity>): boolean => {
      for (let parent = node.parentId === undefined ? undefined : getNode(node.parentId); parent;) {
        if (nodeTypes.get(parent.nodeType)?.clipChildren && !containsPoint(parent)) return true;
        parent = parent.parentId === undefined ? undefined : getNode(parent.parentId);
      }
      return false;
    };

    let top: Readonly<NodeEntity> | undefined;
    const candidateIds = this.spatialIndex.hitTest(point);
    for (let i = 0; i < candidateIds.length; i++) {
      const node = getNode(candidateIds[i]);
      if (!node || node.style?.opacity === 0 || !containsPoint(node)) continue;
      if (top && compareHierarchicalNodes(node, top, getNode, chainCache) < 0) continue;
      if (isClippedOut(node)) continue;
      top = node;
    }
    return top;
  }

  /**
   * 新建节点的统一入口：由已注册节点类型的 createContent 给出内容，引擎补齐公共字段后经事务提交 (一步撤销)
   * 新节点置于目标容器最上层
   * @returns 新节点 id；提交被拒绝时返回 null
   * @throws 节点类型未注册或不支持新建 (属调用方编程错误)
   */
  createNode<T extends string>(request: CreateNodeRequest<T>): string | null {
    const definition = this.nodeTypes.get(request.nodeType);
    if (!definition?.createContent) {
      throw new Error(`[SkyNoteEngine] 节点类型 "${request.nodeType}" 未注册或不支持新建`);
    }
    const content = definition.createContent(request.options ?? {});
    const width = request.width ?? content.width;
    const height = request.height ?? content.height;
    // 内容驱动尺寸的节点 (如自由文本) 以 0 尺寸创建、提交时才测量，居中放置时退化为左上角对准
    const centered = request.origin === 'center';
    const node: NodeEntity = {
      ...content,
      id: request.id ?? generateId('node'),
      type: 'node',
      nodeType: request.nodeType,
      ...(request.parentId !== undefined && { parentId: request.parentId }),
      x: centered ? request.x - width / 2 : request.x,
      y: centered ? request.y - height / 2 : request.y,
      width,
      height,
      rotation: request.rotation ?? 0,
      zIndex: this.documentStore.createTopZIndex(request.parentId),
      locked: false
    };
    return this.documentStore.addNode(node, { label: request.label }) ? node.id : null;
  }

  /**
   * 获取当前只读文档投影视图
   */
  getView(): CanvasDocumentView {
    return this.documentStore.getView();
  }

  /**
   * 彻底销毁引擎实例并释放全部插件资源
   */
  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    this.unsubscribeDocument();
    this.unsubscribeRouters();
    this.routes.clear();
    this.plugins.destroy();
    this.pointer.clear();
    this.nodeSpatialIndex.clear();
    this.connectorSpatialIndex.clear();
    this.inputScopes.clear();
    this.nodeTypes.clear();
    this.arrowMarkers.clear();
    this.routers.clear();
    this.documentStore.clearHistory();
  }

  /**
   * 按变更集增量维护空间索引：只触达本次提交涉及的实体，由索引实现自行决定逐条插入还是整体重建
   */
  private syncSpatialIndexes(changes: DocumentChangeSet): void {
    // 分层索引：容器移动只更新容器自身的条目，后代无需任何处理
    this.nodeSpatialIndex.applyChanges(changes.nodes);

    for (const id of changes.connectors.removed) {
      this.connectorSpatialIndex.remove(id);
      this.routes.delete(id);
    }
    // 依附节点移动引发的路由失效已由 DocumentStore 并入 connectors.geometry
    this.updateConnectorRoutes(changes.connectors.geometry);
  }

  /**
   * 注入或移除文本测量器：注入后本地事务中的文本与宽度变更会在同一事务内派生节点尺寸
   */
  setTextMeasurer(measurer: TextMeasurer | null): void {
    this.textMeasurer = measurer;
    this.documentStore.coordinator.setPatchDerivation(
      measurer
        ? (doc, patches) => deriveTextLayoutPatches(doc, collectTextLayoutTargets(patches), measurer, this.nodeTypes)
        : null
    );
  }

  /**
   * 按当前测量器重新排版节点 (默认全部节点)，以非撤销的系统事务写回尺寸
   * 用于 Web 字体加载完成、测量器替换等测量基准变化的时机
   */
  relayoutText(nodeIds?: Iterable<string>): CanvasOperationRecord | null {
    if (!this.textMeasurer) return null;
    const targets = nodeIds ?? this.entityStore.getAllNodes().map((runtimeNode) => runtimeNode.entity.id);
    const patches = deriveTextLayoutPatches(
      this.getView() as CanvasDocument,
      targets,
      this.textMeasurer,
      this.nodeTypes
    );
    return this.documentStore.commit({ label: '重新排版文本', source: 'system', undoable: false, patches });
  }

  /**
   * 节点在世界坐标系中的轴对齐包围盒 (含自身与祖先旋转)；节点不存在时返回 undefined
   */
  getNodeWorldBounds(nodeId: string): RectBounds | undefined {
    const runtimeNode = this.entityStore.getNode(nodeId);
    if (!runtimeNode) return undefined;
    return computeNodeWorldBounds(runtimeNode.entity, this.entityStore.getWorldTransform(nodeId)!);
  }

  /**
   * 获取连线的当前路由；悬空连线 (两端无法定位) 返回 undefined
   */
  getConnectorRoute(connectorId: string): ComputedRoute | undefined {
    return this.routes.get(connectorId);
  }

  private updateConnectorRoutes(connectorIds: Iterable<string>): void {
    const resolveNode = (nodeId: string) => {
      const runtimeNode = this.entityStore.getNode(nodeId);
      return runtimeNode && { node: runtimeNode.entity, worldMatrix: this.entityStore.getWorldTransform(nodeId)! };
    };
    const entries: SpatialIndexEntry[] = [];
    for (const id of connectorIds) {
      const runtimeConnector = this.entityStore.getConnector(id);
      const route = runtimeConnector ? computeConnectorRoute(runtimeConnector.entity, resolveNode, this.routers) : null;
      if (route) {
        this.routes.set(id, route);
        entries.push([id, route.bounds]);
      } else {
        // 悬空连线不参与渲染与空间检索
        this.routes.delete(id);
        this.connectorSpatialIndex.remove(id);
      }
    }
    this.connectorSpatialIndex.load(entries);
  }
}

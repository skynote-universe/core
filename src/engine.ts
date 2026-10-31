/**
 * @file engine.ts
 * @description SkyNote 平台中立核心引擎门面 (SkyNoteEngine)
 *
 * 设计考量 (Why):
 * 1. 组装而非实现：文档 (DocumentStore)、会话 (SessionStore)、注册表、空间索引、输入与插件各自独立，引擎只负责接线。
 * 2. 派生状态统一维护：消费 DocumentChangeSet 增量维护空间索引与连线路由，并剔除选区中已删除的实体；
 *    每次提交只触达变更实体，与画布总规模无关。
 * 3. 平台中立：0 DOM / 0 Canvas 依赖，可运行于浏览器、Web Worker 或 Node.js；宿主能力由渲染器挂载时提供。
 * 4. 拾取归内核 (ADR-116)：节点与连线拾取都在这里，渲染器、插件与导出共享同一套判定。
 */

import type { Point, RectBounds } from './types/geometry';
import type { CanvasDocument, ViewportState } from './types/canvas';
import type { CanvasAssetMeta } from './types/asset';
import type { NodeEntity } from './types/node';
import type { ConnectorEndpointSnap, ConnectorEntity } from './types/connector';
import type { CanvasThemeConfig } from './types/theme';
import type { ComputedRoute } from './types/runtime';
import type { DocumentChangeSet } from './types/change-set';
import type { FontMeasurer } from './protocols/font-measurer.protocol';
import {
  AssetAdapterError,
  type AssetAdapter,
  type AssetUploadResult,
  type AssetTaskResult,
  type AssetTaskEvent,
  type AssetTaskInfo,
  type AssetTaskCancelReason,
  type AssetFailure
} from './protocols/asset.protocol';
import type { NodeClipboardPayload } from './serialization/document-schema';
import type { EntityIds } from './types/canvas';
import { clonePlainData } from './utils/clone';
import type { SkyNotePlugin } from './protocols/plugin.protocol';
import { DETACHED_CANVAS_HOST, type CanvasHost } from './protocols/host.protocol';
import {
  applyMatrix,
  computeNodeWorldBounds,
  distanceToPolyline,
  expandBounds,
  invertMatrix,
  isPointInBounds,
  isPointInPolygon,
  transformBounds
} from './utils/geometry';
import { compareHierarchicalNodes } from './layout/layer-order';
import { resolveConnectorLayerPlacement } from './layout/connector-layer';
import { compareFractionalIndex } from './utils/fractional-index';
import { resolveNodeStyle, type NodeTypeDefinition } from './protocols/node-type.protocol';
import { isNodeHiddenByOpacity } from './utils/node-opacity';
import { isEqual } from './utils/equality';
import {
  computeConnectorRoute,
  resolveConnectorStyle,
  type ConnectorRouteSource,
  type ResolvedEndpointNode
} from './routing/connector-route';
import { projectOntoOutline, resolveNodeAnchors, resolveNodeOutline } from './routing/outline';
import { DocumentStore } from './state/document-store';
import type { EntityReader } from './state/entity-store';
import { SessionStore, type ZoomRange } from './state/session-store';
import { NodeTypeRegistry } from './registry/node-type-registry';
import { ArrowMarkerRegistry } from './registry/arrow-marker-registry';
import { CursorRegistry } from './registry/cursor-registry';
import { ConnectorRouterRegistry } from './registry/connector-router-registry';
import { LayoutRegistry } from './registry/layout-registry';
import { ConnectorSourceRegistry } from './registry/connector-source-registry';
import {
  RTreeSpatialIndex,
  SceneSpatialIndex,
  type NodeSpatialQuery,
  type SpatialIndex,
  type SpatialIndexEntry
} from './spatial';
import { InputScopeManager } from './input/input-scope-manager';
import { PointerDispatcher } from './input/pointer-dispatcher';
import { ClipboardDispatcher } from './input/clipboard-dispatcher';
import { PluginManager } from './plugin/plugin-manager';
import { generateId } from './utils/id';

export interface SkyNoteEngineOptions {
  /** 初始画布文档 (默认创建空文档) */
  initialDoc?: CanvasDocument;
  /** 初始视口 (宿主可自行持久化上次浏览位置并在此恢复) */
  initialViewport?: Partial<ViewportState>;
  /** 视口缩放范围 (默认 DEFAULT_ZOOM_RANGE) */
  zoomRange?: ZoomRange;
  /** 画布主题 (默认浅色预设)，运行时通过 engine.session.setTheme() 切换 */
  theme?: CanvasThemeConfig;
  /** 字体测量器 (由渲染适配层提供)，缺省时不做文本驱动的自动尺寸 */
  fonts?: FontMeasurer;
  /** 媒体资产适配器：宿主负责上传、解析和释放实际资源 */
  assets?: AssetAdapter;
  /** 节点空间索引工厂 (默认 R-Tree)：分层索引为每个容器各建一个实例 (ADR-114)；测试借此观测索引调用 */
  createNodeSpatialIndex?: () => SpatialIndex;
}

/** 插件可用的连线派生能力：空间检索、路由、预览路由、端点吸附与吸附点 (只读，不改文档) */
export type ConnectorGeometryApi = Pick<
  SkyNoteEngine,
  | 'connectorSpatialIndex'
  | 'getConnectorRoute'
  | 'previewConnectorRoute'
  | 'snapConnectorEndpoint'
  | 'getConnectorAnchors'
>;

/** 按画面层叠点中的最上层实体 */
export type CanvasHit =
  | { readonly kind: 'node'; readonly node: Readonly<NodeEntity> }
  | { readonly kind: 'connector'; readonly connector: Readonly<ConnectorEntity> };

/** 节点精确拾取 (声明了 hitTest 的笔迹、路径等) 的默认屏幕像素容差 */
const NODE_HIT_TOLERANCE_PX = 6;
/** 连线拾取的默认屏幕像素容差 */
const CONNECTOR_HIT_TOLERANCE_PX = 6;
/** 粗筛时按此线宽放宽 (世界坐标)：比它更粗的线在线条中段仍能命中，只是边缘外侧的容差略少 */
const MAX_HIT_STROKE = 16;
/** 连线端点吸附到吸附点或边框的屏幕像素距离 */
const CONNECTOR_SNAP_PX = 8;

interface PendingAssetTask extends AssetTaskInfo {
  readonly controller: AbortController;
  reason?: AssetTaskCancelReason;
  targets?: ReadonlyMap<string, string>;
  committing?: boolean;
}

export class SkyNoteEngine {
  readonly nodeTypes = new NodeTypeRegistry();
  readonly arrowMarkers = new ArrowMarkerRegistry();
  /** 画布光标 (全部自绘)：插件与宿主应用可注册、覆盖与统一配色 */
  readonly cursors = new CursorRegistry();
  readonly routers = new ConnectorRouterRegistry();
  /** 布局 (ADR-130)：导图等树形布局的排列规则，内核在同一事务内据此派生成员位置 */
  readonly layouts = new LayoutRegistry();
  /** 派生连线来源 (ADR-130)：由文档数据推导、不存在于文档中的连线 */
  readonly connectorSources = new ConnectorSourceRegistry();
  readonly documentStore: DocumentStore;
  /** 本地会话状态：视口、选区与主题 */
  readonly session: SessionStore;
  readonly connectorSpatialIndex = new RTreeSpatialIndex();
  readonly inputScopes = new InputScopeManager();
  readonly pointer = new PointerDispatcher();
  readonly clipboard = new ClipboardDispatcher();
  readonly assets: AssetAdapter | undefined;
  readonly plugins: PluginManager;

  private readonly nodeSpatialIndex: SceneSpatialIndex;
  private currentHost: CanvasHost = DETACHED_CANVAS_HOST;
  private readonly unsubscribeDocument: () => void;
  private readonly unsubscribeNodeTypes: () => void;
  private readonly unsubscribeRouters: () => void;
  private readonly unsubscribeLayouts: () => void;
  /** 连线路由缓存：连线自身或两端节点几何变化时整体替换 */
  private readonly routes = new Map<string, ComputedRoute>();
  private isDestroyed = false;
  /** 任务集合负责销毁时统一取消；节点索引只用于快速找到冲突替换任务 */
  private readonly pendingAssetTasks = new Set<PendingAssetTask>();
  private readonly assetExecutions = new Set<Promise<void>>();
  private maintenanceDepth = 0;

  /**
   * 同步冻结写入口并取消资产任务。drained 等待真实执行结束，包含此前已返回取消的上传。
   * 宿主仍须排空自己的导入、导出、保存和显示任务，再交接库保护；resume 幂等。
   */
  beginMaintenance(): { readonly drained: Promise<void>; resume(): void } {
    if (this.isDestroyed) throw new Error('已销毁的引擎不能进入维护状态');
    const resumeWrites = this.documentStore.suspendWrites();
    this.maintenanceDepth++;
    this.session.setMaintenance(true);
    this.cancelPendingAssetTasks('maintenance');
    let resumed = false;
    return {
      drained: Promise.all([...this.assetExecutions]).then(() => undefined),
      resume: () => {
        if (resumed) return;
        resumed = true;
        this.maintenanceDepth--;
        if (this.maintenanceDepth === 0) this.session.setMaintenance(false);
        resumeWrites();
      }
    };
  }
  private readonly imageReplacementTasks = new Map<string, PendingAssetTask>();
  private readonly assetTaskListeners = new Set<(event: AssetTaskEvent) => void>();
  private contentEpoch = 0;

  get documentEpoch(): number {
    return this.contentEpoch;
  }

  onAssetTaskEvent(listener: (event: AssetTaskEvent) => void): () => void {
    this.assetTaskListeners.add(listener);
    return () => this.assetTaskListeners.delete(listener);
  }

  reportAssetFailure(operation: 'copy-nodes' | 'paste-nodes', failure: AssetFailure): void {
    this.emitAssetTaskEvent({ phase: 'rejected', operation, failure });
  }

  private emitAssetTaskEvent(event: AssetTaskEvent): void {
    for (const listener of this.assetTaskListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[SkyNote] 资产结果订阅失败:', error);
      }
    }
  }

  constructor(options?: SkyNoteEngineOptions) {
    this.assets = options?.assets;
    this.documentStore = new DocumentStore(options?.initialDoc, {
      nodeTypes: this.nodeTypes,
      layouts: this.layouts,
      connectorSources: this.connectorSources,
      fonts: options?.fonts,
      connectorEnds: (id) => {
        const points = this.routes.get(id)?.points;
        return points && [points[0], points[points.length - 1]];
      }
    });
    this.session = new SessionStore({
      viewport: options?.initialViewport,
      theme: options?.theme,
      zoomRange: options?.zoomRange
    });
    this.nodeSpatialIndex = new SceneSpatialIndex(
      this.entityStore,
      options?.createNodeSpatialIndex ?? (() => new RTreeSpatialIndex()),
      (node) => {
        const runtimeNode = this.entityStore.getNode(node.id);
        return this.nodeTypes.getValid(node, runtimeNode?.runtime.dataVersion)?.extent?.(node as NodeEntity);
      }
    );
    this.plugins = new PluginManager(this);

    this.nodeSpatialIndex.rebuild();
    this.updateConnectorRoutes(this.entityStore.getAllConnectors().map((runtime) => runtime.entity.id));

    // 空间索引、路由与选区都是文档的派生状态：实体删除 (本地、远端或撤销) 后选区不会残留失效 id
    this.unsubscribeDocument = this.documentStore.subscribe((_view, _record, changes) => {
      if (changes.contentReplaced) {
        this.contentEpoch++;
        this.nodeTypes.clearValidationCache();
        this.cancelPendingAssetTasks('document-replaced');
      } else {
        for (const id of changes.nodes.removed) this.nodeTypes.evictValidationCache(id);
      }
      if (this.imageReplacementTasks.size) {
        for (const id of changes.nodes.removed) this.checkReplacementTarget(id);
        for (const id of changes.nodes.data) this.checkReplacementTarget(id);
      }
      this.syncDerivedState(changes);
      this.session.pruneSelection(changes.nodes.removed, changes.connectors.removed);
      this.pruneSubtreeSelection();
    });
    // 节点类型晚于文档注册 (或被卸载) 时，重算对应类型节点的空间占据范围与依附连线路由
    this.unsubscribeNodeTypes = this.nodeTypes.onChange((type) => {
      const affectedNodes = new Set<string>();
      const affectedConnectors = new Set<string>();
      for (const { entity } of this.entityStore.getAllNodes()) {
        if (entity.nodeType !== type) continue;
        affectedNodes.add(entity.id);
        for (const connectorId of this.entityStore.getConnectorIdsOfNode(entity.id)) {
          affectedConnectors.add(connectorId);
        }
      }
      if (affectedNodes.size > 0) {
        this.nodeSpatialIndex.applyChanges({
          added: new Set(),
          removed: new Set(),
          geometry: affectedNodes,
          data: affectedNodes,
          reparented: new Set(),
          worldGeometry: affectedNodes
        });
      }
      if (affectedConnectors.size > 0) {
        this.updateConnectorRoutes(affectedConnectors);
      }
    });
    // 布局晚于文档注册 (或被卸载) 时重新排版
    this.unsubscribeLayouts = this.layouts.onChange(() => {
      this.documentStore.refreshLayouts();
      this.pruneSubtreeSelection();
    });
    // 路由器晚于文档注册时，重算对应类型的连线
    this.unsubscribeRouters = this.routers.onChange((routerId) => {
      this.updateConnectorRoutes(
        this.entityStore
          .getAllConnectors()
          .filter((runtime) => runtime.entity.connectorType === routerId)
          .map((runtime) => runtime.entity.id)
      );
    });
  }

  /** 实体运行时索引 (只读) */
  private pruneSubtreeSelection(): void {
    const selected = this.session.selectedSubtreeNodeIds;
    const kept = [...selected].filter((id) => this.documentStore.selectionGeometry.canSelectSubtree(id));
    if (kept.length !== selected.size) this.session.setSelection({ subtreeNodeIds: kept });
  }

  get entityStore(): EntityReader {
    return this.documentStore.entityStore;
  }

  /** 节点空间检索 (世界坐标，分层索引由引擎按变更集维护) */
  get spatialIndex(): NodeSpatialQuery {
    return this.nodeSpatialIndex;
  }

  /** 当前挂载的宿主能力 (渲染器挂载前为空实现) */
  get host(): CanvasHost {
    return this.currentHost;
  }

  use(plugin: SkyNotePlugin): this {
    this.plugins.use(plugin);
    return this;
  }

  /** 上传图片并在一个可撤销批次内登记资产与创建节点；失败或销毁时丢弃过期结果 */
  async insertImage(
    file: unknown,
    point: Point,
    fit: 'fill' | 'cover' | 'contain' | 'none' = 'cover',
    signal?: AbortSignal
  ): Promise<AssetTaskResult<string>> {
    const position = { ...point };
    return this.runAssetTask('insert-image', signal, async (task) => {
      if (!this.assets) throw new AssetAdapterError('unsupported-source', '没有配置图片资产适配器');
      const uploaded = await this.assets.upload(file, { signal: task.controller.signal });
      this.assertAssetTaskCurrent(task);
      const meta = createImageAssetMeta(uploaded);
      const assetId = meta.id;
      const nodeId = this.documentStore.createNodeWithAsset(
        {
          nodeType: 'image',
          x: position.x,
          y: position.y,
          origin: 'center',
          options: {
            assetId,
            fit,
            intrinsicWidth: uploaded.width ?? 0,
            intrinsicHeight: uploaded.height ?? 0
          },
          label: '插入图片'
        },
        meta
      );
      if (!nodeId) throw new AssetAdapterError('commit-rejected', '无法登记图片资产或创建图片节点');
      return nodeId;
    });
  }

  /** 上传并原子替换所选图片的资产引用，保留节点几何、样式与各自的显示方式 */
  async replaceImage(
    nodeIds: readonly string[],
    file: unknown,
    signal?: AbortSignal
  ): Promise<AssetTaskResult<readonly string[]>> {
    const targetIds = [...new Set(nodeIds)].filter((id) => {
      const node = this.documentStore.getNode(id) as (NodeEntity & { image?: { assetId?: unknown } }) | undefined;
      return !node?.locked && typeof node?.image?.assetId === 'string';
    });
    const references = targetIds.map(
      (id) => this.documentStore.getNode(id) as NodeEntity & { image: { assetId: string } }
    );
    const originalAssets = references.map((node) => node.image.assetId);
    return this.runAssetTask('replace-image', signal, async (task) => {
      if (!this.assets || targetIds.length === 0)
        throw new AssetAdapterError('unsupported-source', '没有可替换的图片或资产适配器');
      task.targets = new Map(targetIds.map((id, index) => [id, originalAssets[index]]));
      for (const id of targetIds) {
        const previous = this.imageReplacementTasks.get(id);
        if (previous) this.cancelAssetTask(previous, 'superseded');
        this.imageReplacementTasks.set(id, task);
      }
      const uploaded = await this.assets.upload(file, { signal: task.controller.signal });
      this.assertAssetTaskCurrent(task);
      if (
        targetIds.some((id, index) => {
          const node = this.documentStore.getNode(id) as (NodeEntity & { image?: { assetId: string } }) | undefined;
          return (
            !node ||
            node.locked ||
            node.image?.assetId !== originalAssets[index] ||
            this.imageReplacementTasks.get(id) !== task
          );
        })
      ) {
        this.cancelAssetTask(task, 'target-changed');
        this.assertAssetTaskCurrent(task);
      }
      const asset = createImageAssetMeta(uploaded);
      task.committing = true;
      if (!this.documentStore.replaceImagesWithAsset(targetIds, asset))
        throw new AssetAdapterError('commit-rejected', '图片替换提交被拒绝');
      return targetIds;
    });
  }

  async pasteNodesWithAssets(
    payload: NodeClipboardPayload,
    offset: Point,
    signal?: AbortSignal
  ): Promise<AssetTaskResult<EntityIds>> {
    const snapshot = clonePlainData(payload);
    const position = { ...offset };
    return this.runAssetTask('paste-nodes', signal, async (task) => {
      if (!this.assets?.checkReferences || !snapshot.source)
        throw new AssetAdapterError('unsupported-source', '当前资产库不支持此图片粘贴来源');
      const assetIds = new Set<string>();
      for (const node of snapshot.nodes) {
        const definition = this.nodeTypes.get(node.nodeType);
        if (!definition) throw new AssetAdapterError('invalid-reference', `未注册节点类型：${node.nodeType}`);
        for (const id of definition.assets?.collect(node) ?? []) assetIds.add(id);
      }
      if (
        assetIds.size !== Object.keys(snapshot.assets).length ||
        [...assetIds].some((id) => !Object.hasOwn(snapshot.assets, id))
      )
        throw new AssetAdapterError('invalid-reference', '剪贴板资产映射不完整');
      await this.assets.checkReferences({
        sourceScope: snapshot.source.referenceScope,
        assets: Object.values(snapshot.assets),
        signal: task.controller.signal
      });
      this.assertAssetTaskCurrent(task);
      const mapping = new Map([...assetIds].map((id) => [id, generateId('asset')]));
      const assets = Object.fromEntries([...mapping].map(([id, next]) => [next, { ...snapshot.assets[id], id: next }]));
      const reserved = new Set([
        'id',
        'type',
        'nodeType',
        'parentId',
        'x',
        'y',
        'width',
        'height',
        'rotation',
        'zIndex',
        'locked',
        'style',
        'data',
        'textBlocks',
        'textStyle',
        'layout',
        'layoutItem',
        'aspectLocked'
      ]);
      const nodes = snapshot.nodes.map((node) => {
        const contract = this.nodeTypes.get(node.nodeType)!.assets;
        if (!contract) return node;
        const fields = contract.remap(node, mapping);
        if (Object.keys(fields).some((key) => reserved.has(key)))
          throw new AssetAdapterError('invalid-reference', '资产映射改写了公共节点字段');
        const remapped = { ...node, ...fields };
        if (contract.collect(remapped).some((id) => !Object.hasOwn(assets, id)))
          throw new AssetAdapterError('invalid-reference', '节点资产引用映射无效');
        return remapped;
      });
      const result = this.documentStore.pasteEntities({ ...snapshot, nodes, assets }, position);
      if (!result.nodeIds.length && !result.connectorIds.length)
        throw new AssetAdapterError('commit-rejected', '粘贴提交被拒绝');
      return result;
    });
  }

  private assertAssetTaskCurrent(task: PendingAssetTask): void {
    if (this.isDestroyed) this.cancelAssetTask(task, 'engine-destroyed');
    else if (task.documentEpoch !== this.contentEpoch) this.cancelAssetTask(task, 'document-replaced');
    if (task.controller.signal.aborted) throw new Error('资产任务已取消');
  }

  private checkReplacementTarget(id: string): void {
    const task = this.imageReplacementTasks.get(id);
    if (!task || task.committing) return;
    const node = this.documentStore.getNode(id) as (NodeEntity & { image?: { assetId: string } }) | undefined;
    if (!node || node.locked || node.image?.assetId !== task.targets?.get(id))
      this.cancelAssetTask(task, 'target-changed');
  }

  private cancelAssetTask(task: PendingAssetTask, reason: AssetTaskCancelReason): void {
    if (task.controller.signal.aborted) return;
    task.reason = reason;
    task.controller.abort();
  }

  private async runAssetTask<T extends string | readonly string[] | EntityIds>(
    operation: AssetTaskInfo['operation'],
    signal: AbortSignal | undefined,
    run: (task: PendingAssetTask) => Promise<T>
  ): Promise<AssetTaskResult<T>> {
    if (this.maintenanceDepth > 0) return { status: 'cancelled', reason: 'maintenance' };
    const task: PendingAssetTask = {
      requestId: generateId('task'),
      operation,
      documentEpoch: this.contentEpoch,
      controller: new AbortController()
    };
    const info: AssetTaskInfo = { requestId: task.requestId, operation, documentEpoch: task.documentEpoch };
    this.pendingAssetTasks.add(task);
    const onAbort = () =>
      this.cancelAssetTask(task, signal?.reason === 'owner-disposed' ? 'owner-disposed' : 'caller-aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    this.emitAssetTaskEvent({ phase: 'started', task: info });
    let wake!: () => void;
    const aborted = new Promise<AssetTaskResult<T>>((resolve) => {
      wake = () => resolve({ status: 'cancelled', reason: task.reason ?? 'caller-aborted' });
    });
    task.controller.signal.addEventListener('abort', wake, { once: true });
    let result: AssetTaskResult<T>;
    try {
      this.assertAssetTaskCurrent(task);
      let finishExecution!: () => void;
      const completion = new Promise<void>((resolve) => {
        finishExecution = resolve;
      });
      this.assetExecutions.add(completion);
      const execution = (async () => {
        if (!this.assets?.protect) return run(task);
        const protection = await this.assets.protect({ purpose: operation, signal: task.controller.signal });
        try {
          this.assertAssetTaskCurrent(task);
          return await run(task);
        } finally {
          // 取消结果可先返回；实际异步执行结束后再释放，覆盖忽略取消的适配器。
          try {
            protection.release();
          } catch (error) {
            console.warn('[SkyNote:Assets] 宿主资产保护释放失败，不能更改已提交任务结果:', error);
          }
        }
      })().then(
        (value): AssetTaskResult<T> => ({ status: 'succeeded', value }),
        (error: unknown): AssetTaskResult<T> => {
          if (task.controller.signal.aborted) return { status: 'cancelled', reason: task.reason ?? 'caller-aborted' };
          return {
            status: 'failed',
            failure: {
              code: error instanceof AssetAdapterError ? error.code : 'unknown',
              detail: error instanceof Error ? error.message : '资产操作失败'
            }
          };
        }
      );
      void execution.then(() => {
        this.assetExecutions.delete(completion);
        finishExecution();
      });
      result = await Promise.race([execution, aborted]);
    } catch {
      result = { status: 'cancelled', reason: task.reason ?? 'caller-aborted' };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      task.controller.signal.removeEventListener('abort', wake);
      this.pendingAssetTasks.delete(task);
      for (const [id, owner] of this.imageReplacementTasks) if (owner === task) this.imageReplacementTasks.delete(id);
    }
    this.emitAssetTaskEvent({ phase: 'settled', task: info, result });
    return result;
  }

  private cancelPendingAssetTasks(reason: AssetTaskCancelReason = 'engine-destroyed'): void {
    for (const task of this.pendingAssetTasks) this.cancelAssetTask(task, reason);
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
   * 点选最上层节点：空间索引粗筛后按世界矩阵精判 (含自身与祖先旋转)，节点类型声明了 hitTest 或轮廓时按声明判断；
   * 落在裁剪型祖先 (画框) 之外的部分不可拾取；候选返回顺序与层叠无关，必须显式比较层级
   * @param accept 只在满足条件的节点中拾取 (如拖放时只找可接收子节点且不是被拖节点的容器)
   */
  hitTestNode(point: Point, accept?: (node: Readonly<NodeEntity>) => boolean): Readonly<NodeEntity> | undefined {
    const { entityStore, nodeTypes } = this;
    const tolerance = NODE_HIT_TOLERANCE_PX / this.session.viewport.zoom;
    const chainCache = new Map<string, Readonly<NodeEntity>[]>();
    const getNode = (id: string) => entityStore.getNode(id)?.entity;
    const containsPoint = (node: Readonly<NodeEntity>, definition: NodeTypeDefinition | undefined): boolean => {
      const local = applyMatrix(invertMatrix(entityStore.getWorldTransform(node.id)!), point.x, point.y);
      if (definition?.hitTest) {
        return definition.hitTest(node as NodeEntity, local, tolerance);
      }
      const inShape = definition?.outline
        ? isPointInPolygon(local, definition.outline(node as NodeEntity))
        : local.x >= 0 && local.x <= node.width && local.y >= 0 && local.y <= node.height;
      if (inShape) return true;
      if (definition?.extent) {
        const ext = definition.extent(node as NodeEntity);
        return local.x >= ext.left && local.x <= ext.right && local.y >= ext.top && local.y <= ext.bottom;
      }
      return false;
    };
    // 裁剪按容器外框判定 (框外标题不裁剪子节点)
    const isClippedOut = (node: Readonly<NodeEntity>) =>
      entityStore.getAncestorIds(node.id).some((id) => {
        const ancestor = getNode(id)!;
        if (!nodeTypes.get(ancestor.nodeType)?.clipChildren) return false;
        const local = applyMatrix(invertMatrix(entityStore.getWorldTransform(id)!), point.x, point.y);
        return local.x < 0 || local.y < 0 || local.x > ancestor.width || local.y > ancestor.height;
      });

    let top: Readonly<NodeEntity> | undefined;
    const candidateIds = this.nodeSpatialIndex.search(
      expandBounds({ left: point.x, top: point.y, right: point.x, bottom: point.y }, tolerance)
    );
    for (let i = 0; i < candidateIds.length; i++) {
      const runtimeNode = entityStore.getNode(candidateIds[i]);
      if (!runtimeNode) continue;
      const { entity: node, runtime } = runtimeNode;
      const definition = nodeTypes.getValid(node, runtime.dataVersion);
      if (isNodeHiddenByOpacity(node, definition) || (accept && !accept(node)) || !containsPoint(node, definition))
        continue;
      if (top && compareHierarchicalNodes(node, top, getNode, chainCache) < 0) continue;
      if (isClippedOut(node)) continue;
      top = node;
    }
    return top;
  }

  /**
   * 节点是否与世界坐标系中的选框真实相交 (框选粗筛后的几何精判)
   * 未声明 intersectsBounds 的节点类型已由空间索引完成外接矩形判定，直接返回 true。
   */
  intersectsNodeBounds(nodeId: string, worldBounds: RectBounds): boolean {
    const runtimeNode = this.entityStore.getNode(nodeId);
    if (!runtimeNode) return false;
    const { entity: node, runtime } = runtimeNode;
    const definition = this.nodeTypes.getValid(node, runtime.dataVersion);
    if (!definition?.intersectsBounds) return true;
    const localBounds = transformBounds(worldBounds, invertMatrix(this.entityStore.getWorldTransform(nodeId)!));
    return definition.intersectsBounds(node as NodeEntity, localBounds);
  }

  /**
   * 连线拾取：点在连线文字上，或到路由折线的距离不超过 tolerancePx 屏幕像素即命中
   * 经连线空间索引粗筛后按路由精判，离屏或尚未绘制的连线同样可拾取
   */
  hitTestConnector(point: Point, tolerancePx = CONNECTOR_HIT_TOLERANCE_PX): Readonly<ConnectorEntity> | undefined {
    const tolerance = tolerancePx / this.session.viewport.zoom;
    // 粗线按画出来的宽度命中：容差再加半个线宽 (粗筛按可能的最粗线宽放宽)
    const candidateIds = this.connectorSpatialIndex.search(
      expandBounds({ left: point.x, top: point.y, right: point.x, bottom: point.y }, tolerance + MAX_HIT_STROKE / 2)
    );
    // 连线索引只收录有路由的连线
    for (let i = candidateIds.length - 1; i >= 0; i--) {
      const connector = this.entityStore.getConnector(candidateIds[i])!.entity;
      const route = this.routes.get(connector.id)!;
      if (route.labels.some(({ bounds }) => isPointInBounds(point, bounds))) return connector;
      const width = resolveConnectorStyle(connector, this.routers).strokeWidth ?? 2;
      if (width === 0) continue;
      if (distanceToPolyline(point, route.points) <= tolerance + width / 2) return connector;
    }
    return undefined;
  }

  /**
   * 点中的最上层实体：节点与连线都命中时按画面层叠决定 (与渲染同一条层叠规则，见 resolveConnectorLayerPlacement)，
   * 盖在连线上面的无关节点优先，连线所连的节点与其内部永远在连线下方
   */
  hitTest(point: Point): CanvasHit | null {
    const connector = this.hitTestConnector(point);
    const node = this.hitTestNode(point);
    if (!connector) return node ? { kind: 'node', node } : null;
    if (node && this.isNodeAboveConnector(node, connector)) return { kind: 'node', node };
    return { kind: 'connector', connector };
  }

  /** 节点是否画在连线之上 */
  private isNodeAboveConnector(node: Readonly<NodeEntity>, connector: Readonly<ConnectorEntity>): boolean {
    const getNode = (id: string) => this.entityStore.getNode(id)?.entity as NodeEntity | undefined;
    const { anchorNode } = resolveConnectorLayerPlacement(connector, getNode);
    if (!anchorNode) {
      // 两端都是自由端：连线以自身索引与根层级节点排序
      const root = this.entityStore.getAncestorIds(node.id).at(-1);
      const top = root === undefined ? node : getNode(root)!;
      return compareFractionalIndex(top.zIndex, top.id, connector.zIndex, connector.id) > 0;
    }
    // 连线紧贴锚点上方：锚点本身及其内部都在连线下方
    if (node.id === anchorNode.id || this.entityStore.getAncestorIds(node.id).includes(anchorNode.id)) return false;
    return compareHierarchicalNodes(node, anchorNode, getNode) > 0;
  }

  /** 节点在世界坐标系中的轴对齐包围盒 (含自身与祖先旋转)；节点不存在时返回 undefined */
  getNodeWorldBounds(nodeId: string): RectBounds | undefined {
    const runtimeNode = this.entityStore.getNode(nodeId);
    return runtimeNode && computeNodeWorldBounds(runtimeNode.entity, this.entityStore.getWorldTransform(nodeId)!);
  }

  /**
   * 节点在世界坐标系中的实际占据范围包围盒 (含 extent 框外扩展、自身与祖先旋转)；
   * 常用于选区外框计算、工具栏定位与外部排他判定。节点不存在时返回 undefined
   */
  getNodeOccupiedBounds(nodeId: string): RectBounds | undefined {
    return this.nodeSpatialIndex.getBounds(nodeId);
  }

  /** 连线的当前路由；悬空连线 (两端无法定位) 返回 undefined */
  getConnectorRoute(connectorId: string): ComputedRoute | undefined {
    return this.routes.get(connectorId);
  }

  /** 尚未提交的连线 (如拖拽中的预览) 的路由，与已保存连线走同一套求解 */
  previewConnectorRoute(connector: Readonly<ConnectorRouteSource>): ComputedRoute | null {
    return computeConnectorRoute(connector, this.resolveEndpointNode, this.routers, this.documentStore.fonts);
  }

  /** 节点的连线吸附点 (世界坐标)，供连线工具提示；缺省为轮廓上、右、下、左四点 (见 resolveNodeAnchors) */
  getConnectorAnchors(nodeId: string): Point[] {
    const resolved = this.resolveEndpointNode(nodeId);
    if (!resolved) return [];
    return resolved.anchors.map(({ point }) => applyMatrix(resolved.worldMatrix, point.x, point.y));
  }

  /**
   * 指针处的连线端点：靠近吸附点 → 固定在吸附点；靠近边框 → 固定在边框上最近的一点；
   * 落在节点内部 → 浮动绑定整个节点；都不是 → 自由端
   * @param accept 只吸附满足条件的节点 (如不连到自身所在的连线之外的东西)
   */
  snapConnectorEndpoint(point: Point, accept?: (node: Readonly<NodeEntity>) => boolean): ConnectorEndpointSnap {
    const tolerance = CONNECTOR_SNAP_PX / this.session.viewport.zoom;
    const candidates = this.nodeSpatialIndex
      .search(expandBounds({ left: point.x, top: point.y, right: point.x, bottom: point.y }, tolerance))
      .map((id) => this.resolveEndpointNode(id)!)
      .filter(({ node }) => {
        const runtimeNode = this.entityStore.getNode(node.id);
        return (
          !isNodeHiddenByOpacity(node, this.nodeTypes.getValid(node, runtimeNode?.runtime.dataVersion)) &&
          (!accept || accept(node))
        );
      });

    const fixedAt = (resolved: ResolvedEndpointNode, local: Point, kind: 'anchor' | 'outline') => {
      const { node, worldMatrix } = resolved;
      return {
        endpoint: {
          nodeId: node.id,
          anchor: { x: node.width ? local.x / node.width : 0, y: node.height ? local.y / node.height : 0 }
        },
        point: applyMatrix(worldMatrix, local.x, local.y),
        kind
      };
    };
    let best: ConnectorEndpointSnap | null = null;
    let bestDistance = tolerance;
    for (const resolved of candidates) {
      for (const { point: local } of resolved.anchors) {
        const world = applyMatrix(resolved.worldMatrix, local.x, local.y);
        const distance = Math.hypot(world.x - point.x, world.y - point.y);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = fixedAt(resolved, local, 'anchor');
        }
      }
    }
    if (best) return best;
    for (const resolved of candidates) {
      const local = applyMatrix(invertMatrix(resolved.worldMatrix), point.x, point.y);
      const projected = projectOntoOutline(resolved.outline, local).point;
      const world = applyMatrix(resolved.worldMatrix, projected.x, projected.y);
      const distance = Math.hypot(world.x - point.x, world.y - point.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = fixedAt(resolved, projected, 'outline');
      }
    }
    if (best) return best;
    const node = this.hitTestNode(point, accept);
    if (node) {
      const m = this.entityStore.getWorldTransform(node.id)!;
      return { endpoint: { nodeId: node.id }, point: applyMatrix(m, node.width / 2, node.height / 2), kind: 'node' };
    }
    return { endpoint: { position: { x: point.x, y: point.y } }, point: { x: point.x, y: point.y }, kind: 'free' };
  }

  /** 销毁引擎并释放全部插件资源 */
  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.cancelPendingAssetTasks();
    this.unsubscribeDocument();
    this.unsubscribeNodeTypes();
    this.unsubscribeRouters();
    this.unsubscribeLayouts();
    this.plugins.destroy();
    this.routes.clear();
    this.pointer.clear();
    this.nodeSpatialIndex.clear();
    this.connectorSpatialIndex.clear();
    this.inputScopes.clear();
    this.clipboard.clear();
    this.nodeTypes.clear();
    this.arrowMarkers.clear();
    this.cursors.clear();
    this.routers.clear();
    this.documentStore.clearHistory();
    this.pendingAssetTasks.clear();
    this.imageReplacementTasks.clear();
    this.assetTaskListeners.clear();
  }

  /** 按变更集增量维护空间索引与连线路由，只触达本次提交涉及的实体 */
  private syncDerivedState(changes: DocumentChangeSet): void {
    const { nodes, connectors } = changes;
    // 分层索引：容器移动只更新容器自身的条目，后代无需任何处理
    this.nodeSpatialIndex.applyChanges(nodes);
    for (const id of connectors.removed) {
      this.connectorSpatialIndex.remove(id);
      this.routes.delete(id);
    }
    // 依附节点移动引发的路由失效已由 DocumentStore 并入 connectors.geometry
    const affected = new Set(connectors.geometry);
    // 节点样式变化 (如描边粗细) 影响线端位置：重算连在它上面的连线
    for (const id of nodes.data) {
      for (const connectorId of this.entityStore.getConnectorIdsOfNode(id)) affected.add(connectorId);
    }
    this.updateConnectorRoutes(affected);
  }

  /** 连线端点所需的节点信息：世界矩阵与轮廓 */
  private readonly resolveEndpointNode = (nodeId: string): ResolvedEndpointNode | undefined => {
    const runtimeNode = this.entityStore.getNode(nodeId);
    if (!runtimeNode) return undefined;
    const node = runtimeNode.entity;
    const definition = this.nodeTypes.getValid(node, runtimeNode.runtime.dataVersion);
    const outline = resolveNodeOutline(node, definition);
    return {
      node,
      worldMatrix: this.entityStore.getWorldTransform(nodeId)!,
      outline,
      anchors: resolveNodeAnchors(node, definition, outline),
      strokeWidth: resolveNodeStyle(node, definition).strokeWidth ?? 0
    };
  };

  private updateConnectorRoutes(connectorIds: Iterable<string>): void {
    const entries: SpatialIndexEntry[] = [];
    for (const id of connectorIds) {
      const runtimeConnector = this.entityStore.getConnector(id);
      const route =
        runtimeConnector &&
        computeConnectorRoute(
          runtimeConnector.entity,
          this.resolveEndpointNode,
          this.routers,
          this.documentStore.fonts
        );
      // 重算结果与原来一致 (如只改了节点填充色)：沿用原对象，下游按引用判定不必重画
      const previous = this.routes.get(id);
      if (route && previous && isSameRoute(previous, route)) continue;
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

/** 两次求解的路由在几何与文字排版上完全一致 */
function isSameRoute(a: ComputedRoute, b: ComputedRoute): boolean {
  if (a.pathData !== b.pathData || a.points.length !== b.points.length || a.labels.length !== b.labels.length) {
    return false;
  }
  if (a.points.some((p, i) => p.x !== b.points[i].x || p.y !== b.points[i].y)) return false;
  return a.labels.every((label, i) => {
    const other = b.labels[i];
    const [p, q] = [label.primitive, other.primitive];
    return (
      label.blockId === other.blockId &&
      p.runs === q.runs &&
      isEqual(p.style, q.style) &&
      label.bounds.left === other.bounds.left &&
      label.bounds.top === other.bounds.top &&
      label.bounds.right === other.bounds.right &&
      label.bounds.bottom === other.bounds.bottom
    );
  });
}

function createImageAssetMeta(uploaded: AssetUploadResult): CanvasAssetMeta {
  if (
    typeof uploaded.src !== 'string' ||
    uploaded.src.length === 0 ||
    typeof uploaded.mimeType !== 'string' ||
    !uploaded.mimeType.startsWith('image/') ||
    (uploaded.width !== undefined && (!Number.isFinite(uploaded.width) || uploaded.width <= 0)) ||
    (uploaded.height !== undefined && (!Number.isFinite(uploaded.height) || uploaded.height <= 0))
  )
    throw new TypeError('图片资产适配器返回了无效元数据');
  return {
    id: generateId('asset'),
    src: uploaded.src,
    mimeType: uploaded.mimeType,
    ...(uploaded.name !== undefined && { name: uploaded.name }),
    ...(uploaded.sizeBytes !== undefined && { sizeBytes: uploaded.sizeBytes }),
    ...(uploaded.width !== undefined && { width: uploaded.width }),
    ...(uploaded.height !== undefined && { height: uploaded.height }),
    ...(uploaded.sha256 !== undefined && { sha256: uploaded.sha256 })
  };
}

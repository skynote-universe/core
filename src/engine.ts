/**
 * @file engine.ts
 * @description SkyNote 平台中立核心引擎门面 (SkyNoteEngine)
 * 
 * 设计考量 (Why):
 * 1. 唯一门面，统筹枢纽：将 DocumentStore、EntityStore、NodeTypeRegistry、SpatialGridIndex、
 *    InputScopeManager、PluginManager 强力组装为一体。
 * 2. 空间拓扑与状态树自联动：消费 DocumentChangeSet 增量维护节点与连线两套空间索引，
 *    每次提交只触达变更实体，与画布总规模无关；渲染器与选框无需手动同步索引。
 * 4. 连线路由统一求解：几何失效的连线在此求解路由并缓存，连线空间索引取真实路由包围盒；
 *    渲染器、导出与插件经 getConnectorRoute 共享结果。路由器晚于文档注册时自动重算对应类型的连线。
 * 3. 严格遵循四大红线：全文 0 DOM / 0 Canvas 依赖，纯内存图灵完备，可无缝运行于浏览器、Web Worker 或 Node.js。
 */

import type { CanvasDocument, CanvasDocumentView, ViewportState } from './types/canvas';
import type { DocumentChangeSet } from './types/change-set';
import type { CanvasThemeConfig } from './types/theme';
import type { ComputedRoute } from './types/runtime';
import { computeNodeBounds } from './utils/geometry';
import { computeConnectorRoute } from './routing/connector-route';
import { DocumentStore, createEmptyCanvasDocument } from './state/document-store';
import type { EntityReader } from './state/entity-store';
import { SessionStore } from './state/session-store';
import { NodeTypeRegistry } from './registry/node-type-registry';
import { ArrowMarkerRegistry } from './registry/arrow-marker-registry';
import { ConnectorRouterRegistry } from './registry/connector-router-registry';
import { type SpatialIndex, type SpatialIndexEntry, createSpatialIndex } from './spatial';
import { InputScopeManager } from './input/input-scope-manager';
import { PointerDispatcher } from './input/pointer-dispatcher';
import { PluginManager } from './plugin/plugin-manager';
import type { SkyNotePlugin } from './protocols/plugin.protocol';

export interface SkyNoteEngineOptions {
  /** 初始画布文档 (默认创建空文档) */
  initialDoc?: CanvasDocument;
  /** 初始视口 (宿主可自行持久化上次浏览位置并在此恢复) */
  initialViewport?: Partial<ViewportState>;
  /** 画布主题 (默认浅色预设)，运行时通过 engine.session.setTheme() 显式切换 */
  theme?: CanvasThemeConfig;
  /** 自定义节点空间拓扑索引实现 (默认采用 R-Tree 层次包围盒) */
  spatialIndex?: SpatialIndex;
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
  readonly spatialIndex: SpatialIndex;
  readonly connectorSpatialIndex: SpatialIndex;
  readonly inputScopes: InputScopeManager;
  readonly pointer: PointerDispatcher;
  readonly plugins: PluginManager;

  private readonly unsubscribeDocument: () => void;
  private readonly unsubscribeRouters: () => void;
  /** 连线路由缓存：连线自身或两端节点几何变化时整体替换 */
  private readonly routes = new Map<string, ComputedRoute>();
  private isDestroyed = false;

  constructor(options?: SkyNoteEngineOptions) {
    const doc = options?.initialDoc ?? createEmptyCanvasDocument();

    this.documentStore = new DocumentStore(doc);
    this.entityStore = this.documentStore.entityStore;
    this.session = new SessionStore({ viewport: options?.initialViewport, theme: options?.theme });
    this.nodeTypes = new NodeTypeRegistry();
    this.arrowMarkers = new ArrowMarkerRegistry();
    this.routers = new ConnectorRouterRegistry();
    this.spatialIndex = options?.spatialIndex ?? createSpatialIndex('rtree');
    this.connectorSpatialIndex = options?.connectorSpatialIndex ?? createSpatialIndex('rtree');
    this.inputScopes = new InputScopeManager();
    this.pointer = new PointerDispatcher();

    this.plugins = new PluginManager({
      documentStore: this.documentStore,
      session: this.session,
      nodeTypeRegistry: this.nodeTypes,
      arrowMarkerRegistry: this.arrowMarkers,
      connectorRouterRegistry: this.routers,
      inputScopeManager: this.inputScopes,
      pointerDispatcher: this.pointer
    });

    this.spatialIndex.load(
      this.entityStore.getAllNodes().map((runtimeNode) => [runtimeNode.entity.id, computeNodeBounds(runtimeNode.entity)] as const)
    );
    this.updateConnectorRoutes(this.entityStore.getAllConnectors().map((runtimeConnector) => runtimeConnector.entity.id));

    // 空间索引与选区都是文档的派生状态，由引擎统一维护一致性：
    // 实体删除（本地、远端或撤销）后选区不会残留指向不存在实体的 id
    this.unsubscribeDocument = this.documentStore.subscribe((_view, _record, changes) => {
      this.syncSpatialIndexes(changes);
      this.session.pruneSelection(changes.nodes.removed, changes.connectors.removed);
    });
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
    this.spatialIndex.clear();
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
    for (const id of changes.nodes.removed) {
      this.spatialIndex.remove(id);
    }
    const nodeEntries: SpatialIndexEntry[] = [];
    for (const id of changes.nodes.geometry) {
      const runtimeNode = this.entityStore.getNode(id);
      if (runtimeNode) nodeEntries.push([id, computeNodeBounds(runtimeNode.entity)]);
    }
    this.spatialIndex.load(nodeEntries);

    for (const id of changes.connectors.removed) {
      this.connectorSpatialIndex.remove(id);
      this.routes.delete(id);
    }
    // 依附节点移动引发的路由失效已由 DocumentStore 并入 connectors.geometry
    this.updateConnectorRoutes(changes.connectors.geometry);
  }

  /**
   * 获取连线的当前路由；悬空连线 (两端无法定位) 返回 undefined
   */
  getConnectorRoute(connectorId: string): ComputedRoute | undefined {
    return this.routes.get(connectorId);
  }

  private updateConnectorRoutes(connectorIds: Iterable<string>): void {
    const resolveNode = (nodeId: string) => this.entityStore.getNode(nodeId)?.entity;
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

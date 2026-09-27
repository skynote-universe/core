/**
 * @file engine.ts
 * @description SkyNote 平台中立核心引擎门面 (SkyNoteEngine)
 * 
 * 设计考量 (Why):
 * 1. 唯一门面，统筹枢纽：将 DocumentStore、EntityStore、NodeTypeRegistry、SpatialGridIndex、
 *    InputScopeManager、PluginManager 强力组装为一体。
 * 2. 空间拓扑与状态树自联动：当节点几何变更或增删时，引擎自动维护 SpatialGridIndex 包围盒，
 *    彻底消除渲染器与选框在上层手动同步索引的心智负担。
 * 3. 严格遵循四大红线：全文 0 DOM / 0 Canvas 依赖，纯内存图灵完备，可无缝运行于浏览器、Web Worker 或 Node.js。
 */

import type { CanvasDocument, CanvasDocumentView } from './types/canvas';
import { DocumentStore, createEmptyCanvasDocument } from './state/document-store';
import { EntityStore } from './state/entity-store';
import { NodeTypeRegistry } from './registry/node-type-registry';
import { ArrowMarkerRegistry } from './registry/arrow-marker-registry';
import { ConnectorRouterRegistry } from './registry/connector-router-registry';
import { type SpatialIndex, createSpatialIndex } from './spatial';
import { InputScopeManager } from './input/input-scope-manager';
import { PointerDispatcher } from './input/pointer-dispatcher';
import { PluginManager } from './plugin/plugin-manager';
import type { SkyNotePlugin } from './protocols/plugin.protocol';

export interface SkyNoteEngineOptions {
  /** 初始画布文档 (默认创建空文档) */
  initialDoc?: CanvasDocument;
  /** 自定义空间拓扑索引实现 (默认采用 R-Tree 层次包围盒) */
  spatialIndex?: SpatialIndex;
}

export class SkyNoteEngine {
  readonly documentStore: DocumentStore;
  readonly entityStore: EntityStore;
  readonly nodeTypes: NodeTypeRegistry;
  readonly arrowMarkers: ArrowMarkerRegistry;
  readonly routers: ConnectorRouterRegistry;
  readonly spatialIndex: SpatialIndex;
  readonly inputScopes: InputScopeManager;
  readonly pointer: PointerDispatcher;
  readonly plugins: PluginManager;

  /** 引擎已索引节点的几何版本号缓存 (Map<nodeId, geomVersion>，兼做 O(1) 差集索引) */
  private readonly indexedGeomVersions = new Map<string, number>();
  private isDestroyed = false;

  constructor(options?: SkyNoteEngineOptions) {
    const doc = options?.initialDoc ?? createEmptyCanvasDocument();

    this.documentStore = new DocumentStore(doc);
    this.entityStore = this.documentStore.entityStore;
    this.nodeTypes = new NodeTypeRegistry();
    this.arrowMarkers = new ArrowMarkerRegistry();
    this.routers = new ConnectorRouterRegistry();
    this.spatialIndex = options?.spatialIndex ?? createSpatialIndex('rtree');
    this.inputScopes = new InputScopeManager();
    this.pointer = new PointerDispatcher();

    this.plugins = new PluginManager({
      documentStore: this.documentStore,
      nodeTypeRegistry: this.nodeTypes,
      arrowMarkerRegistry: this.arrowMarkers,
      connectorRouterRegistry: this.routers,
      inputScopeManager: this.inputScopes,
      pointerDispatcher: this.pointer
    });

    // 初始同步空间索引
    this.syncSpatialIndexFromView(this.documentStore.getView());

    // 状态变更与空间索引自动联动
    this.documentStore.subscribe((view) => {
      if (this.isDestroyed) return;
      this.syncSpatialIndexFromView(view);
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

    this.plugins.destroy();
    this.pointer.clear();
    this.spatialIndex.clear();
    this.inputScopes.clear();
    this.nodeTypes.clear();
    this.arrowMarkers.clear();
    this.routers.clear();
    this.indexedGeomVersions.clear();
    this.documentStore.clearHistory();
  }

  /**
   * 视图与空间拓扑索引自联动
   * 
   * 性能军规守卫 (AGENTS.md):
   * 1. 双版本号守卫：仅当节点几何发生真实位移/尺寸形变 (geomVersion 递增) 时才更新空间索引！
   *    文本、背景色、边框样式或纯视口缩放时，数万个无几何形变的节点 0 耗时跳过。
   * 2. O(1) 差集删除：通过 Map 键集合毫秒级定位已删除节点，杜绝向树发送 [-Infinity, Infinity] 深度递归。
   */
  private syncSpatialIndexFromView(view: CanvasDocumentView): void {
    const activeIds = new Set<string>();
    const nodes = view.content.nodes;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      activeIds.add(node.id);

      // 双版本号守卫拦截
      const runtimeNode = this.entityStore.getNode(node.id);
      const currentGeomVer = runtimeNode?.runtime.geomVersion ?? 0;
      const lastGeomVer = this.indexedGeomVersions.get(node.id);

      if (lastGeomVer !== currentGeomVer) {
        this.spatialIndex.update(node.id, {
          left: node.x,
          top: node.y,
          right: node.x + node.width,
          bottom: node.y + node.height,
          width: node.width,
          height: node.height
        });
        this.indexedGeomVersions.set(node.id, currentGeomVer);
      }
    }

    // 剔除已删除的节点：基于 Map 差集精准定位与释放
    if (this.indexedGeomVersions.size > activeIds.size) {
      for (const id of this.indexedGeomVersions.keys()) {
        if (!activeIds.has(id)) {
          this.spatialIndex.remove(id);
          this.indexedGeomVersions.delete(id);
        }
      }
    }
  }
}

/**
 * @file plugin-manager.ts
 * @description 插件生命周期与受控沙盒管理器 (PluginManager)
 *
 * 设计考量 (Why):
 * 1. 严格落实单一职责原则 (SRP)：高频指针与手势交互已彻底抽离归位于 PointerDispatcher。
 *    PluginManager 纯粹聚焦于插件的安装、上下文注入 (PluginContext)、依赖解耦与彻底销毁。
 * 2. 插件绝对零感知 (AGENTS.md 红线)：通过 CanvasPluginContext 受控暴露 API，严禁插件探测其他插件的私有状态。
 * 3. 自动化注销拦截：插件安装时声明的指针交互钩子与作用域，在 unmount() 时由沙盒统一全自动释放，杜绝内存静默泄漏。
 */

import type { CanvasPluginContext, SkyNotePlugin } from '../protocols/plugin.protocol';
import type { NodeTypeDefinition } from '../protocols/node-type.protocol';
import type { ArrowMarkerDefinition } from '../protocols/arrow-marker.protocol';
import type { ConnectorRouterDefinition } from '../protocols/connector-router.protocol';
import type { InputScope } from '../protocols/input-scope.protocol';
import type { CommitOperationOptions, CanvasOperationRecord } from '../types/operation';
import type { CanvasDocumentView } from '../types/canvas';
import type { DocumentStore } from '../state/document-store';
import type { SessionStore, SessionChange } from '../state/session-store';
import type { DocumentChangeSet } from '../types/change-set';
import type { NodeTypeRegistry } from '../registry/node-type-registry';
import type { ArrowMarkerRegistry } from '../registry/arrow-marker-registry';
import type { ConnectorRouterRegistry } from '../registry/connector-router-registry';
import type { InputScopeManager } from '../input/input-scope-manager';
import type { PointerDispatcher, PointerHooks } from '../input/pointer-dispatcher';
import type { EntityReader } from '../state/entity-store';
import type { NodeSpatialQuery } from '../spatial/scene-spatial-index';
import type { CanvasHost, CanvasHostServices, OverlayChannel, OverlayOptions } from '../protocols/overlay.protocol';
import type { CanvasPrimitive } from '../protocols/primitives.protocol';
import type { SystemCursor } from '../protocols/host-bridge.protocol';
import type { NodeEntity } from '../types/node';
import type { Point } from '../types/canvas';

export interface PluginManagerDependencies {
  documentStore: DocumentStore;
  session: SessionStore;
  nodeTypeRegistry: NodeTypeRegistry;
  arrowMarkerRegistry: ArrowMarkerRegistry;
  connectorRouterRegistry: ConnectorRouterRegistry;
  inputScopeManager: InputScopeManager;
  pointerDispatcher: PointerDispatcher;
  entities: EntityReader;
  spatial: NodeSpatialQuery;
  hitTestNode: (point: Point) => Readonly<NodeEntity> | undefined;
  /** 当前挂载的宿主 (渲染器挂载前为空实现)；每次调用时读取，插件无需关心挂载先后 */
  getHost: () => CanvasHost;
}

/** 覆盖层转发：记录插件用过的会话，插件卸载时一并清除，避免残留图元 */
class TrackedOverlay implements OverlayChannel {
  private readonly sessions = new Set<string>();

  constructor(private readonly getHost: () => CanvasHost) {}

  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    this.sessions.add(sessionId);
    this.getHost().overlay.setPrimitives(sessionId, primitives, options);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.getHost().overlay.clear(sessionId);
  }

  dispose(): void {
    for (const sessionId of this.sessions) this.getHost().overlay.clear(sessionId);
    this.sessions.clear();
  }
}

/** 插件可用的宿主能力：每次调用读取当前宿主，插件无需关心渲染器挂载先后 */
class PluginHostServices implements CanvasHostServices {
  readonly overlay: TrackedOverlay;

  constructor(private readonly getHost: () => CanvasHost) {
    this.overlay = new TrackedOverlay(getHost);
  }

  setCursor(cursor: SystemCursor): void {
    this.getHost().bridge.setCursor(cursor);
  }

  capturePointer(pointerId: number): void {
    this.getHost().bridge.capturePointer(pointerId);
  }

  releasePointer(pointerId: number): void {
    this.getHost().bridge.releasePointer(pointerId);
  }

  getViewportSize(): { width: number; height: number } {
    return this.getHost().bridge.getViewportRect();
  }

  dispose(): void {
    this.overlay.dispose();
  }
}

export class PluginManager {
  private readonly plugins = new Map<string, SkyNotePlugin>();
  /** 插件自注册资源的清理回收袋 (插件 ID -> 清理函数集合) */
  private readonly cleanupBags = new Map<string, Array<() => void>>();

  constructor(private readonly deps: PluginManagerDependencies) {}

  /**
   * 安装并激活插件
   */
  use(plugin: SkyNotePlugin): void {
    if (!plugin || !plugin.id) {
      throw new Error('[PluginManager] 安装失败：插件缺少有效 id 标识');
    }

    if (this.plugins.has(plugin.id)) {
      console.warn(`[PluginManager] 插件 "${plugin.id}" 已安装，先卸载原插件`);
      this.remove(plugin.id);
    }

    this.plugins.set(plugin.id, plugin);
    const cleanupList: Array<() => void> = [];
    this.cleanupBags.set(plugin.id, cleanupList);

    // 若插件自身声明了指针交互钩子，自动注册到输入子系统并在卸载时自动解绑
    if (
      plugin.onPointerDown ||
      plugin.onPointerMove ||
      plugin.onPointerUp ||
      plugin.onPointerCancel ||
      plugin.onWheel
    ) {
      const unbindPointer = this.deps.pointerDispatcher.register(plugin.id, {
        onPointerDown: plugin.onPointerDown?.bind(plugin),
        onPointerMove: plugin.onPointerMove?.bind(plugin),
        onPointerUp: plugin.onPointerUp?.bind(plugin),
        onPointerCancel: plugin.onPointerCancel?.bind(plugin),
        onWheel: plugin.onWheel?.bind(plugin)
      });
      cleanupList.push(unbindPointer);
    }

    const pluginContext = this.createPluginContext(plugin.id, cleanupList);

    try {
      plugin.install(pluginContext);
    } catch (err) {
      console.error(`[PluginManager] 插件 "${plugin.id}" 安装时发生异常:`, err);
      this.remove(plugin.id);
      throw err;
    }
  }

  /**
   * 卸载并注销指定插件
   */
  remove(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    // 1. 自动执行沙盒收集的全部资源解绑 (包括自动注册的指针事件)
    const cleanups = this.cleanupBags.get(pluginId);
    if (cleanups) {
      for (let i = 0; i < cleanups.length; i++) {
        try {
          cleanups[i]();
        } catch (err) {
          console.error(`[PluginManager] 插件 "${pluginId}" 资源清理异常:`, err);
        }
      }
      this.cleanupBags.delete(pluginId);
    }

    // 2. 触发插件自身的卸载钩子
    try {
      plugin.unmount?.();
    } catch (err) {
      console.error(`[PluginManager] 插件 "${pluginId}" 卸载时发生异常:`, err);
    }

    return this.plugins.delete(pluginId);
  }

  /**
   * 获取指定插件实例
   */
  get(pluginId: string): SkyNotePlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * 获取所有已安装插件
   */
  getAll(): readonly SkyNotePlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 销毁全部插件
   */
  destroy(): void {
    const pluginIds = Array.from(this.plugins.keys());
    for (let i = 0; i < pluginIds.length; i++) {
      this.remove(pluginIds[i]);
    }
    this.plugins.clear();
    this.cleanupBags.clear();
  }

  /**
   * 构建插件专属的受控上下文，所有自注册资源自动纳入沙盒生命周期管控
   */
  private createPluginContext(pluginId: string, cleanupList: Array<() => void>): CanvasPluginContext {
    const host = new PluginHostServices(this.deps.getHost);
    cleanupList.push(() => host.dispose());
    return {
      getDocument: (): CanvasDocumentView => {
        return this.deps.documentStore.getView();
      },
      getNode: (id: string) => {
        return this.deps.documentStore.getNode(id);
      },
      getConnector: (id: string) => {
        return this.deps.documentStore.getConnector(id);
      },
      commitOperation: <TPayload>(options: CommitOperationOptions<TPayload>): CanvasOperationRecord | null => {
        return this.deps.documentStore.commit(options);
      },
      session: this.deps.session,
      document: this.deps.documentStore,
      entities: this.deps.entities,
      spatial: this.deps.spatial,
      hitTestNode: this.deps.hitTestNode,
      host,
      onDocumentChange: (
        listener: (changes: DocumentChangeSet, record: CanvasOperationRecord) => void
      ): (() => void) => {
        const unbind = this.deps.documentStore.subscribe((_view, record, changes) => listener(changes, record));
        cleanupList.push(unbind);
        return unbind;
      },
      onSessionChange: (listener: (change: SessionChange) => void): (() => void) => {
        const unbind = this.deps.session.subscribe(listener);
        cleanupList.push(unbind);
        return unbind;
      },
      registerNodeType: (definition: NodeTypeDefinition): void => {
        this.deps.nodeTypeRegistry.register(definition);
        cleanupList.push(() => {
          this.deps.nodeTypeRegistry.unregister(definition.type);
        });
      },
      registerArrowMarker: (definition: ArrowMarkerDefinition): void => {
        this.deps.arrowMarkerRegistry.register(definition);
        cleanupList.push(() => {
          this.deps.arrowMarkerRegistry.unregister(definition.id);
        });
      },
      registerConnectorRouter: (definition: ConnectorRouterDefinition): void => {
        this.deps.connectorRouterRegistry.register(definition);
        cleanupList.push(() => {
          this.deps.connectorRouterRegistry.unregister(definition.id);
        });
      },
      registerInputScope: (scope: InputScope): (() => void) => {
        this.deps.inputScopeManager.pushScope(scope);
        const unbind = () => {
          this.deps.inputScopeManager.popScope(scope.id);
        };
        cleanupList.push(unbind);
        return unbind;
      },
      registerPointerHooks: (hooks: PointerHooks, priority = 0): (() => void) => {
        const id = `${pluginId}_hook_${Math.random().toString(36).slice(2, 9)}`;
        const unbind = this.deps.pointerDispatcher.register(id, hooks, priority);
        cleanupList.push(unbind);
        return unbind;
      }
    };
  }
}

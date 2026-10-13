/**
 * @file plugin-manager.ts
 * @description 插件生命周期与受控上下文 (PluginManager)
 *
 * 设计考量 (Why):
 * 1. 受控上下文：每个插件拿到自己的 PluginContext，只暴露协议约定的能力，拿不到引擎本身。
 * 2. 成对释放：经上下文注册的节点类型、作用域、指针钩子、订阅与覆盖层会话都记入该插件的清理列表，
 *    卸载时统一释放，插件无需自己记账。
 */

import type { CanvasPluginContext, SkyNotePlugin } from '../protocols/plugin.protocol';
import type { NodeTypeDefinition } from '../protocols/node-type.protocol';
import type { ArrowMarkerDefinition } from '../protocols/arrow-marker.protocol';
import type { CursorDefinition } from '../protocols/cursor.protocol';
import type { ConnectorRouterDefinition } from '../protocols/connector-router.protocol';
import type { LayoutDefinition, LayoutReader } from '../protocols/layout.protocol';
import type { DerivedConnectorSource } from '../protocols/connector-source.protocol';
import type { InputScope } from '../protocols/input-scope.protocol';
import type {
  CanvasHost,
  OverlayChannel,
  OverlayOptions,
  CanvasCursor,
  TextInputHandler,
  TextInputSession
} from '../protocols/host.protocol';
import type { CanvasPrimitive } from '../protocols/primitives.protocol';
import type { Point } from '../types/geometry';
import type { NodeEntity } from '../types/node';
import type { ConnectorEntity } from '../types/connector';
import type { CanvasOperationRecord } from '../types/operation';
import type { DocumentChangeSet } from '../types/change-set';
import type { DocumentApi } from '../state/document-store';
import type { EntityReader } from '../state/entity-store';
import type { SessionController, SessionChange } from '../state/session-store';
import type { NodeSpatialQuery } from '../spatial/scene-spatial-index';
import type { CanvasHit, ConnectorGeometryApi } from '../engine';
import type { PointerHooks } from '../input/pointer-dispatcher';
import type { ClipboardHandler } from '../input/clipboard-dispatcher';
import type { NodeTypeReader } from '../registry/node-type-registry';
import type { SkyNoteEngine } from '../engine';

/**
 * 插件的宿主能力：每次调用读取引擎当前宿主 (插件无需关心渲染器挂载先后)，
 * 并记录用过的覆盖层会话与文字输入会话，插件卸载时一并清除，避免残留图元与悬空的输入通道
 */
class PluginHost implements CanvasHost, OverlayChannel {
  private readonly sessions = new Set<string>();
  private textInput: TextInputSession | null = null;

  constructor(private readonly engine: SkyNoteEngine) {}

  get overlay(): OverlayChannel {
    return this;
  }

  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    this.sessions.add(sessionId);
    this.engine.host.overlay.setPrimitives(sessionId, primitives, options);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.engine.host.overlay.clear(sessionId);
  }

  setCursor(cursor: CanvasCursor): void {
    this.engine.host.setCursor(cursor);
  }

  capturePointer(pointerId: number): void {
    this.engine.host.capturePointer(pointerId);
  }

  releasePointer(pointerId: number): void {
    this.engine.host.releasePointer(pointerId);
  }

  openTextInput(handler: TextInputHandler): TextInputSession {
    this.textInput?.close();
    const session = this.engine.host.openTextInput(handler);
    this.textInput = session;
    return session;
  }

  dispose(): void {
    for (const sessionId of this.sessions) this.engine.host.overlay.clear(sessionId);
    this.sessions.clear();
    this.textInput?.close();
    this.textInput = null;
  }
}

/** 单个插件的受控上下文，自带清理列表 */
class PluginContext implements CanvasPluginContext {
  readonly document: DocumentApi;
  readonly entities: EntityReader;
  readonly spatial: NodeSpatialQuery;
  readonly connectors: ConnectorGeometryApi;
  readonly nodeTypes: NodeTypeReader;
  readonly layouts: LayoutReader;
  readonly session: SessionController;
  readonly host: PluginHost;
  private readonly cleanups: Array<() => void> = [];
  private hookCount = 0;

  constructor(
    private readonly engine: SkyNoteEngine,
    private readonly pluginId: string
  ) {
    this.document = engine.documentStore;
    this.entities = engine.entityStore;
    this.spatial = engine.spatialIndex;
    this.connectors = engine;
    this.nodeTypes = engine.nodeTypes;
    this.layouts = {
      get: (id) => engine.layouts.get(id),
      onChange: (listener) => this.track(engine.layouts.onChange(listener))
    };
    this.session = engine.session;
    const assetController = new AbortController();
    this.cleanups.push(() => assetController.abort('owner-disposed'));
    this.insertImage = (file, point) => engine.insertImage(file, point, 'cover', assetController.signal);
    this.pasteNodesWithAssets = (payload, offset) =>
      engine.pasteNodesWithAssets(payload, offset, assetController.signal);
    this.host = new PluginHost(engine);
    this.cleanups.push(() => this.host.dispose());
  }

  readonly insertImage: CanvasPluginContext['insertImage'];
  readonly pasteNodesWithAssets: CanvasPluginContext['pasteNodesWithAssets'];
  get assetReferenceScope(): string | undefined {
    return this.engine.assets?.referenceScope;
  }
  reportAssetFailure(
    operation: 'copy-nodes' | 'paste-nodes',
    failure: Parameters<CanvasPluginContext['reportAssetFailure']>[1]
  ): void {
    this.engine.reportAssetFailure(operation, failure);
  }

  hitTestNode(point: Point, accept?: (node: Readonly<NodeEntity>) => boolean): Readonly<NodeEntity> | undefined {
    return this.engine.hitTestNode(point, accept);
  }

  hitTestConnector(point: Point, tolerancePx?: number): Readonly<ConnectorEntity> | undefined {
    return this.engine.hitTestConnector(point, tolerancePx);
  }

  hitTest(point: Point): CanvasHit | null {
    return this.engine.hitTest(point);
  }

  onDocumentChange(listener: (changes: DocumentChangeSet, record: CanvasOperationRecord) => void): () => void {
    return this.track(this.engine.documentStore.subscribe((_view, record, changes) => listener(changes, record)));
  }

  onSessionChange(listener: (change: SessionChange) => void): () => void {
    return this.track(this.engine.session.subscribe(listener));
  }

  registerNodeType(definition: NodeTypeDefinition): void {
    this.engine.nodeTypes.register(definition);
    this.cleanups.push(() => this.engine.nodeTypes.unregister(definition.type));
  }

  registerArrowMarker(definition: ArrowMarkerDefinition): void {
    this.engine.arrowMarkers.register(definition);
    this.cleanups.push(() => this.engine.arrowMarkers.unregister(definition.id));
  }

  registerConnectorRouter(definition: ConnectorRouterDefinition): void {
    this.engine.routers.register(definition);
    this.cleanups.push(() => this.engine.routers.unregister(definition.id));
  }

  registerLayout(definition: LayoutDefinition): void {
    this.engine.layouts.register(definition);
    this.cleanups.push(() => this.engine.layouts.unregister(definition));
  }

  registerConnectorSource(source: DerivedConnectorSource): void {
    this.engine.connectorSources.register(source);
    this.cleanups.push(() => this.engine.connectorSources.unregister(source));
  }

  refreshConnectorSource(sourceId: string): void {
    this.engine.connectorSources.refresh(sourceId);
  }

  registerCursor(definition: CursorDefinition): void {
    this.cleanups.push(this.engine.cursors.register(definition));
  }

  registerInputScope(scope: InputScope): () => void {
    this.engine.inputScopes.pushScope(scope);
    return this.track(() => this.engine.inputScopes.popScope(scope.id));
  }

  registerPointerHooks(hooks: PointerHooks, priority = 0): () => void {
    return this.track(this.engine.pointer.register(`${this.pluginId}#${++this.hookCount}`, hooks, priority));
  }

  registerClipboardHandler(handler: ClipboardHandler, priority = 0): () => void {
    return this.track(this.engine.clipboard.register(handler, priority));
  }

  /** 按注册的逆序释放：后注册的资源可能依赖先注册的 */
  dispose(): void {
    for (let i = this.cleanups.length - 1; i >= 0; i--) {
      try {
        this.cleanups[i]();
      } catch (err) {
        console.error(`[SkyNote:PluginManager] 插件 "${this.pluginId}" 资源清理异常:`, err);
      }
    }
    this.cleanups.length = 0;
  }

  /** 记入清理列表并原样返回解绑函数 (插件提前解绑时重复调用无副作用) */
  private track(unbind: () => void): () => void {
    this.cleanups.push(unbind);
    return unbind;
  }
}

export class PluginManager {
  private readonly installed = new Map<string, { plugin: SkyNotePlugin; context: PluginContext }>();

  constructor(private readonly engine: SkyNoteEngine) {}

  /** 安装插件；同 id 的已安装插件先卸载 */
  use(plugin: SkyNotePlugin): void {
    if (this.installed.has(plugin.id)) this.remove(plugin.id);
    const context = new PluginContext(this.engine, plugin.id);
    this.installed.set(plugin.id, { plugin, context });
    try {
      plugin.install(context);
    } catch (err) {
      this.remove(plugin.id);
      throw err;
    }
  }

  /** 卸载插件：先释放经上下文注册的资源，再调用插件自身的 unmount */
  remove(pluginId: string): boolean {
    const entry = this.installed.get(pluginId);
    if (!entry) return false;
    this.installed.delete(pluginId);
    entry.context.dispose();
    try {
      entry.plugin.unmount?.();
    } catch (err) {
      console.error(`[SkyNote:PluginManager] 插件 "${pluginId}" 卸载时发生异常:`, err);
    }
    return true;
  }

  get(pluginId: string): SkyNotePlugin | undefined {
    return this.installed.get(pluginId)?.plugin;
  }

  destroy(): void {
    for (const pluginId of [...this.installed.keys()]) this.remove(pluginId);
  }
}

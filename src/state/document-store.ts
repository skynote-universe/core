/**
 * @file document-store.ts
 * @description 画布文档状态中心：唯一的写入口 (事务、语义命令、新建节点、文本自动尺寸) 与增量变更集广播
 *
 * 设计考量 (Why):
 * 1. 只读投影：对外暴露的文档在类型上是深度只读的，写入只能经事务提交。
 * 2. 语义命令：移动、删除、改挂、层级、新建都在这里封装为规范补丁并走同一提交入口，自动满足守卫、派生排版与撤销合并。
 * 3. 增量变更集：每次提交把补丁路径按实体语义归类为 DocumentChangeSet 广播一次，下游 (索引、渲染、插件) 全部增量消费。
 * 4. 文本驱动的自动尺寸：注入字体测量器后，本地事务中的文本或宽度变更在同一事务内派生尺寸补丁，撤销时一并回退。
 */

import type {
  CanvasContent,
  CanvasDocument,
  CanvasDocumentView,
  EntityIds,
  EntityRefs,
  FractionalIndex
} from '../types/canvas';
import type { NodeEntity } from '../types/node';
import type { Matrix2D, Point } from '../types/geometry';
import type { ConnectorEndpoint, ConnectorEntity, ConnectorStyle } from '../types/connector';
import type {
  CanvasHistoryEntry,
  CanvasOperationRecord,
  CommitOperationOptions,
  CanvasPatch
} from '../types/operation';
import type { DocumentChangeSet, EntityChanges } from '../types/change-set';
import { isAspectLocked, type CreateNodeRequest, type ResizeHandle } from '../protocols/node-type.protocol';
import type { WorldFrame } from '../utils/geometry';
import type { FontMeasurer } from '../protocols/font-measurer.protocol';
import { EntityStore, type EntityReader, type EntitySyncResult } from './entity-store';
import { OperationCoordinator, type HistoryChangeListener } from '../operation/coordinator';
import { normalizePatchPath } from '../operation/patch-path';
import { NodeTypeRegistry } from '../registry/node-type-registry';
import { clonePlainData } from '../utils/clone';
import { generateId } from '../utils/id';
import { findCommitViolation, findInlineMediaUrl } from './commit-guards';
import { NODE_CLIPBOARD_KIND, type NodeClipboardPayload } from '../serialization/document-schema';
import { collectTextLayoutTargets, createFitContext, deriveTextLayoutPatches } from '../layout/text-layout';
import {
  compareHierarchicalNodes,
  computeLayerOrder,
  deriveLayerOrderPatches,
  renumberLayerOrder,
  sortSiblingsByLayer,
  type LayerMove
} from '../layout/layer-order';
import { generateKeyBetween, generateNKeysBetween } from '../utils/fractional-index';
import { areStructuredValuesEqual } from '../utils/equality';
import {
  applyMatrix,
  applyMatrixToVector,
  computeFrameMatrix,
  computeNodeWorldBounds,
  computeWorldFrame,
  decomposeNodeMatrix,
  invertMatrix,
  multiplyMatrix,
  unionBounds
} from '../utils/geometry';

/** 创建空文档 */
export function createEmptyCanvasDocument(id = 'doc_root', name = '未命名画布'): CanvasDocument {
  const now = Date.now();
  return {
    id,
    name,
    meta: { version: 1, createdAt: now, updatedAt: now },
    content: { nodes: {}, connectors: {} }
  };
}

const NODE_GEOM_FIELDS: ReadonlySet<string | number> = new Set(['x', 'y', 'width', 'height', 'rotation']);
/**
 * 线型决定路由器；style 中的 cornerRadius / padding 会改变路由形状；文字的排版与路由一起求解 (占据范围随之变化)，
 * 因此这些都视为几何变更
 */
const CONNECTOR_GEOM_FIELDS: ReadonlySet<string | number> = new Set([
  'connectorType',
  'textBlocks',
  'from',
  'to',
  'controlPoints',
  'style'
]);
const NODE_ORDER_FIELDS: ReadonlySet<string | number> = new Set(['zIndex', 'parentId']);
const CONNECTOR_ORDER_FIELDS: ReadonlySet<string | number> = new Set(['zIndex', 'from', 'to']);
const LAYER_MOVE_LABELS: Record<LayerMove, string> = {
  forward: '上移一层',
  backward: '下移一层',
  front: '置顶',
  back: '置底'
};

/** 单个节点的变换：世界坐标中的新外框，以及同一事务写入的其他字段 */
export interface NodeTransform {
  id: string;
  frame: WorldFrame;
  /** 节点类型 applyResize 的结果 (如文本尺寸模式、字号)，与外框一并提交 */
  fields?: Partial<NodeEntity>;
}

/** 新建连线的请求 */
export interface CreateConnectorRequest {
  from: ConnectorEndpoint;
  to: ConnectorEndpoint;
  /** 线型 (路由器 id)，缺省为折线 */
  connectorType?: string;
  style?: ConnectorStyle;
  /** 缺省时自动生成 */
  id?: string;
  /** 撤销记录名称 */
  label?: string;
}

/** 节点子树快照 (实体均为深拷贝)：创建副本与剪贴板共用 */
interface Subtrees {
  topmost: NodeEntity[];
  descendants: NodeEntity[];
  connectors: ConnectorEntity[];
}

/** 语义命令的公共选项 */
export interface CommandOptions {
  /** 撤销记录名称 */
  label?: string;
  /** 默认 true；false 时不进入撤销栈 (系统整理、载入) */
  undoable?: boolean;
  /** 同组的连续提交折叠为一步撤销 (拖拽逐帧提交) */
  groupId?: string;
}

/**
 * 插件可用的文档能力：只读查询与语义命令，全部经事务提交
 * 订阅、清空历史、替换字体测量器等宿主级能力不对插件开放
 */
export type DocumentApi = Pick<
  DocumentStore,
  | 'getView'
  | 'fonts'
  | 'getNode'
  | 'getConnector'
  | 'commit'
  | 'createNode'
  | 'addNode'
  | 'updateNode'
  | 'updateNodes'
  | 'updateConnector'
  | 'updateConnectors'
  | 'createConnector'
  | 'moveEntities'
  | 'transformNodes'
  | 'resizeNodes'
  | 'rotateNodes'
  | 'setAspectLocked'
  | 'fitContent'
  | 'canFitContent'
  | 'removeEntities'
  | 'duplicateEntities'
  | 'copyEntities'
  | 'pasteEntities'
  | 'reparentNodes'
  | 'moveLayers'
  | 'batch'
  | 'undo'
  | 'redo'
  | 'canUndo'
  | 'canRedo'
>;

/** 文档变更订阅回调 */
export type DocumentSubscriber = (
  view: CanvasDocumentView,
  record: CanvasOperationRecord,
  changes: DocumentChangeSet
) => void;

export interface DocumentStoreOptions {
  /** 节点类型注册表：新建节点与文本排版据此取节点定义 */
  nodeTypes?: NodeTypeRegistry;
  /** 字体测量器 (渲染适配层提供)，缺省时不做文本驱动的自动尺寸 */
  fonts?: FontMeasurer;
  /**
   * 连线两端当前的世界坐标 (由引擎按路由提供)：单独复制连线而不带所连节点时，
   * 断开的一端改为自由端并停在原位
   */
  connectorEnds?: (connectorId: string) => readonly [Point, Point] | undefined;
}

interface MutableEntityChanges extends EntityChanges {
  readonly added: Set<string>;
  readonly removed: Set<string>;
  readonly geometry: Set<string>;
  readonly data: Set<string>;
}

function createEntityChanges(): MutableEntityChanges {
  return { added: new Set(), removed: new Set(), geometry: new Set(), data: new Set() };
}

/** 把实体对齐结果归入变更集，返回层叠关系是否可能变化 */
function recordSyncResult(changes: MutableEntityChanges, id: string, result: EntitySyncResult): boolean {
  switch (result) {
    case 'added':
      changes.added.add(id);
      changes.geometry.add(id);
      changes.data.add(id);
      return true;
    case 'replaced':
      changes.geometry.add(id);
      changes.data.add(id);
      return true;
    case 'removed':
      changes.removed.add(id);
      return true;
    case 'unchanged':
      return false;
  }
}

export class DocumentStore {
  readonly nodeTypes: NodeTypeRegistry;
  private readonly document: CanvasDocument;
  private readonly entities = new EntityStore();
  private readonly coordinator: OperationCoordinator<CanvasDocument>;
  private readonly subscribers = new Set<DocumentSubscriber>();
  private fontMeasurer: FontMeasurer | null = null;
  private readonly connectorEnds: (connectorId: string) => readonly [Point, Point] | undefined;

  constructor(initialDoc?: CanvasDocument, options?: DocumentStoreOptions) {
    // 外部传入文档属于不可信输入边界：深拷贝净化并切断与调用方的引用共享
    this.document = initialDoc ? clonePlainData(initialDoc) : createEmptyCanvasDocument();
    // 资产表等 content 之外的字段同样不允许内联媒体，因此整份文档扫描一次
    const inlineMedia = findInlineMediaUrl(this.document);
    const violation = inlineMedia
      ? `${inlineMedia} 内联了 data:/blob: 媒体地址`
      : findCommitViolation(createEmptyCanvasDocument(), [
          { op: 'set', path: ['content'], value: this.document.content }
        ]);
    if (violation) throw new Error(`[DocumentStore] 文档非法：${violation}`);

    this.nodeTypes = options?.nodeTypes ?? new NodeTypeRegistry();
    this.connectorEnds = options?.connectorEnds ?? (() => undefined);
    this.coordinator = new OperationCoordinator(this.document);
    const { nodes, connectors } = this.document.content;
    for (const id in nodes) this.entities.syncNode(id, nodes[id]);
    for (const id in connectors) this.entities.syncConnector(id, connectors[id]);
    this.coordinator.onOperation((record, doc) => this.handleOperationCommitted(record, doc));
    this.setFontMeasurer(options?.fonts ?? null);
  }

  /** 实体运行时索引 (只读视图；写入只经本类的事务提交回调) */
  get entityStore(): EntityReader {
    return this.entities;
  }

  getView(): CanvasDocumentView {
    return this.document as CanvasDocumentView;
  }

  getNode(id: string): Readonly<NodeEntity> | undefined {
    return this.entities.getNode(id)?.entity;
  }

  getConnector(id: string): Readonly<ConnectorEntity> | undefined {
    return this.entities.getConnector(id)?.entity;
  }

  get canUndo(): boolean {
    return this.coordinator.canUndo;
  }

  get canRedo(): boolean {
    return this.coordinator.canRedo;
  }

  /** 撤销栈 (旧 → 新)，供调试与界面展示 */
  get undoEntries(): readonly CanvasHistoryEntry[] {
    return this.coordinator.undoEntries;
  }

  /** 订阅撤销 / 重做可用状态 (订阅时立即回调一次当前状态) */
  onHistoryChange(listener: HistoryChangeListener): () => void {
    return this.coordinator.onHistoryChange(listener);
  }

  subscribe(listener: DocumentSubscriber): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /**
   * 提交原子事务：先经结构性守卫 (零 Base64、容器无环、层级索引合法)，违规时整体拒绝
   * @returns 事务记录；被拒绝或补丁冲突时返回 null
   */
  commit(options: CommitOperationOptions): CanvasOperationRecord | null {
    const violation = findCommitViolation(this.document, options.patches);
    if (violation) {
      console.error(`[SkyNote:DocumentStore] 事务被拒绝：${violation}`);
      return null;
    }
    return this.coordinator.commitOperation(options);
  }

  /**
   * 将多个语义操作合并为一步撤销 (如新建节点并连线、粘贴一组实体)
   * 期间每次提交即时生效；fn 抛错时本批改动整体撤回
   */
  batch<T>(fn: () => T, label?: string): T {
    return this.coordinator.batch(fn, label);
  }

  undo(): boolean {
    return this.coordinator.undo();
  }

  redo(): boolean {
    return this.coordinator.redo();
  }

  clearHistory(): void {
    this.coordinator.clearHistory();
  }

  // ================= 文本自动尺寸 =================

  /** 当前字体测量器：文字排版 (光标、选区等) 与自动尺寸共用，未注入时为 null */
  get fonts(): FontMeasurer | null {
    return this.fontMeasurer;
  }

  /** 注入或移除字体测量器：注入后本地事务中的文本与宽度变更会在同一事务内派生节点尺寸 */
  setFontMeasurer(measurer: FontMeasurer | null): void {
    this.fontMeasurer = measurer;
    this.coordinator.setPatchDerivation(
      measurer
        ? (doc, patches) => deriveTextLayoutPatches(doc, collectTextLayoutTargets(patches), measurer, this.nodeTypes)
        : null
    );
  }

  /**
   * 按当前字体测量器重新排版节点 (默认全部)，以非撤销的系统事务写回尺寸
   * 用于 Web 字体加载完成、测量器替换等测量基准变化的时机
   */
  relayoutText(nodeIds: Iterable<string> = Object.keys(this.document.content.nodes)): CanvasOperationRecord | null {
    if (!this.fontMeasurer) return null;
    const patches = deriveTextLayoutPatches(this.document, nodeIds, this.fontMeasurer, this.nodeTypes);
    return this.commit({ label: '重新排版文本', source: 'system', undoable: false, patches });
  }

  // ================= 语义命令 =================

  /**
   * 新建节点：由已注册节点类型的 createContent 给出内容，这里补齐 id、位置、层级等公共字段后提交
   * 新节点置于目标容器最上层
   * @returns 新节点 id；提交被拒绝时返回 null
   * @throws 节点类型未注册或不支持新建 (属调用方编程错误)
   */
  createNode<T extends string>(request: CreateNodeRequest<T>): string | null {
    const definition = this.nodeTypes.get(request.nodeType);
    if (!definition?.createContent) {
      throw new Error(`[DocumentStore] 节点类型 "${request.nodeType}" 未注册或不支持新建`);
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
      zIndex: this.createTopZIndex(request.parentId),
      locked: false
    };
    return this.addNode(node, { label: request.label }) ? node.id : null;
  }

  /** 添加完整节点实体 (粘贴、导入)；id 已存在时拒绝 */
  addNode(node: NodeEntity, options?: CommandOptions): CanvasOperationRecord | null {
    if (Object.hasOwn(this.document.content.nodes, node.id)) {
      console.error(`[SkyNote:DocumentStore] 节点 id 已存在，拒绝覆盖: ${node.id}`);
      return null;
    }
    return this.commit({
      ...options,
      label: options?.label ?? '添加节点',
      patches: [{ op: 'set', path: ['content', 'nodes', node.id], value: node }]
    });
  }

  /** 更新节点字段：style / data 默认浅合并，其余字段直接覆盖，值为 undefined 时删除该字段；id 与 type 不可修改 */
  updateNode(
    nodeId: string,
    partial: Partial<NodeEntity>,
    options?: CommandOptions & { merge?: boolean }
  ): CanvasOperationRecord | null {
    return this.updateEntities('nodes', [nodeId], partial, { label: '更新节点属性', ...options });
  }

  /**
   * 批量写入节点字段，一次提交：连续调整可凭 groupId 合并为一步撤销
   * @param fields 各节点相同的字段；或按节点计算各自的字段 (如只改某个圆角、保留其余三角)
   */
  updateNodes(
    nodeIds: Iterable<string>,
    fields: Partial<NodeEntity> | ((node: Readonly<NodeEntity>) => Partial<NodeEntity>),
    options?: CommandOptions & { merge?: boolean }
  ): CanvasOperationRecord | null {
    return this.updateEntities('nodes', nodeIds, fields, { label: '更新节点属性', ...options });
  }

  /** 更新连线字段，规则同 updateNode */
  updateConnector(
    connectorId: string,
    partial: Partial<ConnectorEntity>,
    options?: CommandOptions & { merge?: boolean }
  ): CanvasOperationRecord | null {
    return this.updateEntities('connectors', [connectorId], partial, { label: '更新连线属性', ...options });
  }

  /** 批量写入连线字段，规则同 updateNodes */
  updateConnectors(
    connectorIds: Iterable<string>,
    fields: Partial<ConnectorEntity> | ((connector: Readonly<ConnectorEntity>) => Partial<ConnectorEntity>),
    options?: CommandOptions & { merge?: boolean }
  ): CanvasOperationRecord | null {
    return this.updateEntities('connectors', connectorIds, fields, { label: '更新连线属性', ...options });
  }

  /**
   * 新建连线：置于两端节点已有连线之上 (连线紧贴较高一端节点下方，ADR-114)
   * @returns 新连线 id；端点引用的节点不存在或提交被拒绝时返回 null
   */
  createConnector(request: CreateConnectorRequest): string | null {
    const { nodes, connectors } = this.document.content;
    const endpointNodes = [request.from.nodeId, request.to.nodeId].filter((id) => id !== undefined);
    if (endpointNodes.some((id) => !Object.hasOwn(nodes, id))) return null;
    let top: FractionalIndex | null = null;
    for (const nodeId of endpointNodes) {
      for (const id of this.entities.getConnectorIdsOfNode(nodeId)) {
        if (top === null || connectors[id].zIndex > top) top = connectors[id].zIndex;
      }
    }
    const connector: ConnectorEntity = {
      id: request.id ?? generateId('connector'),
      type: 'connector',
      connectorType: request.connectorType ?? 'orthogonal',
      from: request.from,
      to: request.to,
      zIndex: generateKeyBetween(top, null),
      locked: false,
      ...(request.style && { style: request.style })
    };
    const record = this.commit({
      label: request.label ?? '添加连线',
      patches: [{ op: 'set', path: ['content', 'connectors', connector.id], value: connector }]
    });
    return record ? connector.id : null;
  }

  /**
   * 删除节点与连线 (支持多选)：同一事务内级联删除节点的全部后代 (容器语义) 与依附连线，撤销一步整体恢复
   * 选区中的失效项由引擎在收到变更集后统一剔除，本地删除与远端删除走同一条路径
   */
  removeEntities(refs: EntityRefs, options?: CommandOptions): CanvasOperationRecord | null {
    const removed = new Set<string>();
    for (const id of this.collectTopmost(refs.nodeIds ?? [])) {
      removed.add(id);
      for (const descendantId of this.entities.collectDescendantIds(id)) removed.add(descendantId);
    }
    const connectorIds = new Set<string>();
    for (const id of refs.connectorIds ?? []) {
      if (this.entities.getConnector(id)) connectorIds.add(id);
    }
    const patches: CanvasPatch[] = [];
    for (const id of removed) {
      patches.push({ op: 'unset', path: ['content', 'nodes', id] });
      for (const connectorId of this.entities.getConnectorIdsOfNode(id)) connectorIds.add(connectorId);
    }
    for (const connectorId of connectorIds) {
      patches.push({ op: 'unset', path: ['content', 'connectors', connectorId] });
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? '删除', patches });
  }

  /**
   * 创建副本 (支持多选)：最顶层选中节点连同全部后代一起复制，所连节点都在副本内的连线与选中的连线一并复制；
   * 副本留在原容器中，按世界位移 offset 偏移、置于容器最上层并保持原相对层级，一步撤销
   * @returns 副本中最顶层节点与连线的 id；提交被拒绝时为空
   */
  duplicateEntities(refs: EntityRefs, offset: Point, options?: CommandOptions): EntityIds {
    return this.insertSubtrees(this.collectSubtrees(refs, false), offset, {
      ...options,
      label: options?.label ?? '创建副本'
    });
  }

  /**
   * 复制到剪贴板的数据 (支持多选)：最顶层节点连同全部后代与连线；最顶层换算为根层级的世界位姿，
   * 粘贴到任何位置 (包括另一个标签页) 时外观不变
   * @returns 没有可复制的内容时为 null
   */
  copyEntities(refs: EntityRefs): NodeClipboardPayload | null {
    const subtrees = this.collectSubtrees(refs, true);
    if (subtrees.topmost.length === 0 && subtrees.connectors.length === 0) return null;
    return {
      kind: NODE_CLIPBOARD_KIND,
      version: 1,
      nodes: [...subtrees.topmost, ...subtrees.descendants],
      connectors: subtrees.connectors
    };
  }

  /**
   * 粘贴剪贴板中的节点与连线 (数据须先经 parseNodeClipboard 校验)：全部换新 id，放在根层级最上方，
   * 按世界位移 offset 偏移，一步撤销
   * @returns 粘贴出的最顶层节点与连线 id；提交被拒绝时为空
   */
  pasteEntities(payload: NodeClipboardPayload, offset: Point, options?: CommandOptions): EntityIds {
    const ids = new Set(payload.nodes.map((node) => node.id));
    const isTopmost = (node: NodeEntity) => node.parentId === undefined || !ids.has(node.parentId);
    const topmost = payload.nodes.filter(isTopmost).map(({ parentId: _parentId, ...node }) => node);
    const descendants = payload.nodes.filter((node) => !isTopmost(node));
    return this.insertSubtrees({ topmost, descendants, connectors: payload.connectors }, offset, {
      ...options,
      label: options?.label ?? '粘贴'
    });
  }

  /**
   * 整体替换文档内容 (导入文件、从本地存储恢复)；内容须先经 parseCanvasDocument 校验
   * 默认可撤销：导入后撤销一步即回到原内容
   */
  replaceContent(content: CanvasContent, options?: CommandOptions): CanvasOperationRecord | null {
    return this.commit({
      ...options,
      label: options?.label ?? '导入文档',
      patches: [{ op: 'set', path: ['content'], value: content }]
    });
  }

  /**
   * 移动节点与连线 (支持多选)：delta 为世界坐标位移，只改最顶层选中节点，后代坐标相对容器，不产生补丁 (ADR-114)；
   * 父容器旋转时把世界位移换算为父容器局部位移。连线的自由端与手动拐点是世界坐标，随之平移的有：
   * 选中的连线，以及两端都连在移动范围内节点上的连线 (一起移动的流程图，拐点保持相对位置)；
   * 一端是自由端的连线只在选中时平移。
   * 高频拖拽通过 groupId 折叠为一步撤销
   */
  moveEntities(
    refs: EntityRefs,
    delta: { x?: number; y?: number },
    options?: CommandOptions
  ): CanvasOperationRecord | null {
    const dx = delta.x ?? 0;
    const dy = delta.y ?? 0;
    if (!dx && !dy) return null;
    const { nodes, connectors } = this.document.content;
    const patches: CanvasPatch[] = [];
    const moved = new Set<string>();
    for (const id of this.collectTopmost(refs.nodeIds ?? [])) {
      const node = nodes[id];
      const parentMatrix = node.parentId === undefined ? undefined : this.entities.getWorldTransform(node.parentId);
      const local = parentMatrix ? applyMatrixToVector(invertMatrix(parentMatrix), dx, dy) : { x: dx, y: dy };
      if (local.x) patches.push({ op: 'set', path: ['content', 'nodes', id, 'x'], value: node.x + local.x });
      if (local.y) patches.push({ op: 'set', path: ['content', 'nodes', id, 'y'], value: node.y + local.y });
      moved.add(id);
      for (const descendantId of this.entities.collectDescendantIds(id)) moved.add(descendantId);
    }

    const carried = new Set<string>();
    for (const id of refs.connectorIds ?? []) {
      if (Object.hasOwn(connectors, id)) carried.add(id);
    }
    // 只带上两端都连在移动范围内的连线：一端是自由端的连线没选中时，自由端留在原处 (与 FigJam、Miro 一致)
    const inside = (end: ConnectorEndpoint) => end.nodeId !== undefined && moved.has(end.nodeId);
    for (const id of moved) {
      for (const connectorId of this.entities.getConnectorIdsOfNode(id)) {
        const c = connectors[connectorId];
        if (inside(c.from) && inside(c.to)) carried.add(connectorId);
      }
    }
    const shift = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
    for (const id of carried) {
      const c = connectors[id];
      const path = ['content', 'connectors', id];
      if (c.from.position)
        patches.push({ op: 'set', path: [...path, 'from'], value: { position: shift(c.from.position) } });
      if (c.to.position) patches.push({ op: 'set', path: [...path, 'to'], value: { position: shift(c.to.position) } });
      if (c.controlPoints) {
        patches.push({ op: 'set', path: [...path, 'controlPoints'], value: c.controlPoints.map(shift) });
      }
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? '移动', patches });
  }

  /**
   * 变换节点 (缩放、旋转)：frame 为世界坐标中的新外框，换算为父容器局部坐标后一次提交，只写有变化的字段
   * 后代坐标相对容器，随容器移动与旋转，不产生补丁 (ADR-114)；高频拖拽通过 groupId 折叠为一步撤销
   */
  transformNodes(transforms: readonly NodeTransform[], options?: CommandOptions): CanvasOperationRecord | null {
    const { nodes } = this.document.content;
    const patches: CanvasPatch[] = [];
    const carried = new Set<string>();
    for (const { id, frame, fields } of transforms) {
      if (!Object.hasOwn(nodes, id)) continue;
      const node = nodes[id];
      const world = computeFrameMatrix(frame);
      const parentMatrix = node.parentId === undefined ? undefined : this.entities.getWorldTransform(node.parentId);
      const local = parentMatrix ? multiplyMatrix(invertMatrix(parentMatrix), world) : world;
      const pose = decomposeNodeMatrix(local, frame.width, frame.height);
      const next: Partial<NodeEntity> = { ...pose, width: frame.width, height: frame.height, ...fields };
      for (const [key, value] of Object.entries(next)) {
        if (key === 'id' || key === 'type') continue;
        if (areStructuredValuesEqual(node[key as keyof NodeEntity], value)) continue;
        patches.push({ op: 'set', path: ['content', 'nodes', id, key], value });
      }
      // 容器内的连线随后代一起移动旋转：自由端与手动拐点是世界坐标，按容器自身坐标系的变化一并换算
      const delta = multiplyMatrix(world, invertMatrix(this.entities.getWorldTransform(id)!));
      this.carryConnectors([id, ...this.entities.collectDescendantIds(id)], delta, carried, patches);
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? '变换节点', patches });
  }

  /**
   * 两端都连在 subtree 内节点上的连线：手动拐点按矩阵 m 换算 (每条连线只处理一次)
   * @param carried 本次事务已处理的连线
   */
  private carryConnectors(subtree: readonly string[], m: Matrix2D, carried: Set<string>, patches: CanvasPatch[]): void {
    const { connectors } = this.document.content;
    const inside = new Set(subtree);
    const contains = (end: ConnectorEndpoint) => end.nodeId !== undefined && inside.has(end.nodeId);
    const map = (p: Point): Point => applyMatrix(m, p.x, p.y);
    for (const nodeId of subtree) {
      for (const id of this.entities.getConnectorIdsOfNode(nodeId)) {
        const c = connectors[id];
        if (carried.has(id) || !c.controlPoints || !contains(c.from) || !contains(c.to)) continue;
        carried.add(id);
        patches.push({
          op: 'set',
          path: ['content', 'connectors', id, 'controlPoints'],
          value: c.controlPoints.map(map)
        });
      }
    }
  }

  /**
   * 把节点设为指定宽高 (尺寸面板，支持多选)：节点左上角在世界中不动，旋转节点同样成立
   * 只给一边且比例锁定时另一边按比例联动；节点类型的 applyResize 一并写入 (如自由文本切换为固定宽度)，
   * 与拖控制柄走同一套缩放语义，否则排版派生会把直接写入的宽高改回去
   */
  resizeNodes(
    nodeIds: Iterable<string>,
    size: { width?: number; height?: number },
    options?: CommandOptions
  ): CanvasOperationRecord | null {
    const { nodes } = this.document.content;
    const handle: ResizeHandle = size.height === undefined ? 'e' : size.width === undefined ? 's' : 'se';
    const transforms: NodeTransform[] = [];
    for (const id of nodeIds) {
      if (!Object.hasOwn(nodes, id)) continue;
      const node = nodes[id];
      const definition = this.nodeTypes.get(node.nodeType);
      let width = size.width ?? node.width;
      let height = size.height ?? node.height;
      let scale = 1;
      if (handle !== 'se' && isAspectLocked(node, definition) && node.width > 0 && node.height > 0) {
        scale = handle === 'e' ? width / node.width : height / node.height;
        width = node.width * scale;
        height = node.height * scale;
      }
      // 旧节点局部坐标中左上角仍在原点，新中心 (w/2, h/2) 经旧世界矩阵换算即可
      const frame = computeWorldFrame({ width, height }, this.entities.getWorldTransform(id)!);
      const fields = definition?.applyResize?.(node, { handle, width, height, scale });
      transforms.push({ id, frame, fields });
    }
    return this.transformNodes(transforms, { ...options, label: options?.label ?? '调整尺寸' });
  }

  /**
   * 绕选中节点整体外接框的中心增量旋转 (支持多选)：与拖动旋转控制柄的结果一致
   * 只变换最顶层选中节点，后代随容器旋转
   */
  rotateNodes(nodeIds: Iterable<string>, degrees: number, options?: CommandOptions): CanvasOperationRecord | null {
    const targets = this.collectTopmost(nodeIds).map((id) => {
      const node = this.document.content.nodes[id];
      return { id, node, matrix: this.entities.getWorldTransform(id)! };
    });
    if (targets.length === 0 || degrees % 360 === 0) return null;
    const bounds = targets
      .map(({ node, matrix }) => computeNodeWorldBounds(node, matrix))
      .reduce((union, b) => unionBounds(union, b));
    const pivot = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    const rad = (degrees * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const transforms = targets.map(({ id, node, matrix }): NodeTransform => {
      const frame = computeWorldFrame(node, matrix);
      const dx = frame.cx - pivot.x;
      const dy = frame.cy - pivot.y;
      return {
        id,
        frame: {
          ...frame,
          cx: pivot.x + dx * cos - dy * sin,
          cy: pivot.y + dx * sin + dy * cos,
          rotation: frame.rotation + degrees
        }
      };
    });
    return this.transformNodes(transforms, { ...options, label: options?.label ?? '旋转节点' });
  }

  /**
   * 设置比例锁定 (支持多选)：写入显式值，即使与节点类型默认值相同，用户的选择也不随默认值变化
   * 值无变化的节点不产生补丁
   */
  setAspectLocked(nodeIds: Iterable<string>, locked: boolean, options?: CommandOptions): CanvasOperationRecord | null {
    const { nodes } = this.document.content;
    const patches: CanvasPatch[] = [];
    for (const id of nodeIds) {
      if (!Object.hasOwn(nodes, id) || nodes[id].aspectLocked === locked) continue;
      patches.push({ op: 'set', path: ['content', 'nodes', id, 'aspectLocked'], value: locked });
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? (locked ? '锁定比例' : '解锁比例'), patches });
  }

  /** 让节点外框适应内容 (支持多选)：写入的字段由节点类型决定，已适应内容或不支持的节点跳过 */
  fitContent(nodeIds: Iterable<string>, options?: CommandOptions): CanvasOperationRecord | null {
    const patches: CanvasPatch[] = [];
    for (const id of nodeIds) {
      const fields = this.resolveFitContent(id);
      if (!fields) continue;
      for (const [key, value] of Object.entries(fields)) {
        patches.push({ op: 'set', path: ['content', 'nodes', id, key], value });
      }
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? '适应内容', patches });
  }

  /** 节点能否适应内容 (节点类型支持且尚未适应)：界面据此决定是否显示入口 */
  canFitContent(nodeId: string): boolean {
    return this.resolveFitContent(nodeId) !== null;
  }

  /**
   * 改挂容器 (支持多选，parentId 为 undefined 时移出到根层级)：保持节点在世界中的位置与朝向不变，
   * 换算为新容器的局部坐标，并按原有层叠顺序依次放到新容器最上层；会成环的改挂由提交守卫整体拒绝
   */
  reparentNodes(
    nodeIds: Iterable<string>,
    parentId: string | undefined,
    options?: CommandOptions
  ): CanvasOperationRecord | null {
    const { nodes } = this.document.content;
    if (parentId !== undefined && !Object.hasOwn(nodes, parentId)) return null;
    const getNode = (id: string): Readonly<NodeEntity> | undefined =>
      Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    const chainCache = new Map<string, Readonly<NodeEntity>[]>();
    const targets = this.collectTopmost(nodeIds)
      .filter((id) => nodes[id].parentId !== parentId)
      .map((id) => nodes[id])
      .sort((a, b) => compareHierarchicalNodes(a, b, getNode, chainCache));
    if (targets.length === 0) return null;

    const parentMatrix = parentId === undefined ? undefined : this.entities.getWorldTransform(parentId);
    const toParentLocal = parentMatrix && invertMatrix(parentMatrix);
    const keys = generateNKeysBetween(this.findTopZIndex(parentId), null, targets.length);
    const patches: CanvasPatch[] = [];
    for (let i = 0; i < targets.length; i++) {
      const node = targets[i];
      const world = this.entities.getWorldTransform(node.id)!;
      const pose = decomposeNodeMatrix(
        toParentLocal ? multiplyMatrix(toParentLocal, world) : world,
        node.width,
        node.height
      );
      const base = ['content', 'nodes', node.id];
      patches.push(
        parentId === undefined
          ? { op: 'unset', path: [...base, 'parentId'] }
          : { op: 'set', path: [...base, 'parentId'], value: parentId },
        { op: 'set', path: [...base, 'x'], value: pose.x },
        { op: 'set', path: [...base, 'y'], value: pose.y },
        { op: 'set', path: [...base, 'rotation'], value: pose.rotation },
        { op: 'set', path: [...base, 'zIndex'], value: keys[i] }
      );
    }
    return this.commit({ ...options, label: options?.label ?? '移入容器', patches });
  }

  /** 指定容器 (undefined 为根层级) 中位于最上层的新层级索引 */
  createTopZIndex(parentId?: string): FractionalIndex {
    return generateKeyBetween(this.findTopZIndex(parentId), null);
  }

  /**
   * 调整层级 (上移一层 / 下移一层 / 置顶 / 置底)，按列表顺序在各自容器的兄弟之间移动
   * 只为被移动的节点生成新索引，多选时保持相对顺序；顺序无变化时返回 null
   */
  moveLayers(nodeIds: Iterable<string>, move: LayerMove, options?: CommandOptions): CanvasOperationRecord | null {
    const { nodes } = this.document.content;
    const groups = new Map<string | undefined, Set<string>>();
    for (const id of nodeIds) {
      if (!Object.hasOwn(nodes, id)) continue;
      const parentId = nodes[id].parentId;
      let group = groups.get(parentId);
      if (!group) {
        group = new Set();
        groups.set(parentId, group);
      }
      group.add(id);
    }

    const patches: CanvasPatch[] = [];
    for (const [parentId, selected] of groups) {
      const siblings = this.siblingsInLayerOrder(parentId);
      const order = siblings.map((node) => node.id);
      const newOrder = computeLayerOrder(order, selected, move);
      if (newOrder.every((id, i) => id === order[i])) continue;
      patches.push(...deriveLayerOrderPatches(siblings, newOrder, selected));
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? LAYER_MOVE_LABELS[move], patches });
  }

  /**
   * 按当前层叠顺序为容器内的兄弟重新编号为最短的均匀索引 (画面顺序不变)
   * 用于同一位置反复插入导致索引过长时整理，以非撤销的系统事务提交
   */
  renumberLayers(parentId?: string): CanvasOperationRecord | null {
    const siblings = this.siblingsInLayerOrder(parentId);
    const patches = renumberLayerOrder(
      siblings,
      siblings.map((node) => node.id)
    );
    return this.commit({ label: '整理层级索引', source: 'system', undoable: false, patches });
  }

  // ================= 内部 =================

  private resolveFitContent(id: string): Partial<NodeEntity> | null {
    const node = this.getNode(id);
    const definition = node && this.nodeTypes.get(node.nodeType);
    if (!node || !definition?.fitContent) return null;
    return definition.fitContent(node as NodeEntity, createFitContext(node, definition, this.fontMeasurer));
  }

  private updateEntities<T extends NodeEntity | ConnectorEntity>(
    collection: 'nodes' | 'connectors',
    ids: Iterable<string>,
    fields: Partial<T> | ((entity: Readonly<T>) => Partial<T>),
    options: CommandOptions & { merge?: boolean }
  ): CanvasOperationRecord | null {
    const entities = this.document.content[collection] as Record<string, T>;
    const merge = options.merge ?? true;
    const patches: CanvasPatch[] = [];
    for (const id of ids) {
      if (!Object.hasOwn(entities, id)) continue;
      const partial = typeof fields === 'function' ? fields(entities[id]) : fields;
      for (const [key, value] of Object.entries(partial)) {
        // 主键与实体类别不可修改
        if (key === 'id' || key === 'type') continue;
        const path = ['content', collection, id, key];
        // 显式传 undefined 表示去掉该字段 (如清除手动拐点恢复自动路由)，而不是留下值为 undefined 的键
        if (value === undefined) {
          if (Object.hasOwn(entities[id], key)) patches.push({ op: 'unset', path });
          continue;
        }
        const mergeable = merge && (key === 'style' || key === 'data') && typeof value === 'object' && value !== null;
        patches.push({ op: 'set', path, value, ...(mergeable && { merge: true }) });
      }
    }
    if (patches.length === 0) return null;
    return this.commit({ label: options.label, undoable: options.undoable, groupId: options.groupId, patches });
  }

  /**
   * 选中实体的子树快照 (深拷贝)：最顶层节点按层叠顺序排列、全部后代，以及连线——
   * 所连节点都在其中的连线 (另一端可以是自由端) 与选中的连线；选中连线所连的节点不在其中时，
   * 断开的一端改为停在原位的自由端
   * @param toWorld 最顶层节点换算为根层级的世界位姿并去掉 parentId (剪贴板)；否则保留所在容器 (创建副本)
   */
  private collectSubtrees(refs: EntityRefs, toWorld: boolean): Subtrees {
    const { nodes, connectors } = this.document.content;
    const getNode = (id: string): Readonly<NodeEntity> | undefined =>
      Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    const chainCache = new Map<string, Readonly<NodeEntity>[]>();
    const topIds = this.collectTopmost(refs.nodeIds ?? []).sort((a, b) =>
      compareHierarchicalNodes(nodes[a], nodes[b], getNode, chainCache)
    );
    const topmost = topIds.map((id) => {
      const node = clonePlainData(nodes[id]) as NodeEntity;
      if (!toWorld) return node;
      const { parentId: _parentId, ...rest } = node;
      return { ...rest, ...decomposeNodeMatrix(this.entities.getWorldTransform(id)!, node.width, node.height) };
    });
    const descendants = topIds.flatMap((id) =>
      this.entities.collectDescendantIds(id).map((descendantId) => clonePlainData(nodes[descendantId]) as NodeEntity)
    );
    const included = new Set([...topIds, ...descendants.map((node) => node.id)]);
    const isInside = (end: ConnectorEndpoint) => end.nodeId === undefined || included.has(end.nodeId);

    const picked = new Map<string, ConnectorEntity>();
    for (const id of included) {
      for (const connectorId of this.entities.getConnectorIdsOfNode(id)) {
        const c = connectors[connectorId];
        if (isInside(c.from) && isInside(c.to)) picked.set(connectorId, clonePlainData(c) as ConnectorEntity);
      }
    }
    for (const id of refs.connectorIds ?? []) {
      if (picked.has(id) || !this.entities.getConnector(id)) continue;
      const ends = this.connectorEnds(id);
      // 悬空连线没有可落脚的位置，不复制
      if (!ends) continue;
      const c = clonePlainData(connectors[id]) as ConnectorEntity;
      picked.set(id, {
        ...c,
        from: isInside(c.from) ? c.from : { position: { x: ends[0].x, y: ends[0].y } },
        to: isInside(c.to) ? c.to : { position: { x: ends[1].x, y: ends[1].y } }
      });
    }
    return { topmost, descendants, connectors: [...picked.values()] };
  }

  /**
   * 把子树快照写入文档：全部换新 id；最顶层放进各自容器 (不存在时为根层级) 最上方并按世界位移偏移，
   * 后代与连线改接到新 id；自由端与手动拐点是世界坐标，随之偏移
   */
  private insertSubtrees(subtrees: Subtrees, offset: Point, options: CommandOptions): EntityIds {
    const { nodes } = this.document.content;
    const idMap = new Map<string, string>();
    for (const node of [...subtrees.topmost, ...subtrees.descendants]) idMap.set(node.id, generateId('node'));

    const patches: CanvasPatch[] = [];
    const topKeys = new Map<string | undefined, FractionalIndex | null>();
    for (const node of subtrees.topmost) {
      const parentId = node.parentId !== undefined && Object.hasOwn(nodes, node.parentId) ? node.parentId : undefined;
      const zIndex = generateKeyBetween(topKeys.get(parentId) ?? this.findTopZIndex(parentId), null);
      topKeys.set(parentId, zIndex);
      const parentMatrix = parentId === undefined ? undefined : this.entities.getWorldTransform(parentId);
      const local = parentMatrix ? applyMatrixToVector(invertMatrix(parentMatrix), offset.x, offset.y) : offset;
      const { parentId: _parentId, ...rest } = node;
      const copy: NodeEntity = {
        ...rest,
        ...(parentId !== undefined && { parentId }),
        id: idMap.get(node.id)!,
        x: node.x + local.x,
        y: node.y + local.y,
        zIndex
      };
      patches.push({ op: 'set', path: ['content', 'nodes', copy.id], value: copy });
    }
    for (const node of subtrees.descendants) {
      const copy = { ...node, id: idMap.get(node.id)!, parentId: idMap.get(node.parentId!)! };
      patches.push({ op: 'set', path: ['content', 'nodes', copy.id], value: copy });
    }
    const shift = (p: Point): Point => ({ x: p.x + offset.x, y: p.y + offset.y });
    // 剪贴板是外部数据：所连节点不在数据中的连线跳过
    const remap = (end: ConnectorEndpoint): ConnectorEndpoint | null => {
      if (end.nodeId === undefined) return { position: shift(end.position!) };
      const nodeId = idMap.get(end.nodeId);
      return nodeId ? { ...end, nodeId } : null;
    };
    const connectorIds: string[] = [];
    for (const connector of subtrees.connectors) {
      const from = remap(connector.from);
      const to = remap(connector.to);
      if (!from || !to) continue;
      const copy: ConnectorEntity = {
        ...connector,
        id: generateId('connector'),
        from,
        to,
        ...(connector.controlPoints && { controlPoints: connector.controlPoints.map(shift) })
      };
      connectorIds.push(copy.id);
      patches.push({ op: 'set', path: ['content', 'connectors', copy.id], value: copy });
    }

    const empty: EntityIds = { nodeIds: [], connectorIds: [] };
    if (patches.length === 0) return empty;
    const record = this.commit({ ...options, patches });
    return record ? { nodeIds: subtrees.topmost.map((node) => idMap.get(node.id)!), connectorIds } : empty;
  }

  /**
   * 过滤出「祖先不在集合中」的节点：后代坐标相对容器，随容器一起移动、改挂或删除；
   * 否则同时选中容器与其子节点时，子节点会被重复处理
   */
  private collectTopmost(nodeIds: Iterable<string>): string[] {
    const selected = new Set<string>();
    for (const id of nodeIds) {
      if (this.entities.hasNode(id)) selected.add(id);
    }
    const topmost: string[] = [];
    for (const id of selected) {
      if (!this.entities.getAncestorIds(id).some((ancestorId) => selected.has(ancestorId))) topmost.push(id);
    }
    return topmost;
  }

  private findTopZIndex(parentId: string | undefined): FractionalIndex | null {
    let top: FractionalIndex | null = null;
    for (const id of this.entities.getChildIds(parentId)) {
      const key = this.document.content.nodes[id].zIndex;
      if (top === null || key > top) top = key;
    }
    return top;
  }

  private siblingsInLayerOrder(parentId: string | undefined): Readonly<NodeEntity>[] {
    const { nodes } = this.document.content;
    return sortSiblingsByLayer([...this.entities.getChildIds(parentId)].map((id) => nodes[id]));
  }

  /**
   * 事务提交后：对齐实体索引、递增双版本号，并把补丁按实体语义归类为变更集广播
   */
  private handleOperationCommitted(record: CanvasOperationRecord, doc: CanvasDocument): void {
    const nodeChanges = createEntityChanges();
    const connectorChanges = createEntityChanges();
    let fullSync = false;
    let orderChanged = false;

    const syncNodeIds = new Set<string>();
    const reparentedNodeIds = new Set<string>();
    const syncConnectorIds = new Set<string>();
    const nodeGeomIds = new Set<string>();
    const nodeDataIds = new Set<string>();
    const connectorGeomIds = new Set<string>();
    const connectorDataIds = new Set<string>();

    for (let i = 0; i < record.patches.length; i++) {
      const patch = record.patches[i];
      const segments = normalizePatchPath(patch.path);
      if (segments[0] !== 'content') continue;

      // 整体替换 content 或整个 nodes/connectors 集合
      if (segments.length <= 2) {
        fullSync = true;
        continue;
      }

      const isNode = segments[1] === 'nodes';
      if (!isNode && segments[1] !== 'connectors') continue;
      const id = String(segments[2]);

      let fields: readonly (string | number)[];
      if (segments.length > 3) {
        fields = [segments[3]];
      } else if (patch.op === 'set' && patch.merge) {
        // 对实体本身做字典合并：按合并的字段逐一归类
        fields = Object.keys(patch.value as object);
      } else {
        (isNode ? syncNodeIds : syncConnectorIds).add(id);
        continue;
      }

      const geomFields = isNode ? NODE_GEOM_FIELDS : CONNECTOR_GEOM_FIELDS;
      const orderFields = isNode ? NODE_ORDER_FIELDS : CONNECTOR_ORDER_FIELDS;
      for (let j = 0; j < fields.length; j++) {
        const field = fields[j];
        if (geomFields.has(field)) {
          (isNode ? nodeGeomIds : connectorGeomIds).add(id);
        } else {
          (isNode ? nodeDataIds : connectorDataIds).add(id);
          // 占据范围由节点类型按任意字段计算 (如随标题文字伸缩)：数据变化同样要更新空间索引
          if (
            isNode &&
            Object.hasOwn(doc.content.nodes, id) &&
            this.nodeTypes.get(doc.content.nodes[id].nodeType)?.extent
          ) {
            nodeGeomIds.add(id);
          }
        }
        if (orderFields.has(field)) orderChanged = true;
        if (isNode && field === 'parentId') reparentedNodeIds.add(id);
      }
    }

    const { nodes, connectors } = doc.content;
    const store = this.entities;

    if (fullSync) {
      for (const runtimeNode of store.getAllNodes()) syncNodeIds.add(runtimeNode.entity.id);
      for (const id in nodes) syncNodeIds.add(id);
      for (const runtimeConnector of store.getAllConnectors()) syncConnectorIds.add(runtimeConnector.entity.id);
      for (const id in connectors) syncConnectorIds.add(id);
    }

    for (const id of syncNodeIds) {
      const result = store.syncNode(id, Object.hasOwn(nodes, id) ? nodes[id] : undefined);
      if (recordSyncResult(nodeChanges, id, result)) orderChanged = true;
    }
    for (const id of syncConnectorIds) {
      const result = store.syncConnector(id, Object.hasOwn(connectors, id) ? connectors[id] : undefined);
      if (recordSyncResult(connectorChanges, id, result)) orderChanged = true;
    }

    for (const id of reparentedNodeIds) {
      store.reindexNodeParent(id);
    }

    // 事务内单次统一递增版本号；同一事务先改字段再删除实体时，已删除的实体不再计入变更
    for (const id of nodeGeomIds) {
      if (store.bumpNodeVersion(id, 'geom')) nodeChanges.geometry.add(id);
    }
    for (const id of nodeDataIds) {
      if (store.bumpNodeVersion(id, 'data')) nodeChanges.data.add(id);
    }
    for (const id of connectorGeomIds) {
      if (store.bumpConnectorVersion(id, 'geom')) connectorChanges.geometry.add(id);
    }
    for (const id of connectorDataIds) {
      if (store.bumpConnectorVersion(id, 'data')) connectorChanges.data.add(id);
    }

    // 世界几何失效：自身几何变化、改挂容器的节点连同全部后代；被删除容器遗留的子节点回落到根层级，同样失效
    const worldGeometry = new Set<string>();
    const invalidateSubtree = (id: string): void => {
      if (worldGeometry.has(id) || !store.hasNode(id)) return;
      worldGeometry.add(id);
      for (const descendantId of store.collectDescendantIds(id)) worldGeometry.add(descendantId);
    };
    for (const id of nodeChanges.geometry) invalidateSubtree(id);
    const reparented = new Set<string>();
    for (const id of reparentedNodeIds) {
      if (!store.hasNode(id)) continue;
      reparented.add(id);
      invalidateSubtree(id);
    }
    for (const id of nodeChanges.removed) {
      for (const childId of store.getChildIds(id)) invalidateSubtree(childId);
    }

    // 节点世界几何变化或删除时，依附连线的路由随之失效
    for (const affected of [worldGeometry, nodeChanges.removed]) {
      for (const nodeId of affected) {
        for (const connectorId of store.getConnectorIdsOfNode(nodeId)) {
          if (connectorChanges.geometry.has(connectorId)) continue;
          if (store.bumpConnectorVersion(connectorId, 'geom')) connectorChanges.geometry.add(connectorId);
        }
      }
    }

    const changes: DocumentChangeSet = {
      nodes: { ...nodeChanges, worldGeometry, reparented },
      connectors: connectorChanges,
      orderChanged
    };
    const view = this.getView();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(view, record, changes);
      } catch (err) {
        console.error('[SkyNote:DocumentStore] 变更订阅回调异常:', err);
      }
    }
  }
}

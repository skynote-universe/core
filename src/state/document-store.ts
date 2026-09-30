/**
 * @file document-store.ts
 * @description 画布文档状态中心：唯一的写入口 (事务、语义命令、新建节点、文本自动尺寸) 与增量变更集广播
 *
 * 设计考量 (Why):
 * 1. 只读投影：对外暴露的文档在类型上是深度只读的，写入只能经事务提交。
 * 2. 语义命令：移动、删除、改挂、层级、新建都在这里封装为规范补丁并走同一提交入口，自动满足守卫、派生排版与撤销合并。
 * 3. 增量变更集：每次提交把补丁路径按实体语义归类为 DocumentChangeSet 广播一次，下游 (索引、渲染、插件) 全部增量消费。
 * 4. 文本驱动的自动尺寸：注入测量器后，本地事务中的文本或宽度变更在同一事务内派生尺寸补丁，撤销时一并回退。
 */

import type { CanvasDocument, CanvasDocumentView, FractionalIndex } from '../types/canvas';
import type { NodeEntity } from '../types/node';
import type { ConnectorEntity } from '../types/connector';
import type {
  CanvasHistoryEntry,
  CanvasOperationRecord,
  CommitOperationOptions,
  CanvasPatch
} from '../types/operation';
import type { DocumentChangeSet, EntityChanges } from '../types/change-set';
import type { CreateNodeRequest } from '../protocols/node-type.protocol';
import type { TextMeasurer } from '../protocols/text-measurer.protocol';
import { EntityStore, type EntityReader, type EntitySyncResult } from './entity-store';
import { OperationCoordinator, type HistoryChangeListener } from '../operation/coordinator';
import { normalizePatchPath } from '../operation/patch-path';
import { NodeTypeRegistry } from '../registry/node-type-registry';
import { clonePlainData } from '../utils/clone';
import { generateId } from '../utils/id';
import { findCommitViolation, findInlineMediaUrl } from './commit-guards';
import { collectTextLayoutTargets, deriveTextLayoutPatches } from '../layout/text-layout';
import {
  compareHierarchicalNodes,
  computeLayerOrder,
  deriveLayerOrderPatches,
  renumberLayerOrder,
  sortSiblingsByLayer,
  type LayerMove
} from '../layout/layer-order';
import { generateKeyBetween, generateNKeysBetween } from '../utils/fractional-index';
import { applyMatrixToVector, decomposeNodeMatrix, invertMatrix, multiplyMatrix } from '../utils/geometry';

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
/** style 中的 curveType / cornerRadius / padding 会改变路由形状，因此连线样式同时视为几何变更 */
const CONNECTOR_GEOM_FIELDS: ReadonlySet<string | number> = new Set(['from', 'to', 'controlPoints', 'style']);
const NODE_ORDER_FIELDS: ReadonlySet<string | number> = new Set(['zIndex', 'parentId']);
const CONNECTOR_ORDER_FIELDS: ReadonlySet<string | number> = new Set(['zIndex', 'from', 'to']);
const LAYER_MOVE_LABELS: Record<LayerMove, string> = {
  forward: '上移一层',
  backward: '下移一层',
  front: '置顶',
  back: '置底'
};

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
 * 订阅、清空历史、替换测量器等宿主级能力不对插件开放
 */
export type DocumentApi = Pick<
  DocumentStore,
  | 'getView'
  | 'getNode'
  | 'getConnector'
  | 'commit'
  | 'createNode'
  | 'addNode'
  | 'updateNode'
  | 'updateConnector'
  | 'moveNodes'
  | 'removeNodes'
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
  /** 文本测量器 (渲染适配层提供)，缺省时不做文本驱动的自动尺寸 */
  textMeasurer?: TextMeasurer;
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
  private textMeasurer: TextMeasurer | null = null;

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
    this.coordinator = new OperationCoordinator(this.document);
    const { nodes, connectors } = this.document.content;
    for (const id in nodes) this.entities.syncNode(id, nodes[id]);
    for (const id in connectors) this.entities.syncConnector(id, connectors[id]);
    this.coordinator.onOperation((record, doc) => this.handleOperationCommitted(record, doc));
    this.setTextMeasurer(options?.textMeasurer ?? null);
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
      console.error(`[DocumentStore] 事务被拒绝：${violation}`);
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

  /** 注入或移除文本测量器：注入后本地事务中的文本与宽度变更会在同一事务内派生节点尺寸 */
  setTextMeasurer(measurer: TextMeasurer | null): void {
    this.textMeasurer = measurer;
    this.coordinator.setPatchDerivation(
      measurer
        ? (doc, patches) => deriveTextLayoutPatches(doc, collectTextLayoutTargets(patches), measurer, this.nodeTypes)
        : null
    );
  }

  /**
   * 按当前测量器重新排版节点 (默认全部)，以非撤销的系统事务写回尺寸
   * 用于 Web 字体加载完成、测量器替换等测量基准变化的时机
   */
  relayoutText(nodeIds: Iterable<string> = Object.keys(this.document.content.nodes)): CanvasOperationRecord | null {
    if (!this.textMeasurer) return null;
    const patches = deriveTextLayoutPatches(this.document, nodeIds, this.textMeasurer, this.nodeTypes);
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
      console.error(`[DocumentStore] 节点 id 已存在，拒绝覆盖: ${node.id}`);
      return null;
    }
    return this.commit({
      ...options,
      label: options?.label ?? '添加节点',
      patches: [{ op: 'set', path: ['content', 'nodes', node.id], value: node }]
    });
  }

  /** 更新节点字段：style / data 默认浅合并，其余字段直接覆盖；id 与 type 不可修改 */
  updateNode(
    nodeId: string,
    partial: Partial<NodeEntity>,
    options?: CommandOptions & { merge?: boolean }
  ): CanvasOperationRecord | null {
    return this.updateEntity('nodes', nodeId, partial, { label: '更新节点属性', ...options });
  }

  /** 更新连线字段，规则同 updateNode */
  updateConnector(
    connectorId: string,
    partial: Partial<ConnectorEntity>,
    options?: CommandOptions & { merge?: boolean }
  ): CanvasOperationRecord | null {
    return this.updateEntity('connectors', connectorId, partial, { label: '更新连线属性', ...options });
  }

  /**
   * 删除节点 (支持多选)：同一事务内级联删除全部后代 (容器语义) 与这些节点上的依附连线，撤销一步整体恢复
   * 选区中的失效项由引擎在收到变更集后统一剔除，本地删除与远端删除走同一条路径
   */
  removeNodes(nodeIds: Iterable<string>, options?: CommandOptions): CanvasOperationRecord | null {
    const removed = new Set<string>();
    for (const id of this.collectTopmost(nodeIds)) {
      removed.add(id);
      for (const descendantId of this.entities.collectDescendantIds(id)) removed.add(descendantId);
    }
    if (removed.size === 0) return null;

    const connectorIds = new Set<string>();
    const patches: CanvasPatch[] = [];
    for (const id of removed) {
      patches.push({ op: 'unset', path: ['content', 'nodes', id] });
      for (const connectorId of this.entities.getConnectorIdsOfNode(id)) connectorIds.add(connectorId);
    }
    for (const connectorId of connectorIds) {
      patches.push({ op: 'unset', path: ['content', 'connectors', connectorId] });
    }
    return this.commit({ ...options, label: options?.label ?? '删除节点', patches });
  }

  /**
   * 移动节点 (支持多选)：delta 为世界坐标位移，只改最顶层选中节点，后代坐标相对容器，不产生补丁 (ADR-114)
   * 父容器旋转时把世界位移换算为父容器局部位移；高频拖拽通过 groupId 折叠为一步撤销
   */
  moveNodes(
    nodeIds: Iterable<string>,
    delta: { x?: number; y?: number },
    options?: CommandOptions
  ): CanvasOperationRecord | null {
    const dx = delta.x ?? 0;
    const dy = delta.y ?? 0;
    if (!dx && !dy) return null;
    const { nodes } = this.document.content;
    const patches: CanvasPatch[] = [];
    for (const id of this.collectTopmost(nodeIds)) {
      const node = nodes[id];
      const parentMatrix = node.parentId === undefined ? undefined : this.entities.getWorldTransform(node.parentId);
      const local = parentMatrix ? applyMatrixToVector(invertMatrix(parentMatrix), dx, dy) : { x: dx, y: dy };
      if (local.x) patches.push({ op: 'set', path: ['content', 'nodes', id, 'x'], value: node.x + local.x });
      if (local.y) patches.push({ op: 'set', path: ['content', 'nodes', id, 'y'], value: node.y + local.y });
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? '移动节点', patches });
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

  private updateEntity(
    collection: 'nodes' | 'connectors',
    id: string,
    partial: Partial<NodeEntity> | Partial<ConnectorEntity>,
    options: CommandOptions & { merge?: boolean }
  ): CanvasOperationRecord | null {
    if (!Object.hasOwn(this.document.content[collection], id)) return null;
    const merge = options.merge ?? true;
    const patches: CanvasPatch[] = [];
    for (const [key, value] of Object.entries(partial)) {
      // 主键与实体类别不可修改
      if (key === 'id' || key === 'type') continue;
      const mergeable = merge && (key === 'style' || key === 'data') && typeof value === 'object' && value !== null;
      patches.push({ op: 'set', path: ['content', collection, id, key], value, ...(mergeable && { merge: true }) });
    }
    if (patches.length === 0) return null;
    return this.commit({ label: options.label, undoable: options.undoable, groupId: options.groupId, patches });
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
        console.error('[DocumentStore] 变更订阅回调异常:', err);
      }
    }
  }
}

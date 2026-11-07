/**
 * @file document-store.ts
 * @description 画布文档状态中心：唯一的写入口 (事务、语义命令、新建节点、文本自动尺寸) 与增量变更集广播
 *
 * 设计考量 (Why):
 * 1. 只读投影：对外暴露的文档在类型上是深度只读的，写入只能经事务提交。
 * 2. 语义命令：移动、删除、改挂、层级、新建都在这里封装为规范补丁并走同一提交入口，自动满足守卫、派生排版与撤销合并。
 * 3. 增量变更集：每次提交把补丁路径按实体语义归类为 DocumentChangeSet 广播一次，下游 (索引、渲染、插件) 全部增量消费。
 * 4. 文本驱动的自动尺寸：注入字体测量器后，本地事务中的文本或宽度变更在同一事务内派生尺寸补丁，撤销时一并回退。
 * 5. 布局 (ADR-130)：文字尺寸之后再派生布局成员的位置。
 * 6. 派生连线来源 (ADR-130)：来源推导出的连线与文档中的连线一起进入实体索引 (下游当作普通连线消费)，
 *    对它的写入交给来源转写为文档补丁；内核不知道任何具体来源的语义。
 */

import type {
  CanvasContent,
  CanvasDocument,
  CanvasDocumentView,
  EntityIds,
  EntityRefs,
  FractionalIndex
} from '../types/canvas';
import type { CanvasAssetMeta } from '../types/asset';
import type { NodeEntity, NodeLayout } from '../types/node';
import type { Matrix2D, Point } from '../types/geometry';
import type { ConnectorEndpoint, ConnectorEntity, ConnectorStyle } from '../types/connector';
import type {
  CanvasHistoryEntry,
  CanvasHistorySnapshot,
  CanvasOperationRecord,
  CommitOperationOptions,
  CanvasPatch
} from '../types/operation';
import type { DocumentChangeSet, EntityChanges } from '../types/change-set';
import {
  isAspectLocked,
  type CreateNodeRequest,
  type ResizeHandle,
  type NodeResizePolicy
} from '../protocols/node-type.protocol';
import { AssetAdapterError } from '../protocols/asset.protocol';
import type { WorldFrame } from '../utils/geometry';
import type { FontMeasurer } from '../protocols/font-measurer.protocol';
import { EntityStore, type EntityReader, type EntitySyncResult } from './entity-store';
import { OperationCoordinator, type HistoryChangeListener } from '../operation/coordinator';
import { normalizePatchPath } from '../operation/patch-path';
import { NodeTypeRegistry } from '../registry/node-type-registry';
import { LayoutRegistry } from '../registry/layout-registry';
import { clonePlainData } from '../utils/clone';
import { collectNodeDataPaths } from '../operation/node-change-paths';
import { generateId } from '../utils/id';
import { findCommitViolation, findInlineMediaUrl } from './commit-guards';
import { NODE_CLIPBOARD_KIND, type NodeClipboardPayload } from '../serialization/document-schema';
import {
  collectTextLayoutTargets,
  createFitContext,
  deriveTextLayoutPatches,
  scaleNodeTextBlocks,
  scaleTextBlockPixels
} from '../layout/text-layout';
import { deriveContainerPatches } from '../layout/container-derivation';
import { scaleConnectorTextBlocks } from '../layout/connector-label';
import { GROUP_NODE_TYPE } from '../layout/group-bounds-derivation';
import { findMemberRootId } from '../layout/layout-tree';
import { SelectionGeometry, type SelectionGeometryReader } from '../layout/selection-geometry';
import { computeSubtreeFootprint } from '../layout/subtree-footprint';
import {
  NODE_ALIGNMENT_LABELS,
  planNodeAlignment,
  planNodeAutoArrangement,
  planNodeDistribution,
  resolveArrangementTargets,
  type NodeAlignment,
  type NodeDistributionAxis,
  type NodeArrangementInfo,
  type NodeArrangementMove,
  type NodeAutoArrangeOptions
} from '../layout/selection-arrangement';
import { ConnectorSourceRegistry } from '../registry/connector-source-registry';
import {
  derivedConnectorId,
  isDerivedConnectorId,
  type DerivedNodeChange,
  type DerivedSourceChanges
} from '../protocols/connector-source.protocol';
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
import { parseCanvasHistory } from '../serialization/history-schema';
import { parseCanvasDocument, type ParseResult } from '../serialization/document-schema';
import {
  applyMatrix,
  applyMatrixToVector,
  computeFrameMatrix,
  computeNodeWorldBounds,
  computeWorldFrame,
  computeNodeLocalMatrix,
  decomposeNodeMatrix,
  invertMatrix,
  multiplyMatrix,
  roundPersisted,
  unionBounds
} from '../utils/geometry';

/** 创建空文档 */
export function createEmptyCanvasDocument(id = 'doc_root', name = '未命名画布'): CanvasDocument {
  const now = Date.now();
  return {
    id,
    name,
    meta: { version: 1, createdAt: now, updatedAt: now },
    content: { nodes: {}, connectors: {} },
    assets: {}
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
  /** 整体等比缩放后代、文本和内部连线；与仅修改外框尺寸分开。 */
  scaleContents?: boolean;
  /** 指针按下时的完整内容快照；每帧从原始数据计算，避免文字测量反写尺寸后破坏后续比例。 */
  scaleSnapshot?: NodeScaleSnapshot;
  /** 仅调整容器外框时保持内容世界位置，使用手势起始快照的直接子节点位姿。 */
  preserveContents?: boolean;
  /** 旋转手势的必要连线几何；每帧从起点计算，避免对已经取整的拐点累积变换。 */
  connectorSnapshot?: NodeConnectorTransformSnapshot;
  /** 共同手势显式声明的起点到目标矩阵；配合共享连线快照处理不同根之间的内部连线。 */
  connectorTransform?: { snapshot: NodeConnectorTransformSnapshot; matrix: Matrix2D };
}

export interface NodeConnectorTransformSnapshot {
  frame: WorldFrame;
  nodeIds: readonly string[];
  controlPoints: ReadonlyMap<string, readonly Point[] | undefined>;
}

export interface NodeScaleSnapshot {
  nodes: ReadonlyMap<string, { node: NodeEntity; frame: WorldFrame }>;
  connectors: ReadonlyMap<string, ConnectorEntity>;
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
export interface NodeArrangementCommandOptions extends CommandOptions {
  readonly subtreeNodeIds?: ReadonlySet<string>;
}

export type DocumentApi = Pick<
  DocumentStore,
  | 'getView'
  | 'readScope'
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
  | 'getNodeArrangementInfo'
  | 'selectionGeometry'
  | 'alignNodes'
  | 'distributeNodes'
  | 'autoArrangeNodes'
  | 'transformNodes'
  | 'captureConnectorTransformSnapshot'
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
  | 'groupNodes'
  | 'ungroupNodes'
  | 'canGroupNodes'
  | 'canUngroupNodes'
  | 'moveLayers'
  | 'holdLayoutMembers'
  | 'releaseLayoutMembers'
  | 'getNodeResizePolicy'
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
  /** 布局注册表：布局成员的排版据此取布局定义 (ADR-130) */
  layouts?: LayoutRegistry;
  /** 派生连线来源注册表 (ADR-130) */
  connectorSources?: ConnectorSourceRegistry;
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
  readonly layouts: LayoutRegistry;
  readonly connectorSources: ConnectorSourceRegistry;
  private readonly document: CanvasDocument;
  private readonly assetIds = new Set<string>();
  private readonly entities = new EntityStore();
  readonly selectionGeometry: SelectionGeometryReader;
  private readonly coordinator: OperationCoordinator<CanvasDocument>;
  private readonly subscribers = new Set<DocumentSubscriber>();
  private fontMeasurer: FontMeasurer | null = null;
  /** 派生连线 id → 所属来源与键 */
  private readonly derivedOrigins = new Map<string, { readonly sourceId: string; readonly key: string }>();
  /** 来源 id → 它当前拥有的派生连线 id */
  private readonly sourceConnectorIds = new Map<string, Set<string>>();
  private readonly connectorEnds: (connectorId: string) => readonly [Point, Point] | undefined;
  /** 交互中暂时托管、布局派生不回写位置的成员 (本地瞬态) */
  private readonly heldLayoutMembers = new Set<string>();

  constructor(initialDoc?: CanvasDocument, options?: DocumentStoreOptions) {
    // 外部传入文档属于不可信输入边界：深拷贝净化并切断与调用方的引用共享
    this.document = initialDoc ? clonePlainData(initialDoc) : createEmptyCanvasDocument();
    this.document.assets ??= {};
    for (const id of Object.keys(this.document.assets)) this.assetIds.add(id);
    // 资产表等 content 之外的字段同样不允许内联媒体，因此整份文档扫描一次
    const inlineMedia = findInlineMediaUrl(this.document);
    const violation = inlineMedia
      ? `${inlineMedia} 内联了 data:/blob: 媒体地址`
      : findCommitViolation(createEmptyCanvasDocument(), [
          { op: 'set', path: ['content'], value: this.document.content }
        ]);
    if (violation) throw new Error(`[DocumentStore] 文档非法：${violation}`);

    this.nodeTypes = options?.nodeTypes ?? new NodeTypeRegistry();
    this.layouts = options?.layouts ?? new LayoutRegistry();
    this.selectionGeometry = new SelectionGeometry(this.entities, this.layouts);
    this.connectorSources = options?.connectorSources ?? new ConnectorSourceRegistry();
    this.connectorEnds = options?.connectorEnds ?? (() => undefined);
    this.coordinator = new OperationCoordinator(this.document);
    const { nodes, connectors } = this.document.content;
    for (const id in nodes) this.entities.syncNode(id, nodes[id]);
    for (const id in connectors) this.entities.syncConnector(id, connectors[id]);
    this.connectorSources.onRefresh((sourceId) => this.refreshConnectorSource(sourceId));
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

  /** 运行时读取身份，事务内派生和事务外缓存必须分别校验；不进入文档或历史。 */
  get readScope(): object | null {
    return this.coordinator.readScope;
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

  getHistorySnapshot(): CanvasHistorySnapshot {
    return this.coordinator.getHistorySnapshot();
  }

  /** 恢复可信校验后的完整本地状态；必须由宿主决定恢复来源，不作为普通文件导入。 */
  restoreRecovery(document: unknown, history: unknown): ParseResult<void> {
    const parsed = parseCanvasDocument(document);
    if (!parsed.ok) return parsed;
    const checked = parseCanvasHistory(parsed.value, history);
    if (!checked.ok) return checked;
    const patches: CanvasPatch[] = Object.entries(parsed.value).map(([key, value]) => ({
      op: 'set',
      path: [key],
      value
    }));
    for (const key of Object.keys(this.document))
      if (!Object.hasOwn(parsed.value, key)) patches.push({ op: 'unset', path: [key] });
    const violation = findCommitViolation(this.document, patches);
    if (violation) return { ok: false, error: violation };
    const committed = this.coordinator.commitWithHistory(
      { patches, source: 'system', label: '恢复本地检查点' },
      checked.value
    );
    return committed ? { ok: true, value: undefined } : { ok: false, error: '当前事务或维护状态不允许恢复' };
  }

  /** 宿主维护能力，不向插件的 DocumentApi 开放。 */
  suspendWrites(): () => void {
    return this.coordinator.suspendWrites();
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
  batch<T>(fn: () => T, options?: string | { label?: string; groupId?: string }): T {
    return this.coordinator.batch(fn, options);
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

  /**
   * 注入或移除字体测量器：注入后本地事务中的文本与宽度变更会在同一事务内派生节点尺寸
   * 派生流水线：文字自动尺寸 → 按容器深度交错派生布局与组合外框 (ADR-130, ADR-145)
   */
  setFontMeasurer(measurer: FontMeasurer | null): void {
    this.fontMeasurer = measurer;
    const layoutContext = {
      layouts: this.layouts,
      previousParentId: (id: string) => this.entities.getIndexedParentId(id),
      previousChildIds: (id: string) => this.entities.getChildIds(id),
      isHeld: (id: string) => this.heldLayoutMembers.has(id)
    };
    this.coordinator.setPatchDerivations([
      ...(measurer
        ? [
            (doc: CanvasDocument, patches: readonly CanvasPatch[]) =>
              deriveTextLayoutPatches(
                doc,
                collectTextLayoutTargets(patches, doc, this.nodeTypes),
                measurer,
                this.nodeTypes
              )
          ]
        : []),
      (doc, patches) => deriveContainerPatches(doc, patches, layoutContext)
    ]);
  }

  /** 布局注册表变化后 (插件晚于文档注册或被卸载)：全部布局树重新排版，系统事务，不进撤销栈 */
  refreshLayouts(): void {
    const patches = deriveContainerPatches(this.document, [{ op: 'set', path: ['content', 'nodes'], value: null }], {
      layouts: this.layouts,
      previousParentId: () => undefined,
      previousChildIds: (id) => this.entities.getChildIds(id),
      isHeld: (id) => this.heldLayoutMembers.has(id)
    });
    if (patches.length > 0) this.commit({ label: '重新排版', source: 'system', undoable: false, patches });
  }

  /**
   * 托管布局成员 (本地瞬态，不持久化、不同步)：交互期间 (如拖拽堆叠成员跟随指针) 成员仍参与排版并占据槽位，
   * 但布局派生不回写其位置；以新集合整体替换此前的托管集合
   */
  holdLayoutMembers(nodeIds: Iterable<string>): void {
    this.heldLayoutMembers.clear();
    for (const id of nodeIds) this.heldLayoutMembers.add(id);
  }

  /**
   * 释放全部托管成员，并把它们仍所在的布局树重新排版归位
   * 归位补丁以 options 提交 (传入交互的 groupId 即与该交互同一步撤销)；无托管或无位置变化时不提交
   */
  releaseLayoutMembers(options?: CommandOptions): CanvasOperationRecord | null {
    if (this.heldLayoutMembers.size === 0) return null;
    const released = [...this.heldLayoutMembers];
    this.heldLayoutMembers.clear();
    // 只借 layoutItem 触发字段找出受影响的布局树；这些探测补丁本身不提交
    const probes: CanvasPatch[] = released
      .filter((id) => Object.hasOwn(this.document.content.nodes, id))
      .map((id) => ({ op: 'set', path: ['content', 'nodes', id, 'layoutItem'], value: null }));
    if (probes.length === 0) return null;
    const patches = deriveContainerPatches(this.document, probes, {
      layouts: this.layouts,
      previousParentId: () => undefined,
      previousChildIds: (id) => this.entities.getChildIds(id)
    });
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? '布局归位', patches });
  }

  /** 全量重算某来源的派生连线 (来源注册、卸载或其依赖的外部条件变化)，有变化时广播 */
  private refreshConnectorSource(sourceId: string): void {
    const connectorChanges = createEntityChanges();
    const orderChanged = this.syncDerivedConnectors(null, connectorChanges, sourceId);
    if (!orderChanged && connectorChanges.geometry.size === 0 && connectorChanges.data.size === 0) return;
    const record: CanvasOperationRecord = {
      id: generateId('op'),
      label: '刷新派生连线',
      timestamp: Date.now(),
      origin: 'local',
      source: 'system',
      undoable: false,
      patches: [],
      inversePatches: []
    };
    this.broadcast(record, {
      contentReplaced: false,
      assets: new Set(),
      nodes: { ...createEntityChanges(), worldGeometry: new Set(), reparented: new Set() },
      connectors: connectorChanges,
      orderChanged
    });
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
    const node = this.createNodeEntity(request);
    if (Object.hasOwn(this.document.content.nodes, node.id)) {
      console.error(`[SkyNote:DocumentStore] 节点 id 已存在，拒绝覆盖: ${node.id}`);
      return null;
    }
    const patches: CanvasPatch[] = [{ op: 'set', path: ['content', 'nodes', node.id], value: node }];
    const definition = this.nodeTypes.get(node.nodeType);
    if (definition?.acceptsChildren && request.autoWrap !== false) {
      this.appendAutoWrapPatches(node, patches);
    }
    const record = this.commit({
      label: request.label ?? '添加节点',
      patches
    });
    return record ? node.id : null;
  }

  /** 在同一个原子事务中登记资产元数据并创建引用它的节点 */
  createNodeWithAsset<T extends string>(request: CreateNodeRequest<T>, asset: CanvasAssetMeta): string | null {
    const node = this.createNodeEntity(request);
    if (Object.hasOwn(this.document.assets!, asset.id) || Object.hasOwn(this.document.content.nodes, node.id))
      return null;
    const record = this.commit({
      label: request.label ?? '插入图片',
      patches: [
        { op: 'set', path: ['assets', asset.id], value: asset },
        { op: 'set', path: ['content', 'nodes', node.id], value: node }
      ]
    });
    return record ? node.id : null;
  }

  /** 将新资产登记并替换所选图片节点的引用；同一补丁保证撤销时图片与资产元数据同步恢复 */
  replaceImagesWithAsset(nodeIds: Iterable<string>, asset: CanvasAssetMeta): CanvasOperationRecord | null {
    if (Object.hasOwn(this.document.assets ?? {}, asset.id)) return null;
    const patches: CanvasPatch[] = [{ op: 'set', path: ['assets', asset.id], value: asset }];
    let replacedCount = 0;
    for (const id of new Set(nodeIds)) {
      const node = this.document.content.nodes[id];
      const image = (node as (NodeEntity & { image?: { assetId?: unknown; [key: string]: unknown } }) | undefined)
        ?.image;
      if (!image || typeof image.assetId !== 'string') continue;
      patches.push({
        op: 'set',
        path: ['content', 'nodes', id, 'image'],
        value: { ...image, assetId: asset.id }
      });
      replacedCount++;
    }
    if (replacedCount === 0) return null;
    return this.commit({ label: '替换图片', patches });
  }

  private createNodeEntity<T extends string>(request: CreateNodeRequest<T>): NodeEntity {
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
    return node;
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
      for (const id of this.documentConnectorIdsOfNode(nodeId)) {
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
    const { connectors } = this.document.content;
    // 派生连线不经通用命令删除：它由文档数据推导，删不删由来源对应的数据决定
    const connectorIds = new Set<string>();
    for (const id of refs.connectorIds ?? []) {
      if (Object.hasOwn(connectors, id)) connectorIds.add(id);
    }
    const patches: CanvasPatch[] = [];
    for (const id of removed) {
      patches.push({ op: 'unset', path: ['content', 'nodes', id] });
      for (const connectorId of this.documentConnectorIdsOfNode(id)) connectorIds.add(connectorId);
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
    const assets: Record<string, CanvasAssetMeta> = {};
    for (const node of [...subtrees.topmost, ...subtrees.descendants]) {
      for (const id of this.nodeTypes.get(node.nodeType)?.assets?.collect(node) ?? []) {
        const asset = this.document.assets?.[id];
        if (!asset) throw new AssetAdapterError('missing-asset', '复制图片缺少资产元数据');
        assets[id] = clonePlainData(asset);
      }
    }
    return {
      kind: NODE_CLIPBOARD_KIND,
      version: 1,
      nodes: [...subtrees.topmost, ...subtrees.descendants],
      connectors: subtrees.connectors,
      assets
    };
  }

  /**
   * 粘贴剪贴板中的节点与连线 (数据须先经 parseNodeClipboard 校验)：全部换新 id，放在根层级 (或 parentId 容器)
   * 最上方，保持世界位姿并按世界位移 offset 偏移，一步撤销
   * @returns 粘贴出的最顶层节点与连线 id；提交被拒绝时为空
   */
  pasteEntities(
    payload: NodeClipboardPayload,
    offset: Point,
    options?: CommandOptions & { parentId?: string }
  ): EntityIds {
    const { parentId, ...commandOptions } = options ?? {};
    const parentMatrix = parentId === undefined ? undefined : this.entities.getWorldTransform(parentId);
    if (parentId !== undefined && !parentMatrix) return { nodeIds: [], connectorIds: [] };
    const toParentLocal = parentMatrix && invertMatrix(parentMatrix);
    const ids = new Set(payload.nodes.map((node) => node.id));
    const isTopmost = (node: NodeEntity) => node.parentId === undefined || !ids.has(node.parentId);
    // 剪贴板中最顶层节点是世界位姿：放进容器时换算为容器局部位姿
    const topmost = payload.nodes.filter(isTopmost).map(({ parentId: _parentId, ...node }): NodeEntity => {
      if (!toParentLocal) return node;
      const pose = decomposeNodeMatrix(
        multiplyMatrix(toParentLocal, computeNodeLocalMatrix(node)),
        node.width,
        node.height
      );
      return { ...node, ...pose, parentId };
    });
    const descendants = payload.nodes.filter((node) => !isTopmost(node));
    return this.insertSubtrees(
      { topmost, descendants, connectors: payload.connectors },
      offset,
      {
        ...commandOptions,
        label: commandOptions.label ?? '粘贴'
      },
      payload.assets
    );
  }

  /**
   * 整体替换文档内容 (导入文件、从本地存储恢复)；内容须先经 parseCanvasDocument 校验
   * 默认可撤销：导入后撤销一步即回到原内容
   */
  replaceContent(
    content: CanvasContent,
    options?: CommandOptions,
    assets?: Record<string, CanvasAssetMeta>
  ): CanvasOperationRecord | null {
    const patches: CanvasPatch[] = [{ op: 'set', path: ['content'], value: content }];
    if (assets !== undefined) patches.push({ op: 'set', path: ['assets'], value: assets });
    return this.commit({
      ...options,
      label: options?.label ?? '导入文档',
      patches
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
      for (const connectorId of this.documentConnectorIdsOfNode(id)) {
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

  /** 顶层有效目标数量及不可手动排版原因；不计算外框或扫描全图。 */
  getNodeArrangementInfo(nodeIds: Iterable<string>): NodeArrangementInfo {
    return resolveArrangementTargets(nodeIds, (id) => this.document.content.nodes[id]).info;
  }

  alignNodes(
    nodeIds: Iterable<string>,
    alignment: NodeAlignment,
    options?: NodeArrangementCommandOptions
  ): CanvasOperationRecord | null {
    return this.arrangeNodes(nodeIds, { alignment }, options);
  }

  distributeNodes(
    nodeIds: Iterable<string>,
    axis: NodeDistributionAxis,
    options?: NodeArrangementCommandOptions
  ): CanvasOperationRecord | null {
    return this.arrangeNodes(nodeIds, { axis }, options);
  }

  /** 单次整理成网格，不创建容器或持续布局关系。 */
  autoArrangeNodes(
    nodeIds: Iterable<string>,
    settings?: NodeAutoArrangeOptions,
    options?: NodeArrangementCommandOptions
  ): CanvasOperationRecord | null {
    return this.arrangeNodes(nodeIds, { auto: settings ?? {} }, options);
  }

  private arrangeNodes(
    nodeIds: Iterable<string>,
    mode: { alignment: NodeAlignment } | { axis: NodeDistributionAxis } | { auto: NodeAutoArrangeOptions },
    options?: NodeArrangementCommandOptions
  ): CanvasOperationRecord | null {
    const targets = resolveArrangementTargets(nodeIds, (id) => this.document.content.nodes[id]);
    if (targets.info.blockedBy || targets.nodes.length < ('axis' in mode ? 3 : 2)) return null;
    const items = targets.nodes.map((node) => ({
      id: node.id,
      bounds:
        options?.subtreeNodeIds?.has(node.id) ||
        ('auto' in mode && node.layout && this.layouts.get(node.layout.type)?.footprint === 'subtree')
          ? this.selectionGeometry.getSubtreeBounds(node.id)!
          : computeNodeWorldBounds(node, this.entities.getWorldTransform(node.id)!)
    }));
    const moves =
      'alignment' in mode
        ? planNodeAlignment(items, mode.alignment)
        : 'axis' in mode
          ? planNodeDistribution(items, mode.axis)
          : planNodeAutoArrangement(items, mode.auto);
    const patches: CanvasPatch[] = [];
    const carried = new Set<string>();
    for (const move of moves) this.appendArrangementMove(move, patches, carried);
    if (!patches.length) return null;
    const label =
      'alignment' in mode
        ? NODE_ALIGNMENT_LABELS[mode.alignment]
        : 'auto' in mode
          ? '自动排列'
          : mode.axis === 'horizontal'
            ? '水平等距分布'
            : '垂直等距分布';
    const { subtreeNodeIds: _scope, ...commandOptions } = options ?? {};
    return this.commit({ ...commandOptions, label: options?.label ?? label, patches });
  }

  private appendArrangementMove(move: NodeArrangementMove, patches: CanvasPatch[], carried: Set<string>): void {
    const { id, delta } = move;
    if (Math.abs(delta.x) < 1e-6 && Math.abs(delta.y) < 1e-6) return;
    const node = this.document.content.nodes[id];
    const parent = node.parentId === undefined ? undefined : this.entities.getWorldTransform(node.parentId);
    const local = parent ? applyMatrixToVector(invertMatrix(parent), delta.x, delta.y) : delta;
    const x = Math.abs(local.x) < 1e-6 ? node.x : Math.round(node.x + local.x);
    const y = Math.abs(local.y) < 1e-6 ? node.y : Math.round(node.y + local.y);
    if (x === node.x && y === node.y) return;
    if (x !== node.x) patches.push({ op: 'set', path: ['content', 'nodes', id, 'x'], value: x });
    if (y !== node.y) patches.push({ op: 'set', path: ['content', 'nodes', id, 'y'], value: y });
    // 连线拐点跟随实际取整后的世界位移，复用容器变换的内部连线认领规则。
    const actual = parent ? applyMatrixToVector(parent, x - node.x, y - node.y) : { x: x - node.x, y: y - node.y };
    this.carryConnectors(
      this.collectContentScaleIds(id, new Set()),
      { a: 1, b: 0, c: 0, d: 1, e: actual.x, f: actual.y },
      carried,
      patches
    );
  }

  /**
   * 变换节点 (缩放、旋转)：frame 为世界坐标中的新外框，换算为父容器局部坐标后一次提交，只写有变化的字段
   * 后代坐标相对容器，随容器移动与旋转，不产生补丁 (ADR-114)；组合 (group) 发生尺寸缩放时将缩放比例传播至后代 (ADR-145)；
   * 高频拖拽通过 groupId 折叠为一步撤销
   */
  transformNodes(transforms: readonly NodeTransform[], options?: CommandOptions): CanvasOperationRecord | null {
    const { nodes } = this.document.content;
    const patches: CanvasPatch[] = [];
    const carried = new Set<string>();
    const explicitIds = new Set(transforms.map((t) => t.id));
    const effective: (NodeTransform & { fieldsNormalized?: boolean })[] = [];
    const scaledNodes = new Map<string, Partial<NodeEntity>>();

    const pending = [...transforms];
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index];
      const { id, frame } = item;
      if (!Object.hasOwn(nodes, id)) continue;
      const node = nodes[id];
      const original = item.scaleSnapshot?.nodes.get(id);
      const sourceNode = original?.node ?? node;
      const sourceNodes = item.scaleSnapshot?.nodes;
      const sourceConnectors = item.scaleSnapshot?.connectors;
      const resized = Math.abs(frame.width - node.width) > 1e-6 || Math.abs(frame.height - node.height) > 1e-6;
      if (item.scaleContents && (resized || original)) {
        const kx = frame.width / sourceNode.width;
        const ky = frame.height / sourceNode.height;
        if (!Number.isFinite(kx) || Math.abs(kx - ky) > 1e-4) return null;
        const fields = this.scaleContentFields(sourceNode, kx);
        effective.push({ ...item, fields: { ...item.fields, ...fields }, fieldsNormalized: true });
        const scope = this.collectContentScaleIds(id, explicitIds, sourceNodes);
        for (let childIndex = 1; childIndex < scope.length; childIndex++) {
          const childId = scope[childIndex];
          const child = sourceNodes?.get(childId)?.node ?? nodes[childId];
          const scaled = {
            x: Math.round(child.x * kx),
            y: Math.round(child.y * kx),
            width: child.width === 0 ? 0 : Math.max(1, Math.round(child.width * kx)),
            height: child.height === 0 ? 0 : Math.max(1, Math.round(child.height * kx)),
            ...this.scaleContentFields(child, kx)
          };
          scaledNodes.set(childId, scaled);
          this.appendTransformPatches(childId, scaled, patches);
        }
        const oldFrame = original?.frame ?? computeWorldFrame(node, this.entities.getWorldTransform(id)!);
        const delta = multiplyMatrix(
          multiplyMatrix(computeFrameMatrix(frame), { a: kx, b: 0, c: 0, d: kx, e: 0, f: 0 }),
          invertMatrix(computeFrameMatrix(oldFrame))
        );
        this.carryConnectors(scope, delta, carried, patches, sourceConnectors, kx);
        continue;
      }
      if (node.nodeType === GROUP_NODE_TYPE && (resized || original)) {
        const leaves: string[] = [];
        const scope = new Set([id]);
        this.collectGroupLeaves(id, explicitIds, leaves, scope, sourceNodes);
        if (leaves.length > 0) {
          const oldGroupFrame = original?.frame ?? computeWorldFrame(node, this.entities.getWorldTransform(id)!);
          const toOldGroup = invertMatrix(computeFrameMatrix(oldGroupFrame));
          const fromNewGroup = computeFrameMatrix(frame);
          const kx = oldGroupFrame.width > 0 ? frame.width / oldGroupFrame.width : 1;
          const ky = oldGroupFrame.height > 0 ? frame.height / oldGroupFrame.height : 1;
          const uniform = Math.abs(kx - ky) < 1e-4;
          const scale = uniform ? kx : 1;
          const dRot = frame.rotation - oldGroupFrame.rotation;
          const groupDelta = multiplyMatrix(
            multiplyMatrix(fromNewGroup, { a: kx, b: 0, c: 0, d: ky, e: 0, f: 0 }),
            toOldGroup
          );
          // 连线只属于本次实际变换的成员；锁定组、独立显式目标及其后代不能被提前认领。
          if (uniform) {
            for (const leafId of leaves) {
              if (!this.nodeTypes.get(nodes[leafId].nodeType)?.supportsContentScale) continue;
              for (const memberId of this.collectContentScaleIds(leafId, explicitIds, sourceNodes)) scope.add(memberId);
            }
          }
          this.carryConnectors([...scope], groupDelta, carried, patches, sourceConnectors, uniform ? scale : undefined);
          for (const leafId of leaves) {
            if (sourceNodes && !sourceNodes.has(leafId)) continue;
            const leaf = sourceNodes?.get(leafId)?.node ?? nodes[leafId];
            const leafFrame =
              sourceNodes?.get(leafId)?.frame ?? computeWorldFrame(leaf, this.entities.getWorldTransform(leafId)!);
            const c = applyMatrix(toOldGroup, leafFrame.cx, leafFrame.cy);
            const center = applyMatrix(fromNewGroup, c.x * kx, c.y * ky);
            const nextLeafFrame: WorldFrame = {
              cx: center.x,
              cy: center.y,
              width: leafFrame.width === 0 ? 0 : Math.max(1, leafFrame.width * kx),
              height: leafFrame.height === 0 ? 0 : Math.max(1, leafFrame.height * ky),
              rotation: leafFrame.rotation + dRot
            };
            if (this.nodeTypes.get(leaf.nodeType)?.supportsContentScale && uniform) {
              pending.push({
                id: leafId,
                frame: nextLeafFrame,
                scaleContents: true,
                scaleSnapshot: item.scaleSnapshot
              });
            } else {
              const fields = uniform
                ? this.scaleContentFields(leaf, scale)
                : this.nodeTypes.get(leaf.nodeType)?.applyResize?.(leaf, {
                    handle: 'se',
                    width: nextLeafFrame.width,
                    height: nextLeafFrame.height,
                    scale
                  });
              effective.push({ id: leafId, frame: nextLeafFrame, fields, fieldsNormalized: uniform });
            }
          }
          continue;
        }
        // 没有可变换叶子时，外框仍由内容派生；不能写入再被派生撤回而制造空历史。
        continue;
      }
      effective.push(item);
    }

    const planned = this.planTransformGeometry(effective, scaledNodes);
    for (const [id, fields] of planned.fields) this.appendTransformPatches(id, fields, patches);
    const sharedConnectors = new Map<NodeConnectorTransformSnapshot, Matrix2D>();
    for (const { id, preserveContents, connectorSnapshot, connectorTransform } of effective) {
      if (!Object.hasOwn(nodes, id)) continue;
      if (preserveContents) continue;
      const source = connectorTransform?.snapshot ?? connectorSnapshot;
      if (connectorTransform) {
        const previous = sharedConnectors.get(connectorTransform.snapshot);
        if (previous) {
          // 同一快照声明共同矩阵；重复根不能再次扫描整个选区，也不能静默采用冲突矩阵。
          if (!areStructuredValuesEqual(previous, connectorTransform.matrix)) return null;
          continue;
        }
        sharedConnectors.set(connectorTransform.snapshot, connectorTransform.matrix);
      }
      // 容器内的连线随后代一起移动旋转：自由端与手动拐点是世界坐标，按容器自身坐标系的变化一并换算
      const delta =
        connectorTransform?.matrix ??
        multiplyMatrix(
          planned.world.get(id)!,
          invertMatrix(source ? computeFrameMatrix(source.frame) : this.entities.getWorldTransform(id)!)
        );
      const scope =
        source && (connectorTransform || explicitIds.size === 1)
          ? source.nodeIds
          : this.collectContentScaleIds(id, explicitIds);
      this.carryConnectors(scope, delta, carried, patches, undefined, undefined, source?.controlPoints);
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? '变换节点', patches });
  }

  /** 只冻结成员和内部拐点；独立子目标可排除其子树，避免嵌套多选重复保存与认领。 */
  captureConnectorTransformSnapshot(
    nodeIds: Iterable<string>,
    frame: WorldFrame,
    excludedRoots?: ReadonlySet<string>
  ): NodeConnectorTransformSnapshot {
    const members: string[] = [];
    const ids = [...new Set(nodeIds)].filter((id) => this.entities.hasNode(id));
    // 单根不需要判定选中祖先，深层嵌套逐根捕获时不能重复遍历完整父链。
    for (const id of ids.length === 1 ? ids : this.collectTopmost(ids)) {
      if (excludedRoots) {
        for (const memberId of this.collectContentScaleIds(id, excludedRoots)) members.push(memberId);
      } else {
        members.push(id);
        for (const childId of this.entities.collectDescendantIds(id)) members.push(childId);
      }
    }
    const inside = new Set(members);
    const controlPoints = new Map<string, readonly Point[] | undefined>();
    for (const id of members) {
      for (const connectorId of this.documentConnectorIdsOfNode(id)) {
        if (controlPoints.has(connectorId)) continue;
        const connector = this.document.content.connectors[connectorId];
        if (!inside.has(connector.from.nodeId!) || !inside.has(connector.to.nodeId!)) continue;
        controlPoints.set(
          connectorId,
          connector.controlPoints?.map((point) => ({ ...point }))
        );
      }
    }
    return { frame, nodeIds: members, controlPoints };
  }

  /** 父子显式目标共用提交前的最终几何规划；祖先只求解一次，派生 Group 仍沿用现有局部坐标系。 */
  private planTransformGeometry(
    transforms: readonly (NodeTransform & { fieldsNormalized?: boolean })[],
    scaledNodes: ReadonlyMap<string, Partial<NodeEntity>>
  ): { fields: Map<string, Partial<NodeEntity>>; world: Map<string, Matrix2D> } {
    const { nodes } = this.document.content;
    const targets = new Map(transforms.map((item) => [item.id, item]));
    const preserved = new Map<string, WorldFrame>();
    for (const { id, preserveContents, scaleSnapshot } of transforms) {
      if (!preserveContents || !scaleSnapshot) continue;
      for (const childId of this.entities.getChildIds(id)) {
        const child = scaleSnapshot.nodes.get(childId);
        if (child && !targets.has(childId)) preserved.set(childId, child.frame);
      }
    }
    const fields = new Map<string, Partial<NodeEntity>>();
    const world = new Map<string, Matrix2D>();
    const changedWorld = new Set<string>();
    for (const id of [...targets.keys(), ...preserved.keys()]) {
      const path: string[] = [];
      let current: string | undefined = id;
      while (current !== undefined && Object.hasOwn(nodes, current) && !world.has(current)) {
        path.push(current);
        current = nodes[current].parentId;
      }
      for (let i = path.length - 1; i >= 0; i--) {
        const nodeId = path[i];
        const node = nodes[nodeId];
        const parent = node.parentId === undefined ? undefined : world.get(node.parentId);
        const target = targets.get(nodeId);
        const frame = target?.frame ?? preserved.get(nodeId);
        let next = scaledNodes.get(nodeId);
        if (!frame && !next && (node.parentId === undefined || !changedWorld.has(node.parentId))) {
          // 未受本次规划影响的祖先复用运行时矩阵，深层叶子变换不为整条祖先链重复分配矩阵。
          world.set(nodeId, this.entities.getWorldTransform(nodeId)!);
          continue;
        }
        if (frame) {
          const matrix = computeFrameMatrix(frame);
          const local = parent ? multiplyMatrix(invertMatrix(parent), matrix) : matrix;
          const pose = decomposeNodeMatrix(local, frame.width, frame.height);
          next = { x: Math.round(pose.x), y: Math.round(pose.y), rotation: Math.round(pose.rotation) };
          if (target) {
            next = {
              ...next,
              width: frame.width === 0 ? 0 : Math.max(1, Math.round(frame.width)),
              height: frame.height === 0 ? 0 : Math.max(1, Math.round(frame.height)),
              ...this.roundResizeFields(target.fields ?? {}, !target.fieldsNormalized)
            };
          }
          fields.set(nodeId, next);
        }
        const local = computeNodeLocalMatrix(next ? { ...node, ...next } : node);
        world.set(nodeId, parent ? multiplyMatrix(parent, local) : local);
        changedWorld.add(nodeId);
      }
    }
    return { fields, world };
  }

  /** 变换字段与普通更新保持同一删除语义，避免 set undefined 的历史在 JSON 往返后失效。 */
  private appendTransformPatches(id: string, fields: Partial<NodeEntity>, patches: CanvasPatch[]): void {
    const node = this.document.content.nodes[id];
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'id' || key === 'type') continue;
      const path = ['content', 'nodes', id, key];
      if (value === undefined) {
        if (Object.hasOwn(node, key)) patches.push({ op: 'unset', path });
      } else if (!areStructuredValuesEqual(node[key as keyof NodeEntity], value))
        patches.push({ op: 'set', path, value });
    }
  }

  /** 整体缩放显式固化有效字号、像素行高及文本内边距，避免默认样式或行内样式留在原比例。 */
  private scaleContentFields(node: NodeEntity, scale: number): Partial<NodeEntity> {
    const definition = this.nodeTypes.get(node.nodeType);
    const fields = this.roundResizeFields(
      definition?.applyContentScale?.(node, scale) ??
        definition?.applyResize?.(node, {
          handle: 'se',
          width: node.width * scale,
          height: node.height * scale,
          scale
        }) ??
        {},
      true
    );
    // hook 的显式文本是最终值，包括移除；没有返回文本时才使用统一默认缩放。
    if (Object.hasOwn(fields, 'textBlocks') || !node.textBlocks) return fields;
    return { ...fields, textBlocks: scaleNodeTextBlocks(node, definition, scale) };
  }

  /** 类型插件可返回小数描边；只规范像素属性，透明度等比例值保留原语义。 */
  private roundResizeFields(fields: Partial<NodeEntity>, includeText = false): Partial<NodeEntity> {
    if (includeText && fields.textBlocks)
      fields = { ...fields, textBlocks: fields.textBlocks.map((block) => scaleTextBlockPixels(block, 1)) };
    if (!fields.style) return fields;
    const { strokeWidth, radius } = fields.style;
    return {
      ...fields,
      style: {
        ...fields.style,
        ...(strokeWidth !== undefined
          ? { strokeWidth: strokeWidth === 0 ? 0 : Math.max(1, Math.round(strokeWidth)) }
          : {}),
        ...(radius !== undefined
          ? {
              radius:
                typeof radius === 'number'
                  ? Math.round(radius)
                  : (radius.map(Math.round) as [number, number, number, number])
            }
          : {})
      }
    };
  }

  /** 用迭代器栈保持深度优先顺序，非组合容器作为整体叶子；深链不占调用栈，也不复制宽层成员数组。 */
  private collectGroupLeaves(
    groupId: string,
    explicitIds: ReadonlySet<string>,
    out: string[],
    scope?: Set<string>,
    sourceNodes?: NodeScaleSnapshot['nodes']
  ): void {
    const { nodes } = this.document.content;
    const stack = [{ id: groupId, children: this.entities.getChildIds(groupId).values(), complete: true }];
    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      const next = current.children.next();
      if (next.done) {
        stack.pop();
        // 含排除成员的逻辑组不一定按同一仿射矩阵改变外框，不能替它认领连线。
        if (!current.complete) {
          scope?.delete(current.id);
          if (stack.length > 0) stack[stack.length - 1].complete = false;
        }
        continue;
      }
      const child = nodes[next.value];
      if (!child || child.locked || explicitIds.has(child.id) || (sourceNodes && !sourceNodes.has(child.id))) {
        current.complete = false;
        continue;
      }
      scope?.add(child.id);
      if (child.nodeType === GROUP_NODE_TYPE) {
        stack.push({ id: child.id, children: this.entities.getChildIds(child.id).values(), complete: true });
      } else {
        out.push(child.id);
      }
    }
  }

  /** 显式目标拥有自己的子树；快照之外的新成员不能回退到 live 起点参与绝对倍率计算。 */
  private collectContentScaleIds(
    id: string,
    explicitIds: ReadonlySet<string>,
    sourceNodes?: NodeScaleSnapshot['nodes']
  ): string[] {
    const scope = [id];
    for (let index = 0; index < scope.length; index++) {
      for (const childId of this.entities.getChildIds(scope[index])) {
        if (explicitIds.has(childId) || (sourceNodes && !sourceNodes.has(childId))) continue;
        scope.push(childId);
      }
    }
    return scope;
  }

  /**
   * 两端都连在 subtree 内节点上的连线：拐点按矩阵换算，整体等比缩放时标注像素同步换算，每条只处理一次。
   * @param carried 本次事务已处理的连线
   */
  private carryConnectors(
    subtree: readonly string[],
    m: Matrix2D,
    carried: Set<string>,
    patches: CanvasPatch[],
    originals?: ReadonlyMap<string, ConnectorEntity>,
    contentScale?: number,
    pointOriginals?: ReadonlyMap<string, readonly Point[] | undefined>
  ): void {
    const { connectors } = this.document.content;
    const inside = new Set(subtree);
    const contains = (end: ConnectorEndpoint) => end.nodeId !== undefined && inside.has(end.nodeId);
    const map = (p: Point): Point => applyMatrix(m, p.x, p.y);
    for (const nodeId of subtree) {
      for (const id of this.documentConnectorIdsOfNode(nodeId)) {
        if (originals && !originals.has(id)) continue;
        if (pointOriginals && !pointOriginals.has(id)) continue;
        const c = originals?.get(id) ?? connectors[id];
        if (carried.has(id) || !contains(c.from) || !contains(c.to)) continue;
        carried.add(id);
        const sourcePoints = pointOriginals ? pointOriginals.get(id) : c.controlPoints;
        if (sourcePoints) {
          const points = sourcePoints.map((point) => {
            const next = map(point);
            return { x: Math.round(next.x), y: Math.round(next.y) };
          });
          if (!areStructuredValuesEqual(connectors[id].controlPoints, points))
            patches.push({
              op: 'set',
              path: ['content', 'connectors', id, 'controlPoints'],
              value: points
            });
        }
        if (contentScale !== undefined && c.textBlocks) {
          const blocks = scaleConnectorTextBlocks(c.textBlocks, contentScale);
          if (!areStructuredValuesEqual(connectors[id].textBlocks, blocks))
            patches.push({
              op: 'set',
              path: ['content', 'connectors', id, 'textBlocks'],
              value: blocks
            });
        }
      }
    }
  }

  /** 手柄、尺寸面板与命令共用约束；组合约束只访问非组合叶子。 */
  getNodeResizePolicy(
    id: string,
    source: 'pointer' | 'size' = 'pointer',
    handle: ResizeHandle = 'se'
  ): NodeResizePolicy {
    const node = this.document.content.nodes[id];
    if (!node) return { behavior: 'resize-bounds', axes: 'none', lockAspect: false };
    const definition = this.nodeTypes.get(node.nodeType);
    const behavior =
      node.nodeType === GROUP_NODE_TYPE
        ? 'scale-contents'
        : source === 'pointer'
          ? (definition?.getResizeBehavior?.(node, handle) ?? 'resize-bounds')
          : 'resize-bounds';
    let axes =
      behavior === 'scale-contents'
        ? ('both' as const)
        : (definition?.getResizeAxes?.(node) ?? definition?.resize ?? 'both');
    let lockAspect =
      (!!definition?.supportsContentScale && behavior === 'scale-contents') || isAspectLocked(node, definition);
    if (node.nodeType === GROUP_NODE_TYPE) {
      for (const memberId of this.entities.collectDescendantIds(id)) {
        const member = this.document.content.nodes[memberId];
        if (member.layout && this.layouts.get(member.layout.type)?.supportsContentScale === false)
          return { behavior, axes: 'none', lockAspect: false };
      }
      const leaves: string[] = [];
      this.collectGroupLeaves(id, new Set(), leaves);
      if (leaves.length === 0) return { behavior, axes: 'none', lockAspect: false };
      const rootRotation = computeWorldFrame(node, this.entities.getWorldTransform(id)!).rotation;
      let width = true,
        height = true;
      for (const childId of leaves) {
        const child = this.document.content.nodes[childId];
        const type = this.nodeTypes.get(child.nodeType);
        const childAxes = type?.supportsContentScale
          ? 'both'
          : (type?.getResizeAxes?.(child) ?? type?.resize ?? 'both');
        const rotation = computeWorldFrame(child, this.entities.getWorldTransform(childId)!).rotation - rootRotation;
        lockAspect ||= Math.abs(rotation % 360) > 1e-4 || isAspectLocked(child, type) || !!type?.supportsContentScale;
        if (childAxes !== 'both' && Math.abs(rotation % 180) > 1e-4) {
          width = false;
          height = false;
        }
        width &&= childAxes === 'width' || childAxes === 'both';
        height &&= childAxes === 'height' || childAxes === 'both';
      }
      axes =
        lockAspect && (!width || !height) ? 'none' : width ? (height ? 'both' : 'width') : height ? 'height' : 'none';
    }
    return { behavior, axes, lockAspect };
  }

  /** 尺寸面板以世界左上角为锚调整外框；组合按共用策略将变换传播到成员。 */
  resizeNodes(
    nodeIds: Iterable<string>,
    size: { width?: number; height?: number },
    options?: CommandOptions,
    snapshots?: ReadonlyMap<string, NodeScaleSnapshot>
  ): CanvasOperationRecord | null {
    const { nodes } = this.document.content;
    const handle: ResizeHandle = size.height === undefined ? 'e' : size.width === undefined ? 's' : 'se';
    const transforms: NodeTransform[] = [];
    for (const id of nodeIds) {
      if (!Object.hasOwn(nodes, id)) continue;
      const snapshot = snapshots?.get(id);
      const node = snapshot?.nodes.get(id)?.node ?? nodes[id];
      const definition = this.nodeTypes.get(node.nodeType);
      let width = size.width ?? node.width;
      let height = size.height ?? node.height;
      const policy = this.getNodeResizePolicy(id, 'size', handle);
      const axes = policy.axes;
      if (axes === 'none') continue;
      if (axes === 'height') width = node.width;
      if (axes === 'width') height = node.height;
      const scalesContainerGroup = node.nodeType === GROUP_NODE_TYPE && policy.lockAspect;
      let scale = 1;
      if (axes === 'both' && policy.lockAspect) {
        if (handle === 'e' && node.width > 0) {
          scale = width / node.width;
          width = node.width * scale;
          height = node.height * scale;
        } else if (handle === 's' && node.height > 0) {
          scale = height / node.height;
          width = node.width * scale;
          height = node.height * scale;
        } else if (handle === 'se' && (node.width > 0 || node.height > 0)) {
          scale =
            node.width > 0 && node.height > 0
              ? Math.max(width / node.width, height / node.height)
              : node.width > 0
                ? width / node.width
                : height / node.height;
        }
      }
      if (scalesContainerGroup) {
        width = node.width * scale;
        height = node.height * scale;
      }
      // 旧节点局部坐标中左上角仍在原点，新中心 (w/2, h/2) 经旧世界矩阵换算即可
      const sourceFrame = snapshot?.nodes.get(id)?.frame;
      const frame = computeWorldFrame(
        { width, height },
        sourceFrame ? computeFrameMatrix(sourceFrame) : this.entities.getWorldTransform(id)!
      );
      const fields = definition?.applyResize?.(node, { handle, width, height, scale });
      transforms.push({ id, frame, fields, scaleSnapshot: snapshot });
    }
    return this.transformNodes(transforms, { ...options, label: options?.label ?? '调整尺寸' });
  }

  /**
   * 绕选中节点整体外接框的中心增量旋转 (支持多选)：与拖动旋转控制柄的结果一致
   * 只变换最顶层选中节点，后代随容器旋转
   */
  rotateNodes(nodeIds: Iterable<string>, degrees: number, options?: CommandOptions): CanvasOperationRecord | null {
    degrees = Math.round(degrees);
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
    const sourceFrame: WorldFrame = {
      cx: pivot.x,
      cy: pivot.y,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
      rotation: 0
    };
    const connectorSnapshot = this.captureConnectorTransformSnapshot(
      targets.map(({ id }) => id),
      sourceFrame
    );
    const connectorTransform = {
      snapshot: connectorSnapshot,
      matrix: multiplyMatrix(
        computeFrameMatrix({ ...sourceFrame, rotation: degrees }),
        invertMatrix(computeFrameMatrix(sourceFrame))
      )
    };
    const transforms = targets.map(({ id, node, matrix }): NodeTransform => {
      const frame = computeWorldFrame(node, matrix);
      const dx = frame.cx - pivot.x;
      const dy = frame.cy - pivot.y;
      return {
        id,
        connectorTransform,
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

  /** 让节点外框适应内容 (支持多选)：写入的字段由节点类型或容器子内容决定，已适应内容或不支持的节点跳过 */
  fitContent(nodeIds: Iterable<string>, options?: CommandOptions): CanvasOperationRecord | null {
    const patches: CanvasPatch[] = [];
    for (const id of nodeIds) {
      const containerPatches = this.resolveContainerFitPatches(id);
      if (containerPatches) {
        patches.push(...containerPatches);
        continue;
      }
      const fields = this.resolveFitContent(id);
      if (!fields) continue;
      for (const [key, value] of Object.entries(fields)) {
        patches.push({ op: 'set', path: ['content', 'nodes', id, key], value });
      }
    }
    if (patches.length === 0) return null;
    return this.commit({ ...options, label: options?.label ?? '适应内容', patches });
  }

  /** 节点能否适应内容 (节点类型支持或容器内有子内容，且尚未适应)：界面据此决定是否显示入口 */
  canFitContent(nodeId: string): boolean {
    return this.resolveContainerFitPatches(nodeId) !== null || this.resolveFitContent(nodeId) !== null;
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

  /**
   * 判断指定节点集合是否满足创建组合的条件：
   * 至少 2 个未锁定的最顶层节点，且不能是受排版控制的布局成员 (layoutItem !== undefined && !layout)
   */
  canGroupNodes(nodeIds: Iterable<string>): boolean {
    const { nodes } = this.document.content;
    const targets = this.collectTopmost(nodeIds).filter((id) => {
      const node = nodes[id];
      return Boolean(node && !node.locked && !(node.layoutItem !== undefined && !node.layout));
    });
    return targets.length >= 2;
  }

  /**
   * 判断指定节点集合是否包含可以解散的组合或含子节点的容器外壳
   */
  canUngroupNodes(nodeIds: Iterable<string>): boolean {
    const { nodes } = this.document.content;
    return this.collectTopmost(nodeIds).some((id) => {
      const node = nodes[id];
      if (!node || node.locked) return false;
      const isGroup = node.nodeType === GROUP_NODE_TYPE;
      const isContainer = Boolean(this.nodeTypes.get(node.nodeType)?.acceptsChildren);
      return isGroup || (isContainer && this.entities.getChildIds(id).size > 0);
    });
  }

  /**
   * 创建组合 (Ctrl+G，支持多选与嵌套组合)：至少 2 个未锁定的最顶层非布局成员节点；
   * 同容器节点在原容器内成组，跨容器节点提升至最近公共祖先；组合置于选中最高节点的层级处，一步撤销
   * @returns 新组合节点的 id；不满足条件或提交被拒绝时返回 null
   */
  groupNodes(nodeIds: Iterable<string>, options?: CommandOptions): string | null {
    const { nodes } = this.document.content;
    const getNode = (id: string): Readonly<NodeEntity> | undefined =>
      Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    const chainCache = new Map<string, Readonly<NodeEntity>[]>();
    const targets = this.collectTopmost(nodeIds)
      .filter((id) => {
        const node = nodes[id];
        return !node.locked && !(node.layoutItem !== undefined && !node.layout);
      })
      .map((id) => nodes[id])
      .sort((a, b) => compareHierarchicalNodes(a, b, getNode, chainCache));
    if (targets.length < 2) return null;

    // 确定目标父容器：全部同父时留在原父容器，否则取最近公共祖先 (或根层级 undefined)
    let parentId = targets[0].parentId;
    if (!targets.every((t) => t.parentId === parentId)) {
      const firstAncestors = this.entities.getAncestorIds(targets[0].id);
      parentId = firstAncestors.find((ancestorId) =>
        targets.every((t) => t.parentId === ancestorId || this.entities.getAncestorIds(t.id).includes(ancestorId))
      );
    }

    // 组合层级紧贴最高选中节点所在的同层兄弟位置，不越过原本盖在选区上方的无关节点
    const lastTarget = targets[targets.length - 1];
    const branchInParentId =
      lastTarget.parentId === parentId
        ? lastTarget.id
        : this.entities.getAncestorIds(lastTarget.id).find((aId) => nodes[aId]?.parentId === parentId);
    const siblings = this.siblingsInLayerOrder(parentId);
    const branchIdx = branchInParentId === undefined ? -1 : siblings.findIndex((s) => s.id === branchInParentId);
    const nextZIndex = branchIdx >= 0 ? (siblings[branchIdx + 1]?.zIndex ?? null) : null;
    const renumber = branchIdx >= 0 && nextZIndex !== null && siblings[branchIdx].zIndex >= nextZIndex;
    const groupZIndex = renumber
      ? siblings[branchIdx].zIndex
      : branchIdx >= 0
        ? generateKeyBetween(siblings[branchIdx].zIndex, nextZIndex)
        : this.createTopZIndex(parentId);

    const parentMatrix = parentId === undefined ? undefined : this.entities.getWorldTransform(parentId);
    const toParentLocal = parentMatrix && invertMatrix(parentMatrix);
    const inParentMatrices = targets.map((node) => {
      const world = this.entities.getWorldTransform(node.id)!;
      return toParentLocal ? multiplyMatrix(toParentLocal, world) : world;
    });

    const groupBounds = targets
      .map((node, i) => computeNodeWorldBounds(node, inParentMatrices[i]))
      .reduce((union, b) => unionBounds(union, b));

    const gx = roundPersisted(groupBounds.left);
    const gy = roundPersisted(groupBounds.top);
    const gw = roundPersisted(Math.max(1, groupBounds.right - groupBounds.left));
    const gh = roundPersisted(Math.max(1, groupBounds.bottom - groupBounds.top));
    const groupId = generateId('group');

    const groupNode: NodeEntity = {
      id: groupId,
      type: 'node',
      nodeType: GROUP_NODE_TYPE,
      ...(parentId !== undefined && { parentId }),
      x: gx,
      y: gy,
      width: gw,
      height: gh,
      rotation: 0,
      zIndex: groupZIndex,
      locked: false,
      data: {}
    };

    const childKeys = generateNKeysBetween(null, null, targets.length);
    const patches: CanvasPatch[] = [{ op: 'set', path: ['content', 'nodes', groupId], value: groupNode }];
    if (renumber) {
      // 并发或导入允许合法键相同；沿用层级操作的事务内重编号，避免生成相等边界之间的键。
      const order = siblings.map((node) => node.id);
      order.splice(branchIdx + 1, 0, groupId);
      patches.push(...renumberLayerOrder(siblings, order));
    }

    for (let i = 0; i < targets.length; i++) {
      const node = targets[i];
      const pose = decomposeNodeMatrix(inParentMatrices[i], node.width, node.height);
      const base = ['content', 'nodes', node.id];
      patches.push(
        { op: 'set', path: [...base, 'parentId'], value: groupId },
        { op: 'set', path: [...base, 'x'], value: roundPersisted(pose.x - gx) },
        { op: 'set', path: [...base, 'y'], value: roundPersisted(pose.y - gy) },
        { op: 'set', path: [...base, 'rotation'], value: pose.rotation },
        { op: 'set', path: [...base, 'zIndex'], value: childKeys[i] }
      );
    }

    const record = this.commit({ ...options, label: options?.label ?? '创建组合', patches });
    return record ? groupId : null;
  }

  /**
   * 取消组合 / 解散容器外壳 (Ctrl+Shift+G，支持多选)：
   * 将组合 (group) 或含有子节点的画框 (frame) 的直接子节点换算回父容器局部坐标、保持世界位姿与原有层叠顺序，并删除容器外壳，一步撤销
   * @returns 释放出的直接子节点 id 列表；无有效目标或提交被拒绝时为空数组
   */
  ungroupNodes(nodeIds: Iterable<string>, options?: CommandOptions): string[] {
    const { nodes } = this.document.content;
    const getNode = (id: string): Readonly<NodeEntity> | undefined =>
      Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    const chainCache = new Map<string, Readonly<NodeEntity>[]>();
    const containers = this.collectTopmost(nodeIds)
      .filter((id) => {
        const node = nodes[id];
        if (!node || node.locked) return false;
        const isGroup = node.nodeType === GROUP_NODE_TYPE;
        const isContainer = !!this.nodeTypes.get(node.nodeType)?.acceptsChildren;
        if (!isGroup && !isContainer) return false;
        return isGroup || this.entities.getChildIds(id).size > 0;
      })
      .map((id) => nodes[id])
      .sort((a, b) => compareHierarchicalNodes(a, b, getNode, chainCache));
    if (containers.length === 0) return [];

    const patches: CanvasPatch[] = [];
    const releasedIds: string[] = [];
    const connectorIds = new Set<string>();

    for (const container of containers) {
      const children = this.siblingsInLayerOrder(container.id);
      const parentId = container.parentId;
      const parentMatrix = parentId === undefined ? undefined : this.entities.getWorldTransform(parentId);
      const toParentLocal = parentMatrix && invertMatrix(parentMatrix);
      const siblings = this.siblingsInLayerOrder(parentId);
      const idx = siblings.findIndex((s) => s.id === container.id);
      const nextZ = idx >= 0 ? (siblings[idx + 1]?.zIndex ?? null) : null;
      const keys = generateNKeysBetween(container.zIndex, nextZ, children.length);

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const world = this.entities.getWorldTransform(child.id)!;
        const pose = decomposeNodeMatrix(
          toParentLocal ? multiplyMatrix(toParentLocal, world) : world,
          child.width,
          child.height
        );
        const base = ['content', 'nodes', child.id];
        patches.push(
          parentId === undefined
            ? { op: 'unset', path: [...base, 'parentId'] }
            : { op: 'set', path: [...base, 'parentId'], value: parentId },
          { op: 'set', path: [...base, 'x'], value: pose.x },
          { op: 'set', path: [...base, 'y'], value: pose.y },
          { op: 'set', path: [...base, 'rotation'], value: pose.rotation },
          { op: 'set', path: [...base, 'zIndex'], value: keys[i] }
        );
        // 自带布局的子节点 (如导图中心主题) 的 layoutItem 兼作它自己布局的根设置，只在为空 (仅是外层成员标记) 时移除
        if (
          container.layout &&
          child.layoutItem !== undefined &&
          (!child.layout || Object.keys(child.layoutItem).length === 0)
        ) {
          patches.push({ op: 'unset', path: [...base, 'layoutItem'] });
        }
        releasedIds.push(child.id);
      }

      patches.push({ op: 'unset', path: ['content', 'nodes', container.id] });
      for (const cId of this.documentConnectorIdsOfNode(container.id)) connectorIds.add(cId);
    }

    for (const cId of connectorIds) {
      patches.push({ op: 'unset', path: ['content', 'connectors', cId] });
    }

    const record = this.commit({ ...options, label: options?.label ?? '取消组合', patches });
    return record ? releasedIds : [];
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

  /** 新建容器节点时，将同层中完全落入容器外框内的非容器兄弟节点自动收纳进该容器 */
  private appendAutoWrapPatches(container: NodeEntity, patches: CanvasPatch[]): void {
    const invContainer = invertMatrix(computeNodeLocalMatrix(container));
    const siblings = this.siblingsInLayerOrder(container.parentId);
    const wrapped: Readonly<NodeEntity>[] = [];
    for (const sibling of siblings) {
      if (sibling.id === container.id || sibling.locked) continue;
      if (sibling.layoutItem !== undefined && !sibling.layout) continue;
      if (this.nodeTypes.get(sibling.nodeType)?.acceptsChildren) continue;
      const toLocal = multiplyMatrix(invContainer, computeNodeLocalMatrix(sibling));
      const b = computeNodeWorldBounds(sibling, toLocal);
      if (
        b.left >= -1e-4 &&
        b.top >= -1e-4 &&
        b.right <= container.width + 1e-4 &&
        b.bottom <= container.height + 1e-4
      ) {
        wrapped.push(sibling);
      }
    }
    if (wrapped.length === 0) return;
    const keys = generateNKeysBetween(null, null, wrapped.length);
    for (let i = 0; i < wrapped.length; i++) {
      const sibling = wrapped[i];
      const toLocal = multiplyMatrix(invContainer, computeNodeLocalMatrix(sibling));
      const pose = decomposeNodeMatrix(toLocal, sibling.width, sibling.height);
      const base = ['content', 'nodes', sibling.id];
      patches.push(
        { op: 'set', path: [...base, 'parentId'], value: container.id },
        { op: 'set', path: [...base, 'x'], value: pose.x },
        { op: 'set', path: [...base, 'y'], value: pose.y },
        { op: 'set', path: [...base, 'rotation'], value: pose.rotation },
        { op: 'set', path: [...base, 'zIndex'], value: keys[i] }
      );
    }
  }

  /** 容器适应直接子节点占位，复合布局使用完整子树；保留24px边距，补偿局部坐标保持世界位姿。 */
  private resolveContainerFitPatches(id: string): CanvasPatch[] | null {
    const node = this.getNode(id);
    const definition = node && this.nodeTypes.get(node.nodeType);
    if (!node || node.locked || node.layout || !definition?.acceptsChildren) return null;
    const childIds = [...this.entities.getChildIds(id)];
    if (childIds.length === 0) return null;
    const { nodes } = this.document.content;
    let bounds: { left: number; top: number; right: number; bottom: number } | null = null;
    for (const childId of childIds) {
      const child = nodes[childId];
      if (!child) continue;
      const matrix = computeNodeLocalMatrix(child);
      const box =
        child.layout && this.layouts.get(child.layout.type)?.footprint === 'subtree'
          ? computeSubtreeFootprint(
              child,
              (parentId) => [...this.entities.getChildIds(parentId)].map((childId) => nodes[childId]),
              matrix
            )
          : computeNodeWorldBounds(child, matrix);
      bounds = bounds ? unionBounds(bounds, box) : box;
    }
    if (!bounds) return null;
    const padding = 24;
    const dx = roundPersisted(bounds.left - padding);
    const dy = roundPersisted(bounds.top - padding);
    const newWidth = roundPersisted(Math.max(1, bounds.right - bounds.left + padding * 2));
    const newHeight = roundPersisted(Math.max(1, bounds.bottom - bounds.top + padding * 2));
    const offsetChanged = Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3;
    const sizeChanged = Math.abs(newWidth - node.width) > 1e-3 || Math.abs(newHeight - node.height) > 1e-3;
    if (!offsetChanged && !sizeChanged) return null;

    const patches: CanvasPatch[] = [];
    if (offsetChanged) {
      for (const childId of childIds) {
        const child = nodes[childId];
        if (!child) continue;
        const nextChildX = roundPersisted(child.x - dx);
        const nextChildY = roundPersisted(child.y - dy);
        if (nextChildX !== child.x)
          patches.push({ op: 'set', path: ['content', 'nodes', childId, 'x'], value: nextChildX });
        if (nextChildY !== child.y)
          patches.push({ op: 'set', path: ['content', 'nodes', childId, 'y'], value: nextChildY });
      }
    }
    const localMatrix = computeNodeLocalMatrix(node);
    const newCenter = applyMatrix(localMatrix, dx + newWidth / 2, dy + newHeight / 2);
    const newX = roundPersisted(newCenter.x - newWidth / 2);
    const newY = roundPersisted(newCenter.y - newHeight / 2);
    if (newX !== node.x) patches.push({ op: 'set', path: ['content', 'nodes', id, 'x'], value: newX });
    if (newY !== node.y) patches.push({ op: 'set', path: ['content', 'nodes', id, 'y'], value: newY });
    if (newWidth !== node.width) patches.push({ op: 'set', path: ['content', 'nodes', id, 'width'], value: newWidth });
    if (newHeight !== node.height)
      patches.push({ op: 'set', path: ['content', 'nodes', id, 'height'], value: newHeight });
    return patches.length > 0 ? patches : null;
  }

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
      if (collection === 'connectors' && isDerivedConnectorId(id)) {
        patches.push(
          ...this.redirectDerivedWrite(
            id,
            fields as Partial<ConnectorEntity> | ((c: Readonly<ConnectorEntity>) => Partial<ConnectorEntity>),
            merge
          )
        );
        continue;
      }
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

  /** 对派生连线的修改交给所属来源转写为文档补丁；来源只读或已卸载时忽略 */
  private redirectDerivedWrite(
    connectorId: string,
    fields: Partial<ConnectorEntity> | ((connector: Readonly<ConnectorEntity>) => Partial<ConnectorEntity>),
    merge: boolean
  ): CanvasPatch[] {
    const origin = this.derivedOrigins.get(connectorId);
    const current = this.entities.getConnector(connectorId)?.entity;
    const source = origin && this.connectorSources.get(origin.sourceId);
    if (!origin || !source?.write || !current) return [];
    const partial = typeof fields === 'function' ? fields(current) : fields;
    return source.write(origin.key, current, partial, merge);
  }

  /**
   * 复制到剪贴板的最顶层节点若是布局成员 (ADR-130)：粘贴后离开原树，成员标记失效。
   * 有子成员的带上原树的布局声明 (含参数) 成为一棵独立的树，没有的去掉成员标记成为普通节点 (与拖出布局一致)
   */
  private detachLayoutMember(id: string, copy: NodeEntity): NodeEntity {
    const getNode = (nodeId: string) => this.getNode(nodeId);
    const rootId = findMemberRootId(id, getNode);
    if (rootId === undefined) return copy;
    const { layoutItem: _layoutItem, ...rest } = copy;
    const hasMembers = [...this.entities.getChildIds(id)].some((childId) => getNode(childId)?.layoutItem);
    const layout = getNode(rootId)!.layout!;
    return hasMembers && !rest.layout ? { ...rest, layout: clonePlainData(layout) as NodeLayout } : rest;
  }

  /** 端点绑定在节点上的文档连线 (不含派生连线) */
  private documentConnectorIdsOfNode(nodeId: string): string[] {
    return [...this.entities.getConnectorIdsOfNode(nodeId)].filter((id) => !isDerivedConnectorId(id));
  }

  /**
   * 派生连线与各来源对齐：changes 为 null 时全量重算，否则由来源按本次变化决定重算哪些键
   * 来源抛错只影响它自己的连线；引用了不存在节点的派生连线视为没有
   * @param onlySourceId 只处理这一个来源 (已卸载时移除它的全部连线)
   * @returns 层叠关系是否可能变化
   */
  private syncDerivedConnectors(
    changes: DerivedSourceChanges | null,
    connectorChanges: MutableEntityChanges,
    onlySourceId?: string
  ): boolean {
    const store = this.entities;
    // 被删除节点上的派生连线一律交回来源重算 (来源的 collect 未必会把它们算进去)，避免悬空
    const dangling = new Map<string, string[]>();
    for (const [nodeId, change] of changes?.nodes ?? []) {
      if (change !== 'entity' || store.hasNode(nodeId)) continue;
      for (const id of store.getConnectorIdsOfNode(nodeId)) {
        const origin = this.derivedOrigins.get(id);
        if (origin) dangling.set(origin.sourceId, [...(dangling.get(origin.sourceId) ?? []), origin.key]);
      }
    }
    const sourceIds =
      onlySourceId === undefined ? [...this.connectorSources.all()].map((source) => source.id) : [onlySourceId];
    let orderChanged = false;
    for (const sourceId of sourceIds) {
      const source = this.connectorSources.get(sourceId);
      const owned = this.sourceConnectorIds.get(sourceId) ?? new Set<string>();
      const next = new Map<string, { key: string; entity: ConnectorEntity | undefined }>();
      let full = true;
      if (source) {
        try {
          const collected = changes === null ? null : source.collect(changes);
          const keys = collected === null ? null : [...collected, ...(dangling.get(sourceId) ?? [])];
          if (keys !== null && keys.length === 0) continue;
          full = keys === null;
          for (const [key, derived] of source.derive(keys)) {
            const id = derivedConnectorId(sourceId, key);
            const valid =
              derived &&
              [derived.from, derived.to].every((end) => end.nodeId === undefined || store.hasNode(end.nodeId));
            next.set(id, { key, entity: valid ? { ...derived, id, type: 'connector' } : undefined });
          }
        } catch (err) {
          console.error(`[SkyNote:DocumentStore] 派生连线来源 ${sourceId} 出错，本次跳过:`, err);
          continue;
        }
      }
      if (full) {
        for (const id of owned)
          if (!next.has(id)) next.set(id, { key: this.derivedOrigins.get(id)!.key, entity: undefined });
      }
      for (const [id, { key, entity }] of next) {
        const existing = store.getConnector(id)?.entity;
        if (!entity && !existing) continue;
        if (entity && existing && areStructuredValuesEqual(entity, existing)) continue;
        if (entity) {
          owned.add(id);
          this.derivedOrigins.set(id, { sourceId, key });
        } else {
          owned.delete(id);
          this.derivedOrigins.delete(id);
        }
        if (recordSyncResult(connectorChanges, id, store.syncConnector(id, entity))) orderChanged = true;
      }
      this.sourceConnectorIds.set(sourceId, owned);
    }
    return orderChanged;
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
      return this.detachLayoutMember(id, {
        ...rest,
        ...decomposeNodeMatrix(this.entities.getWorldTransform(id)!, node.width, node.height)
      });
    });
    const descendants = topIds.flatMap((id) =>
      this.entities.collectDescendantIds(id).map((descendantId) => clonePlainData(nodes[descendantId]) as NodeEntity)
    );
    const included = new Set([...topIds, ...descendants.map((node) => node.id)]);
    const isInside = (end: ConnectorEndpoint) => end.nodeId === undefined || included.has(end.nodeId);

    const picked = new Map<string, ConnectorEntity>();
    for (const id of included) {
      for (const connectorId of this.documentConnectorIdsOfNode(id)) {
        const c = connectors[connectorId];
        if (isInside(c.from) && isInside(c.to)) picked.set(connectorId, clonePlainData(c) as ConnectorEntity);
      }
    }
    for (const id of refs.connectorIds ?? []) {
      // 派生连线不复制：它的数据随所推导自的节点一起复制
      if (picked.has(id) || !Object.hasOwn(connectors, id)) continue;
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
  private insertSubtrees(
    subtrees: Subtrees,
    offset: Point,
    options: CommandOptions,
    assets: Record<string, CanvasAssetMeta> = {}
  ): EntityIds {
    const { nodes } = this.document.content;
    const idMap = new Map<string, string>();
    for (const node of [...subtrees.topmost, ...subtrees.descendants]) idMap.set(node.id, generateId('node'));

    if (Object.keys(assets).some((id) => Object.hasOwn(this.document.assets ?? {}, id)))
      return { nodeIds: [], connectorIds: [] };
    const patches: CanvasPatch[] = Object.entries(assets).map(([id, asset]) => ({
      op: 'set',
      path: ['assets', id],
      value: asset
    }));
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
    if (subtrees.topmost.length === 0 && connectorIds.length === 0) return empty;
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
    let contentReplaced = false;
    const assetChanges = new Set<string>();
    const nodeChanges = createEntityChanges();
    const connectorChanges = createEntityChanges();
    let fullSync = false;
    let orderChanged = false;

    const syncNodeIds = new Set<string>();
    const reparentedNodeIds = new Set<string>();
    /** 交给派生连线来源的节点变化摘要 (ADR-130) */
    const derivedNodeChanges = new Map<string, DerivedNodeChange>();
    const touchNode = (id: string, field: string | number | null): void => {
      const current = derivedNodeChanges.get(id);
      if (current === 'entity') return;
      if (field === null) derivedNodeChanges.set(id, 'entity');
      else if (current) (current as Set<string>).add(String(field));
      else derivedNodeChanges.set(id, new Set([String(field)]));
    };
    const syncConnectorIds = new Set<string>();
    const nodeGeomIds = new Set<string>();
    const nodeDataIds = new Set<string>();
    const connectorGeomIds = new Set<string>();
    const connectorDataIds = new Set<string>();

    for (let i = 0; i < record.patches.length; i++) {
      const patch = record.patches[i];
      const segments = normalizePatchPath(patch.path);
      if (segments[0] === 'assets') {
        if (segments.length > 1) assetChanges.add(String(segments[1]));
        else {
          for (const id of this.assetIds) assetChanges.add(id);
          for (const id of Object.keys(doc.assets ?? {})) assetChanges.add(id);
          if (patch.op === 'set') for (const id of Object.keys((patch.oldValue ?? {}) as object)) assetChanges.add(id);
        }
      }
      if (segments[0] === 'content' && segments.length === 1) contentReplaced = true;
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
        if (isNode) touchNode(id, null);
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
        if (isNode) touchNode(id, field);
      }
    }

    const { nodes, connectors } = doc.content;
    for (const id of assetChanges) {
      if (Object.hasOwn(doc.assets ?? {}, id)) this.assetIds.add(id);
      else this.assetIds.delete(id);
    }
    const store = this.entities;

    if (fullSync) {
      for (const runtimeNode of store.getAllNodes()) syncNodeIds.add(runtimeNode.entity.id);
      for (const id in nodes) syncNodeIds.add(id);
      for (const runtimeConnector of store.getAllConnectors()) {
        if (!isDerivedConnectorId(runtimeConnector.entity.id)) syncConnectorIds.add(runtimeConnector.entity.id);
      }
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

    if (fullSync || derivedNodeChanges.size > 0) {
      const summary = fullSync ? null : { nodes: derivedNodeChanges };
      if (this.syncDerivedConnectors(summary, connectorChanges)) orderChanged = true;
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
      // 派生补丁可由深到浅到达；共享已失效集合，不能为每个祖先重复枚举完整子树。
      const pending = [id];
      for (let index = 0; index < pending.length; index++) {
        for (const childId of store.getChildIds(pending[index])) {
          if (worldGeometry.has(childId)) continue;
          worldGeometry.add(childId);
          pending.push(childId);
        }
      }
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

    this.broadcast(record, {
      contentReplaced,
      assets: assetChanges,
      nodes: {
        ...nodeChanges,
        worldGeometry,
        reparented,
        dataPaths: collectNodeDataPaths(record.patches) ?? undefined
      },
      connectors: connectorChanges,
      orderChanged
    });
  }

  private broadcast(record: CanvasOperationRecord, changes: DocumentChangeSet): void {
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

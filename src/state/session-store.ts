/**
 * @file session-store.ts
 * @description 本地会话状态：视口、选区与主题 (SessionStore)
 *
 * 设计考量 (Why):
 * 1. 交互态与文档分离：视口和选区属于单个用户、单个窗口，不进入可持久化、可协同的 CanvasDocument，
 *    平移缩放不走事务与撤销栈，也不会同步给协作者 (他人的选区与视口走在线状态通道)。
 * 2. 增量通知：选区变化只广播选中态翻转的 id，渲染器据此只重绘受影响的实体。
 * 3. 画布内文字编辑的目标、滚动与输入法组合文字同属本地交互态，放在这里供渲染器与编辑插件共读。
 * 4. 当前工具 (选择、连线等) 同样是本地交互态：工具插件据此认领指针，界面据此高亮按钮。
 * 5. 视口命令只有一处实现：缩放、适配内容都经 setViewport 写入并受缩放范围约束；
 *    视口像素尺寸由渲染器上报到这里，插件与界面据此换算中心点，不再各自持有尺寸。
 */

import type { Point, RectBounds } from '../types/geometry';
import type { ViewportState } from '../types/canvas';
import type { CanvasTheme, CanvasThemeConfig } from '../types/theme';
import type { RichTextRunStyle } from '../types/text';
import { deriveCanvasTheme, LIGHT_CANVAS_THEME_SEED } from '../utils/theme';
import { clamp, computeFitViewport, screenToWorld } from '../utils/geometry';

/** 单次会话状态变更 */
export interface SessionChange {
  /** 视口平移、缩放或像素尺寸变化 */
  readonly viewportChanged: boolean;
  readonly themeChanged: boolean;
  /** 正在编辑的文字块变化 (进入、退出或切换) */
  readonly textEditingChanged: boolean;
  /** 当前工具切换 */
  readonly toolChanged: boolean;
  /** 引擎维护冻结状态变化 (进入或退出 beginMaintenance) */
  readonly maintenanceChanged: boolean;
  /** 选中态发生翻转的节点 id (新选中 ∪ 取消选中) */
  readonly toggledNodeIds: ReadonlySet<string>;
  /** 选中态发生翻转的连线 id */
  readonly toggledConnectorIds: ReadonlySet<string>;
}

/** 输入法组合中尚未确认的文字：只在本地显示 (插入到 offset 处并带下划线)，确认后才写入文档 */
export interface TextComposition {
  readonly offset: number;
  readonly text: string;
  readonly style: RichTextRunStyle;
}

/**
 * 正在画布内编辑的文字块 (ADR-122)：渲染器与编辑插件据此得到同一份编辑视图 (editingTextPrimitive)
 * 编辑块不截断，超出文本框的部分裁剪并按 scrollY 滚动；滚动与组合文字都是本地状态，不进入文档
 */
export interface TextEditingTarget {
  /** 文字所属的实体：节点的文字块，或连线上的文字 */
  readonly kind: 'node' | 'connector';
  readonly id: string;
  readonly blockId: string;
  /** 文字超出文本框时向上滚动的距离 (文本框坐标) */
  readonly scrollY: number;
  readonly composition: TextComposition | null;
}

export type SessionListener = (change: SessionChange) => void;

/** 默认工具：点选、框选与拖动；其他工具 (如 'connector') 由对应插件在激活时认领指针 */
export const SELECT_TOOL = 'select';

/** 选区更新参数：未提供的类别保持不变 */
export interface SelectionUpdate {
  nodeIds?: Iterable<string>;
  connectorIds?: Iterable<string>;
}

/** 视口缩放范围 */
export interface ZoomRange {
  min: number;
  max: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** 适配内容的留白与缩放上限 */
export interface FitOptions {
  /** 内容与视口边缘的屏幕像素留白 (默认 80) */
  padding?: number;
  /** 内容很少时不放得过大 (默认 1，即不超过原始尺寸) */
  maxZoom?: number;
}

/** 暴露给插件、渲染器与界面的会话读写接口 */
export interface SessionController {
  readonly viewport: Readonly<ViewportState>;
  /** 画布视口的屏幕像素尺寸 (渲染器挂载前为 0) */
  readonly viewportSize: Readonly<ViewportSize>;
  /** 视口中心的世界坐标 (新建节点的默认落点) */
  readonly viewportCenter: Point;
  readonly zoomRange: Readonly<ZoomRange>;
  readonly theme: CanvasTheme;
  readonly selectedNodeIds: ReadonlySet<string>;
  readonly selectedConnectorIds: ReadonlySet<string>;
  readonly textEditing: TextEditingTarget | null;
  /** 当前工具 (缺省 SELECT_TOOL) */
  readonly tool: string;
  /** 引擎当前是否处于维护冻结状态 (beginMaintenance 期间为 true，草稿类交互据此取消并清理预览) */
  readonly inMaintenance: boolean;
  setViewport(viewport: Partial<ViewportState>): void;
  /** 以世界坐标 anchor (默认视口中心) 为不动点按倍率缩放 */
  zoomAt(factor: number, anchor?: Point): void;
  /** 缩放并平移使 bounds 居中容纳；null (空画布) 回到原点 */
  fitBounds(bounds: RectBounds | null, options?: FitOptions): void;
  setSelection(selection: SelectionUpdate): void;
  setTextEditing(target: TextEditingTarget | null): void;
  /**
   * 请求进入某节点的文字编辑 (如新建主题、插入便签后立即输入)
   * 单向的意图通知：由文字编辑插件决定是否响应，未安装时无效果
   */
  requestTextEditing(nodeId: string): void;
  onTextEditRequest(listener: (nodeId: string) => void): () => void;
  setTool(tool: string): void;
  /**
   * 显式切换主题
   * @throws 配置中含非法颜色
   */
  setTheme(config: CanvasThemeConfig): void;
}

/** 默认缩放范围：下限足以俯瞰超大画布 (LOD 会在低缩放时降级绘制)，上限足以检查细节 */
export const DEFAULT_ZOOM_RANGE: Readonly<ZoomRange> = Object.freeze({ min: 0.02, max: 8 });

/** 会话初始状态 */
export interface SessionStoreOptions {
  viewport?: Partial<ViewportState>;
  zoomRange?: ZoomRange;
  /** 默认浅色主题 */
  theme?: CanvasThemeConfig;
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const VIEWPORT_CHANGE: SessionChange = Object.freeze({
  viewportChanged: true,
  themeChanged: false,
  textEditingChanged: false,
  toolChanged: false,
  maintenanceChanged: false,
  toggledNodeIds: EMPTY_ID_SET,
  toggledConnectorIds: EMPTY_ID_SET
});
const THEME_CHANGE: SessionChange = Object.freeze({
  viewportChanged: false,
  themeChanged: true,
  textEditingChanged: false,
  toolChanged: false,
  maintenanceChanged: false,
  toggledNodeIds: EMPTY_ID_SET,
  toggledConnectorIds: EMPTY_ID_SET
});
const TEXT_EDITING_CHANGE: SessionChange = Object.freeze({
  viewportChanged: false,
  themeChanged: false,
  textEditingChanged: true,
  toolChanged: false,
  maintenanceChanged: false,
  toggledNodeIds: EMPTY_ID_SET,
  toggledConnectorIds: EMPTY_ID_SET
});
const TOOL_CHANGE: SessionChange = Object.freeze({
  viewportChanged: false,
  themeChanged: false,
  textEditingChanged: false,
  toolChanged: true,
  maintenanceChanged: false,
  toggledNodeIds: EMPTY_ID_SET,
  toggledConnectorIds: EMPTY_ID_SET
});
const MAINTENANCE_CHANGE: SessionChange = Object.freeze({
  viewportChanged: false,
  themeChanged: false,
  textEditingChanged: false,
  toolChanged: false,
  maintenanceChanged: true,
  toggledNodeIds: EMPTY_ID_SET,
  toggledConnectorIds: EMPTY_ID_SET
});

/** 用新集合替换旧集合，返回选中态翻转的 id；无变化返回 null */
function diffIdSets(previous: ReadonlySet<string>, next: ReadonlySet<string>): Set<string> | null {
  const toggled = new Set<string>();
  for (const id of previous) {
    if (!next.has(id)) toggled.add(id);
  }
  for (const id of next) {
    if (!previous.has(id)) toggled.add(id);
  }
  return toggled.size > 0 ? toggled : null;
}

export class SessionStore implements SessionController {
  readonly zoomRange: Readonly<ZoomRange>;
  private viewportState: ViewportState;
  private sizeState: ViewportSize = { width: 0, height: 0 };
  private themeState: CanvasTheme;
  private nodeSelection: ReadonlySet<string> = EMPTY_ID_SET;
  private connectorSelection: ReadonlySet<string> = EMPTY_ID_SET;
  private editingTarget: TextEditingTarget | null = null;
  private currentTool = SELECT_TOOL;
  private maintenanceState = false;
  private readonly listeners = new Set<SessionListener>();
  private readonly textEditRequestListeners = new Set<(nodeId: string) => void>();

  constructor(options?: SessionStoreOptions) {
    const range = options?.zoomRange ?? DEFAULT_ZOOM_RANGE;
    if (!(range.min > 0) || !(range.max >= range.min)) {
      throw new Error(`[SessionStore] 非法缩放范围: ${JSON.stringify(range)}`);
    }
    this.zoomRange = Object.freeze({ min: range.min, max: range.max });
    const initial = { x: 0, y: 0, zoom: 1, ...options?.viewport };
    this.viewportState = { ...initial, zoom: clamp(initial.zoom, range.min, range.max) };
    this.themeState = deriveCanvasTheme(options?.theme ?? { seed: LIGHT_CANVAS_THEME_SEED });
  }

  get viewport(): Readonly<ViewportState> {
    return this.viewportState;
  }

  get viewportSize(): Readonly<ViewportSize> {
    return this.sizeState;
  }

  get viewportCenter(): Point {
    return screenToWorld({ x: this.sizeState.width / 2, y: this.sizeState.height / 2 }, this.viewportState);
  }

  get theme(): CanvasTheme {
    return this.themeState;
  }

  get selectedNodeIds(): ReadonlySet<string> {
    return this.nodeSelection;
  }

  get selectedConnectorIds(): ReadonlySet<string> {
    return this.connectorSelection;
  }

  get textEditing(): TextEditingTarget | null {
    return this.editingTarget;
  }

  get tool(): string {
    return this.currentTool;
  }

  get inMaintenance(): boolean {
    return this.maintenanceState;
  }

  setTool(tool: string): void {
    if (tool === this.currentTool) return;
    this.currentTool = tool;
    this.notify(TOOL_CHANGE);
  }

  /** 由引擎在进入或退出 beginMaintenance 时同步更新 */
  setMaintenance(inMaintenance: boolean): void {
    if (inMaintenance === this.maintenanceState) return;
    this.maintenanceState = inMaintenance;
    this.notify(MAINTENANCE_CHANGE);
  }

  requestTextEditing(nodeId: string): void {
    for (const listener of this.textEditRequestListeners) listener(nodeId);
  }

  onTextEditRequest(listener: (nodeId: string) => void): () => void {
    this.textEditRequestListeners.add(listener);
    return () => {
      this.textEditRequestListeners.delete(listener);
    };
  }

  setTextEditing(target: TextEditingTarget | null): void {
    const current = this.editingTarget;
    if (
      current?.kind === target?.kind &&
      current?.id === target?.id &&
      current?.blockId === target?.blockId &&
      current?.scrollY === target?.scrollY &&
      current?.composition === target?.composition
    ) {
      return;
    }
    // 整体替换：渲染器按引用判断编辑视图是否变化
    this.editingTarget = target && Object.freeze({ ...target });
    this.notify(TEXT_EDITING_CHANGE);
  }

  setTheme(config: CanvasThemeConfig): void {
    this.themeState = deriveCanvasTheme(config);
    this.notify(THEME_CHANGE);
  }

  setViewport(viewport: Partial<ViewportState>): void {
    const next: ViewportState = { ...this.viewportState, ...viewport };
    if (!(next.zoom > 0) || !Number.isFinite(next.zoom) || !Number.isFinite(next.x) || !Number.isFinite(next.y)) {
      console.error('[SkyNote:SessionStore] 非法视口参数，已忽略:', viewport);
      return;
    }
    next.zoom = clamp(next.zoom, this.zoomRange.min, this.zoomRange.max);
    const current = this.viewportState;
    if (next.x === current.x && next.y === current.y && next.zoom === current.zoom) return;
    // 整体替换而非就地修改：持有旧引用的读者不会读到撕裂的中间态
    this.viewportState = next;
    this.notify(VIEWPORT_CHANGE);
  }

  /** 由渲染器在挂载与容器尺寸变化时上报 */
  setViewportSize(size: ViewportSize): void {
    if (size.width === this.sizeState.width && size.height === this.sizeState.height) return;
    this.sizeState = { width: size.width, height: size.height };
    this.notify(VIEWPORT_CHANGE);
  }

  zoomAt(factor: number, anchor: Point = this.viewportCenter): void {
    const { x, y, zoom } = this.viewportState;
    const nextZoom = clamp(zoom * factor, this.zoomRange.min, this.zoomRange.max);
    // 保持 anchor 的屏幕位置不变：screen = world * zoom + offset
    this.setViewport({ x: x + anchor.x * (zoom - nextZoom), y: y + anchor.y * (zoom - nextZoom), zoom: nextZoom });
  }

  fitBounds(bounds: RectBounds | null, options?: FitOptions): void {
    this.setViewport(
      computeFitViewport(bounds, this.sizeState, this.viewportState, {
        padding: options?.padding ?? 80,
        minZoom: this.zoomRange.min,
        maxZoom: Math.min(options?.maxZoom ?? 1, this.zoomRange.max)
      })
    );
  }

  setSelection(selection: SelectionUpdate): void {
    let toggledNodeIds: ReadonlySet<string> = EMPTY_ID_SET;
    let toggledConnectorIds: ReadonlySet<string> = EMPTY_ID_SET;

    if (selection.nodeIds !== undefined) {
      const next = new Set(selection.nodeIds);
      const toggled = diffIdSets(this.nodeSelection, next);
      if (toggled) {
        this.nodeSelection = next;
        toggledNodeIds = toggled;
      }
    }
    if (selection.connectorIds !== undefined) {
      const next = new Set(selection.connectorIds);
      const toggled = diffIdSets(this.connectorSelection, next);
      if (toggled) {
        this.connectorSelection = next;
        toggledConnectorIds = toggled;
      }
    }

    if (toggledNodeIds.size === 0 && toggledConnectorIds.size === 0) return;
    this.notify({
      viewportChanged: false,
      themeChanged: false,
      textEditingChanged: false,
      toolChanged: false,
      maintenanceChanged: false,
      toggledNodeIds,
      toggledConnectorIds
    });
  }

  /**
   * 剔除已被删除实体的选中项与编辑目标 (由引擎在文档实体删除后调用，保证选区永不指向不存在的实体)
   */
  pruneSelection(removedNodeIds: ReadonlySet<string>, removedConnectorIds: ReadonlySet<string>): void {
    if (removedNodeIds.size === 0 && removedConnectorIds.size === 0) return;
    // 按选区规模遍历：选区通常远小于一次批量删除的规模
    const keptNodeIds = [...this.nodeSelection].filter((id) => !removedNodeIds.has(id));
    const keptConnectorIds = [...this.connectorSelection].filter((id) => !removedConnectorIds.has(id));
    this.setSelection({ nodeIds: keptNodeIds, connectorIds: keptConnectorIds });
    const editing = this.editingTarget;
    const removed = editing?.kind === 'node' ? removedNodeIds : removedConnectorIds;
    if (editing && removed.has(editing.id)) this.setTextEditing(null);
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(change: SessionChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error('[SkyNote:SessionStore] 会话监听回调异常:', err);
      }
    }
  }
}

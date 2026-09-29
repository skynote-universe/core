/**
 * @file session-store.ts
 * @description 本地会话状态：视口与选区 (SessionStore)
 *
 * 设计考量 (Why):
 * 1. 交互态与文档分离：视口和选区属于单个用户、单个窗口的交互状态，不进入可持久化、可协同的 CanvasDocument。
 *    因此平移缩放不走事务与撤销栈、不产生文档变更（不会误触发自动保存），也不会被同步给协作者；
 *    协同场景下他人的选区与视口属于在线状态 (awareness) 通道。
 * 2. 增量通知：选区变化只广播被选中/取消选中的 id（对称差），渲染器据此只重绘受影响的实体。
 * 3. 主题同属本地偏好：由开发者显式配置与切换，切换时整体替换主题对象，下游按引用比较即可判定失效。
 * 4. 缩放范围由会话统一约束：滚轮、按钮、适配视口与插件都经 setViewport 写入，范围只在这一处生效，
 *    宿主界面不再各自夹取。
 */

import type { Point, ViewportState } from '../types/canvas';
import type { CanvasTheme, CanvasThemeConfig } from '../types/theme';
import { deriveCanvasTheme, LIGHT_CANVAS_THEME_SEED } from '../utils/theme';

/** 单次会话状态变更 */
export interface SessionChange {
  readonly viewportChanged: boolean;
  readonly themeChanged: boolean;
  /** 选中态发生翻转的节点 id (新选中 ∪ 取消选中) */
  readonly toggledNodeIds: ReadonlySet<string>;
  /** 选中态发生翻转的连线 id */
  readonly toggledConnectorIds: ReadonlySet<string>;
}

export type SessionListener = (change: SessionChange) => void;

/** 选区更新参数：未提供的类别保持不变 */
export interface SelectionUpdate {
  nodeIds?: Iterable<string>;
  connectorIds?: Iterable<string>;
}

/** 暴露给插件与渲染器的会话读写接口 */
export interface SessionController {
  readonly viewport: Readonly<ViewportState>;
  readonly theme: CanvasTheme;
  readonly selectedNodeIds: ReadonlySet<string>;
  readonly selectedConnectorIds: ReadonlySet<string>;
  /** 缩放范围 (setViewport 写入时夹取) */
  readonly zoomRange: Readonly<ZoomRange>;
  setViewport(viewport: Partial<ViewportState>): void;
  /** 以世界坐标 worldPoint 为不动点按倍率缩放 (滚轮、缩放按钮)，结果受缩放范围约束 */
  zoomAt(factor: number, worldPoint: Point): void;
  setSelection(selection: SelectionUpdate): void;
  /**
   * 显式切换主题
   * @throws 配置中含非法颜色
   */
  setTheme(config: CanvasThemeConfig): void;
}

/** 视口缩放范围 */
export interface ZoomRange {
  min: number;
  max: number;
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
  private viewportState: ViewportState;
  private themeState: CanvasTheme;
  private nodeSelection: ReadonlySet<string> = EMPTY_ID_SET;
  private connectorSelection: ReadonlySet<string> = EMPTY_ID_SET;
  private readonly listeners = new Set<SessionListener>();
  readonly zoomRange: Readonly<ZoomRange>;

  constructor(options?: SessionStoreOptions) {
    const range = options?.zoomRange ?? DEFAULT_ZOOM_RANGE;
    if (!(range.min > 0) || !(range.max >= range.min)) {
      throw new Error(`[SessionStore] 非法缩放范围: ${JSON.stringify(range)}`);
    }
    this.zoomRange = Object.freeze({ min: range.min, max: range.max });
    const initial = { x: 0, y: 0, zoom: 1, ...options?.viewport };
    this.viewportState = { ...initial, zoom: Math.min(range.max, Math.max(range.min, initial.zoom)) };
    this.themeState = deriveCanvasTheme(options?.theme ?? { seed: LIGHT_CANVAS_THEME_SEED });
  }

  get theme(): CanvasTheme {
    return this.themeState;
  }

  setTheme(config: CanvasThemeConfig): void {
    this.themeState = deriveCanvasTheme(config);
    this.notify({
      viewportChanged: false,
      themeChanged: true,
      toggledNodeIds: EMPTY_ID_SET,
      toggledConnectorIds: EMPTY_ID_SET
    });
  }

  get viewport(): Readonly<ViewportState> {
    return this.viewportState;
  }

  get selectedNodeIds(): ReadonlySet<string> {
    return this.nodeSelection;
  }

  get selectedConnectorIds(): ReadonlySet<string> {
    return this.connectorSelection;
  }

  setViewport(viewport: Partial<ViewportState>): void {
    const next: ViewportState = { ...this.viewportState, ...viewport };
    if (!(next.zoom > 0) || !Number.isFinite(next.zoom) || !Number.isFinite(next.x) || !Number.isFinite(next.y)) {
      console.error('[SessionStore] 非法视口参数，已忽略:', viewport);
      return;
    }
    next.zoom = Math.min(this.zoomRange.max, Math.max(this.zoomRange.min, next.zoom));
    const current = this.viewportState;
    if (next.x === current.x && next.y === current.y && next.zoom === current.zoom) return;

    // 整体替换而非就地修改：持有旧引用的读者不会读到撕裂的中间态
    this.viewportState = next;
    this.notify({
      viewportChanged: true,
      themeChanged: false,
      toggledNodeIds: EMPTY_ID_SET,
      toggledConnectorIds: EMPTY_ID_SET
    });
  }

  zoomAt(factor: number, worldPoint: Point): void {
    const { x, y, zoom } = this.viewportState;
    const nextZoom = Math.min(this.zoomRange.max, Math.max(this.zoomRange.min, zoom * factor));
    // 保持 worldPoint 的屏幕位置不变：screen = world * zoom + offset
    this.setViewport({
      x: x + worldPoint.x * (zoom - nextZoom),
      y: y + worldPoint.y * (zoom - nextZoom),
      zoom: nextZoom
    });
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
    this.notify({ viewportChanged: false, themeChanged: false, toggledNodeIds, toggledConnectorIds });
  }

  /**
   * 剔除已被删除实体的选中项 (由引擎在文档实体删除后调用，保证选区永不指向不存在的实体)
   */
  pruneSelection(removedNodeIds: ReadonlySet<string>, removedConnectorIds: ReadonlySet<string>): void {
    if (removedNodeIds.size === 0 && removedConnectorIds.size === 0) return;
    // 按选区规模遍历：选区通常远小于一次批量删除的规模
    const keptNodeIds = [...this.nodeSelection].filter((id) => !removedNodeIds.has(id));
    const keptConnectorIds = [...this.connectorSelection].filter((id) => !removedConnectorIds.has(id));
    this.setSelection({ nodeIds: keptNodeIds, connectorIds: keptConnectorIds });
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
        console.error('[SessionStore] 会话监听回调异常:', err);
      }
    }
  }
}

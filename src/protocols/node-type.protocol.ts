/**
 * @file node-type.protocol.ts
 * @description 统一节点类型规范与 defineNodeType 注册协议
 * 
 * 设计考量 (Why):
 * 1. 渐进式渲染阶梯：普通节点实现 compose() 即可享受跨引擎绘制；富文本/视频实现 mountDOM() 作为逃生舱。
 * 2. 尺寸所有权与复合排版：支持 sizingPolicy 声明外框自适应策略，并通过 computeBounds 求解复杂零件与多插槽文本联动。
 * 3. 严格类型约束：通过泛型严密绑定节点的私有 data 与 style，杜绝运行时属性未定义访问。
 */

import type { NodeEntity, NodeStyle, Point, TextSizingMode, NodeTextStyle } from '../types';
import type { CanvasPrimitive } from './primitives.protocol';
import type { CanvasTheme } from '../types/theme';

/** compose() 的渲染上下文 */
export interface NodeComposeContext {
  /**
   * 当前主题：未显式设置颜色的零件应取主题语义色 (如 theme.nodeFill / theme.textColor)，
   * 也可直接输出 `$名称` 引用调色板，由渲染管线统一解析
   */
  readonly theme: CanvasTheme;
}

/** 节点外框尺寸驱动策略 */
export type NodeSizingPolicy =
  | 'fixed'           // 宽高全由用户拖拽决定，内容不撑开外框 (如几何矩形、圆)
  | 'height-driven'   // 宽度固定，高度由内容自适应向下撑高 (如便签卡片、长段落卡片)
  | 'content-driven'; // 宽高双向由内容自动撑大 (如思维导图气泡、自由文本)

/** 节点文本插槽静态规则契约 (代码级 Blueprint，绝不污染持久化文档) */
export interface NodeTextSlotDefinition {
  /** 插槽唯一标识，如 'title', 'body', 'footer' */
  readonly slot: string;
  /** UI 呈现说明 */
  readonly label?: string;
  /** 插槽默认尺寸自适应策略 (如 'auto-height') */
  readonly sizing?: TextSizingMode;
  /**
   * 该插槽内容折行撑开时，是否负责驱动宿主节点外框一同向下延伸
   */
  readonly expandsContainer?: boolean;
  /** 插槽默认外观样式 */
  readonly defaultStyle?: NodeTextStyle;
}

/** 单个文本块的实际测量排版包围盒快照 */
export interface TextBlockMetrics {
  readonly width: number;
  readonly height: number;
  readonly lineCount?: number;
}

/** 变换控制手柄定义 */
export interface NodeControlHandle {
  id: string;
  label?: string;
  cursor?: string;
  getPosition(node: NodeEntity): Point;
}

/**
 * 节点类型定义契约
 */
export interface NodeTypeDefinition<
  TData = Record<string, unknown>,
  TStyle extends NodeStyle = NodeStyle
> {
  /** 节点全局唯一类型标识，例如 'free-text', 'card', 'custom:sticker' */
  readonly type: string;
  /** UI 呈现名称 */
  readonly label: string;
  /** 默认初始业务载荷 */
  readonly defaultData: TData;
  /** 默认初始几何样式 */
  readonly defaultStyle?: TStyle;

  /**
   * 节点的几何外框自适应策略 (默认为 'fixed')
   */
  readonly sizingPolicy?: NodeSizingPolicy;

  /**
   * 静态文本插槽规则集合 (Blueprint)
   * 声明节点拥有哪些语义文本槽位及其是否撑开容器，纯静态配置，不入持久化文档。
   */
  readonly slots?: NodeTextSlotDefinition[];

  /**
   * 动态几何尺寸与多插槽排版求解器 (选填)
   * 当内部任何文本块发生测量尺寸变动时，内核会调用此函数，由节点自己精准决定外框宽高！
   * @param node 当前节点
   * @param textMetrics 每一个 slot 文本块的实际测量包围盒映射
   */
  computeBounds?: (
    node: NodeEntity<TData, TStyle>,
    textMetrics: Map<string, TextBlockMetrics>
  ) => { width: number; height: number };

  /**
   * 【模式 A：声明式跨引擎中间图元】(选填：极力推荐)
   * 返回纯 JSON 描述的基础图元集合，引擎自动将其渲染至当前生效的渲染器 (Leafer / WebGPU / SVG)。
   * 内部各零件 (如文本下方的矩形、进度条) 可直接基于 node 的最新宽高进行相对数学计算。
   * 主题切换后会以新主题重新调用，严禁在图元中写死色值。
   */
  compose?: (node: NodeEntity<TData, TStyle>, context: NodeComposeContext) => CanvasPrimitive[];

  /**
   * 【模式 B：DOM 浮层逃生舱】(选填)
   * 针对富交互 Web 组件 (如 Monaco Editor, ECharts, 视频播放器)。
   * 遵守平台中立红线：容器使用 unknown 类型，严禁直接引入原生 HTMLElement。
   * 返回清理解绑函数。
   */
  mountDOM?: (node: NodeEntity<TData, TStyle>, container: unknown) => () => void;

  /** 控制手柄列表提供器 (选填) */
  getHandles?: (node: NodeEntity<TData, TStyle>) => NodeControlHandle[];
}

/**
 * 辅助构造函数：为插件开发者提供类型推导友好的节点类型定义工具
 */
export function defineNodeType<
  TData = Record<string, unknown>,
  TStyle extends NodeStyle = NodeStyle
>(definition: NodeTypeDefinition<TData, TStyle>): NodeTypeDefinition<TData, TStyle> {
  return definition;
}

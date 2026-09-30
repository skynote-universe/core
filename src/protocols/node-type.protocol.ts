/**
 * @file node-type.protocol.ts
 * @description 统一节点类型规范：插件以类实现 NodeTypeDefinition，经 registerNodeType 注册
 *
 * 设计考量 (Why):
 * 1. 渐进式渲染阶梯：普通节点实现 compose() 即可享受跨引擎绘制；富文本/视频实现 mountDOM() 作为逃生舱。
 * 2. 尺寸所有权与复合排版：支持 sizingPolicy 声明外框自适应策略，并通过 computeBounds 求解复杂零件与多插槽文本联动。
 * 3. 严格类型约束：通过泛型严密绑定节点的私有 data 与 style，杜绝运行时属性未定义访问。
 */

import type { NodeEntity, NodeStyle, TextSizingMode, NodeTextStyle } from '../types';
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
  | 'fixed' // 宽高全由用户拖拽决定，内容不撑开外框 (如几何矩形、圆)
  | 'height-driven' // 宽度固定，高度由内容自适应向下撑高 (如便签卡片、长段落卡片)
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

/** 节点类型为新节点提供的部分；id、类型、位置、旋转、层级与锁定由引擎填写 */
export type NodeCreateContent<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle> = Pick<
  NodeEntity<TData, TStyle>,
  'width' | 'height'
> &
  Partial<Pick<NodeEntity<TData, TStyle>, 'textBlocks' | 'style' | 'textStyle' | 'anchors' | 'data'>>;

/**
 * 各节点类型的新建选项表：节点插件以模块扩充登记，createNode 据 nodeType 推导 options 的类型
 * @example declare module '@skynote/core' { interface NodeCreateOptionsMap { sticky: StickyCreateOptions } }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 供模块扩充的登记表，内核自身不登记任何类型
export interface NodeCreateOptionsMap {}

/** 某节点类型的新建选项；未登记的类型 (如运行时动态类型) 退化为任意对象 */
export type NodeCreateOptions<T extends string> = T extends keyof NodeCreateOptionsMap
  ? NodeCreateOptionsMap[T]
  : object;

/** 经引擎新建节点的请求 */
export interface CreateNodeRequest<T extends string = string> {
  nodeType: T;
  /** 父容器局部坐标；origin 决定它是节点左上角 (默认) 还是中心 */
  x: number;
  y: number;
  origin?: 'top-left' | 'center';
  parentId?: string;
  /** 缺省时自动生成 */
  id?: string;
  /** 覆盖节点类型给出的默认尺寸 (如拖拽框出的形状) */
  width?: number;
  height?: number;
  rotation?: number;
  /** 节点类型自身的选项 (文字、颜色、几何等) */
  options?: NodeCreateOptions<T>;
  /** 撤销记录名称 */
  label?: string;
}

/**
 * 节点类型定义契约
 */
export interface NodeTypeDefinition<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle> {
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
   * 引擎注入 TextMeasurer 后生效：文本或宽度变化时在同一事务内派生尺寸 (见 layout/text-layout)。
   */
  readonly sizingPolicy?: NodeSizingPolicy;

  /**
   * 是否裁剪子节点 (画框类容器，默认 false)：子节点超出本节点外框的部分不绘制也不可拾取。
   * 两端都在本容器内的连线随之裁剪；跨容器连线挂在公共祖先容器中，不受裁剪 (ADR-114)。
   */
  readonly clipChildren?: boolean;

  /**
   * 静态文本插槽规则集合 (Blueprint)
   * 声明节点拥有哪些语义文本槽位及其是否撑开容器，纯静态配置，不入持久化文档。
   * 排版时插槽的 sizing 与 defaultStyle 作为该插槽文本块的默认值。
   */
  readonly slots?: NodeTextSlotDefinition[];

  /**
   * 动态几何尺寸与多插槽排版求解器 (选填)
   * 当内部任何文本块发生测量尺寸变动时，内核会调用此函数，由节点自己精准决定外框宽高！
   * @param node 当前节点
   * @param textMetrics 每一个 slot 文本块的实际测量包围盒映射
   * textMetrics 以插槽名 (无插槽时为文本块 id) 为键，度量为不含 padding 的内容盒；提供时优先于 sizingPolicy 的默认规则。
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
   * 【尚未实现】渲染器暂未提供 DOM 浮层挂载点，落地前不会调用该函数。
   */
  mountDOM?: (node: NodeEntity<TData, TStyle>, container: unknown) => () => void;

  /**
   * 新建节点的内容 (选填)：按本类型默认值与选项给出尺寸、样式、数据与文本。
   * 由 SkyNoteEngine.createNode 统一调用，id、位置、层级等公共字段由引擎填写；未实现的类型不能经引擎新建。
   * 写成方法签名：各类型的选项结构不同，实现方可收窄参数类型 (选项表见 NodeCreateOptionsMap)。
   */
  createContent?(options: object): NodeCreateContent<TData, TStyle>;
}

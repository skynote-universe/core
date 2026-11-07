/**
 * @file node-type.protocol.ts
 * @description 统一节点类型规范：插件以类实现 NodeTypeDefinition，经 registerNodeType 注册
 *
 * 设计考量 (Why):
 * 1. 渐进式渲染阶梯：普通节点实现 compose() 即可享受跨引擎绘制；富文本/视频实现 mountDOM() 作为逃生舱。
 * 2. 尺寸所有权与复合排版：支持 sizingPolicy 声明外框自适应策略，并通过 computeBounds 求解复杂零件与多插槽文本联动。
 * 3. 严格类型约束：通过泛型严密绑定节点的私有 data 与 style，杜绝运行时属性未定义访问。
 */

import type {
  CanvasPatch,
  NodeDataPath,
  CustomNodeFields,
  NodeEntity,
  NodeStyle,
  TextBlock,
  TextSizingMode,
  NodeTextStyle
} from '../types';
import type { Point, RectBounds } from '../types/geometry';
import type { CanvasPrimitive, TextPrimitive } from './primitives.protocol';
import type { CanvasTheme } from '../types/theme';

/** compose() 的渲染上下文 */
export interface NodeComposeContext {
  /**
   * 当前主题：未显式设置颜色的零件应取主题语义色 (如 theme.nodeFill / theme.textColor)，
   * 也可直接输出 `$名称` 引用调色板，由渲染管线统一解析
   */
  readonly theme: CanvasTheme;
}

/** 稳定分片按数组顺序叠放；空图元仍保留槽位，局部更新不能改变分片顺序。 */
export interface NodeCompositionPart {
  readonly id: string;
  readonly primitives: readonly CanvasPrimitive[];
}

/** 节点外框尺寸驱动策略 */
export type NodeSizingPolicy =
  | 'fixed' // 宽高全由用户拖拽决定，内容不撑开外框 (如几何矩形、圆)
  | 'height-driven' // 宽度固定，高度由内容自适应向下撑高 (如便签卡片、长段落卡片)
  | 'content-driven'; // 宽高双向由内容自动撑大 (如思维导图气泡、自由文本)

/** 节点透明度为零时的可见性语义 */
export type NodeOpacityBehavior = 'whole-node' | 'renderer-defined';

/** 节点类型解释自己的资产字段；通用事务只使用公开契约。 */
export interface NodeAssetReferences {
  collect(node: Readonly<NodeEntity>): readonly string[];
  remap(node: Readonly<NodeEntity>, ids: ReadonlyMap<string, string>): Partial<CustomNodeFields>;
  /** 外部文档的可恢复字段修复；纯函数，只返回本节点拥有的扩展字段，不制造资产。 */
  repair?(node: Readonly<NodeEntity>): Partial<CustomNodeFields> | undefined;
}

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
  /**
   * 纯文本插槽 (如画框标题)：外观由节点类型固定，不接受文字格式；
   * 编辑时界面不显示格式工具栏，粘贴只取纯文本，选中节点时也不作为整块格式的目标
   */
  readonly plainText?: boolean;
  /** 单行插槽：Enter 确认并退出编辑，粘贴的换行替换为空格 */
  readonly singleLine?: boolean;
  /**
   * 自动宽度 (auto-width) 的上限 (内容宽度，不含内边距)：文字超过时按此宽度折行、高度随之增长
   * (如标签、按钮文字)；缺省为不限，始终单行
   */
  readonly maxWidth?: number;
}

/** 单个文本块的实际测量排版包围盒快照 */
export interface TextBlockMetrics {
  readonly width: number;
  readonly height: number;
  readonly lineCount?: number;
}

/** 缩放控制柄：四边中点与四角 (按节点自身未旋转的方位) */
export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

/** 用户可调整的尺寸方向：宽高、单轴，或完全由内容决定而不可手动调整 */
export type NodeResizeAxes = 'both' | 'width' | 'height' | 'none';

/** 控制柄调整外框或整体内容；布局可强制覆盖用户偏好。 */
export type NodeResizeBehavior = 'resize-bounds' | 'scale-contents';

export interface NodeResizePolicy {
  behavior: NodeResizeBehavior;
  axes: NodeResizeAxes;
  lockAspect: boolean;
}

/** 用户拖动控制柄后的目标尺寸 */
export interface NodeResizeRequest {
  handle: ResizeHandle;
  /** 用户拖出的外框尺寸 (已夹取最小值) */
  width: number;
  height: number;
  /** 等比缩放时相对缩放开始时的倍数；非等比时为 1 */
  scale: number;
}

/** fitContent() 的上下文 */
export interface NodeFitContext {
  /**
   * 按文本块最终样式测量内容盒 (不含 padding)；maxWidth 缺省时不折行，与排版派生走同一测量器
   * 未注入字体测量器时返回 null，需要测量的节点类型应视为无法适应
   */
  measureText(block: Readonly<TextBlock>, maxWidth?: number): TextBlockMetrics | null;
}

/** 节点的生效样式：节点类型的默认样式 < 节点自身样式 */
export function resolveNodeStyle(node: Readonly<NodeEntity>, definition: NodeTypeDefinition | undefined): NodeStyle {
  return { ...definition?.defaultStyle, ...node.style };
}

/** 节点当前是否锁定比例：节点上的显式值优先，否则取节点类型的默认值 */
export function isAspectLocked(node: Readonly<NodeEntity>, definition: NodeTypeDefinition | undefined): boolean {
  return node.aspectLocked ?? definition?.defaultAspectLocked ?? false;
}

/** 节点类型为新节点提供的部分；id、类型、位置、旋转、层级与锁定由引擎填写 */
export type NodeCreateContent<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle> = Pick<
  NodeEntity<TData, TStyle>,
  'width' | 'height'
> &
  Partial<
    Pick<NodeEntity<TData, TStyle>, 'textBlocks' | 'style' | 'textStyle' | 'data' | 'layout' | 'layoutItem'> &
      CustomNodeFields
  >;

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
  /** 创建容器节点 (acceptsChildren) 时是否自动收纳完全落入其外框内的同层节点，默认 true */
  autoWrap?: boolean;
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
  /**
   * 节点未设置的样式项取此默认值 (如画框线宽 1、圆角 4)；颜色缺省跟随主题，不在此列。
   * 绘制与界面面板经 resolveNodeStyle 读同一份生效样式，面板显示的值即画出的值
   */
  readonly defaultStyle?: TStyle;

  /** style.opacity 为零时默认隐藏整个节点；renderer-defined 表示保留节点，由渲染实现决定透明度作用范围 */
  readonly opacityBehavior?: NodeOpacityBehavior;
  readonly assets?: NodeAssetReferences;

  /**
   * 节点的几何外框自适应策略 (默认为 'fixed')
   * 引擎注入 FontMeasurer 后生效：文本或宽度变化时在同一事务内派生尺寸 (见 layout/text-layout)。
   */
  readonly sizingPolicy?: NodeSizingPolicy;

  /**
   * 是否裁剪子节点 (画框类容器，默认 false)：子节点超出本节点外框的部分不绘制也不可拾取。
   * 两端都在本容器内的连线随之裁剪；跨容器连线挂在公共祖先容器中，不受裁剪 (ADR-114)。
   */
  readonly clipChildren?: boolean;

  /**
   * 可经拖拽接收子节点 (画框等容器)：拖动节点松手时指针所在的最上层此类节点成为其新父容器，
   * 落在空白处则移出到画布根层级 (ADR-123)
   */
  readonly acceptsChildren?: boolean;

  /**
   * 静态文本插槽规则集合 (Blueprint)
   * 声明节点拥有哪些语义文本槽位及其是否撑开容器，纯静态配置，不入持久化文档。
   * 排版时插槽的 sizing 与 defaultStyle 作为该插槽文本块的默认值。
   */
  readonly slots?: NodeTextSlotDefinition[];
  /** 多文字块节点可在 Tab 时结束当前编辑，将后续导航交给节点的输入作用域。 */
  readonly tabNavigatesTextBlocks?: boolean;

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
  ) => { width: number; height: number; patches?: readonly CanvasPatch[] };

  /**
   * 为指定文本块计算折行测量宽度 (不含 padding)；缺省按节点宽度与文本块 explicitWidth 决定。
   * 多列网格节点 (如表格) 可按文本块所属列/合并格返回单元格可用内宽。
   */
  measureBlockWidth?: (node: Readonly<NodeEntity<TData, TStyle>>, block: Readonly<TextBlock>) => number | undefined;

  /**
   * 除默认触发字段 (textBlocks/textStyle/width/height/nodeType) 外，修改这些节点顶层扩展字段时也触发重新排版。
   */
  readonly layoutTriggerFields?: readonly string[];

  /**
   * 【模式 A：声明式跨引擎中间图元】(选填：极力推荐)
   * 返回纯 JSON 描述的基础图元集合，引擎自动将其渲染至当前生效的渲染器 (Leafer / WebGPU / SVG)。
   * 内部各零件 (如文本下方的矩形、进度条) 可直接基于 node 的最新宽高进行相对数学计算。
   * 主题切换后会以新主题重新调用，严禁在图元中写死色值。
   */
  compose?: (node: NodeEntity<TData, TStyle>, context: NodeComposeContext) => CanvasPrimitive[];
  /** 多文字块节点按标识直接提供编辑图元，避免一次输入重新生成全部内容。 */
  composeTextBlock?: (
    node: NodeEntity<TData, TStyle>,
    context: NodeComposeContext,
    blockId: string
  ) => TextPrimitive | undefined;
  /** 可选的分片绘制协议；compose 继续用于导出及不支持分片的消费者。 */
  composeParts?: (node: NodeEntity<TData, TStyle>, context: NodeComposeContext) => readonly NodeCompositionPart[];
  /** 返回本次受影响的既有分片；null 表示结构变化，需要重新 composeParts。 */
  composeChangedParts?: (
    node: NodeEntity<TData, TStyle>,
    context: NodeComposeContext,
    paths: readonly NodeDataPath[]
  ) => readonly NodeCompositionPart[] | null;
  /** 节点自行声明本次字段变化是否影响文字驱动尺寸；缺省继续完整测量。 */
  affectsTextLayout?: (node: Readonly<NodeEntity<TData, TStyle>>, paths: readonly NodeDataPath[]) => boolean;

  /**
   * 新建节点默认锁定比例 (如便签、图片、固定比例的容器)；用户可随时解锁，节点上的 aspectLocked 优先
   * 所有节点都可以自由调整宽高，锁定只改变结果为等比，不限制可拖动的控制柄
   */
  readonly defaultAspectLocked?: boolean;
  /**
   * 文字删空后退出编辑即删除节点 (如自由文本：没有文字的文本节点既看不见也无法再选中)
   */
  readonly removeWhenEmpty?: boolean;
  /**
   * 选中时四边是否显示快捷添加/快速连线「+」按钮 (缺省为 true)
   * 表格、音视频等结构化图元可显式设为 false
   */
  readonly quickConnect?: boolean;
  /**
   * 连线吸附点 (局部坐标，会投影到轮廓上)，缺省为轮廓包围盒四边中点的投影 (矩形四边中点、椭圆与菱形四个端点)。
   * 包围盒中点落不到合适位置的形状在此声明，如星形的五个尖角、三角形的顶点与各边中点；返回 undefined 时用缺省
   */
  anchors?(node: NodeEntity<TData, TStyle>): readonly Point[] | undefined;
  /**
   * 绘制时采用样式中的圆角 (style.radius)，缺省 false；界面据此决定是否提供圆角设置，
   * 例如形状只有矩形画圆角，椭圆、菱形调了也看不出变化
   */
  supportsCornerRadius?(node: NodeEntity<TData, TStyle>): boolean;
  /**
   * 拖角时等比缩放内容 (如自由文本按比例缩放字号)，与比例锁定无关；边控制柄不受影响
   */
  readonly scaleContentOnCorners?: boolean;
  /** 支持整体缩放后代；实际控制柄行为由 getResizeBehavior 决定。 */
  readonly supportsContentScale?: boolean;
  /** 只声明控制柄行为；数值面板仍使用外框尺寸语义。 */
  getResizeBehavior?(node: NodeEntity<TData, TStyle>, handle: ResizeHandle): NodeResizeBehavior;
  /**
   * 整体等比缩放的最终字段，基于起始快照计算，不得改写入参。
   * 未返回 textBlocks 时内核统一缩放文本；显式返回时以 hook 为准（不再缩放一遍），像素值仍由内核取整。
   */
  applyContentScale?(node: NodeEntity<TData, TStyle>, scale: number): Partial<NodeEntity<TData, TStyle>>;
  /**
   * 用户可调整的尺寸方向 (缺省 both)。另一轴完全由内容决定的节点 (如高度随文字的标签只能调宽度) 单选时
   * 不出现该轴的边控制柄，拖角与等比修饰键也只改可调的一轴
   */
  readonly resize?: NodeResizeAxes;
  /** 按当前节点状态声明可调整轴，优先于静态 resize；none 表示尺寸完全由内容派生。 */
  getResizeAxes?(node: NodeEntity<TData, TStyle>): NodeResizeAxes;
  /**
   * 裁剪超出外框的内容图元 (缺省 false，照常显示)
   * 文字的溢出方式另由插槽样式 textOverflow 决定 (如便签、形状标签显示省略号)
   */
  readonly clipContent?: boolean;

  /**
   * 用户缩放后需要一并写入的字段 (缺省只写外框宽高)
   * 例如自由文本拖边时切换为固定宽度 / 固定尺寸，拖角时按比例缩放字号。
   * 写成方法签名：实现方可按自身数据结构收窄返回值。
   * @param node 缩放开始时的节点 (同一次拖拽的每一帧都以它为基准，结果不累积误差)
   * 整体缩放回退调用本 hook 时，显式返回的 textBlocks 同样视为最终结果。
   */
  applyResize?(node: NodeEntity<TData, TStyle>, request: NodeResizeRequest): Partial<NodeEntity<TData, TStyle>>;

  /**
   * 让外框适应内容 (浮动工具栏「适应内容」)
   * 自适应类节点 (如自由文本) 恢复尺寸状态，外框交给排版派生；固定尺寸类节点 (如便签) 按测量结果一次性写入尺寸
   * @returns 需要写入的字段；已经适应内容或不支持时返回 null (界面据此决定是否显示入口)
   */
  fitContent?(node: NodeEntity<TData, TStyle>, context: NodeFitContext): Partial<NodeEntity<TData, TStyle>> | null;

  /**
   * 节点占据的局部范围 (缺省为外框)：框外的装饰 (如画框标题) 须包含在内。
   * 空间索引据此登记，拾取时落在轮廓 (outline) 之外但在此范围内的点同样命中节点；
   * 可依赖节点的任意字段 (如标题文字)，节点数据变化时会重新登记
   */
  extent?(node: NodeEntity<TData, TStyle>): RectBounds;

  /**
   * 节点轮廓：自身局部坐标系中的闭合多边形 (缺省为外框矩形)
   * 用于精确拾取与悬停高亮，椭圆、菱形等非矩形节点点在外框空角时不会被选中；
   * 开放路径请勿实现此方法 (否则悬停高亮会将其首尾闭合)，改用 hitTest 与 intersectsBounds。
   */
  outline?(node: NodeEntity<TData, TStyle>): readonly Point[];

  /**
   * 节点局部坐标系下的精确点选命中判定 (选填，用于自由笔迹、开放贝塞尔路径、镂空图形等)
   * 提供时优先于 outline / 外框矩形 / extent 的默认包含判定：返回 false 即视为未命中，不再回退到 extent。
   * @param node 当前节点
   * @param localPoint 指针在节点局部坐标系中的位置
   * @param tolerance 屏幕拾取容差换算到节点局部坐标系后的距离阈值
   */
  hitTest?(node: NodeEntity<TData, TStyle>, localPoint: Point, tolerance: number): boolean;

  /**
   * 节点局部坐标系下的选框相交判定 (选填，用于框选粗筛后的几何精判)
   * 缺省时空间索引世界外接矩形相交即视为框选命中；细长斜向笔迹或开放曲线可实现此方法排除空白外框角。
   * @param node 当前节点
   * @param localBounds 选框转换到节点局部坐标系后的包围盒
   */
  intersectsBounds?(node: NodeEntity<TData, TStyle>, localBounds: RectBounds): boolean;

  /**
   * 节点特有结构的合法性校验 (选填，纯函数)
   * 校验通过返回 null；若外部导入、剪贴板或历史数据中的节点特有字段损坏，返回非空错误描述字符串。
   * 校验失败的节点在渲染层降级为占位框，在内核拾取与空间索引中回退为基础矩形外框，避免损坏数据导致整帧崩溃。
   */
  validate?(node: Readonly<NodeEntity<TData, TStyle>>): string | null;

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

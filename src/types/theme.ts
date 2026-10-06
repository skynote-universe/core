/**
 * @file theme.ts
 * @description 画布主题：少量种子色 + 推导出的语义色板
 *
 * 设计考量 (Why):
 * 1. 种子驱动：开发者只需给出背景、前景、强调三色，其余语义色由 deriveCanvasTheme 统一推导，
 *    明暗主题共享同一套推导规则，不会出现某个角落漏配颜色。
 * 2. 主题属于本地会话：同一文档，不同用户可各自使用浅色或深色主题，主题不写入 CanvasDocument。
 * 3. 文档颜色语义：实体样式未设置的颜色跟随主题；显式色值原样保留；`$名称` 形式引用主题调色板 (palette)，
 *    为将来“同一语义色在明暗主题下自动切换”预留，存储格式无需再变。
 */

/** 主题种子色 (开发者显式配置) */
export interface CanvasThemeSeed {
  /** 画布底色 */
  readonly background: string;
  /** 正文与线条主色 */
  readonly foreground: string;
  /** 选中与强调色 */
  readonly accent: string;
  /** 吸附参考线颜色 (缺省取强调色)：与选中框区分开，拖动时一眼看出是对齐提示 */
  readonly guide?: string;
  /** 语义调色板：文档中的 `$名称` 颜色引用在此解析，如 { yellow: '#FDE68A' } */
  readonly palette?: Readonly<Record<string, string>>;
}

/** 推导完成的主题语义色板 (只读) */
export interface CanvasTheme {
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
  /** 节点默认填充 */
  readonly nodeFill: string;
  /** 节点默认描边 */
  readonly nodeStroke: string;
  /** 默认文字颜色 */
  readonly textColor: string;
  /** 连线默认颜色 */
  readonly connectorStroke: string;
  /** LOD 占位块与降级占位框的默认填充 */
  readonly placeholderFill: string;
  /** 选中描边 */
  readonly selectionStroke: string;
  /** 吸附对齐参考线 */
  readonly snapGuide: string;
  readonly palette: Readonly<Record<string, string>>;
}

/** 对推导结果的逐项覆盖 (调色板经由种子配置) */
export type CanvasThemeOverrides = Partial<Omit<CanvasTheme, 'palette'>>;

/** 主题配置：种子色 + 可选的逐项覆盖 */
export interface CanvasThemeConfig {
  readonly seed: CanvasThemeSeed;
  readonly overrides?: CanvasThemeOverrides;
}

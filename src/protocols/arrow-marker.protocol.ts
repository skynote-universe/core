/**
 * @file arrow-marker.protocol.ts
 * @description 连线端点箭头标记规范与 defineArrowMarker 注册协议
 * 
 * 设计考量 (Why):
 * 1. 突破硬编码限制：连线端点不应写死为有限枚举，支持上层插件注册 UML、BPMN、电路图、思维导图等专业端点符号。
 * 2. 几何线身后撤 (lineOffset)：箭头通常有自身长度，若线身直接画到端点，粗线条会穿透箭头尖端；通过 lineOffset，引擎几何算法可自动将连线折线物理截短，确保视觉刀锋锐利。
 */

/** 箭头颜色填充规则 */
export type ArrowMarkerFillRule =
  | 'match-stroke'    // 填充颜色与连线描边色一致 (实心箭头)
  | 'match-background'// 填充背景底色 (空心箭头，如 UML 泛化继承)
  | 'none';           // 不填充 (仅描边开放箭头，如依赖箭头)

/**
 * 连线箭头端点标记定义契约
 */
export interface ArrowMarkerDefinition {
  /** 箭头全局唯一标识，如 'standard:arrow', 'uml:inheritance', 'bpmn:message' */
  readonly id: string;
  /** UI 呈现名称 */
  readonly label: string;
  /** 箭头包围盒标称宽度 (像素) */
  readonly width: number;
  /** 箭头包围盒标称高度 (像素) */
  readonly height: number;
  /**
   * 连线几何缩进截断量 (Line Offset):
   * 引擎沿切线方向自动将连线末端后撤指定像素，防止连线线身重叠穿透箭头尖端。
   */
  readonly lineOffset: number;
  /** SVG 路径绘制指令 (以 (0,0) 为箭头尖端或锚定基准) */
  readonly d: string;
  /** 填充规则 */
  readonly fillRule?: ArrowMarkerFillRule;
}

/**
 * 辅助构造函数：为插件开发者提供类型推导友好的箭头标记定义工具
 */
export function defineArrowMarker(
  definition: ArrowMarkerDefinition
): ArrowMarkerDefinition {
  return definition;
}

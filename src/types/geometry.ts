/**
 * @file geometry.ts
 * @description 基础几何类型：点、轴对齐包围盒与二维仿射矩阵 (运算见 utils/geometry)
 */

/** 二维坐标点 */
export interface Point {
  x: number;
  y: number;
}

/** 轴对齐包围盒 (AABB)：只存四条边，宽高按需以 right - left、bottom - top 计算 */
export interface RectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 二维仿射矩阵：x' = a·x + c·y + e，y' = b·x + d·y + f
 * 节点只有平移与旋转 (尺寸由 width / height 表达，不含缩放)，世界矩阵始终是刚体变换
 */
export interface Matrix2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** 参与几何计算的节点字段：x / y / rotation 相对父容器 (ADR-114)，rotation 单位为度、绕节点中心旋转 */
export interface RotatableBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

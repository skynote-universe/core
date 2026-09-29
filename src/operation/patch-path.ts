/**
 * @file patch-path.ts
 * @description 补丁寻址路径解析与对象定位器
 * 
 * 设计考量 (Why):
 * 1. 防原型链污染 (AGENTS.md 铁律)：严格过滤 `__proto__`、`prototype`、`constructor`，防止外部不安全数据注入。
 * 2. 零冗余解析：对数组形式的分段路径直接消费，点号分割路径快速分词，兼顾 API 易用性与微秒级高频执行性能。
 */

import type { CanvasPatchPath } from '../types/operation';
import { DANGEROUS_KEYS } from '../utils/clone';


/** 路径分词微缓存 (上限 512，避免无界膨胀) */
const MAX_PATH_CACHE_SIZE = 512;
const PATH_CACHE = new Map<string, readonly (string | number)[]>();

/**
 * 将 CanvasPatchPath 标准化为段落数组 (内置微缓存，加速高频字符串路径解析)
 */
export function normalizePatchPath(path: CanvasPatchPath): readonly (string | number)[] {
  if (Array.isArray(path)) {
    return path;
  }
  if (typeof path !== 'string' || path.length === 0) {
    return [];
  }

  const cached = PATH_CACHE.get(path);
  if (cached) {
    return cached;
  }

  const segments = path.split('.');
  const result: (string | number)[] = new Array(segments.length);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // 纯十进制数字字符串转换为数字下标，方便数组定位
    if (/^\d+$/.test(seg)) {
      result[i] = Number(seg);
    } else {
      result[i] = seg;
    }
  }

  if (PATH_CACHE.size >= MAX_PATH_CACHE_SIZE) {
    PATH_CACHE.clear();
  }
  PATH_CACHE.set(path, result);

  return result;
}

/**
 * 沿路径查找目标值的安全解析结果
 */
export interface PathResolution {
  /** 倒数第二级持有者对象或数组（目标属性的直接父容器） */
  readonly parent: Record<string, unknown> | unknown[];
  /** 最后一级属性名或数组下标 */
  readonly key: string | number;
  /** 目标位置在变更前的当前值 */
  readonly currentValue: unknown;
  /** 路径是否完整命中（父容器存在且目标属性存在） */
  readonly exists: boolean;
}

/**
 * 沿路径安全读取对象上的当前值
 */
export function getValueByPath(root: unknown, path: CanvasPatchPath): unknown {
  const segments = normalizePatchPath(path);
  if (segments.length === 0) {
    return root;
  }

  let curr: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    if (curr === null || typeof curr !== 'object') {
      return undefined;
    }
    const key = segments[i];
    if (typeof key === 'string' && DANGEROUS_KEYS.has(key)) {
      return undefined;
    }
    curr = (curr as Record<string | number, unknown>)[key];
  }

  return curr;
}

/**
 * 解析路径并返回目标属性的父级引用与键名，用于原子写入/修改
 * 中间层级必须真实存在（自有属性且为对象），绝不自动补建：
 * 否则针对已删除实体的迟到补丁（远端并发修改、撤销旧操作）会凭空造出残缺实体。
 */
export function resolvePathForWrite(root: unknown, path: CanvasPatchPath): PathResolution | null {
  const segments = normalizePatchPath(path);
  if (segments.length === 0 || root === null || typeof root !== 'object') {
    return null;
  }

  let curr: Record<string | number, unknown> = root as Record<string | number, unknown>;

  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (typeof key === 'string' && DANGEROUS_KEYS.has(key)) {
      return null;
    }
    if (!Object.hasOwn(curr, key)) {
      return null;
    }

    const next = curr[key];
    if (next === null || typeof next !== 'object') {
      return null;
    }
    curr = next as Record<string | number, unknown>;
  }

  const finalKey = segments[segments.length - 1];
  if (typeof finalKey === 'string' && DANGEROUS_KEYS.has(finalKey)) {
    return null;
  }

  const exists = Object.prototype.hasOwnProperty.call(curr, finalKey);
  const currentValue = curr[finalKey];

  return {
    parent: curr as Record<string, unknown> | unknown[],
    key: finalKey,
    currentValue,
    exists
  };
}

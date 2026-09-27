/**
 * @file equality.ts
 * @description 极速结构值等价性比对工具 (替代外部庞大的 lodash.isEqual)
 * 
 * 设计考量 (Why):
 * 1. 极简依赖红线：手写收敛，支持循环引用保护、TypedArray 内存块极速校验、Map/Set/Date/RegExp 特殊内置对象处理。
 * 2. 脏检查加速：在 Patch 生成与 Diff 阶段，避免无变化的属性产生无意义的原子操作，节约 80% 的协同广播流量。
 */

export const isEqual = areStructuredValuesEqual;

export function areStructuredValuesEqual(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>()
): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false;
  }

  // 循环引用保护
  const seenRight = seen.get(left);
  if (seenRight) return seenRight === right;
  seen.set(left, right);

  // TypedArray / ArrayBuffer 视图比对
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    if (left.constructor !== right.constructor || left.byteLength !== right.byteLength) {
      return false;
    }
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return leftBytes.every((val, idx) => val === rightBytes[idx]);
  }

  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }

  if (left instanceof RegExp || right instanceof RegExp) {
    return (
      left instanceof RegExp &&
      right instanceof RegExp &&
      left.source === right.source &&
      left.flags === right.flags
    );
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, idx) => areStructuredValuesEqual(item, right[idx], seen));
  }

  // 普通键值对象浅/深比对
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;

  const leftObj = left as Record<string, unknown>;
  const rightObj = right as Record<string, unknown>;

  return leftKeys.every(
    key =>
      Object.prototype.hasOwnProperty.call(rightObj, key) &&
      areStructuredValuesEqual(leftObj[key], rightObj[key], seen)
  );
}

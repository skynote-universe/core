/**
 * @file clone.ts
 * @description 纯数据深拷贝与安全键过滤
 *
 * 设计考量 (Why):
 * 1. 文档与补丁零共享引用：补丁值写入文档前统一深拷贝，调用方保留的对象引用、撤销栈中的历史补丁，
 *    都无法绕过事务篡改文档，文档后续的就地修改也不会反向污染历史记录。
 * 2. 兼做反序列化白名单：只复制 JSON 兼容结构，并丢弃 `__proto__` 等危险键，
 *    协同与导入数据经过一次写入即完成净化。
 */

/** 不允许作为属性名写入文档的危险标识符 */
export const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * 深拷贝 JSON 兼容的纯数据结构（对象、数组、原始值）
 */
export function clonePlainData<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      result[i] = clonePlainData(value[i]);
    }
    return result as T;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (DANGEROUS_KEYS.has(key)) continue;
    result[key] = clonePlainData(source[key]);
  }
  return result as T;
}

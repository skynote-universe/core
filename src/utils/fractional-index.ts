/**
 * @file fractional-index.ts
 * @description 分数索引：可无限插入的字符串排序键 (手写实现，算法源自 rocicorp/fractional-indexing)
 *
 * 设计考量 (Why):
 * 1. 任意两个键之间总能生成新键：调整层级只需改被移动的实体，协同下不会与他人的调整互相覆盖。
 * 2. 用 base62 字符串而非浮点数：浮点数对半切几十次即耗尽精度，字符串按需增长。
 * 3. 键结构 = 整数部分 + 小数部分。整数部分首字符决定其长度 (a~z 正向、A~Z 负向)，向两端追加时键长几乎不增长；
 *    只有在同一位置反复插入时小数部分才会逐步变长。
 * 4. 按字符串码元顺序比较即为键的大小顺序 (base62 字母表按 ASCII 升序排列)。
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);

/** 分数索引字符串 */
export type FractionalIndex = string;

/** 首个键：空序列中的第一个元素使用 */
export const FIRST_FRACTIONAL_INDEX: FractionalIndex = 'a0';

function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`[FractionalIndex] 非法的整数部分首字符: ${head}`);
}

function getIntegerPart(key: string): string {
  const length = getIntegerLength(key[0]);
  if (length > key.length) throw new Error(`[FractionalIndex] 整数部分长度不足: ${key}`);
  return key.slice(0, length);
}

/** 校验键格式：整数部分长度正确、字符均为 base62、小数部分不以 0 结尾、不是保留的最小整数 */
export function isValidFractionalIndex(key: unknown): key is FractionalIndex {
  if (typeof key !== 'string' || key.length === 0 || key === SMALLEST_INTEGER) return false;
  for (let i = 0; i < key.length; i++) {
    if (!DIGITS.includes(key[i])) return false;
  }
  try {
    const integer = getIntegerPart(key);
    return key.slice(integer.length).slice(-1) !== ZERO;
  } catch {
    return false;
  }
}

function assertValid(key: string): void {
  if (!isValidFractionalIndex(key)) throw new Error(`[FractionalIndex] 非法的分数索引: ${key}`);
}

/** 小数部分取中点 (a < b，b 为 null 表示正无穷) */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`[FractionalIndex] 小数部分顺序错误: ${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round((digitA + digitB) / 2)];
  }
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function incrementInteger(integer: string): string | null {
  const [head, ...digits] = integer.split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === DIGITS.length) {
      digits[i] = ZERO;
    } else {
      digits[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join('');
}

function decrementInteger(integer: string): string | null {
  const [head, ...digits] = integer.split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) {
      digits[i] = DIGITS[DIGITS.length - 1];
    } else {
      digits[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return 'Z' + DIGITS[DIGITS.length - 1];
  if (head === 'A') return null;
  const previousHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previousHead < 'Z') digits.push(DIGITS[DIGITS.length - 1]);
  else digits.pop();
  return previousHead + digits.join('');
}

/**
 * 生成严格介于 a 与 b 之间的键 (a 为 null 表示最前，b 为 null 表示最后)
 * @throws a >= b 或任一键格式非法
 */
export function generateKeyBetween(a: FractionalIndex | null, b: FractionalIndex | null): FractionalIndex {
  if (a !== null) assertValid(a);
  if (b !== null) assertValid(b);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`[FractionalIndex] 键顺序错误: ${a} >= ${b}`);
  }

  if (a === null) {
    if (b === null) return FIRST_FRACTIONAL_INDEX;
    const integerB = getIntegerPart(b);
    const fractionB = b.slice(integerB.length);
    if (integerB === SMALLEST_INTEGER) return integerB + midpoint('', fractionB);
    if (integerB < b) return integerB;
    const decremented = decrementInteger(integerB);
    if (decremented === null) throw new Error('[FractionalIndex] 已无法生成更小的键');
    return decremented;
  }

  if (b === null) {
    const integerA = getIntegerPart(a);
    const fractionA = a.slice(integerA.length);
    const incremented = incrementInteger(integerA);
    return incremented === null ? integerA + midpoint(fractionA, null) : incremented;
  }

  const integerA = getIntegerPart(a);
  const fractionA = a.slice(integerA.length);
  const integerB = getIntegerPart(b);
  const fractionB = b.slice(integerB.length);
  if (integerA === integerB) return integerA + midpoint(fractionA, fractionB);
  const incremented = incrementInteger(integerA);
  if (incremented === null) throw new Error('[FractionalIndex] 已无法生成更大的键');
  return incremented < b ? incremented : integerA + midpoint(fractionA, null);
}

/**
 * 生成 n 个严格递增且介于 a 与 b 之间的键 (用于多选整体移动时保持相对顺序)
 * 在区间两端顺序追加、在区间中间二分，使键长增长最慢
 */
export function generateNKeysBetween(
  a: FractionalIndex | null,
  b: FractionalIndex | null,
  n: number
): FractionalIndex[] {
  if (n <= 0) return [];
  if (n === 1) return [generateKeyBetween(a, b)];

  if (b === null) {
    const keys: FractionalIndex[] = [];
    let current = a;
    for (let i = 0; i < n; i++) {
      current = generateKeyBetween(current, null);
      keys.push(current);
    }
    return keys;
  }
  if (a === null) {
    const keys: FractionalIndex[] = [];
    let current: FractionalIndex = b;
    for (let i = 0; i < n; i++) {
      current = generateKeyBetween(null, current);
      keys.push(current);
    }
    return keys.reverse();
  }

  const middle = Math.floor(n / 2);
  const pivot = generateKeyBetween(a, b);
  return [...generateNKeysBetween(a, pivot, middle), pivot, ...generateNKeysBetween(pivot, b, n - middle - 1)];
}

/** 分数索引比较：键相同时按 id 决出先后，保证各客户端排序完全一致 */
export function compareFractionalIndex(
  leftIndex: FractionalIndex,
  leftId: string,
  rightIndex: FractionalIndex,
  rightId: string
): number {
  if (leftIndex !== rightIndex) return leftIndex < rightIndex ? -1 : 1;
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

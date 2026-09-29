/**
 * @file id.ts
 * @description 轻量级实体与事务唯一 ID 生成器
 *
 * 设计考量 (Why):
 * 1. 协同安全：随机部分取自 Web Crypto (浏览器、Node、Worker 均为标准全局)，而非可预测的 Math.random，
 *    多端并发建节点时碰撞概率可忽略 (60 bit 随机熵，且按毫秒时间戳分桶)。
 * 2. 无取模偏差：字母表恰为 32 个字符，每个随机字节取低 5 位即均匀映射。
 * 3. 时间戳前缀保持大致有序，便于调试时按创建先后阅读；避免引入 uuid 库。
 */

/** 32 个字符：去掉易混淆的 i / l / o / u */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const RANDOM_LENGTH = 12;

/**
 * 生成带语义前缀的轻量唯一 ID
 * @param prefix 语义前缀，如 'node', 'conn', 'op', 'block'
 */
export function generateId(prefix = 'id'): string {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  globalThis.crypto.getRandomValues(bytes);

  let random = '';
  for (let i = 0; i < bytes.length; i++) {
    random += ID_ALPHABET[bytes[i] & 31];
  }
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

/**
 * @file id.ts
 * @description 轻量级高性能实体与事务唯一 ID 生成器
 * 
 * 设计考量 (Why):
 * 避免引入大型 uuid 库包袱，采用纳秒级时间戳 + 随机数后缀，生成足够短小且在客户端单机与协作网络中低碰撞率的全局唯一 ID。
 */

let counter = 0;

/**
 * 生成带语义前缀的轻量唯一 ID
 * @param prefix 语义前缀，如 'node', 'conn', 'op', 'block'
 */
export function generateId(prefix = 'id'): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 7);
  counter = (counter + 1) % 1000;
  const countPart = counter.toString(36);
  return `${prefix}_${timestamp}${randomPart}${countPart}`;
}

/**
 * @file overwrite-compactor.ts
 * @description 同组折叠时对同一路径整值覆盖的增量压缩器
 *
 * 设计考量 (Why):
 * 1. 增量而非重算：一次拖拽每帧都向同一撤销条目追加补丁，若每帧对「已累积 + 新增」整体重算，
 *    多选拖拽 2000 个节点时单帧可达十余毫秒；压缩器保留状态，每帧只处理新增补丁。
 * 2. 路径前缀树：按路径分段逐级索引候选。分段直接复用补丁中的字符串 (V8 在字符串上缓存哈希)，
 *    不拼接新键；某路径被写入时，丢弃其子树即令全部后代候选失效，单条补丁开销 O(路径深度) 且零字符串分配。
 * 3. 保守合并：两次覆盖之间若有祖先/后代路径的补丁介入 (如先改 style.fill 再整体覆盖 style)，不合并。
 * 4. 空洞回收：被覆盖的旧补丁留下空槽，空槽过半时整体收紧，数组长度始终与存活补丁数同阶。
 */

import type { CanvasPatch } from '../types/operation';
import { normalizePatchPath } from './patch-path';

interface PathTrieNode {
  /** 以此路径为目标、仍可被后续覆盖合并的补丁所在槽位，-1 表示无 */
  candidate: number;
  children: Map<string, PathTrieNode> | null;
}

function createTrieNode(): PathTrieNode {
  return { candidate: -1, children: null };
}

/** 数组下标统一按字符串分段索引，保证 "0" 与 0 指向同一节点 */
function segmentKey(segment: string | number): string {
  return typeof segment === 'number' ? String(segment) : segment;
}

/** 整值覆盖补丁：非 merge 的 set 与 unset，执行结果只取决于自身，与该路径此前的值无关 */
function isOverwritePatch(patch: CanvasPatch): boolean {
  return (patch.op === 'set' && !patch.merge) || patch.op === 'unset';
}

export class OverwriteCompactor {
  private slots: (CanvasPatch | null)[] = [];
  /** 槽位对应的前缀树节点，空洞回收时据此重映射候选槽位 */
  private slotOwners: (PathTrieNode | null)[] = [];
  private holeCount = 0;
  private readonly root = createTrieNode();

  /**
   * @param keep 'last' 用于正向补丁 (最终值生效)；'first' 用于逆向补丁 (倒序回放时最早的旧值最后生效)
   */
  constructor(private readonly keep: 'first' | 'last') {}

  push(patches: readonly CanvasPatch[]): void {
    for (let i = 0; i < patches.length; i++) {
      this.pushOne(patches[i]);
    }
    if (this.holeCount > this.slots.length / 2) {
      this.reclaimHoles();
    }
  }

  /** 按原始时间序输出存活补丁 */
  toArray(): CanvasPatch[] {
    const result: CanvasPatch[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const patch = this.slots[i];
      if (patch) result.push(patch);
    }
    return result;
  }

  private pushOne(patch: CanvasPatch): void {
    const segments = normalizePatchPath(patch.path);
    const overwrite = isOverwritePatch(patch);

    // 沿路径下行：途经的祖先节点上的候选全部失效
    let node = this.root;
    for (let d = 0; d < segments.length; d++) {
      if (d > 0) node.candidate = -1;
      const key = segmentKey(segments[d]);
      let child = node.children?.get(key);
      if (!child) {
        if (!overwrite) {
          // 非覆盖补丁只需令祖先候选失效；该路径及其后代此前从未登记候选，无需建节点
          this.appendSlot(patch, null);
          return;
        }
        child = createTrieNode();
        (node.children ??= new Map()).set(key, child);
      }
      node = child;
    }

    // 该路径被写入：其后代路径上的候选全部失效
    node.children = null;

    if (!overwrite) {
      node.candidate = -1;
      this.appendSlot(patch, null);
      return;
    }

    if (node.candidate !== -1) {
      if (this.keep === 'first') return;
      this.slots[node.candidate] = null;
      this.slotOwners[node.candidate] = null;
      this.holeCount++;
    }
    node.candidate = this.slots.length;
    this.appendSlot(patch, node);
  }

  private appendSlot(patch: CanvasPatch, owner: PathTrieNode | null): void {
    this.slots.push(patch);
    this.slotOwners.push(owner);
  }

  private reclaimHoles(): void {
    const slots: CanvasPatch[] = [];
    const owners: (PathTrieNode | null)[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const patch = this.slots[i];
      if (!patch) continue;
      const owner = this.slotOwners[i];
      if (owner && owner.candidate === i) owner.candidate = slots.length;
      slots.push(patch);
      owners.push(owner);
    }
    this.slots = slots;
    this.slotOwners = owners;
    this.holeCount = 0;
  }
}

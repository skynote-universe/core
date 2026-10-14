/** 文档边界通过节点公开契约检查资产引用，不猜测插件的私有字段。 */
import type { CanvasDocument } from '../types/canvas';
import type { CanvasAssetMeta } from '../types/asset';
import type { NodeTypeReader } from '../registry/node-type-registry';
import { clonePlainData } from '../utils/clone';
import { findCommitViolation } from '../state/commit-guards';

export interface DocumentAssetIssue {
  readonly nodeId?: string;
  readonly assetId?: string;
  readonly detail: string;
  readonly repaired?: boolean;
}
export interface DocumentAssetInspection {
  readonly document: CanvasDocument;
  readonly assets: readonly CanvasAssetMeta[];
  readonly issues: readonly DocumentAssetIssue[];
}

/** 只在副本上尝试节点声明的修复，宿主决定是否接受问题报告。 */
export function inspectDocumentAssets(
  document: CanvasDocument,
  nodeTypes: Pick<NodeTypeReader, 'get'>
): DocumentAssetInspection {
  const prepared = clonePlainData(document);
  const violation = findCommitViolation(prepared, [{ op: 'set', path: ['content'], value: prepared.content }]);
  if (violation) throw new Error(violation);
  const referenced = new Map<string, CanvasAssetMeta>();
  const issues: DocumentAssetIssue[] = [];
  for (const node of Object.values(prepared.content.nodes)) {
    const definition = nodeTypes.get(node.nodeType);
    if (!definition) throw new Error(`节点「${node.id}」的类型「${node.nodeType}」未注册，无法核对资产引用`);
    const contract = definition.assets;
    if (!contract) continue;
    let ids: readonly string[];
    try {
      ids = contract.collect(node);
    } catch (error) {
      const fields = contract.repair?.(node);
      let repaired = false;
      ids = [];
      if (fields) {
        Object.assign(node, fields);
        try {
          ids = contract.collect(node);
          repaired = true;
        } catch {
          /* 保留无法修复的节点供占位与重新选择。 */
        }
      }
      issues.push({ nodeId: node.id, detail: error instanceof Error ? error.message : '节点资产引用无效', repaired });
    }
    for (const id of ids) {
      if (!Object.hasOwn(prepared.assets ?? {}, id)) {
        issues.push({ nodeId: node.id, assetId: id, detail: `图片资产「${id}」元数据缺失` });
      } else {
        referenced.set(id, prepared.assets![id]);
      }
    }
  }
  if (issues.some((issue) => issue.repaired)) {
    const repairedViolation = findCommitViolation(prepared, [
      { op: 'set', path: ['content'], value: prepared.content }
    ]);
    if (repairedViolation) throw new Error(repairedViolation);
  }
  return { document: prepared, assets: [...referenced.values()], issues };
}

export function collectDocumentAssets(
  document: CanvasDocument,
  nodeTypes: Pick<NodeTypeReader, 'get'>
): readonly CanvasAssetMeta[] {
  const referenced = new Map<string, CanvasAssetMeta>();
  const assets = document.assets ?? {};
  for (const node of Object.values(document.content.nodes)) {
    const definition = nodeTypes.get(node.nodeType);
    if (!definition) throw new Error(`节点「${node.id}」的类型「${node.nodeType}」未注册，无法核对资产引用`);
    for (const id of definition.assets?.collect(node) ?? []) {
      if (!Object.hasOwn(assets, id)) throw new Error(`节点「${node.id}」引用的资产「${id}」不存在`);
      const asset = assets[id];
      referenced.set(id, asset);
    }
  }
  return [...referenced.values()];
}

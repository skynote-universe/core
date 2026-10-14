import { describe, expect, it } from 'vitest';
import {
  collectDocumentAssets,
  inspectDocumentAssets,
  NodeTypeRegistry,
  type CanvasDocument,
  type NodeEntity
} from '../src';

const node: NodeEntity = {
  id: 'media',
  type: 'node',
  nodeType: 'media',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  zIndex: 'a0',
  locked: false,
  data: { asset: 'binary' }
};
const asset = { id: 'binary', src: 'memory:binary', mimeType: 'application/octet-stream' };
function document(): CanvasDocument {
  return {
    id: 'doc',
    name: 'doc',
    meta: { version: 1, createdAt: 0, updatedAt: 0 },
    content: { nodes: { media: node }, connectors: {} },
    assets: { binary: asset }
  };
}
function registry(): NodeTypeRegistry {
  const types = new NodeTypeRegistry();
  types.register({
    type: 'media',
    label: '媒体',
    defaultData: {},
    assets: { collect: (n) => [n.data!.asset as string], remap: () => ({}) }
  });
  return types;
}
describe('文档资产公开契约', () => {
  it('检查报告保留缺失引用和其他内容，未知节点类型仍是不可解释的错误', () => {
    const doc = document();
    doc.assets = {};
    const before = structuredClone(doc);
    const report = inspectDocumentAssets(doc, registry());
    expect(report.issues).toEqual([{ nodeId: 'media', assetId: 'binary', detail: '图片资产「binary」元数据缺失' }]);
    expect(report.document).toEqual(before);
    expect(doc).toEqual(before);
    expect(() => inspectDocumentAssets(doc, new NodeTypeRegistry())).toThrow('未注册');
  });
  it('由节点类型解释引用，共享资产只收集一次且不修改文档', () => {
    const doc = document();
    doc.content.nodes.second = { ...node, id: 'second' };
    doc.assets!.unused = { ...asset, id: 'unused' };
    const before = structuredClone(doc);
    expect(collectDocumentAssets(doc, registry())).toEqual([asset]);
    expect(doc).toEqual(before);
  });
  it('缺失资产或未知节点类型拒绝，避免静默丢失无法解释的媒体', () => {
    const doc = document();
    expect(() => collectDocumentAssets(doc, new NodeTypeRegistry())).toThrow('未注册');
    doc.assets = {};
    expect(() => collectDocumentAssets(doc, registry())).toThrow('不存在');
    doc.content.nodes.media = { ...node, data: { asset: '__proto__' } };
    expect(() => collectDocumentAssets(doc, registry())).toThrow('不存在');
  });
});

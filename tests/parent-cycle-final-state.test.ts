/** 真实提交按最终父关系判环，覆盖删除、浅合并与替换的不同语义。 */
import { describe, expect, it } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';
import type { CanvasPatch } from '../src/types/operation';
import type { NodeEntity } from '../src/types/node';

function node(id: string, parentId?: string): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'frame',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...(parentId ? { parentId } : {})
  };
}

const cycle: CanvasPatch = { op: 'set', path: ['content', 'nodes', 'a', 'parentId'], value: 'b' };
const cases: [string, CanvasPatch[]][] = [
  [
    '整节点删除',
    [
      { op: 'unset', path: ['content', 'nodes', 'a'] },
      { op: 'unset', path: ['content', 'nodes', 'b'] }
    ]
  ],
  ['集合替换', [{ op: 'set', path: ['content', 'nodes'], value: { c: node('c') } }]],
  ['内容替换', [{ op: 'set', path: ['content'], value: { nodes: { c: node('c') }, connectors: {} } }]],
  ['内容浅合并中的集合替换', [{ op: 'set', path: ['content'], merge: true, value: { nodes: { c: node('c') } } }]],
  [
    '集合浅合并删除条目',
    [{ op: 'set', path: ['content', 'nodes'], merge: true, value: { a: undefined, b: undefined } }]
  ],
  [
    '节点浅合并移除父关系',
    [{ op: 'set', path: ['content', 'nodes', 'b'], merge: true, value: { parentId: undefined } }]
  ],
  ['节点整体替换移除旧父关系', [{ op: 'set', path: ['content', 'nodes', 'b'], value: node('b') }]],
  [
    '删除后重建',
    [
      { op: 'unset', path: ['content', 'nodes', 'b'] },
      { op: 'set', path: ['content', 'nodes', 'b'], value: node('b') }
    ]
  ],
  [
    '集合替换后重建',
    [
      { op: 'set', path: ['content', 'nodes'], value: {} },
      { op: 'set', path: ['content', 'nodes', 'c'], value: node('c') }
    ]
  ]
];

describe('最终父关系真实事务', () => {
  it.each(cases)('%s 清除中间环，撤销重做精确恢复', (_label, patches) => {
    const doc = createEmptyCanvasDocument();
    doc.content.nodes = { a: node('a'), b: node('b', 'a') };
    const store = new DocumentStore(doc);
    const before = structuredClone(store.getView().content);
    expect(store.commit({ label: '最终无环', patches: [cycle, ...patches] })).not.toBeNull();
    const after = structuredClone(store.getView().content);
    expect(store.undo()).toBe(true);
    expect(store.getView().content).toEqual(before);
    expect(store.redo()).toBe(true);
    expect(store.getView().content).toEqual(after);
  });

  it.each([
    ['集合浅合并保留其他节点', { op: 'set', path: ['content', 'nodes'], merge: true, value: { c: node('c') } }],
    ['内容浅合并保留节点集合', { op: 'set', path: ['content'], merge: true, value: { connectors: {} } }],
    ['节点浅合并保留父关系', { op: 'set', path: ['content', 'nodes', 'b'], merge: true, value: { width: 200 } }]
  ] satisfies [string, CanvasPatch][])('%s 不能掩盖真实环', (_label, patch) => {
    const doc = createEmptyCanvasDocument();
    doc.content.nodes = { a: node('a'), b: node('b', 'a') };
    const store = new DocumentStore(doc);
    const before = structuredClone(store.getView().content);
    expect(store.commit({ label: '真实环', patches: [cycle, patch] })).toBeNull();
    expect(store.getView().content).toEqual(before);
    expect(store.undo()).toBe(false);
  });
});

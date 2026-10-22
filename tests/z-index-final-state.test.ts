/** 只校验事务结束后仍存在的实体，层级键删除不能生成无法重载的文档。 */
import { describe, expect, it } from 'vitest';
import { DocumentStore, createEmptyCanvasDocument } from '../src/state/document-store';
import { parseCanvasDocument } from '../src/serialization/document-schema';
import { findCommitViolation } from '../src/state/commit-guards';
import type { CanvasPatch } from '../src/types/operation';
import type { NodeEntity } from '../src/types/node';
import type { ConnectorEntity } from '../src/types/connector';

type Kind = 'nodes' | 'connectors';
type Case = [string, (kind: Kind, id: string, entity: NodeEntity | ConnectorEntity) => CanvasPatch[]];

function setup(kind: Kind) {
  const doc = createEmptyCanvasDocument();
  for (const id of ['a', 'b'])
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: 'frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
  const store = new DocumentStore(doc);
  const link = store.createConnector({ from: { nodeId: 'a' }, to: { nodeId: 'b' } })!;
  store.clearHistory();
  const id = kind === 'nodes' ? 'a' : link;
  const entity = structuredClone(kind === 'nodes' ? store.getNode(id)! : store.getConnector(id)!);
  return { store, id, entity };
}

const rejected: Case[] = [
  ['删除字段', (kind, id) => [{ op: 'unset', path: ['content', kind, id, 'zIndex'] }]],
  ['赋值undefined', (kind, id) => [{ op: 'set', path: ['content', kind, id, 'zIndex'], value: undefined }]],
  [
    '浅合并删除字段',
    (kind, id) => [{ op: 'set', path: ['content', kind, id], merge: true, value: { zIndex: undefined } }]
  ],
  [
    '替换实体缺少字段',
    (kind, id, entity) => {
      const value = { ...entity };
      delete (value as Partial<typeof entity>).zIndex;
      return [{ op: 'set', path: ['content', kind, id], value }];
    }
  ],
  [
    '替换集合含非法实体',
    (kind, id, entity) => [{ op: 'set', path: ['content', kind], value: { [id]: { ...entity, zIndex: '' } } }]
  ],
  [
    '内容浅合并替换集合含非法实体',
    (kind, id, entity) => [
      { op: 'set', path: ['content'], merge: true, value: { [kind]: { [id]: { ...entity, zIndex: undefined } } } }
    ]
  ]
];
const accepted: Case[] = [
  [
    '删除后补回字段',
    (kind, id) => [
      { op: 'unset', path: ['content', kind, id, 'zIndex'] },
      { op: 'set', path: ['content', kind, id, 'zIndex'], value: 'a1' }
    ]
  ],
  [
    '非法中间键被合法键覆盖',
    (kind, id) => [
      { op: 'set', path: ['content', kind, id, 'zIndex'], value: 'bad' },
      { op: 'set', path: ['content', kind, id], merge: true, value: { zIndex: 'a1' } }
    ]
  ],
  [
    '删除层级键后删除实体',
    (kind, id) => [
      { op: 'unset', path: ['content', kind, id, 'zIndex'] },
      { op: 'unset', path: ['content', kind, id] }
    ]
  ],
  [
    '集合替换清除此前变更',
    (kind, id) => [
      { op: 'unset', path: ['content', kind, id, 'zIndex'] },
      { op: 'set', path: ['content', kind], value: {} }
    ]
  ],
  [
    '删除后合法重建',
    (kind, id, entity) => [
      { op: 'unset', path: ['content', kind, id, 'zIndex'] },
      { op: 'unset', path: ['content', kind, id] },
      { op: 'set', path: ['content', kind, id], value: entity }
    ]
  ],
  [
    '内容浅合并覆盖此前变更',
    (kind, id, entity) => [
      { op: 'unset', path: ['content', kind, id, 'zIndex'] },
      { op: 'set', path: ['content'], merge: true, value: { [kind]: { [id]: entity } } }
    ]
  ]
];

for (const kind of ['nodes', 'connectors'] as const)
  describe(`${kind} 最终层级键`, () => {
    it.each(rejected)('%s 整体拒绝且保留合法重载', (_name, patches) => {
      const { store, id, entity } = setup(kind);
      const before = structuredClone(store.getView().content);
      expect(store.commit({ patches: patches(kind, id, entity) })).toBeNull();
      expect(store.getView().content).toEqual(before);
      expect(parseCanvasDocument(JSON.parse(JSON.stringify(store.getView()))).ok).toBe(true);
      expect(store.canUndo).toBe(false);
    });
    it.each(accepted)('%s 正常提交、重载与撤销重做', (_name, patches) => {
      const { store, id, entity } = setup(kind);
      const before = structuredClone(store.getView().content);
      expect(store.commit({ patches: patches(kind, id, entity) })).not.toBeNull();
      const after = structuredClone(store.getView().content);
      expect(parseCanvasDocument(JSON.parse(JSON.stringify(store.getView()))).ok).toBe(true);
      store.undo();
      expect(store.getView().content).toEqual(before);
      store.redo();
      expect(store.getView().content).toEqual(after);
    });
  });

it('无关几何补丁不枚举原实体集合', () => {
  const doc = createEmptyCanvasDocument();
  doc.content.nodes = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('不应枚举无关节点');
      }
    }
  );
  doc.content.connectors = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('不应枚举无关连线');
      }
    }
  );
  expect(findCommitViolation(doc, [{ op: 'set', path: ['content', 'nodes', 'a', 'x'], value: 1 }])).toBeNull();
});

import { expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import { collectNodeDataPaths } from '../src/operation/node-change-paths';
import type { NodeTypeDefinition } from '../src/protocols/node-type.protocol';
import type { DocumentChangeSet } from '../src/types';

it('节点路径摘要保留嵌套合并和数组索引，整体替换覆盖局部提示', () => {
  const paths = collectNodeDataPaths([
    { op: 'set', path: ['content', 'nodes', 'a', 'data'], value: { first: 1, second: 2 }, merge: true },
    { op: 'set', path: ['content', 'nodes', 'b', 'textBlocks', 3, 'runs'], value: [] },
    { op: 'set', path: ['content', 'nodes', 'a'], value: {} },
    { op: 'unset', path: ['content', 'nodes', 'a', 'data', 'first'] }
  ])!;
  expect(paths.get('a')).toBeNull();
  expect(paths.get('b')).toEqual([['textBlocks', 3, 'runs']]);
  expect(collectNodeDataPaths([{ op: 'set', path: ['content', 'nodes'], value: {} }])).toBeNull();
});

it('本地、撤销和重做广播相对路径，未改变的字段不混入摘要', () => {
  const engine = new SkyNoteEngine();
  const changes: DocumentChangeSet[] = [];
  engine.documentStore.subscribe((_view, _record, change) => changes.push(change));
  const definition: NodeTypeDefinition = {
    type: 'paths',
    label: '路径测试',
    defaultData: {},
    createContent: () => ({ width: 100, height: 40, data: {} })
  };
  engine.nodeTypes.register(definition);
  try {
    const id = engine.documentStore.createNode({ nodeType: 'paths', x: 0, y: 0 })!;
    engine.documentStore.commit({
      label: '字段修改',
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'data'], merge: true, value: { first: 1 } }]
    });
    expect(changes.at(-1)?.nodes.dataPaths?.get(id)).toEqual([['data', 'first']]);
    engine.documentStore.undo();
    expect(changes.at(-1)?.nodes.dataPaths?.get(id)).toEqual([['data', 'first']]);
    engine.documentStore.redo();
    expect(changes.at(-1)?.nodes.dataPaths?.get(id)).toEqual([['data', 'first']]);
  } finally {
    engine.destroy();
  }
});

it('节点声明不影响文字尺寸时跳过测量，文字变更仍按默认路径测量', () => {
  const measureWidth = vi.fn((text: string) => text.length * 7);
  const engine = new SkyNoteEngine({ fonts: { measureWidth } });
  engine.nodeTypes.register({
    type: 'measure-paths',
    label: '测量测试',
    defaultData: {},
    sizingPolicy: 'height-driven',
    layoutTriggerFields: ['data'],
    createContent: () => ({ width: 100, height: 40, data: {}, textBlocks: [{ id: 'text', runs: [{ text: '初始' }] }] }),
    affectsTextLayout(_node, paths) {
      return paths.some((path) => !this.layoutTriggerFields?.includes(String(path[0])));
    }
  });
  try {
    const id = engine.documentStore.createNode({ nodeType: 'measure-paths', x: 0, y: 0 })!;
    measureWidth.mockClear();
    engine.documentStore.updateNode(id, { data: { first: 1 } });
    expect(measureWidth).not.toHaveBeenCalled();
    engine.documentStore.commit({
      label: '改文字',
      patches: [
        { op: 'set', path: ['content', 'nodes', id, 'textBlocks', 0, 'runs'], value: [{ text: '修改后的文字' }] }
      ]
    });
    expect(measureWidth).toHaveBeenCalled();
  } finally {
    engine.destroy();
  }
});

it('批量摘要保留同节点路径次序与合并键，整体失效不会影响其他节点', () => {
  const patches = Array.from({ length: 10000 }, (_, index) => ({
    op: 'set' as const,
    path: ['content', 'nodes', 'a', 'textBlocks', index, 'runs'],
    value: []
  }));
  const paths = collectNodeDataPaths([
    ...patches,
    { op: 'set', path: ['content', 'nodes', 'a', 'data'], merge: true, value: { first: 1, second: 2 } },
    { op: 'set', path: ['content', 'nodes', 'b'], value: {} },
    { op: 'set', path: ['content', 'nodes', 'b', 'data'], value: {} }
  ])!;
  expect(paths.get('a')).toHaveLength(10002);
  expect(paths.get('a')![0]).toEqual(['textBlocks', 0, 'runs']);
  expect(paths.get('a')![9999]).toEqual(['textBlocks', 9999, 'runs']);
  expect(paths.get('a')!.slice(-2)).toEqual([
    ['data', 'first'],
    ['data', 'second']
  ]);
  expect(paths.get('b')).toBeNull();
});

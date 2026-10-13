import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '../src/engine';
import type { AssetTaskEvent, AssetUploadResult } from '../src/protocols/asset.protocol';

const engines: SkyNoteEngine[] = [];
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.destroy());
  vi.restoreAllMocks();
});
const uploaded: AssetUploadResult = { src: 'memory:image', mimeType: 'image/png', width: 100, height: 80 };

function setup() {
  let complete!: (result: AssetUploadResult) => void;
  const upload = vi.fn(
    () =>
      new Promise<AssetUploadResult>((resolve) => {
        complete = resolve;
      })
  );
  const engine = new SkyNoteEngine({ assets: { upload, resolve: (src) => src } });
  engine.nodeTypes.register({
    type: 'image',
    label: '测试图片',
    defaultData: {},
    createContent: () => ({ width: 100, height: 80 })
  });
  engines.push(engine);
  const events: AssetTaskEvent[] = [];
  engine.onAssetTaskEvent((event) => events.push(event));
  return { engine, upload, events, complete: () => complete(uploaded) };
}

describe('平台中立资产任务', () => {
  it.each(['import', 'undo', 'redo'] as const)(
    '整体内容 %s 使旧任务及时取消，忽略 signal 的晚到结果也不能提交',
    async (action) => {
      const { engine, events, complete } = setup();
      const store = engine.documentStore;
      if (action !== 'import') store.replaceContent({ nodes: {}, connectors: {} });
      if (action === 'redo') store.undo();
      const pending = engine.insertImage('file', { x: 100, y: 100 });
      if (action === 'import') store.replaceContent({ nodes: {}, connectors: {} });
      else if (action === 'undo') store.undo();
      else store.redo();
      expect(await pending).toEqual({ status: 'cancelled', reason: 'document-replaced' });
      complete();
      await Promise.resolve();
      expect(Object.keys(store.getView().content.nodes)).toHaveLength(0);
      expect(events.filter((event) => event.phase === 'settled')).toHaveLength(1);
    }
  );

  it('普通编辑不使任务失效；成功任务只登记一次事务', async () => {
    const { engine, complete } = setup();
    engine.documentStore.createNode({ nodeType: 'image', id: 'existing', x: 0, y: 0 });
    const epoch = engine.documentEpoch;
    const pending = engine.insertImage('file', { x: 100, y: 100 });
    engine.documentStore.updateNode('existing', { x: 30 });
    complete();
    expect((await pending).status).toBe('succeeded');
    expect(engine.documentEpoch).toBe(epoch);
    engine.documentStore.undo();
    expect(Object.keys(engine.documentStore.getView().content.nodes)).toEqual(['existing']);
  });

  it('预取消不调用宿主；缺少适配器为明确失败，订阅异常不改变结果', async () => {
    const { engine, upload } = setup();
    const signal = AbortSignal.abort();
    expect(await engine.insertImage('file', { x: 0, y: 0 }, 'cover', signal)).toEqual({
      status: 'cancelled',
      reason: 'caller-aborted'
    });
    expect(upload).not.toHaveBeenCalled();
    const bare = new SkyNoteEngine();
    engines.push(bare);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    bare.onAssetTaskEvent(() => {
      throw new Error('订阅异常');
    });
    expect(await bare.insertImage('file', { x: 0, y: 0 })).toMatchObject({
      status: 'failed',
      failure: { code: 'unsupported-source' }
    });
  });
});

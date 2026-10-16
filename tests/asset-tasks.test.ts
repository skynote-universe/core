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
  it('维护取消任务后仍等待忽略取消的真实执行，冻结提交并拒绝新上传', async () => {
    const { engine, upload, complete } = setup();
    const task = engine.insertImage('file', { x: 0, y: 0 });
    const maintenance = engine.beginMaintenance();
    let drained = false;
    void maintenance.drained.then(() => {
      drained = true;
    });
    expect(await task).toEqual({ status: 'cancelled', reason: 'maintenance' });
    expect(drained).toBe(false);
    expect(engine.documentStore.commit({ patches: [{ op: 'set', path: 'name', value: 'changed' }] })).toBeNull();
    expect(await engine.insertImage('next', { x: 0, y: 0 })).toEqual({ status: 'cancelled', reason: 'maintenance' });
    expect(upload).toHaveBeenCalledOnce();
    complete();
    await maintenance.drained;
    expect(Object.keys(engine.documentStore.getView().assets ?? {})).toHaveLength(0);
    expect(engine.documentStore.getView().content.nodes).toEqual({});
    maintenance.resume();
    maintenance.resume();
    expect(engine.documentStore.commit({ patches: [{ op: 'set', path: 'name', value: 'resumed' }] })).not.toBeNull();
  });

  it('维护排空包含此前已经向调用方返回取消的上传', async () => {
    const { engine, complete } = setup();
    const controller = new AbortController();
    const task = engine.insertImage('file', { x: 0, y: 0 }, 'cover', controller.signal);
    controller.abort();
    await task;
    const maintenance = engine.beginMaintenance();
    let drained = false;
    void maintenance.drained.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    complete();
    await maintenance.drained;
    maintenance.resume();
    expect(drained).toBe(true);
  });

  it('嵌套维护只在最后恢复时放行，已销毁引擎不能进入维护', async () => {
    const { engine } = setup();
    const first = engine.beginMaintenance();
    const second = engine.beginMaintenance();
    await Promise.all([first.drained, second.drained]);
    first.resume();
    expect(await engine.insertImage('file', { x: 0, y: 0 })).toEqual({ status: 'cancelled', reason: 'maintenance' });
    second.resume();
    expect(engine.documentStore.commit({ patches: [{ op: 'set', path: 'name', value: 'ok' }] })).not.toBeNull();
    engine.destroy();
    expect(() => engine.beginMaintenance()).toThrow('已销毁');
  });

  it('取消可先返回，实际执行结束后才释放宿主保护，晚到上传不提交', async () => {
    let complete!: (value: AssetUploadResult) => void;
    const release = vi.fn();
    const protect = vi.fn(async () => ({ release, retain: vi.fn() }));
    const upload = vi.fn(
      () =>
        new Promise<AssetUploadResult>((resolve) => {
          complete = resolve;
        })
    );
    const engine = new SkyNoteEngine({ assets: { upload, resolve: (src) => src, protect } });
    engine.nodeTypes.register({
      type: 'image',
      label: '图片',
      defaultData: {},
      createContent: () => ({ width: 2, height: 1 })
    });
    engines.push(engine);
    const controller = new AbortController();
    const task = engine.insertImage('file', { x: 0, y: 0 }, 'cover', controller.signal);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    controller.abort();
    expect((await task).status).toBe('cancelled');
    expect(release).not.toHaveBeenCalled();
    complete(uploaded);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(Object.keys(engine.documentStore.getView().content.nodes)).toHaveLength(0);
    expect(protect).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'insert-image' }));
  });

  it('保护准备失败不上传，释放异常不能把已提交插入误报为失败', async () => {
    const upload = vi.fn(async () => uploaded);
    const engine = new SkyNoteEngine({
      assets: {
        upload,
        resolve: (src) => src,
        protect: async () => {
          throw new Error('protection storage failed');
        }
      }
    });
    engine.nodeTypes.register({
      type: 'image',
      label: '图片',
      defaultData: {},
      createContent: () => ({ width: 2, height: 1 })
    });
    engines.push(engine);
    expect((await engine.insertImage('file', { x: 0, y: 0 })).status).toBe('failed');
    expect(upload).not.toHaveBeenCalled();
    const good = new SkyNoteEngine({
      assets: {
        upload,
        resolve: (src) => src,
        protect: async () => ({
          release: () => {
            throw new Error('broken host release');
          },
          retain: vi.fn()
        })
      }
    });
    good.nodeTypes.register({
      type: 'image',
      label: '图片',
      defaultData: {},
      createContent: () => ({ width: 2, height: 1 })
    });
    engines.push(good);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await good.insertImage('file', { x: 0, y: 0 })).status).toBe('succeeded');
    expect(Object.keys(good.documentStore.getView().content.nodes)).toHaveLength(1);
  });

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

import { expect, it, vi } from 'vitest';
import { ClipboardDispatcher } from '../src/input/clipboard-dispatcher';

it('生成载荷不广播系统写入；写入通知有独立不可变数据，注销和销毁清理观察者', () => {
  const dispatcher = new ClipboardDispatcher();
  const data = { 'text/plain': 'original' };
  dispatcher.register({ copy: () => data });
  const events = vi.fn();
  const unsubscribe = dispatcher.onWrite(events);
  expect(dispatcher.copy()).toEqual(data);
  expect(events).not.toHaveBeenCalled();
  dispatcher.notifyWrite('copy', data);
  data['text/plain'] = 'changed';
  expect(events.mock.calls[0][0]).toEqual({
    operation: 'copy',
    status: 'completed',
    data: { 'text/plain': 'original' }
  });
  expect(Object.isFrozen(events.mock.calls[0][0].data)).toBe(true);
  unsubscribe();
  dispatcher.notifyWrite('cut', data, 'partial');
  expect(events).toHaveBeenCalledOnce();
  dispatcher.onWrite(events);
  dispatcher.clear();
  dispatcher.notifyWrite('copy', data);
  expect(events).toHaveBeenCalledOnce();
});

it('观察者失败不改变已写入或剪切结果，其他观察者继续收到通知', () => {
  const dispatcher = new ClipboardDispatcher();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const listener = vi.fn();
  dispatcher.onWrite(() => {
    throw new Error('observer failed');
  });
  dispatcher.onWrite(listener);
  try {
    expect(() => dispatcher.notifyWrite('cut', { 'text/plain': 'cut' }, 'partial')).not.toThrow();
    expect(listener).toHaveBeenCalledWith({ operation: 'cut', status: 'partial', data: { 'text/plain': 'cut' } });
  } finally {
    warning.mockRestore();
  }
});

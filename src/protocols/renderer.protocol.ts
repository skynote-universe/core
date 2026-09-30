/**
 * @file renderer.protocol.ts
 * @description 渲染适配器契约：让编辑器与具体渲染引擎 (Leafer、WebGPU、小程序画布等) 解耦
 *
 * 设计考量 (Why):
 * 1. 渲染器与文本测量器成对提供：测量与绘制必须走同一排版路径 (ADR-105)，由同一个适配器给出，
 *    使用方无法配出「用 A 引擎测量、用 B 引擎绘制」的错位组合。
 * 2. 渲染器契约只有 destroy：视口、选区、主题与视口尺寸在会话中，拾取在引擎中，宿主能力经 attachHost 提供，
 *    编辑器与界面不需要从渲染器读取任何状态。
 * 3. 容器类型由适配器决定 (浏览器为 HTMLElement，小程序为画布节点)，内核不感知 DOM。
 */

import type { TextMeasurer } from './text-measurer.protocol';
import type { SkyNoteEngine } from '../engine';

/** 已挂载的渲染器实例 */
export interface CanvasRenderer {
  /** 解除与容器和引擎的全部关联并释放图元 */
  destroy(): void;
}

/** 渲染适配器：把某个渲染引擎接入编辑器 */
export interface RenderAdapter<TContainer = unknown> {
  /** 与该适配器绘制排版一致的文本测量器 (创建引擎时注入) */
  readonly textMeasurer: TextMeasurer;
  /** 把引擎挂到宿主容器并开始渲染 */
  mount(engine: SkyNoteEngine, container: TContainer): CanvasRenderer;
}

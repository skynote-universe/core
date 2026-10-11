/**
 * @file asset.protocol.ts
 * @description 宿主提供的媒体资产适配器协议
 *
 * 设计考量 (Why):
 * 1. 内核只保存适配器引用，不接触浏览器文件、二进制存储或临时 URL。
 * 2. 显示地址由同一适配器按需解析并成对释放，保证本地与远端存储可替换。
 */

export interface AssetUploadResult {
  readonly src: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly sizeBytes?: number;
  readonly name?: string;
  readonly sha256?: string;
}

export interface AssetResolveOptions {
  readonly signal: AbortSignal;
  readonly maxSize?: number;
}

export interface AssetReadResult {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface AssetAdapter {
  upload(file: unknown, options: { readonly signal: AbortSignal }): Promise<AssetUploadResult>;
  /** 将已登记的资产读取为二进制，用于可迁移文档包导出 */
  read?(src: string, options: { readonly signal: AbortSignal }): Promise<AssetReadResult>;
  resolve(src: string, options: AssetResolveOptions): string | Promise<string>;
  release?(src: string, url: string): void;
}

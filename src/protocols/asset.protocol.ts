/**
 * @file asset.protocol.ts
 * @description 宿主提供的媒体资产适配器协议
 *
 * 设计考量 (Why):
 * 1. 内核只保存适配器引用，不接触浏览器文件、二进制存储或临时 URL。
 * 2. 显示地址由同一适配器按需解析并成对释放，保证本地与远端存储可替换。
 */

import type { CanvasAssetMeta } from '../types/asset';
import type { EntityIds } from '../types/canvas';

export type AssetTaskCancelReason =
  | 'document-replaced'
  | 'superseded'
  | 'target-changed'
  | 'caller-aborted'
  | 'owner-disposed'
  | 'engine-destroyed'
  | 'maintenance';
export type AssetFailureCode =
  | 'unsupported-source'
  | 'missing-asset'
  | 'invalid-reference'
  | 'invalid-image'
  | 'storage-failed'
  | 'commit-rejected'
  | 'unknown';
export interface AssetFailure {
  readonly code: AssetFailureCode;
  readonly detail?: string;
}
export class AssetAdapterError extends Error {
  constructor(
    readonly code: AssetFailureCode,
    message: string
  ) {
    super(message);
  }
}
export type AssetTaskResult<T> =
  | { readonly status: 'succeeded'; readonly value: T }
  | { readonly status: 'cancelled'; readonly reason: AssetTaskCancelReason }
  | { readonly status: 'failed'; readonly failure: AssetFailure };
export type AssetTaskOperation = 'insert-image' | 'replace-image' | 'paste-nodes';
export interface AssetTaskInfo {
  readonly requestId: string;
  readonly operation: AssetTaskOperation;
  readonly documentEpoch: number;
}
export type AssetTaskEvent =
  | { readonly phase: 'started'; readonly task: AssetTaskInfo }
  | {
      readonly phase: 'settled';
      readonly task: AssetTaskInfo;
      readonly result: AssetTaskResult<string | readonly string[] | EntityIds>;
    }
  | { readonly phase: 'rejected'; readonly operation: 'copy-nodes' | 'paste-nodes'; readonly failure: AssetFailure };
export interface AssetReferenceCheck {
  readonly sourceScope: string;
  readonly assets: readonly CanvasAssetMeta[];
  readonly signal: AbortSignal;
}

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

export type AssetProtectionPurpose =
  | AssetTaskOperation
  | 'upload'
  | 'import'
  | 'export'
  | 'display'
  | 'read'
  | 'check'
  | 'workspace'
  | 'persist'
  | 'clipboard';

export interface AssetProtectionRequest {
  readonly purpose: AssetProtectionPurpose;
  /** 未提供地址时保护整个库；显式空数组只建立会话记录，不推断任何文件已无引用。 */
  readonly sources?: readonly string[];
  readonly signal: AbortSignal;
}

export interface AssetProtectionLease {
  /** 幂等释放；宿主释放失败必须保留保护，不应让已提交操作被误报为失败。 */
  release(): void;
  /** 保存失败等未完成交接时保留保护，不按超时自动淘汰。 */
  retain(reason: string): void;
}

export interface AssetProtectionProvider {
  protect(request: AssetProtectionRequest): Promise<AssetProtectionLease>;
}

export interface AssetAdapter {
  protect?(request: AssetProtectionRequest): Promise<AssetProtectionLease>;
  readonly referenceScope?: string;
  checkReferences?(check: AssetReferenceCheck): Promise<void>;
  upload(file: unknown, options: { readonly signal: AbortSignal }): Promise<AssetUploadResult>;
  /** 将已登记的资产读取为二进制，用于可迁移文档包导出 */
  read?(src: string, options: { readonly signal: AbortSignal }): Promise<AssetReadResult>;
  resolve(src: string, options: AssetResolveOptions): string | Promise<string>;
  release?(src: string, url: string): void;
}

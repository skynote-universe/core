/**
 * @file document-store.ts
 * @description 画布文档状态中心 (单一事实源聚合器)
 *
 * 设计考量 (Why):
 * 1. 深度只读投影 (CanvasDocumentView)：对外暴露的文档对象强锁 readonly，防止外部直接属性赋值绕过事务机制。
 * 2. 状态与事务闭环：内聚集成 EntityStore 与 OperationCoordinator，当补丁应用时自动完成双版本号更新与实体索引刷新。
 * 3. 极速响应：提供便捷的高频操作辅助函数 (setViewport, addNode, updateNode)，自动封装规范补丁并走事务提交。
 */

import type { CanvasDocument, CanvasDocumentView, ViewportState, SelectionState } from "../types/canvas";
import type { NodeEntity } from "../types/node";
import type { ConnectorEntity } from "../types/connector";
import type { CanvasOperationRecord, CommitOperationOptions, CanvasPatch } from "../types/operation";
import { EntityStore } from "./entity-store";
import { OperationCoordinator } from "../operation/coordinator";
import { normalizePatchPath } from "../operation/patch-path";

/** 创建纯净空文档初始数据 */
export function createEmptyCanvasDocument(id = "doc_root", name = "未命名画布"): CanvasDocument {
    const now = Date.now();
    return {
        id,
        name,
        meta: {
            version: 1,
            createdAt: now,
            updatedAt: now,
        },
        viewport: {
            x: 0,
            y: 0,
            zoom: 1,
        },
        selection: {
            nodeIds: [],
            connectorIds: [],
        },
        content: {
            nodes: [],
            connectors: [],
        },
    };
}

/** 文档视图订阅回调 */
export type DocumentSubscriber = (view: CanvasDocumentView, record: CanvasOperationRecord) => void;

export class DocumentStore {
    private readonly document: CanvasDocument;
    readonly entityStore: EntityStore;
    readonly coordinator: OperationCoordinator<CanvasDocument>;

    private readonly subscribers = new Set<DocumentSubscriber>();

    constructor(initialDoc?: CanvasDocument) {
        this.document = initialDoc ?? createEmptyCanvasDocument();
        this.entityStore = new EntityStore();
        this.coordinator = new OperationCoordinator<CanvasDocument>(this.document);

        // 初始化实体索引
        this.entityStore.syncFromEntities(this.document.content.nodes, this.document.content.connectors);

        // 监听事务提交，自动调度实体更新与广播
        this.coordinator.onOperation((record, doc) => {
            this.handleOperationCommitted(record, doc);
        });
    }

    /** 获取当前只读投影视图 */
    getView(): CanvasDocumentView {
        return this.document as CanvasDocumentView;
    }

    /** 当前视口状态 */
    getViewport(): Readonly<ViewportState> {
        return this.document.viewport;
    }

    /** 当前选中项 */
    getSelection(): Readonly<SelectionState> {
        return this.document.selection;
    }

    /** 是否可撤销 */
    get canUndo(): boolean {
        return this.coordinator.canUndo;
    }

    /** 是否可重做 */
    get canRedo(): boolean {
        return this.coordinator.canRedo;
    }

    /**
     * 提交原子事务
     */
    commit(options: CommitOperationOptions): CanvasOperationRecord | null {
        return this.coordinator.commitOperation(options);
    }

    /** 撤销一步操作 */
    undo(): boolean {
        return this.coordinator.undo();
    }

    /** 重做一步操作 */
    redo(): boolean {
        return this.coordinator.redo();
    }

    /** 清空历史栈 */
    clearHistory(): void {
        this.coordinator.clearHistory();
    }

    /** 订阅文档视图变更 */
    subscribe(listener: DocumentSubscriber): () => void {
        this.subscribers.add(listener);
        return () => {
            this.subscribers.delete(listener);
        };
    }

    /**
     * O(1) 瞬时查询单个节点实体 (只读引用)
     */
    getNode(id: string): Readonly<NodeEntity> | undefined {
        return this.entityStore.getNode(id)?.entity;
    }

    /**
     * O(1) 瞬时查询单个连线实体 (只读引用)
     */
    getConnector(id: string): Readonly<ConnectorEntity> | undefined {
        return this.entityStore.getConnector(id)?.entity;
    }

    // ================= 便捷语义操作辅助函数 =================

    /**
     * 更新视口平移与缩放 (高频操作，默认不入历史栈)
     */
    setViewport(viewport: Partial<ViewportState>, undoable = false): CanvasOperationRecord | null {
        const patches: CanvasPatch[] = [];
        if (viewport.x !== undefined && viewport.x !== this.document.viewport.x) {
            patches.push({ op: "set", path: "viewport.x", value: viewport.x });
        }
        if (viewport.y !== undefined && viewport.y !== this.document.viewport.y) {
            patches.push({ op: "set", path: "viewport.y", value: viewport.y });
        }
        if (viewport.zoom !== undefined && viewport.zoom !== this.document.viewport.zoom) {
            patches.push({ op: "set", path: "viewport.zoom", value: viewport.zoom });
        }

        if (patches.length === 0) return null;

        return this.commit({
            label: "移动视口",
            patches,
            undoable,
            source: "system",
        });
    }

    /**
     * 更新选中态 (交互临时状态，默认不入历史栈)
     */
    setSelection(selection: Partial<SelectionState>, undoable = false): CanvasOperationRecord | null {
        const patches: CanvasPatch[] = [];
        if (selection.nodeIds !== undefined) {
            patches.push({ op: "set", path: "selection.nodeIds", value: [...selection.nodeIds] });
        }
        if (selection.connectorIds !== undefined) {
            patches.push({ op: "set", path: "selection.connectorIds", value: [...selection.connectorIds] });
        }

        if (patches.length === 0) return null;

        return this.commit({
            label: "更改选择",
            patches,
            undoable,
            source: "system",
        });
    }

    /**
     * 添加节点
     */
    addNode(node: NodeEntity, options?: { undoable?: boolean; label?: string }): CanvasOperationRecord | null {
        const insertIndex = this.document.content.nodes.length;
        return this.commit({
            label: options?.label ?? `添加${node.type}节点`,
            undoable: options?.undoable ?? true,
            patches: [
                {
                    op: "splice",
                    path: "content.nodes",
                    index: insertIndex,
                    deleteCount: 0,
                    items: [node],
                },
            ],
        });
    }

    /**
     * 移除节点 (同时自动清理可能依附于它的选中态)
     */
    removeNode(nodeId: string, options?: { undoable?: boolean; label?: string }): CanvasOperationRecord | null {
        const index = this.document.content.nodes.findIndex((n) => n.id === nodeId);
        if (index === -1) return null;

        const patches: CanvasPatch[] = [
            {
                op: "splice",
                path: "content.nodes",
                index,
                deleteCount: 1,
            },
        ];

        // 如果该节点处于选中态，一并移出选中
        if (this.document.selection.nodeIds.includes(nodeId)) {
            patches.push({
                op: "set",
                path: "selection.nodeIds",
                value: this.document.selection.nodeIds.filter((id) => id !== nodeId),
            });
        }

        return this.commit({
            label: options?.label ?? "删除节点",
            undoable: options?.undoable ?? true,
            patches,
        });
    }

    /**
     * 移动节点几何位置 (支持高频拖拽通过 groupId 折叠)
     */
    moveNode(nodeId: string, delta: { x?: number; y?: number }, options?: { undoable?: boolean; groupId?: string; label?: string }): CanvasOperationRecord | null {
        const index = this.document.content.nodes.findIndex((n) => n.id === nodeId);
        if (index === -1) return null;

        const targetNode = this.document.content.nodes[index];
        const patches: CanvasPatch[] = [];

        if (delta.x !== undefined) {
            patches.push({
                op: "set",
                path: ["content", "nodes", index, "x"],
                value: targetNode.x + delta.x,
            });
        }
        if (delta.y !== undefined) {
            patches.push({
                op: "set",
                path: ["content", "nodes", index, "y"],
                value: targetNode.y + delta.y,
            });
        }

        if (patches.length === 0) return null;

        return this.commit({
            label: options?.label ?? "移动节点",
            undoable: options?.undoable ?? true,
            groupId: options?.groupId,
            patches,
        });
    }

    /**
     * 更新节点属性 (语义化高频更新通道，自动定位与生成正交原子补丁)
     * 支持 style/data 的 merge: true 增量浅合并或直接覆盖赋值
     */
    updateNode(
        nodeId: string,
        partial: Partial<NodeEntity>,
        options?: { undoable?: boolean; label?: string; merge?: boolean }
    ): CanvasOperationRecord | null {
        const index = this.document.content.nodes.findIndex((n) => n.id === nodeId);
        if (index === -1) return null;

        const patches: CanvasPatch[] = [];
        const entries = Object.entries(partial);
        const shouldMerge = options?.merge ?? true;

        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            if (key === "id" || key === "type") continue; // 核心不可变主键禁止篡改

            if ((key === "style" || key === "data") && typeof value === "object" && value !== null && shouldMerge) {
                patches.push({
                    op: "set",
                    path: ["content", "nodes", index, key],
                    value,
                    merge: true,
                });
            } else {
                patches.push({
                    op: "set",
                    path: ["content", "nodes", index, key],
                    value,
                });
            }
        }

        if (patches.length === 0) return null;

        return this.commit({
            label: options?.label ?? "更新节点属性",
            undoable: options?.undoable ?? true,
            patches,
        });
    }

    /**
     * 更新连线属性
     */
    updateConnector(
        connectorId: string,
        partial: Partial<ConnectorEntity>,
        options?: { undoable?: boolean; label?: string; merge?: boolean }
    ): CanvasOperationRecord | null {
        const index = this.document.content.connectors.findIndex((c) => c.id === connectorId);
        if (index === -1) return null;

        const patches: CanvasPatch[] = [];
        const entries = Object.entries(partial);
        const shouldMerge = options?.merge ?? true;

        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            if (key === "id" || key === "type") continue;

            if ((key === "style" || key === "data") && typeof value === "object" && value !== null && shouldMerge) {
                patches.push({
                    op: "set",
                    path: ["content", "connectors", index, key],
                    value,
                    merge: true,
                });
            } else {
                patches.push({
                    op: "set",
                    path: ["content", "connectors", index, key],
                    value,
                });
            }
        }

        if (patches.length === 0) return null;

        return this.commit({
            label: options?.label ?? "更新连线属性",
            undoable: options?.undoable ?? true,
            patches,
        });
    }

    /**
     * 统一处理补丁提交后的双版本号与实体增量同步
     */
    private handleOperationCommitted(record: CanvasOperationRecord, doc: CanvasDocument): void {
        // 本地操作自动刷新文档最后更新时间戳
        if (record.origin === "local") {
            doc.meta.updatedAt = record.timestamp;
        }

        // 检查是否有节点或连线的增删
        let needsFullSync = false;
        const geomChangedNodeIds = new Set<string>();
        const dataChangedNodeIds = new Set<string>();
        const geomChangedConnectorIds = new Set<string>();
        const dataChangedConnectorIds = new Set<string>();

        for (let i = 0; i < record.patches.length; i++) {
            const patch = record.patches[i];
            const segments = normalizePatchPath(patch.path);

            if (segments.length >= 2 && segments[0] === "content") {
                const targetType = segments[1]; // 'nodes' | 'connectors'

                if (segments.length === 2 && patch.op === "splice") {
                    needsFullSync = true;
                    continue;
                }

                // 精确字段更新
                if (targetType === "nodes" && typeof segments[2] === "number") {
                    const nodeIndex = segments[2];
                    const node = doc.content.nodes[nodeIndex];
                    if (node) {
                        // segments.length === 3 说明整包覆盖了 nodes[nodeIndex]，几何与数据同时标记脏
                        if (segments.length === 3) {
                            geomChangedNodeIds.add(node.id);
                            dataChangedNodeIds.add(node.id);
                        } else {
                            const field = segments[3];
                            if (field === "x" || field === "y" || field === "width" || field === "height" || field === "rotation") {
                                geomChangedNodeIds.add(node.id);
                            } else {
                                dataChangedNodeIds.add(node.id);
                            }
                        }
                    }
                } else if (targetType === "connectors" && typeof segments[2] === "number") {
                    const connIndex = segments[2];
                    const conn = doc.content.connectors[connIndex];
                    if (conn) {
                        if (segments.length === 3) {
                            geomChangedConnectorIds.add(conn.id);
                            dataChangedConnectorIds.add(conn.id);
                        } else {
                            const field = segments[3];
                            if (field === "start" || field === "end" || field === "controlPoints" || field === "routingType") {
                                geomChangedConnectorIds.add(conn.id);
                            } else {
                                dataChangedConnectorIds.add(conn.id);
                            }
                        }
                    }
                }
            }
        }

        if (needsFullSync) {
            this.entityStore.syncFromEntities(doc.content.nodes, doc.content.connectors);
        } else {
            // 事务内单次统一递增版本号
            for (const id of geomChangedNodeIds) {
                this.entityStore.notifyNodeGeometryChanged(id);
            }
            for (const id of dataChangedNodeIds) {
                this.entityStore.notifyNodeDataChanged(id);
            }
            for (const id of geomChangedConnectorIds) {
                this.entityStore.notifyConnectorGeometryChanged(id);
            }
            for (const id of dataChangedConnectorIds) {
                this.entityStore.notifyConnectorDataChanged(id);
            }
        }

        // 广播只读视图
        const view = this.getView();
        for (const subscriber of this.subscribers) {
            try {
                subscriber(view, record);
            } catch (err) {
                console.error("[DocumentStore] 视图订阅监听异常:", err);
            }
        }
    }
}

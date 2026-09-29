/**
 * @file document-store.ts
 * @description 画布文档状态中心 (单一事实源聚合器)
 *
 * 设计考量 (Why):
 * 1. 深度只读投影 (CanvasDocumentView)：对外暴露的文档对象强锁 readonly，防止外部直接属性赋值绕过事务机制。
 * 2. 状态与事务闭环：内聚集成 EntityStore 与 OperationCoordinator，当补丁应用时自动完成双版本号更新与实体索引刷新。
 * 3. 极速响应：提供便捷的高频操作辅助函数 (addNode, moveNode, updateNode)，自动封装规范补丁并走事务提交。
 *    视口与选区属于本地会话状态，由 SessionStore 管理，不在此处。
 * 4. 增量变更集：每次提交把补丁路径按实体语义归类为 DocumentChangeSet 一并广播，下游全部增量消费。
 */

import type { CanvasDocument, CanvasDocumentView } from "../types/canvas";
import type { NodeEntity } from "../types/node";
import type { ConnectorEntity } from "../types/connector";
import type { CanvasOperationRecord, CommitOperationOptions, CanvasPatch } from "../types/operation";
import type { DocumentChangeSet, EntityChanges } from "../types/change-set";
import type { EntitySyncResult, EntityReader } from "./entity-store";
import { EntityStore } from "./entity-store";
import { OperationCoordinator } from "../operation/coordinator";
import { normalizePatchPath } from "../operation/patch-path";
import { clonePlainData } from "../utils/clone";

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
        content: {
            nodes: {},
            connectors: {},
        },
    };
}

const NODE_GEOM_FIELDS: ReadonlySet<string | number> = new Set(["x", "y", "width", "height", "rotation"]);
/** style 中的 curveType / cornerRadius / padding 会改变路由形状，因此连线样式同时视为几何变更 */
const CONNECTOR_GEOM_FIELDS: ReadonlySet<string | number> = new Set(["from", "to", "controlPoints", "style"]);
const NODE_ORDER_FIELDS: ReadonlySet<string | number> = new Set(["zIndex", "parentId"]);
const CONNECTOR_ORDER_FIELDS: ReadonlySet<string | number> = new Set(["zIndex", "from", "to"]);

/** 文档视图订阅回调 */
export type DocumentSubscriber = (
    view: CanvasDocumentView,
    record: CanvasOperationRecord,
    changes: DocumentChangeSet
) => void;

interface MutableEntityChanges extends EntityChanges {
    readonly added: Set<string>;
    readonly removed: Set<string>;
    readonly geometry: Set<string>;
    readonly data: Set<string>;
}

function createEntityChanges(): MutableEntityChanges {
    return { added: new Set(), removed: new Set(), geometry: new Set(), data: new Set() };
}

/** 把实体对齐结果归入变更集，返回层叠关系是否可能变化 */
function recordSyncResult(changes: MutableEntityChanges, id: string, result: EntitySyncResult): boolean {
    switch (result) {
        case "added":
            changes.added.add(id);
            changes.geometry.add(id);
            changes.data.add(id);
            return true;
        case "replaced":
            changes.geometry.add(id);
            changes.data.add(id);
            return true;
        case "removed":
            changes.removed.add(id);
            return true;
        case "unchanged":
            return false;
    }
}

export class DocumentStore {
    private readonly document: CanvasDocument;
    /** 对外只读的实体运行时索引；写入只经由本类的事务提交回调 */
    readonly entityStore: EntityReader;
    private readonly entityIndex: EntityStore;
    readonly coordinator: OperationCoordinator<CanvasDocument>;

    private readonly subscribers = new Set<DocumentSubscriber>();

    constructor(initialDoc?: CanvasDocument) {
        // 外部传入文档属于不可信输入边界：深拷贝净化并切断与调用方的引用共享
        this.document = initialDoc ? clonePlainData(initialDoc) : createEmptyCanvasDocument();
        this.entityIndex = new EntityStore();
        this.entityStore = this.entityIndex;
        this.coordinator = new OperationCoordinator<CanvasDocument>(this.document);

        const { nodes, connectors } = this.document.content;
        for (const id in nodes) {
            this.entityIndex.syncNode(id, nodes[id]);
        }
        for (const id in connectors) {
            this.entityIndex.syncConnector(id, connectors[id]);
        }

        // 监听事务提交，自动调度实体更新与广播
        this.coordinator.onOperation((record, doc) => {
            this.handleOperationCommitted(record, doc);
        });
    }

    /** 获取当前只读投影视图 */
    getView(): CanvasDocumentView {
        return this.document as CanvasDocumentView;
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
     * 添加节点
     */
    addNode(node: NodeEntity, options?: { undoable?: boolean; label?: string }): CanvasOperationRecord | null {
        if (Object.hasOwn(this.document.content.nodes, node.id)) {
            console.error(`[DocumentStore] 节点 id 已存在，拒绝覆盖: ${node.id}`);
            return null;
        }
        return this.commit({
            label: options?.label ?? `添加${node.nodeType}节点`,
            undoable: options?.undoable ?? true,
            patches: [{ op: "set", path: ["content", "nodes", node.id], value: node }],
        });
    }

    /**
     * 移除节点，并在同一事务内级联删除依附连线，撤销时整体恢复
     * 选区中的失效项由引擎在收到变更集后统一剔除，本地删除与远端删除走同一条路径
     */
    removeNode(nodeId: string, options?: { undoable?: boolean; label?: string }): CanvasOperationRecord | null {
        if (!Object.hasOwn(this.document.content.nodes, nodeId)) return null;

        const patches: CanvasPatch[] = [{ op: "unset", path: ["content", "nodes", nodeId] }];
        const connectorIds = this.entityStore.getConnectorIdsOfNode(nodeId);
        for (const connectorId of connectorIds) {
            patches.push({ op: "unset", path: ["content", "connectors", connectorId] });
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
        if (!Object.hasOwn(this.document.content.nodes, nodeId)) return null;

        const targetNode = this.document.content.nodes[nodeId];
        const patches: CanvasPatch[] = [];

        if (delta.x !== undefined) {
            patches.push({
                op: "set",
                path: ["content", "nodes", nodeId, "x"],
                value: targetNode.x + delta.x,
            });
        }
        if (delta.y !== undefined) {
            patches.push({
                op: "set",
                path: ["content", "nodes", nodeId, "y"],
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
        if (!Object.hasOwn(this.document.content.nodes, nodeId)) return null;

        const patches: CanvasPatch[] = [];
        const entries = Object.entries(partial);
        const shouldMerge = options?.merge ?? true;

        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            if (key === "id" || key === "type") continue; // 核心不可变主键禁止篡改

            if ((key === "style" || key === "data") && typeof value === "object" && value !== null && shouldMerge) {
                patches.push({
                    op: "set",
                    path: ["content", "nodes", nodeId, key],
                    value,
                    merge: true,
                });
            } else {
                patches.push({
                    op: "set",
                    path: ["content", "nodes", nodeId, key],
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
        if (!Object.hasOwn(this.document.content.connectors, connectorId)) return null;

        const patches: CanvasPatch[] = [];
        const entries = Object.entries(partial);
        const shouldMerge = options?.merge ?? true;

        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            if (key === "id" || key === "type") continue;

            if ((key === "style" || key === "data") && typeof value === "object" && value !== null && shouldMerge) {
                patches.push({
                    op: "set",
                    path: ["content", "connectors", connectorId, key],
                    value,
                    merge: true,
                });
            } else {
                patches.push({
                    op: "set",
                    path: ["content", "connectors", connectorId, key],
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
     * 统一处理补丁提交后的双版本号、实体增量同步，并产出结构化变更集
     */
    private handleOperationCommitted(record: CanvasOperationRecord, doc: CanvasDocument): void {
        // 本地操作自动刷新文档最后更新时间戳
        if (record.origin === "local") {
            doc.meta.updatedAt = record.timestamp;
        }

        const nodeChanges = createEntityChanges();
        const connectorChanges = createEntityChanges();
        let fullSync = false;
        let orderChanged = false;

        const syncNodeIds = new Set<string>();
        const syncConnectorIds = new Set<string>();
        const nodeGeomIds = new Set<string>();
        const nodeDataIds = new Set<string>();
        const connectorGeomIds = new Set<string>();
        const connectorDataIds = new Set<string>();

        for (let i = 0; i < record.patches.length; i++) {
            const patch = record.patches[i];
            const segments = normalizePatchPath(patch.path);
            if (segments[0] !== "content") continue;

            // 整体替换 content 或整个 nodes/connectors 集合
            if (segments.length <= 2) {
                fullSync = true;
                continue;
            }

            const isNode = segments[1] === "nodes";
            if (!isNode && segments[1] !== "connectors") continue;
            const id = String(segments[2]);

            let fields: readonly (string | number)[];
            if (segments.length > 3) {
                fields = [segments[3]];
            } else if (patch.op === "set" && patch.merge) {
                // 对实体本身做字典合并：按合并的字段逐一归类
                fields = Object.keys(patch.value as object);
            } else {
                (isNode ? syncNodeIds : syncConnectorIds).add(id);
                continue;
            }

            const geomFields = isNode ? NODE_GEOM_FIELDS : CONNECTOR_GEOM_FIELDS;
            const orderFields = isNode ? NODE_ORDER_FIELDS : CONNECTOR_ORDER_FIELDS;
            for (let j = 0; j < fields.length; j++) {
                const field = fields[j];
                if (geomFields.has(field)) {
                    (isNode ? nodeGeomIds : connectorGeomIds).add(id);
                } else {
                    (isNode ? nodeDataIds : connectorDataIds).add(id);
                }
                if (orderFields.has(field)) orderChanged = true;
            }
        }

        const { nodes, connectors } = doc.content;
        const store = this.entityIndex;

        if (fullSync) {
            for (const runtimeNode of store.getAllNodes()) syncNodeIds.add(runtimeNode.entity.id);
            for (const id in nodes) syncNodeIds.add(id);
            for (const runtimeConnector of store.getAllConnectors()) syncConnectorIds.add(runtimeConnector.entity.id);
            for (const id in connectors) syncConnectorIds.add(id);
        }

        for (const id of syncNodeIds) {
            const result = store.syncNode(id, Object.hasOwn(nodes, id) ? nodes[id] : undefined);
            if (recordSyncResult(nodeChanges, id, result)) orderChanged = true;
        }
        for (const id of syncConnectorIds) {
            const result = store.syncConnector(id, Object.hasOwn(connectors, id) ? connectors[id] : undefined);
            if (recordSyncResult(connectorChanges, id, result)) orderChanged = true;
        }

        // 事务内单次统一递增版本号；同一事务先改字段再删除实体时，已删除的实体不再计入变更
        for (const id of nodeGeomIds) {
            if (!store.hasNode(id)) continue;
            store.notifyNodeGeometryChanged(id);
            nodeChanges.geometry.add(id);
        }
        for (const id of nodeDataIds) {
            if (!store.hasNode(id)) continue;
            store.notifyNodeDataChanged(id);
            nodeChanges.data.add(id);
        }
        for (const id of connectorGeomIds) {
            if (!store.hasConnector(id)) continue;
            store.notifyConnectorGeometryChanged(id);
            connectorChanges.geometry.add(id);
        }
        for (const id of connectorDataIds) {
            if (!store.hasConnector(id)) continue;
            store.notifyConnectorDataChanged(id);
            connectorChanges.data.add(id);
        }

        // 节点移动或删除时，依附连线的路由随之失效
        for (const affected of [nodeChanges.geometry, nodeChanges.removed]) {
            for (const nodeId of affected) {
                for (const connectorId of store.getConnectorIdsOfNode(nodeId)) {
                    if (connectorChanges.geometry.has(connectorId) || !store.hasConnector(connectorId)) continue;
                    store.notifyConnectorGeometryChanged(connectorId);
                    connectorChanges.geometry.add(connectorId);
                }
            }
        }

        const changes: DocumentChangeSet = {
            nodes: nodeChanges,
            connectors: connectorChanges,
            orderChanged,
        };

        // 广播只读视图
        const view = this.getView();
        for (const subscriber of this.subscribers) {
            try {
                subscriber(view, record, changes);
            } catch (err) {
                console.error("[DocumentStore] 视图订阅监听异常:", err);
            }
        }
    }
}

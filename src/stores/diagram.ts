import { defineStore } from 'pinia';
import type {
  DiagramConnector,
  DiagramDocument,
  DiagramNode,
  NodeKind,
  Point,
  Swimlane,
  ToolMode,
} from '../types/diagram';
import { DEFAULT_NODE_SIZE } from '../utils/diagramGeometry';
import {
  LANE_COLORS,
  LANE_DEFAULT_WIDTH,
  LANE_GAP,
  LANE_HEADER_HEIGHT,
  LANE_MIN_BODY,
  LANE_PADDING,
  computeSwimLayout,
  displayToCanonical,
} from '../utils/swimlaneLayout';

const STORAGE_KEY = 'pair-wise-yy-07-diagram';
let persistTimer: number | undefined;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function initialLanes(): Swimlane[] {
  return [
    {
      id: 'lane-sales',
      name: '销售部',
      color: LANE_COLORS[0],
      x: 60,
      y: 60,
      width: LANE_DEFAULT_WIDTH,
      height: 260,
      collapsed: false,
    },
    {
      id: 'lane-risk',
      name: '风控部',
      color: LANE_COLORS[1],
      x: 60,
      y: 60 + LANE_HEADER_HEIGHT + 260 + LANE_GAP,
      width: LANE_DEFAULT_WIDTH,
      height: 220,
      collapsed: false,
    },
    {
      id: 'lane-ops',
      name: '履约部',
      color: LANE_COLORS[2],
      x: 60,
      y:
        60 +
        (LANE_HEADER_HEIGHT + 260 + LANE_GAP) +
        (LANE_HEADER_HEIGHT + 220 + LANE_GAP),
      width: LANE_DEFAULT_WIDTH,
      height: 200,
      collapsed: false,
    },
  ];
}

function initialNodes(): DiagramNode[] {
  return [
    {
      id: 'table-customers',
      kind: 'table',
      x: 90,
      y: 110,
      width: 210,
      height: 170,
      text: 'customers',
      color: '#ffffff',
      locked: false,
      groupId: null,
      laneId: 'lane-sales',
      zIndex: 1,
      fields: ['id  BIGINT PK', 'name  VARCHAR(80)', 'region  VARCHAR(20)', 'credit_limit DECIMAL'],
    },
    {
      id: 'table-orders',
      kind: 'table',
      x: 470,
      y: 105,
      width: 220,
      height: 190,
      text: 'orders',
      color: '#ffffff',
      locked: false,
      groupId: null,
      laneId: 'lane-sales',
      zIndex: 2,
      fields: ['id  BIGINT PK', 'customer_id  BIGINT FK', 'amount  DECIMAL', 'status VARCHAR(20)'],
    },
    {
      id: 'node-review',
      kind: 'diamond',
      x: 470,
      y: 60 + (LANE_HEADER_HEIGHT + 260 + LANE_GAP) + 46,
      width: 180,
      height: 120,
      text: '风控审核通过？',
      color: '#fff7e8',
      locked: false,
      groupId: null,
      laneId: 'lane-risk',
      zIndex: 3,
      fields: [],
    },
    {
      id: 'node-fulfill',
      kind: 'rectangle',
      x: 330,
      y:
        60 +
        (LANE_HEADER_HEIGHT + 260 + LANE_GAP) +
        (LANE_HEADER_HEIGHT + 220 + LANE_GAP) +
        56,
      width: 180,
      height: 76,
      text: '进入履约流程',
      color: '#eaf7f0',
      locked: false,
      groupId: null,
      laneId: 'lane-ops',
      zIndex: 4,
      fields: [],
    },
    {
      id: 'node-close',
      kind: 'circle',
      x: 620,
      y:
        60 +
        (LANE_HEADER_HEIGHT + 260 + LANE_GAP) +
        (LANE_HEADER_HEIGHT + 220 + LANE_GAP) +
        40,
      width: 112,
      height: 112,
      text: '订单完成',
      color: '#eef4ff',
      locked: false,
      groupId: null,
      laneId: 'lane-ops',
      zIndex: 5,
      fields: [],
    },
  ];
}

function initialConnectors(): DiagramConnector[] {
  return [
    {
      id: 'connector-customer-orders',
      fromId: 'table-customers',
      toId: 'table-orders',
      fromAnchor: 'right',
      toAnchor: 'left',
      label: '1 : N',
      color: '#1f6feb',
      dashed: false,
      locked: false,
      zIndex: 1,
    },
    {
      id: 'connector-orders-review',
      fromId: 'table-orders',
      toId: 'node-review',
      fromAnchor: 'bottom',
      toAnchor: 'top',
      label: '校验',
      color: '#667085',
      dashed: false,
      locked: false,
      zIndex: 2,
    },
    {
      id: 'connector-review-fulfill',
      fromId: 'node-review',
      toId: 'node-fulfill',
      fromAnchor: 'bottom',
      toAnchor: 'top',
      label: '是',
      color: '#12805c',
      dashed: false,
      locked: false,
      zIndex: 3,
    },
    {
      id: 'connector-review-close',
      fromId: 'node-review',
      toId: 'node-close',
      fromAnchor: 'right',
      toAnchor: 'left',
      label: '驳回',
      color: '#c2413b',
      dashed: true,
      locked: false,
      zIndex: 4,
    },
  ];
}

interface HistoryState {
  past: DiagramDocument[];
  future: DiagramDocument[];
}

/**
 * 兼容旧文档：
 * - 缺少 swimlanes 字段时补空数组
 * - 旧 groupId 分组的图元打开时归到同一条泳道，组内布局保留
 * - 缺少 laneId 字段的图元视为自由图元
 */
function migrateDocument(document: Partial<DiagramDocument>): DiagramDocument {
  const nodes = (Array.isArray(document.nodes) ? clonePlain(document.nodes) : []) as DiagramNode[];
  const connectors = Array.isArray(document.connectors)
    ? (clonePlain(document.connectors) as DiagramConnector[])
    : [];
  let lanes = Array.isArray(document.swimlanes)
    ? (clonePlain(document.swimlanes) as Swimlane[])
    : [];

  nodes.forEach((node) => {
    if (node.laneId === undefined) node.laneId = null;
  });

  if (!lanes.length) {
    const groupIds = [...new Set(nodes.map((node) => node.groupId).filter(Boolean))] as string[];
    lanes = groupIds.map((groupId, index) => {
      const members = nodes.filter((node) => node.groupId === groupId);
      const minX = Math.min(...members.map((node) => node.x));
      const minY = Math.min(...members.map((node) => node.y));
      const maxX = Math.max(...members.map((node) => node.x + node.width));
      const maxY = Math.max(...members.map((node) => node.y + node.height));
      const x = minX - LANE_PADDING;
      const y = minY - LANE_HEADER_HEIGHT - LANE_PADDING;
      members.forEach((node) => {
        node.laneId = `lane-${groupId}`;
      });
      return {
        id: `lane-${groupId}`,
        name: `泳道 ${index + 1}`,
        color: LANE_COLORS[index % LANE_COLORS.length],
        x,
        y,
        width: Math.max(LANE_DEFAULT_WIDTH, maxX - x + LANE_PADDING),
        height: Math.max(LANE_MIN_BODY, maxY - minY + LANE_PADDING * 2),
        collapsed: false,
      };
    });
    // 迁移后的多条泳道保留各自在画布上的原始位置（组内相对位置不动），
    // 仅在纵向重叠时按顺序上下排开。
    if (lanes.length > 1) {
      const ordered = [...lanes].sort((a, b) => a.y - b.y);
      for (let index = 1; index < ordered.length; index += 1) {
        const lane = ordered[index];
        const previous = ordered[index - 1];
        const earliest = previous.y + LANE_HEADER_HEIGHT + previous.height + LANE_GAP;
        if (lane.y < earliest) {
          const shift = earliest - lane.y;
          lane.y += shift;
          nodes
            .filter((node) => node.laneId === lane.id)
            .forEach((node) => {
              node.y += shift;
            });
        }
      }
      lanes = ordered;
    }
  }

  // 清理悬空 laneId（指向已不存在泳道的图元变为自由图元）。
  const validLaneIds = new Set(lanes.map((lane) => lane.id));
  nodes.forEach((node) => {
    if (node.laneId && !validLaneIds.has(node.laneId)) node.laneId = null;
  });

  return {
    version: 1,
    title: typeof document.title === 'string' ? document.title : '未命名图表',
    nodes,
    connectors,
    swimlanes: lanes,
    updatedAt: typeof document.updatedAt === 'number' ? document.updatedAt : Date.now(),
  };
}

function loadDocument(): DiagramDocument | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DiagramDocument>;
    if (!Array.isArray(parsed.nodes)) return null;
    return migrateDocument(parsed);
  } catch {
    return null;
  }
}

const savedDocument = loadDocument();
const fallbackLanes = initialLanes();

export const useDiagramStore = defineStore('diagram', {
  state: () => ({
    title: savedDocument?.title ?? '订单履约架构图',
    nodes: savedDocument?.nodes ?? initialNodes(),
    connectors: savedDocument?.connectors ?? initialConnectors(),
    swimlanes: savedDocument?.swimlanes ?? fallbackLanes,
    selectedIds: [] as string[],
    selectedConnectorId: null as string | null,
    selectedLaneId: null as string | null,
    activeNodeId: null as string | null,
    toolMode: 'select' as ToolMode,
    zoom: 1,
    pan: { x: 36, y: 24 },
    snapToGrid: true,
    gridSize: 20,
    history: { past: [], future: [] } as HistoryState,
  }),
  getters: {
    selectedNodes(state): DiagramNode[] {
      return state.nodes.filter((node) => state.selectedIds.includes(node.id));
    },
    activeNode(state): DiagramNode | null {
      return state.nodes.find((node) => node.id === state.activeNodeId) ?? null;
    },
    selectedLane(state): Swimlane | null {
      return state.swimlanes.find((lane) => lane.id === state.selectedLaneId) ?? null;
    },
    canUndo: (state) => state.history.past.length > 0,
    canRedo: (state) => state.history.future.length > 0,
  },
  actions: {
    snapshot(): DiagramDocument {
      return {
        version: 1,
        title: this.title,
        nodes: clonePlain(this.nodes),
        connectors: clonePlain(this.connectors),
        swimlanes: clonePlain(this.swimlanes),
        updatedAt: Date.now(),
      };
    },
    checkpoint() {
      this.history.past.push(this.snapshot());
      if (this.history.past.length > 80) this.history.past.shift();
      this.history.future = [];
    },
    undo() {
      const previous = this.history.past.pop();
      if (!previous) return;
      this.history.future.push(this.snapshot());
      this.restore(previous);
    },
    redo() {
      const next = this.history.future.pop();
      if (!next) return;
      this.history.past.push(this.snapshot());
      this.restore(next);
    },
    restore(document: DiagramDocument) {
      const migrated = migrateDocument(document);
      this.title = migrated.title;
      this.nodes = migrated.nodes;
      this.connectors = migrated.connectors;
      this.swimlanes = migrated.swimlanes;
      this.selectedIds = this.selectedIds.filter((id) =>
        this.nodes.some((node) => node.id === id),
      );
      this.selectedConnectorId = null;
      if (this.selectedLaneId && !this.swimlanes.some((lane) => lane.id === this.selectedLaneId)) {
        this.selectedLaneId = null;
      }
      this.activeNodeId = this.selectedIds.at(-1) ?? null;
    },

    // ---------- 图元 ----------

    addNode(kind: NodeKind, position?: { x: number; y: number }, laneId: string | null = null) {
      this.checkpoint();
      const size = DEFAULT_NODE_SIZE[kind];
      const point = position ?? {
        x: 220 + (this.nodes.length % 4) * 26,
        y: 220 + (this.nodes.length % 3) * 24,
      };
      const node: DiagramNode = {
        id: makeId(kind),
        kind,
        x: this.snapToGrid ? Math.round(point.x / this.gridSize) * this.gridSize : point.x,
        y: this.snapToGrid ? Math.round(point.y / this.gridSize) * this.gridSize : point.y,
        width: size.width,
        height: kind === 'table' ? Math.max(size.height, 82 + 4 * 34) : size.height,
        text:
          kind === 'table'
            ? 'new_table'
            : kind === 'diamond'
              ? '条件判断'
              : kind === 'circle'
                ? '开始 / 结束'
                : '流程节点',
        color: kind === 'table' ? '#ffffff' : '#eef4ff',
        locked: false,
        groupId: null,
        laneId,
        zIndex: Math.max(0, ...this.nodes.map((item) => item.zIndex)) + 1,
        fields: kind === 'table' ? ['id  BIGINT PK', 'name  VARCHAR(80)'] : [],
      };
      this.nodes.push(node);
      if (laneId) this.accommodateNodes([node.id]);
      this.selectNode(node.id);
      this.persistSoon();
    },
    updateNode(id: string, patch: Partial<DiagramNode>) {
      const node = this.nodes.find((item) => item.id === id);
      if (!node) return;
      Object.assign(node, patch);
      this.persistSoon();
    },
    patchNode(id: string, patch: Partial<DiagramNode>) {
      this.checkpoint();
      this.updateNode(id, patch);
      if (patch.height !== undefined || patch.fields !== undefined) {
        const node = this.nodes.find((item) => item.id === id);
        if (node?.laneId) this.accommodateNodes([id]);
      }
    },
    commitPositions(positions: Record<string, { x: number; y: number }>) {
      Object.entries(positions).forEach(([id, point]) => {
        const node = this.nodes.find((item) => item.id === id);
        if (node) {
          node.x = point.x;
          node.y = point.y;
        }
      });
      this.persistSoon();
    },
    /**
     * 拖拽提交：positions 为换算后的规范坐标，laneIds 为拖放后的归属。
     * 归属变化与可能的泳道增高（下方泳道整体平移）在这里一次完成。
     */
    commitDrag(
      positions: Record<string, Point>,
      laneIds: Record<string, string | null>,
    ) {
      Object.entries(positions).forEach(([id, point]) => {
        const node = this.nodes.find((item) => item.id === id);
        if (node) Object.assign(node, point);
      });
      Object.entries(laneIds).forEach(([id, laneId]) => {
        const node = this.nodes.find((item) => item.id === id);
        if (node) node.laneId = laneId;
      });
      const affectedLanes = new Set<string>();
      Object.values(laneIds).forEach((laneId) => {
        if (laneId) affectedLanes.add(laneId);
      });
      Object.keys(positions).forEach((id) => {
        const node = this.nodes.find((item) => item.id === id);
        if (node?.laneId) affectedLanes.add(node.laneId);
      });
      this.accommodateNodes(Object.keys(positions), [...affectedLanes]);
      this.persistSoon();
    },
    /**
     * 保证泳道主体能容纳其图元（只增高）。增高时：
     * - 重排之后泳道的规范 y，并把其成员一起平移（图元跟着泳道走）
     * - 位于整个堆叠下方的自由图元同步下移
     */
    accommodateNodes(nodeIds: string[], laneIdsToCheck?: string[]) {
      const beforeLayout = computeSwimLayout(this.swimlanes, this.nodes);
      const beforeTops = new Map(this.swimlanes.map((lane) => [lane.id, lane.y]));

      // 先基于位移前的原始泳道几何一次性算出每条泳道需要增高多少，
      // 避免边挪边算导致重复增高。
      const laneGrowth = new Map<string, number>();
      const checkIds = laneIdsToCheck
        ? new Set(laneIdsToCheck)
        : new Set(
            nodeIds
              .map((id) => this.nodes.find((node) => node.id === id)?.laneId)
              .filter(Boolean) as string[],
          );
      checkIds.forEach((laneId) => {
        const lane = this.swimlanes.find((item) => item.id === laneId);
        if (!lane) return;
        const originalTop = beforeTops.get(laneId) as number;
        const members = this.nodes.filter((node) => node.laneId === laneId);
        const needed = members.length
          ? Math.max(
              LANE_MIN_BODY,
              ...members.map(
                (node) => node.y - (originalTop + LANE_HEADER_HEIGHT) + node.height + LANE_PADDING,
              ),
            )
          : LANE_MIN_BODY;
        if (needed > lane.height) laneGrowth.set(laneId, needed - lane.height);
        const maxRight = members.length
          ? Math.max(...members.map((node) => node.x + node.width))
          : 0;
        if (maxRight + LANE_PADDING > lane.x + lane.width) {
          lane.width = maxRight - lane.x + LANE_PADDING;
        }
      });
      if (!laneGrowth.size) return;

      // 写入新高度
      laneGrowth.forEach((growth, laneId) => {
        const lane = this.swimlanes.find((item) => item.id === laneId);
        if (lane) lane.height += growth;
      });

      // 按规范顺序累计位移，重写后续泳道的 y。
      let accumulated = 0;
      this.swimlanes.forEach((lane) => {
        const growth = laneGrowth.get(lane.id) ?? 0;
        const originalTop = beforeTops.get(lane.id) as number;
        const nextTop = originalTop + accumulated;
        const shift = nextTop - lane.y;
        if (shift !== 0) {
          this.nodes
            .filter((node) => node.laneId === lane.id)
            .forEach((node) => {
              node.y += shift;
            });
          lane.y = nextTop;
        }
        accumulated += growth;
      });

      // 堆叠下方的自由图元随总增量平移
      const totalGrowth = [...laneGrowth.values()].reduce((sum, value) => sum + value, 0);
      if (totalGrowth > 0) {
        const previousBottom = beforeLayout.canonicalBottom;
        this.nodes
          .filter((node) => !node.laneId && node.y >= previousBottom - 1)
          .forEach((node) => {
            node.y += totalGrowth;
          });
      }
    },
    selectNode(id: string, append = false) {
      this.selectedConnectorId = null;
      this.selectedLaneId = null;
      if (append) {
        this.selectedIds = this.selectedIds.includes(id)
          ? this.selectedIds.filter((item) => item !== id)
          : [...this.selectedIds, id];
      } else {
        this.selectedIds = [id];
      }
      this.activeNodeId = id;
    },
    selectConnector(id: string) {
      this.selectedConnectorId = id;
      this.selectedIds = [];
      this.activeNodeId = null;
      this.selectedLaneId = null;
    },
    selectLane(id: string) {
      this.selectedLaneId = id;
      this.selectedIds = [];
      this.selectedConnectorId = null;
      this.activeNodeId = null;
    },
    clearSelection() {
      this.selectedIds = [];
      this.selectedConnectorId = null;
      this.activeNodeId = null;
      this.selectedLaneId = null;
    },
    assignNodesToLane(ids: string[], laneId: string | null) {
      if (!ids.length) return;
      this.checkpoint();
      // 先按当前显示几何取落点，再换算成目标泳道的规范坐标。
      const layout = computeSwimLayout(this.swimlanes, this.nodes);
      ids.forEach((id) => {
        const node = this.nodes.find((item) => item.id === id);
        if (!node) return;
        const placement = layout.nodes.get(id);
        const canonical = displayToCanonical(
          this.swimlanes,
          layout,
          { x: node.x, y: placement?.y ?? node.y },
          laneId,
        );
        node.y = canonical.y;
        node.laneId = laneId;
      });
      this.accommodateNodes(ids, laneId ? [laneId] : []);
      this.persistSoon();
    },
    addConnector(fromId: string, toId: string, fromAnchor: DiagramConnector['fromAnchor'], toAnchor: DiagramConnector['toAnchor']) {
      if (fromId === toId) return;
      const exists = this.connectors.some(
        (connector) =>
          connector.fromId === fromId &&
          connector.toId === toId &&
          connector.fromAnchor === fromAnchor &&
          connector.toAnchor === toAnchor,
      );
      if (exists) return;
      this.checkpoint();
      this.connectors.push({
        id: makeId('connector'),
        fromId,
        toId,
        fromAnchor,
        toAnchor,
        label: '',
        color: '#667085',
        dashed: false,
        locked: false,
        zIndex: Math.max(0, ...this.connectors.map((item) => item.zIndex)) + 1,
      });
      this.persistSoon();
    },
    updateConnector(id: string, patch: Partial<DiagramConnector>) {
      const connector = this.connectors.find((item) => item.id === id);
      if (!connector) return;
      Object.assign(connector, patch);
      this.persistSoon();
    },
    patchConnector(id: string, patch: Partial<DiagramConnector>) {
      this.checkpoint();
      this.updateConnector(id, patch);
    },
    deleteSelection() {
      if (!this.selectedIds.length && !this.selectedConnectorId) return;
      this.checkpoint();
      const selected = new Set(this.selectedIds);
      this.nodes = this.nodes.filter((node) => !selected.has(node.id));
      this.connectors = this.connectors.filter(
        (connector) =>
          connector.id !== this.selectedConnectorId &&
          !selected.has(connector.fromId) &&
          !selected.has(connector.toId),
      );
      this.clearSelection();
      this.persistSoon();
    },
    duplicateSelection() {
      if (!this.selectedIds.length) return;
      this.checkpoint();
      const idMap = new Map<string, string>();
      const copies = this.selectedNodes.map((node) => {
        const id = makeId(node.kind);
        idMap.set(node.id, id);
        return {
          ...clonePlain(node),
          id,
          x: node.x + 32,
          y: node.y + 32,
          zIndex: Math.max(0, ...this.nodes.map((item) => item.zIndex)) + idMap.size,
        };
      });
      const originalIds = new Set(this.selectedIds);
      const connectorCopies = this.connectors
        .filter(
          (connector) => originalIds.has(connector.fromId) && originalIds.has(connector.toId),
        )
        .map((connector) => ({
          ...clonePlain(connector),
          id: makeId('connector'),
          fromId: idMap.get(connector.fromId) as string,
          toId: idMap.get(connector.toId) as string,
          zIndex: Math.max(0, ...this.connectors.map((item) => item.zIndex)) + 1,
        }));
      this.nodes.push(...copies);
      this.connectors.push(...connectorCopies);
      this.selectedIds = copies.map((node) => node.id);
      this.activeNodeId = copies.at(-1)?.id ?? null;
      const laneIds = new Set(copies.map((node) => node.laneId).filter(Boolean) as string[]);
      this.accommodateNodes(copies.map((node) => node.id), [...laneIds]);
      this.persistSoon();
    },
    groupSelection() {
      if (this.selectedIds.length < 2) return;
      this.checkpoint();
      const groupId = makeId('group');
      this.nodes.forEach((node) => {
        if (this.selectedIds.includes(node.id)) node.groupId = groupId;
      });
      this.persistSoon();
    },
    ungroupSelection() {
      if (!this.selectedIds.length) return;
      this.checkpoint();
      this.nodes.forEach((node) => {
        if (this.selectedIds.includes(node.id)) node.groupId = null;
      });
      this.persistSoon();
    },
    toggleLock() {
      const ids = this.selectedIds.length
        ? this.selectedIds
        : this.selectedConnectorId
          ? [this.selectedConnectorId]
          : [];
      if (!ids.length) return;
      this.checkpoint();
      if (this.selectedConnectorId) {
        this.connectors.forEach((connector) => {
          if (connector.id === this.selectedConnectorId) connector.locked = !connector.locked;
        });
      } else {
        this.nodes.forEach((node) => {
          if (ids.includes(node.id)) node.locked = !node.locked;
        });
      }
      this.persistSoon();
    },
    changeLayer(direction: 'front' | 'back') {
      const ids = this.selectedIds.length
        ? this.selectedIds
        : this.selectedConnectorId
          ? [this.selectedConnectorId]
          : [];
      if (!ids.length) return;
      this.checkpoint();
      if (this.selectedConnectorId) {
        const connector = this.connectors.find((item) => item.id === this.selectedConnectorId);
        if (connector) {
          connector.zIndex =
            direction === 'front'
              ? Math.max(...this.connectors.map((item) => item.zIndex)) + 1
              : Math.min(...this.connectors.map((item) => item.zIndex)) - 1;
        }
      } else {
        this.nodes.forEach((node) => {
          if (ids.includes(node.id)) {
            node.zIndex =
              direction === 'front'
                ? Math.max(...this.nodes.map((item) => item.zIndex)) + 1
                : Math.min(...this.nodes.map((item) => item.zIndex)) - 1;
          }
        });
      }
      this.persistSoon();
    },

    // ---------- 泳道 ----------

    addLane(position?: { x: number; y: number }) {
      this.checkpoint();
      const layout = computeSwimLayout(this.swimlanes, this.nodes);
      const index = this.swimlanes.length;
      const lane: Swimlane = {
        id: makeId('lane'),
        name: `泳道 ${index + 1}`,
        color: LANE_COLORS[index % LANE_COLORS.length],
        x: position?.x ?? (this.swimlanes[0]?.x ?? 60),
        y: position?.y ?? layout.canonicalBottom + LANE_GAP,
        width: this.swimlanes[0]?.width ?? LANE_DEFAULT_WIDTH,
        height: LANE_MIN_BODY,
        collapsed: false,
      };
      this.swimlanes.push(lane);
      this.selectLane(lane.id);
      this.persistSoon();
      return lane.id;
    },
    updateLane(id: string, patch: Partial<Swimlane>) {
      const lane = this.swimlanes.find((item) => item.id === id);
      if (!lane) return;
      Object.assign(lane, patch);
      this.persistSoon();
    },
    patchLane(id: string, patch: Partial<Swimlane>) {
      this.checkpoint();
      const lane = this.swimlanes.find((item) => item.id === id);
      if (!lane) return;
      const heightPatch = patch.height;
      if (heightPatch !== undefined) {
        const beforeLayout = computeSwimLayout(this.swimlanes, this.nodes);
        const nextBody = Math.max(60, heightPatch - LANE_HEADER_HEIGHT);
        const delta = nextBody - lane.height;
        lane.height = nextBody;
        if (delta !== 0) this.shiftLanesAfter(id, delta, beforeLayout);
        delete patch.height;
      }
      Object.assign(lane, patch);
      this.persistSoon();
    },
    renameLane(id: string, name: string) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const lane = this.swimlanes.find((item) => item.id === id);
      if (!lane || lane.name === trimmed) return;
      this.checkpoint();
      lane.name = trimmed;
      this.persistSoon();
    },
    toggleLaneCollapsed(id: string) {
      const lane = this.swimlanes.find((item) => item.id === id);
      if (!lane) return;
      this.checkpoint();
      lane.collapsed = !lane.collapsed;
      this.persistSoon();
    },
    /**
     * 拖动泳道标题调整先后：把 laneId 移动到 targetLaneId 的上方/下方。
     * 成员随泳道整体平移，泳道外的自由图元保持原位。
     */
    moveLane(laneId: string, targetLaneId: string, placement: 'before' | 'after') {
      if (laneId === targetLaneId) return;
      const fromIndex = this.swimlanes.findIndex((lane) => lane.id === laneId);
      if (fromIndex < 0) return;
      this.checkpoint();
      const beforeTops = new Map(this.swimlanes.map((lane) => [lane.id, lane.y]));
      const moved = this.swimlanes[fromIndex];
      const reordered = this.swimlanes.filter((lane) => lane.id !== laneId);
      let targetIndex = reordered.findIndex((lane) => lane.id === targetLaneId);
      if (targetIndex < 0) return;
      if (placement === 'after') targetIndex += 1;
      reordered.splice(targetIndex, 0, moved);

      // 堆叠顶部固定，按新顺序重排规范坐标；成员图元跟着各自泳道平移。
      const stackTop = Math.min(...beforeTops.values());
      let cursor = stackTop;
      reordered.forEach((lane) => {
        const shift = cursor - (beforeTops.get(lane.id) as number);
        if (shift !== 0) {
          this.nodes
            .filter((node) => node.laneId === lane.id)
            .forEach((node) => {
              node.y += shift;
            });
        }
        lane.y = cursor;
        cursor += LANE_HEADER_HEIGHT + lane.height + LANE_GAP;
      });
      this.swimlanes = reordered;
      this.persistSoon();
    },
    /**
     * anchorLaneId 之后（按数组顺序）的泳道整体平移 delta；其成员跟随。
     * 位于整个堆叠下方的自由图元也按 delta 平移。
     */
    shiftLanesAfter(
      anchorLaneId: string,
      delta: number,
      beforeLayout: ReturnType<typeof computeSwimLayout>,
    ) {
      if (delta === 0) return;
      const anchorIndex = this.swimlanes.findIndex((lane) => lane.id === anchorLaneId);
      this.swimlanes.forEach((lane, index) => {
        if (index <= anchorIndex) return;
        lane.y += delta;
        this.nodes
          .filter((node) => node.laneId === lane.id)
          .forEach((node) => {
            node.y += delta;
          });
      });
      const previousBottom = beforeLayout.canonicalBottom;
      this.nodes
        .filter((node) => !node.laneId && node.y >= previousBottom - 1)
        .forEach((node) => {
          node.y += delta;
        });
    },
    deleteLane(id: string, strategy: 'keepMembers' | 'deleteMembers' = 'keepMembers') {
      const lane = this.swimlanes.find((item) => item.id === id);
      if (!lane) return;
      this.checkpoint();
      const beforeLayout = computeSwimLayout(this.swimlanes, this.nodes);
      const stackTop = Math.min(...this.swimlanes.map((item) => item.y));

      if (strategy === 'deleteMembers') {
        const memberIds = new Set(
          this.nodes.filter((node) => node.laneId === id).map((node) => node.id),
        );
        this.nodes = this.nodes.filter((node) => !memberIds.has(node.id));
        this.connectors = this.connectors.filter(
          (connector) => !memberIds.has(connector.fromId) && !memberIds.has(connector.toId),
        );
        this.selectedIds = this.selectedIds.filter((nodeId) => !memberIds.has(nodeId));
      } else {
        // 图元保留为自由图元：把当前显示坐标换算成全展开规范坐标。
        const geometry = beforeLayout.laneById.get(id);
        const shiftToCanonical = geometry ? geometry.y - lane.y : 0;
        this.nodes
          .filter((node) => node.laneId === id)
          .forEach((node) => {
            node.laneId = null;
            node.y += shiftToCanonical;
          });
      }

      const removedFullSpan = LANE_HEADER_HEIGHT + lane.height + LANE_GAP;
      const previousBottom = beforeLayout.canonicalBottom;
      this.swimlanes = this.swimlanes.filter((item) => item.id !== id);
      let cursor = stackTop;
      this.swimlanes.forEach((remaining, index) => {
        if (index === 0) {
          cursor = remaining.y;
        } else {
          const previous = this.swimlanes[index - 1];
          cursor = previous.y + LANE_HEADER_HEIGHT + previous.height + LANE_GAP;
        }
        const shift = cursor - remaining.y;
        if (shift !== 0) {
          this.nodes
            .filter((node) => node.laneId === remaining.id)
            .forEach((node) => {
              node.y += shift;
            });
          remaining.y = cursor;
        }
        cursor = remaining.y + LANE_HEADER_HEIGHT + remaining.height + LANE_GAP;
      });

      // 堆叠下方原有的自由图元随移除泳道的高度上移（刚释放的图元位于被删泳道内部，不会误移）。
      if (previousBottom > 0) {
        this.nodes.forEach((node) => {
          if (!node.laneId && node.y >= previousBottom - 1) node.y -= removedFullSpan;
        });
      }

      if (this.selectedLaneId === id) this.selectedLaneId = null;
      this.activeNodeId = this.selectedIds.at(-1) ?? null;
      this.persistSoon();
    },

    // ---------- 视图 ----------

    setToolMode(mode: ToolMode) {
      this.toolMode = mode;
    },
    zoomBy(delta: number, origin?: { x: number; y: number }) {
      const nextZoom = Math.min(2.5, Math.max(0.25, this.zoom + delta));
      if (origin) {
        const worldX = (origin.x - this.pan.x) / this.zoom;
        const worldY = (origin.y - this.pan.y) / this.zoom;
        this.pan = {
          x: origin.x - worldX * nextZoom,
          y: origin.y - worldY * nextZoom,
        };
      }
      this.zoom = nextZoom;
    },
    setZoom(zoom: number) {
      this.zoom = Math.min(2.5, Math.max(0.25, zoom));
    },
    fitToView(viewportWidth: number, viewportHeight: number) {
      const layout = computeSwimLayout(this.swimlanes, this.nodes);
      const boxes: Array<{ x: number; y: number; right: number; bottom: number }> = [];
      if (layout.lanes.length) {
        layout.lanes.forEach((lane) => {
          boxes.push({ x: lane.x, y: lane.y, right: lane.x + lane.width, bottom: lane.y + lane.height });
        });
      }
      this.nodes.forEach((node) => {
        const placement = layout.nodes.get(node.id);
        if (placement && !placement.visible) return;
        boxes.push({
          x: node.x,
          y: placement?.y ?? node.y,
          right: node.x + node.width,
          bottom: (placement?.y ?? node.y) + node.height,
        });
      });
      if (!boxes.length) return;
      const minX = Math.min(...boxes.map((box) => box.x));
      const minY = Math.min(...boxes.map((box) => box.y));
      const maxX = Math.max(...boxes.map((box) => box.right));
      const maxY = Math.max(...boxes.map((box) => box.bottom));
      const width = Math.max(maxX - minX, 1);
      const height = Math.max(maxY - minY, 1);
      this.zoom = Math.min(1.4, Math.max(0.3, Math.min((viewportWidth - 100) / width, (viewportHeight - 100) / height)));
      this.pan = {
        x: (viewportWidth - width * this.zoom) / 2 - minX * this.zoom,
        y: (viewportHeight - height * this.zoom) / 2 - minY * this.zoom,
      };
    },
    importDocument(document: DiagramDocument) {
      this.checkpoint();
      this.restore(migrateDocument(document));
      this.persistSoon();
    },
    persistSoon() {
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot()));
      }, 180);
    },
  },
});

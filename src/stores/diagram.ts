import { defineStore } from 'pinia';
import type {
  DiagramConnector,
  DiagramDocument,
  DiagramNode,
  NodeKind,
  Swimlane,
  ToolMode,
} from '../types/diagram';
import { DEFAULT_NODE_SIZE } from '../utils/diagramGeometry';
import { deriveLanes, laneAtY, laneRects, makeLane, MIN_LANE_HEIGHT } from '../utils/laneGeometry';

const STORAGE_KEY = 'pair-wise-yy-07-diagram';
let persistTimer: number | undefined;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
      swimlaneId: null,
      zIndex: 1,
      fields: ['id  BIGINT PK', 'name  VARCHAR(80)', 'region  VARCHAR(20)', 'credit_limit DECIMAL'],
    },
    {
      id: 'table-orders',
      kind: 'table',
      x: 470,
      y: 90,
      width: 220,
      height: 190,
      text: 'orders',
      color: '#ffffff',
      locked: false,
      groupId: null,
      swimlaneId: null,
      zIndex: 2,
      fields: ['id  BIGINT PK', 'customer_id  BIGINT FK', 'amount  DECIMAL', 'status VARCHAR(20)'],
    },
    {
      id: 'node-review',
      kind: 'diamond',
      x: 470,
      y: 370,
      width: 180,
      height: 120,
      text: '风控审核通过？',
      color: '#fff7e8',
      locked: false,
      groupId: null,
      swimlaneId: null,
      zIndex: 3,
      fields: [],
    },
    {
      id: 'node-fulfill',
      kind: 'rectangle',
      x: 820,
      y: 385,
      width: 180,
      height: 76,
      text: '进入履约流程',
      color: '#eaf7f0',
      locked: false,
      groupId: null,
      swimlaneId: null,
      zIndex: 4,
      fields: [],
    },
    {
      id: 'node-close',
      kind: 'circle',
      x: 845,
      y: 130,
      width: 112,
      height: 112,
      text: '订单完成',
      color: '#eef4ff',
      locked: false,
      groupId: null,
      swimlaneId: null,
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
      fromAnchor: 'right',
      toAnchor: 'left',
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
      fromAnchor: 'top',
      toAnchor: 'bottom',
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

function loadDocument(): DiagramDocument | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const document = JSON.parse(raw) as DiagramDocument;
    return document.version === 1 && Array.isArray(document.nodes) ? document : null;
  } catch {
    return null;
  }
}

interface InitialState {
  title: string;
  nodes: DiagramNode[];
  connectors: DiagramConnector[];
  swimlanes: Swimlane[];
}

function buildInitialState(): InitialState {
  const saved = loadDocument();
  const baseNodes = saved?.nodes ?? initialNodes();
  const baseConnectors = saved?.connectors ?? initialConnectors();
  if (saved && Array.isArray(saved.swimlanes) && saved.swimlanes.length) {
    return {
      title: saved.title,
      nodes: baseNodes.map((node) => ({ ...node, swimlaneId: node.swimlaneId ?? null })),
      connectors: baseConnectors,
      swimlanes: saved.swimlanes,
    };
  }
  // 旧数据兼容：没有泳道信息时按纵向聚类派生泳道，分过组的图元归到同一条泳道。
  const { lanes, assignments } = deriveLanes(baseNodes);
  return {
    title: saved?.title ?? '订单履约架构图',
    nodes: baseNodes.map((node) => ({ ...node, swimlaneId: assignments.get(node.id) ?? null })),
    connectors: baseConnectors,
    swimlanes: lanes,
  };
}

const initialState = buildInitialState();

export const useDiagramStore = defineStore('diagram', {
  state: () => ({
    title: initialState.title,
    nodes: initialState.nodes,
    connectors: initialState.connectors,
    swimlanes: initialState.swimlanes,
    selectedIds: [] as string[],
    selectedConnectorId: null as string | null,
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
      this.title = document.title;
      this.nodes = clonePlain(document.nodes).map((node) => ({ ...node, swimlaneId: node.swimlaneId ?? null }));
      this.connectors = clonePlain(document.connectors);
      this.swimlanes = Array.isArray(document.swimlanes) ? clonePlain(document.swimlanes) : [];
      this.selectedIds = this.selectedIds.filter((id) => this.nodes.some((node) => node.id === id));
      this.selectedConnectorId = null;
      this.activeNodeId = this.selectedIds.at(-1) ?? null;
    },
    addNode(kind: NodeKind, position?: { x: number; y: number }) {
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
        swimlaneId: null,
        zIndex: Math.max(0, ...this.nodes.map((item) => item.zIndex)) + 1,
        fields: kind === 'table' ? ['id  BIGINT PK', 'name  VARCHAR(80)'] : [],
      };
      const lane = laneAtY(this.swimlanes, point.y + size.height / 2);
      node.swimlaneId = lane?.lane.id ?? this.swimlanes[0]?.id ?? null;
      this.nodes.push(node);
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
    selectNode(id: string, append = false) {
      this.selectedConnectorId = null;
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
    },
    clearSelection() {
      this.selectedIds = [];
      this.selectedConnectorId = null;
      this.activeNodeId = null;
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
    addLane() {
      this.checkpoint();
      const lane = makeLane(`泳道 ${this.swimlanes.length + 1}`, this.swimlanes.length);
      this.swimlanes.push(lane);
      this.persistSoon();
    },
    removeLane(id: string) {
      this.checkpoint();
      this.swimlanes = this.swimlanes.filter((lane) => lane.id !== id);
      this.nodes.forEach((node) => {
        if (node.swimlaneId === id) node.swimlaneId = null;
      });
      this.persistSoon();
    },
    renameLane(id: string, name: string) {
      const lane = this.swimlanes.find((item) => item.id === id);
      if (!lane) return;
      const trimmed = name.trim();
      if (trimmed && trimmed !== lane.name) {
        this.checkpoint();
        lane.name = trimmed;
        this.persistSoon();
      }
    },
    toggleLaneCollapse(id: string) {
      this.checkpoint();
      const lane = this.swimlanes.find((item) => item.id === id);
      if (lane) lane.collapsed = !lane.collapsed;
      this.persistSoon();
    },
    /** 把泳道移动到 toIndex，图元跟着泳道走。 */
    reorderLane(id: string, toIndex: number) {
      const fromIndex = this.swimlanes.findIndex((lane) => lane.id === id);
      if (fromIndex < 0 || toIndex < 0 || toIndex >= this.swimlanes.length) return;
      this.checkpoint();
      const oldY = new Map(laneRects(this.swimlanes).map((rect) => [rect.lane.id, rect.y]));
      const next = [...this.swimlanes];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      laneRects(next).forEach((rect) => {
        const previousY = oldY.get(rect.lane.id);
        if (previousY === undefined) return;
        const dy = rect.y - previousY;
        if (Math.abs(dy) > 0.5) {
          this.nodes.forEach((node) => {
            if (node.swimlaneId === rect.lane.id) node.y += dy;
          });
        }
      });
      this.swimlanes = next;
      this.persistSoon();
    },
    /** 调整泳道高度，下方泳道整体平移，图元跟着泳道走。 */
    resizeLane(id: string, height: number) {
      const rects = laneRects(this.swimlanes);
      const index = rects.findIndex((rect) => rect.lane.id === id);
      if (index < 0) return;
      const lane = this.swimlanes[index];
      const contentBottom = Math.max(
        ...this.nodes.filter((node) => node.swimlaneId === id).map((node) => node.y + node.height),
        -Infinity,
      );
      const minHeight = Math.max(MIN_LANE_HEIGHT, contentBottom - rects[index].y + 24);
      const clamped = Math.max(minHeight, Math.round(height));
      if (Math.abs(clamped - lane.height) < 0.5) return;
      this.checkpoint();
      const delta = clamped - lane.height;
      lane.height = clamped;
      if (Math.abs(delta) > 0.5) {
        const below = new Set(this.swimlanes.slice(index + 1).map((item) => item.id));
        this.nodes.forEach((node) => {
          if (node.swimlaneId && below.has(node.swimlaneId)) node.y += delta;
        });
      }
      this.persistSoon();
    },
    assignNodesToLane(nodeIds: string[], laneId: string | null) {
      if (!nodeIds.length) return;
      this.checkpoint();
      nodeIds.forEach((id) => {
        const node = this.nodes.find((item) => item.id === id);
        if (node) node.swimlaneId = laneId;
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
      if (!this.nodes.length) return;
      const minX = Math.min(...this.nodes.map((node) => node.x));
      const minY = Math.min(...this.nodes.map((node) => node.y));
      const maxX = Math.max(...this.nodes.map((node) => node.x + node.width));
      const maxY = Math.max(...this.nodes.map((node) => node.y + node.height));
      const width = maxX - minX;
      const height = maxY - minY;
      this.zoom = Math.min(1.4, Math.max(0.3, Math.min((viewportWidth - 100) / width, (viewportHeight - 100) / height)));
      this.pan = {
        x: (viewportWidth - width * this.zoom) / 2 - minX * this.zoom,
        y: (viewportHeight - height * this.zoom) / 2 - minY * this.zoom,
      };
    },
    importDocument(document: DiagramDocument) {
      this.checkpoint();
      this.restore(document);
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

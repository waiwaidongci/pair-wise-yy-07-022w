<script setup lang="ts">
import Konva from 'konva';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useDiagramStore } from '../stores/diagram';
import type {
  AnchorPoint,
  AnchorSide,
  DiagramConnector,
  DiagramNode,
  NodeKind,
  Point,
  Swimlane,
} from '../types/diagram';
import {
  anchorPoint,
  calculateAlignmentGuides,
  nodeCenter,
  routeConnector,
} from '../utils/diagramGeometry';
import {
  COLLAPSED_LANE_HEIGHT,
  LANE_COLORS,
  LANE_HEADER_HEIGHT,
  isNodeInCollapsedLane,
  laneAtY,
  laneById,
  laneColor,
  laneRects,
  laneSpan,
  pathCrossesLane,
} from '../utils/laneGeometry';
import MiniMap from './MiniMap.vue';

const store = useDiagramStore();
const containerRef = ref<HTMLDivElement | null>(null);
const stageHostRef = ref<HTMLDivElement | null>(null);
const stageRef = shallowRef<Konva.Stage | null>(null);
const contentLayerRef = shallowRef<Konva.Layer | null>(null);
const guideLayerRef = shallowRef<Konva.Layer | null>(null);
const viewport = ref({ width: 900, height: 650 });
const isPanning = ref(false);
const tempConnection = ref<{ start: AnchorPoint; fromId: string } | null>(null);
let panStart = { x: 0, y: 0, panX: 0, panY: 0 };
let resizeObserver: ResizeObserver | null = null;
let dragState:
  | {
      ids: string[];
      primaryId: string;
      startPositions: Record<string, Point>;
      moved: boolean;
    }
  | null = null;
let laneDrag:
  | {
      id: string;
      startPointerY: number;
      startBandY: number;
      nodeIds: string[];
      startNodePositions: Record<string, Point>;
    }
  | null = null;
let laneResize:
  | {
      id: string;
      startPointerY: number;
      startHeight: number;
      belowIds: string[];
      startBelowPositions: Record<string, Point>;
    }
  | null = null;

const zoomPercent = computed(() => `${Math.round(store.zoom * 100)}%`);

function initializeStage() {
  const host = stageHostRef.value;
  const container = containerRef.value;
  if (!host || !container) return;
  const rect = container.getBoundingClientRect();
  viewport.value = { width: rect.width, height: rect.height };
  const stage = new Konva.Stage({
    container: host,
    width: rect.width,
    height: rect.height,
  });
  const contentLayer = new Konva.Layer();
  const guideLayer = new Konva.Layer({ listening: false });
  stage.add(contentLayer);
  stage.add(guideLayer);
  stageRef.value = stage;
  contentLayerRef.value = contentLayer;
  guideLayerRef.value = guideLayer;

  stage.on('wheel', (event) => {
    event.evt.preventDefault();
    const pointer = stage.getPointerPosition();
    const direction = event.evt.deltaY > 0 ? -0.08 : 0.08;
    store.zoomBy(direction, pointer ?? undefined);
    applyViewport();
  });
  stage.on('mousedown', (event) => {
    if (event.target !== stage) return;
    isPanning.value = true;
    const pointer = stage.getPointerPosition() ?? { x: 0, y: 0 };
    panStart = {
      x: pointer.x,
      y: pointer.y,
      panX: store.pan.x,
      panY: store.pan.y,
    };
    if (event.evt.button === 0) store.clearSelection();
  });
  stage.on('mousemove', () => {
    if (!isPanning.value) return;
    const pointer = stage.getPointerPosition() ?? { x: 0, y: 0 };
    store.pan = {
      x: panStart.panX + pointer.x - panStart.x,
      y: panStart.panY + pointer.y - panStart.y,
    };
    applyViewport();
  });
  stage.on('mouseup', () => {
    isPanning.value = false;
  });
  stage.on('mouseleave', () => {
    isPanning.value = false;
  });
  renderDiagram();
}

function applyViewport() {
  const stage = stageRef.value;
  if (!stage) return;
  stage.scale({ x: store.zoom, y: store.zoom });
  stage.position(store.pan);
  stage.batchDraw();
}

function renderDiagram() {
  const layer = contentLayerRef.value;
  if (!layer) return;
  layer.destroyChildren();
  renderGrid(layer);
  renderLanes(layer);
  const connectorNodes = [...store.connectors].sort((a, b) => a.zIndex - b.zIndex);
  connectorNodes.forEach((connector) => {
    if (isConnectorHidden(connector)) return;
    layer.add(createConnectorNode(connector));
  });
  const diagramNodes = [...store.nodes].sort((a, b) => a.zIndex - b.zIndex);
  diagramNodes.forEach((node) => {
    if (isNodeInCollapsedLane(node, store.swimlanes)) return;
    layer.add(createDiagramNode(node));
  });
  applyViewport();
  layer.batchDraw();
}

function renderLanes(layer: Konva.Layer) {
  const rects = laneRects(store.swimlanes);
  const span = laneSpan(store.nodes);
  rects.forEach((rect) => layer.add(createLaneGroup(rect, span)));
}

function isConnectorHidden(connector: DiagramConnector): boolean {
  const from = store.nodes.find((node) => node.id === connector.fromId);
  const to = store.nodes.find((node) => node.id === connector.toId);
  if (!from || !to) return true;
  if (isNodeInCollapsedLane(from, store.swimlanes) || isNodeInCollapsedLane(to, store.swimlanes)) {
    return true;
  }
  const points = routeConnector(connector, store.nodes, store.swimlanes);
  if (!points.length) return true;
  const span = laneSpan(store.nodes);
  return laneRects(store.swimlanes).some(
    (rect) => rect.collapsed && pathCrossesLane(points, rect, span),
  );
}

function renderGrid(layer: Konva.Layer) {
  const zoom = store.zoom;
  const step = store.gridSize * (zoom < 0.55 ? 4 : zoom < 0.85 ? 2 : 1);
  const left = -store.pan.x / zoom;
  const top = -store.pan.y / zoom;
  const right = left + viewport.value.width / zoom;
  const bottom = top + viewport.value.height / zoom;
  const gridGroup = new Konva.Group({ listening: false });
  for (let x = Math.floor(left / step) * step; x < right + step; x += step) {
    gridGroup.add(
      new Konva.Line({
        points: [x, top, x, bottom],
        stroke: x % (step * 5) === 0 ? '#d8e2ef' : '#eef2f7',
        strokeWidth: x % (step * 5) === 0 ? 1 : 0.7,
      }),
    );
  }
  for (let y = Math.floor(top / step) * step; y < bottom + step; y += step) {
    gridGroup.add(
      new Konva.Line({
        points: [left, y, right, y],
        stroke: y % (step * 5) === 0 ? '#d8e2ef' : '#eef2f7',
        strokeWidth: y % (step * 5) === 0 ? 1 : 0.7,
      }),
    );
  }
  layer.add(gridGroup);
}

function createLaneGroup(
  rect: ReturnType<typeof laneRects>[number],
  span: { x0: number; x1: number },
): Konva.Group {
  const colors = laneColor(rect.index);
  const group = new Konva.Group({
    id: `lane-${rect.lane.id}`,
    name: 'swimlane',
    x: 0,
    y: rect.y,
  });
  const width = span.x1 - span.x0;

  group.add(
    new Konva.Rect({
      name: 'lane-body',
      x: span.x0,
      y: 0,
      width,
      height: rect.visualHeight,
      fill: colors.fill,
      stroke: colors.stroke,
      strokeWidth: 1,
      listening: false,
    }),
  );
  group.add(
    new Konva.Rect({
      name: 'lane-header',
      x: span.x0,
      y: 0,
      width,
      height: LANE_HEADER_HEIGHT,
      fill: colors.header,
      stroke: colors.stroke,
      strokeWidth: 1,
      draggable: true,
    }),
  );
  group.add(
    new Konva.Text({
      x: span.x0 + 10,
      y: 8,
      text: rect.collapsed ? '▶' : '▼',
      fill: colors.text,
      fontSize: 12,
      listening: false,
    }),
  );
  const nameText = new Konva.Text({
    x: span.x0 + 32,
    y: 8,
    text: rect.lane.name,
    fill: colors.text,
    fontSize: 13,
    fontStyle: 'bold',
    listening: false,
  });
  group.add(nameText);
  const nodeCount = store.nodes.filter((node) => node.swimlaneId === rect.lane.id).length;
  group.add(
    new Konva.Text({
      x: span.x0 + 32 + Math.max(80, nameText.width() + 16),
      y: 9,
      text: `${nodeCount} 个图元`,
      fill: colors.text,
      opacity: 0.7,
      fontSize: 10,
      listening: false,
    }),
  );
  const deleteText = new Konva.Text({
    x: span.x1 - 28,
    y: 7,
    text: '×',
    fill: colors.text,
    fontSize: 16,
    listening: true,
  });
  deleteText.on('click tap', (event) => {
    event.cancelBubble = true;
    store.removeLane(rect.lane.id);
  });
  deleteText.on('mouseenter', () => {
    stageRef.value?.container().style.setProperty('cursor', 'pointer');
  });
  deleteText.on('mouseleave', () => {
    stageRef.value?.container().style.setProperty('cursor', 'default');
  });
  group.add(deleteText);

  const collapseHit = new Konva.Rect({
    x: span.x0,
    y: 0,
    width: 28,
    height: LANE_HEADER_HEIGHT,
    fill: 'transparent',
    listening: true,
  });
  collapseHit.on('click tap', (event) => {
    event.cancelBubble = true;
    store.toggleLaneCollapse(rect.lane.id);
  });
  group.add(collapseHit);

  nameText.on('dblclick dbltap', (event) => {
    event.cancelBubble = true;
    promptLaneName(rect.lane);
  });

  if (!rect.collapsed) {
    const handle = new Konva.Rect({
      name: 'lane-resize',
      x: span.x0,
      y: rect.visualHeight - 5,
      width,
      height: 10,
      fill: 'transparent',
      draggable: true,
    });
    handle.on('mouseenter', () => {
      stageRef.value?.container().style.setProperty('cursor', 'ns-resize');
    });
    handle.on('mouseleave', () => {
      stageRef.value?.container().style.setProperty('cursor', 'default');
    });
    handle.on('dragstart', (event) => {
      event.cancelBubble = true;
      laneResize = {
        id: rect.lane.id,
        startPointerY: pointerToWorld().y,
        startHeight: rect.lane.height,
        belowIds: laneRects(store.swimlanes)
          .slice(rect.index + 1)
          .map((item) => item.lane.id),
        startBelowPositions: Object.fromEntries(
          store.nodes
            .filter((node) => node.swimlaneId && laneRects(store.swimlanes).slice(rect.index + 1).some((item) => item.lane.id === node.swimlaneId))
            .map((node) => [node.id, { x: node.x, y: node.y }]),
        ),
      };
    });
    handle.on('dragmove', () => {
      if (!laneResize) return;
      const pointerY = pointerToWorld().y;
      const desired = laneResize.startHeight + (pointerY - laneResize.startPointerY);
      const contentBottom = Math.max(
        ...store.nodes
          .filter((node) => node.swimlaneId === laneResize?.id)
          .map((node) => node.y + node.height),
        -Infinity,
      );
      const currentRect = laneById(store.swimlanes, laneResize.id);
      const minHeight = currentRect
        ? Math.max(120, contentBottom - currentRect.y + 24)
        : 120;
      const nextHeight = Math.max(minHeight, desired);
      const delta = nextHeight - laneResize.startHeight;
      const body = group.findOne('.lane-body') as Konva.Rect | undefined;
      body?.height(nextHeight);
      const resizeHandle = group.findOne('.lane-resize') as Konva.Rect | undefined;
      resizeHandle?.y(nextHeight - 5);
      laneRects(store.swimlanes).forEach((item) => {
        if (item.index <= rect.index) return;
        const belowGroup = contentLayerRef.value?.findOne(`#lane-${item.lane.id}`) as Konva.Group | undefined;
        belowGroup?.y(item.y + delta);
      });
      const previewNodes = store.nodes.map((node) => {
        const start = laneResize?.startBelowPositions[node.id];
        if (start && node.swimlaneId && laneRects(store.swimlanes).slice(rect.index + 1).some((item) => item.lane.id === node.swimlaneId)) {
          return { ...node, y: start.y + delta };
        }
        return node;
      });
      refreshConnectorRoutes(new Set(laneResize.belowIds.flatMap((id) => store.nodes.filter((n) => n.swimlaneId === id).map((n) => n.id))), previewNodes);
    });
    handle.on('dragend', () => {
      if (!laneResize) return;
      const pointerY = pointerToWorld().y;
      const desired = laneResize.startHeight + (pointerY - laneResize.startPointerY);
      store.resizeLane(laneResize.id, desired);
      laneResize = null;
      void nextTick(renderDiagram);
    });
    group.add(handle);
  }

  const header = group.findOne('.lane-header') as Konva.Rect | undefined;
  header?.on('dragstart', (event) => {
    event.cancelBubble = true;
    laneDrag = {
      id: rect.lane.id,
      startPointerY: pointerToWorld().y,
      startBandY: rect.y,
      nodeIds: store.nodes.filter((node) => node.swimlaneId === rect.lane.id).map((node) => node.id),
      startNodePositions: Object.fromEntries(
        store.nodes
          .filter((node) => node.swimlaneId === rect.lane.id)
          .map((node) => [node.id, { x: node.x, y: node.y }]),
      ),
    };
  });
  header?.on('dragmove', () => {
    if (!laneDrag) return;
    const pointerY = pointerToWorld().y;
    const dy = pointerY - laneDrag.startPointerY;
    group.y(laneDrag.startBandY + dy);
    laneDrag.nodeIds.forEach((id) => {
      const start = laneDrag?.startNodePositions[id];
      if (!start) return;
      const child = contentLayerRef.value?.findOne(`#${id}`) as Konva.Group | undefined;
      child?.position({ x: start.x, y: start.y + dy });
    });
    const previewNodes = store.nodes.map((node) => {
      const start = laneDrag?.startNodePositions[node.id];
      return start ? { ...node, y: start.y + dy } : node;
    });
    refreshConnectorRoutes(new Set(laneDrag.nodeIds), previewNodes);
    drawReorderIndicator(pointerY, laneDrag.id);
  });
  header?.on('dragend', () => {
    if (!laneDrag) return;
    const pointerY = pointerToWorld().y;
    const toIndex = dropIndexForPointer(pointerY, laneDrag.id);
    store.reorderLane(laneDrag.id, toIndex);
    laneDrag = null;
    clearReorderIndicator();
    void nextTick(renderDiagram);
  });

  return group;
}

function dropIndexForPointer(pointerY: number, draggedId: string): number {
  const rects = laneRects(store.swimlanes).filter((rect) => rect.lane.id !== draggedId);
  let index = rects.length;
  for (let i = 0; i < rects.length; i += 1) {
    if (pointerY < rects[i].y + rects[i].visualHeight / 2) {
      index = i;
      break;
    }
  }
  return index;
}

function drawReorderIndicator(pointerY: number, draggedId: string) {
  const layer = guideLayerRef.value;
  if (!layer) return;
  clearReorderIndicator();
  const rects = laneRects(store.swimlanes).filter((rect) => rect.lane.id !== draggedId);
  const span = laneSpan(store.nodes);
  let boundaryY = rects.length ? rects[rects.length - 1].bottom : 0;
  for (let i = 0; i < rects.length; i += 1) {
    if (pointerY < rects[i].y + rects[i].visualHeight / 2) {
      boundaryY = rects[i].y;
      break;
    }
  }
  layer.add(
    new Konva.Line({
      name: 'lane-reorder-indicator',
      points: [span.x0, boundaryY, span.x1, boundaryY],
      stroke: '#1769ff',
      strokeWidth: 2,
      dash: [8, 5],
      listening: false,
    }),
  );
  layer.batchDraw();
}

function clearReorderIndicator() {
  const layer = guideLayerRef.value;
  if (!layer) return;
  layer.find('.lane-reorder-indicator').forEach((node) => node.destroy());
  layer.batchDraw();
}

function promptLaneName(lane: Swimlane) {
  // 延迟引入避免循环依赖。
  import('element-plus').then(async ({ ElMessageBox }) => {
    try {
      const { value } = await ElMessageBox.prompt('泳道名称', '重命名泳道', {
        inputValue: lane.name,
        confirmButtonText: '确定',
        cancelButtonText: '取消',
      });
      store.renameLane(lane.id, value);
    } catch {
      // 用户取消。
    }
  });
}

function laneNodeCount(laneId: string): number {
  return store.nodes.filter((node) => node.swimlaneId === laneId).length;
}

let draggingLaneId: string | null = null;

function onLaneRowDragstart(event: DragEvent, laneId: string) {
  draggingLaneId = laneId;
  event.dataTransfer?.setData('text/x-lane-id', laneId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onLaneRowDragover(event: DragEvent, index: number) {
  if (!draggingLaneId) return;
  event.dataTransfer && (event.dataTransfer.dropEffect = 'move');
}

function onLaneRowDrop(event: DragEvent, index: number) {
  const laneId = event.dataTransfer?.getData('text/x-lane-id') || draggingLaneId;
  draggingLaneId = null;
  if (!laneId) return;
  const rect = event.currentTarget as HTMLElement;
  const after = event.offsetY > rect.clientHeight / 2;
  const toIndex = after ? index + 1 : index;
  store.reorderLane(laneId, Math.min(toIndex, store.swimlanes.length - 1));
}

function removeLane(laneId: string) {
  import('element-plus').then(async ({ ElMessageBox }) => {
    try {
      await ElMessageBox.confirm('删除该泳道？泳道内图元会移出泳道，位置保留。', '删除泳道', {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      });
      store.removeLane(laneId);
    } catch {
      // 用户取消。
    }
  });
}

function createDiagramNode(node: DiagramNode): Konva.Group {
  const group = new Konva.Group({
    id: node.id,
    name: 'diagram-node',
    x: node.x,
    y: node.y,
    draggable: !node.locked && store.toolMode === 'select',
  });
  const selected = store.selectedIds.includes(node.id);
  const isMultiSelected = selected && store.selectedIds.length > 1;
  const stroke = node.locked ? '#8b95a5' : selected ? '#1769ff' : '#9aabbf';

  if (node.kind === 'rectangle') {
    group.add(
      new Konva.Rect({
        width: node.width,
        height: node.height,
        fill: node.color,
        stroke,
        strokeWidth: selected ? 2.5 : 1.4,
        cornerRadius: 8,
        shadowColor: '#101828',
        shadowOpacity: selected ? 0.15 : 0.06,
        shadowBlur: selected ? 12 : 6,
        shadowOffsetY: 3,
      }),
    );
    group.add(createCenteredText(node.text, node.width, node.height));
  } else if (node.kind === 'circle') {
    group.add(
      new Konva.Circle({
        x: node.width / 2,
        y: node.height / 2,
        radius: Math.min(node.width, node.height) / 2,
        fill: node.color,
        stroke,
        strokeWidth: selected ? 2.5 : 1.4,
        shadowColor: '#101828',
        shadowOpacity: 0.08,
        shadowBlur: 8,
      }),
    );
    group.add(createCenteredText(node.text, node.width, node.height));
  } else if (node.kind === 'diamond') {
    group.add(
      new Konva.Line({
        points: [
          node.width / 2,
          0,
          node.width,
          node.height / 2,
          node.width / 2,
          node.height,
          0,
          node.height / 2,
        ],
        closed: true,
        fill: node.color,
        stroke,
        strokeWidth: selected ? 2.5 : 1.4,
        shadowColor: '#101828',
        shadowOpacity: 0.08,
        shadowBlur: 8,
      }),
    );
    group.add(createCenteredText(node.text, node.width, node.height, node.width * 0.62));
  } else {
    group.add(
      new Konva.Rect({
        width: node.width,
        height: node.height,
        fill: '#ffffff',
        stroke,
        strokeWidth: selected ? 2.5 : 1.4,
        cornerRadius: 7,
        shadowColor: '#101828',
        shadowOpacity: 0.08,
        shadowBlur: 8,
        shadowOffsetY: 3,
      }),
    );
    group.add(
      new Konva.Rect({
        width: node.width,
        height: 39,
        fill: '#eaf1ff',
        cornerRadius: [7, 7, 0, 0],
      }),
    );
    group.add(
      new Konva.Text({
        x: 13,
        y: 11,
        width: node.width - 26,
        text: node.text,
        fill: '#17335f',
        fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
        fontSize: 14,
        fontStyle: 'bold',
        ellipsis: true,
        wrap: 'none',
      }),
    );
    node.fields.forEach((field, index) => {
      const y = 48 + index * 34;
      if (y + 26 > node.height) return;
      group.add(
        new Konva.Line({
          points: [0, y + 27, node.width, y + 27],
          stroke: '#edf0f5',
          strokeWidth: 1,
        }),
      );
      group.add(
        new Konva.Text({
          x: 12,
          y,
          width: node.width - 24,
          text: field,
          fill: '#475467',
          fontFamily: 'SFMono-Regular, Menlo, monospace',
          fontSize: 11,
          ellipsis: true,
          wrap: 'none',
        }),
      );
    });
  }

  if (node.locked) {
    group.add(
      new Konva.Text({
        x: node.width - 24,
        y: 9,
        text: 'L',
        fill: '#667085',
        fontFamily: 'Menlo, monospace',
        fontSize: 11,
        fontStyle: 'bold',
      }),
    );
  }

  group.on('click tap', (event) => {
    event.cancelBubble = true;
    store.selectNode(node.id, event.evt.shiftKey);
  });
  group.on('dragstart', (event) => {
    if (node.locked) return;
    event.cancelBubble = true;
    if (!store.selectedIds.includes(node.id)) store.selectNode(node.id);
    const groupIds = new Set(store.selectedIds);
    if (node.groupId) {
      store.nodes.filter((item) => item.groupId === node.groupId).forEach((item) => groupIds.add(item.id));
    }
    const ids = [...groupIds];
    store.checkpoint();
    dragState = {
      ids,
      primaryId: node.id,
      startPositions: Object.fromEntries(
        store.nodes
          .filter((item) => ids.includes(item.id))
          .map((item) => [item.id, { x: item.x, y: item.y }]),
      ),
      moved: false,
    };
  });
  group.on('dragmove', (dragEvent) => {
    if (!dragState) return;
    const start = dragState.startPositions[dragState.primaryId];
    if (!start) return;
    let deltaX = group.x() - start.x;
    let deltaY = group.y() - start.y;
    const movingNodes = store.nodes.filter((item) => dragState?.ids.includes(item.id));
    if (store.snapToGrid && !(dragEvent.evt as MouseEvent).shiftKey) {
      const anchor = movingNodes.find((item) => item.id === dragState?.primaryId);
      if (anchor) {
        const snappedX = Math.round((start.x + deltaX) / store.gridSize) * store.gridSize;
        const snappedY = Math.round((start.y + deltaY) / store.gridSize) * store.gridSize;
        deltaX = snappedX - start.x;
        deltaY = snappedY - start.y;
      }
    }
    movingNodes.forEach((item) => {
      const position = dragState?.startPositions[item.id];
      if (!position) return;
      const nextX = position.x + deltaX;
      const nextY = position.y + deltaY;
      const child = group.getStage()?.findOne(`#${item.id}`) as Konva.Group | undefined;
      if (child) child.position({ x: nextX, y: nextY });
    });
    const previewNodes = store.nodes.map((item) => {
      const position = dragState?.startPositions[item.id];
      return position
        ? { ...item, x: position.x + deltaX, y: position.y + deltaY }
        : item;
    });
    const active = previewNodes.filter((item) => dragState?.ids.includes(item.id));
    renderGuides(calculateAlignmentGuides(active, previewNodes, 7 / store.zoom, store.swimlanes));
    refreshConnectorRoutes(new Set(dragState?.ids ?? []), previewNodes);
    dragState.moved = Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5;
  });
  group.on('dragend', () => {
    if (!dragState) return;
    const start = dragState.startPositions[dragState.primaryId];
    const current = group.position();
    const deltaX = current.x - start.x;
    const deltaY = current.y - start.y;
    const positions = Object.fromEntries(
      Object.entries(dragState.startPositions).map(([id, point]) => [
        id,
        { x: point.x + deltaX, y: point.y + deltaY },
      ]),
    );
    store.commitPositions(positions);
    const primary = store.nodes.find((item) => item.id === dragState?.primaryId);
    if (primary) {
      const target = laneAtY(store.swimlanes, primary.y + primary.height / 2);
      const targetId = target && !target.collapsed ? target.lane.id : primary.swimlaneId;
      const changed = dragState.ids.filter((id) => {
        const node = store.nodes.find((item) => item.id === id);
        return node && node.swimlaneId !== targetId;
      });
      if (changed.length) store.assignNodesToLane(changed, targetId);
    }
    dragState = null;
    clearGuides();
    void nextTick(renderDiagram);
  });

  if (isMultiSelected) {
    group.add(
      new Konva.Rect({
        x: -5,
        y: -5,
        width: node.width + 10,
        height: node.height + 10,
        stroke: '#84adff',
        strokeWidth: 1,
        dash: [5, 4],
        listening: false,
      }),
    );
  }
  if (selected && !node.locked && store.toolMode === 'connect') {
    (['top', 'right', 'bottom', 'left'] as AnchorSide[]).forEach((side) => {
      const point = localAnchorPoint(node, side);
      const anchor = new Konva.Circle({
        x: point.x,
        y: point.y,
        radius: 6 / store.zoom,
        fill: '#ffffff',
        stroke: '#1769ff',
        strokeWidth: 2 / store.zoom,
        draggable: true,
        name: 'connect-anchor',
      });
      anchor.on('dragstart', (event) => {
        event.cancelBubble = true;
        tempConnection.value = { start: anchorPoint(node, side), fromId: node.id };
        const line = new Konva.Line({
          name: 'temp-connection',
          points: [tempConnection.value.start.x, tempConnection.value.start.y],
          stroke: '#1769ff',
          strokeWidth: 2 / store.zoom,
          dash: [8 / store.zoom, 5 / store.zoom],
          listening: false,
        });
        guideLayerRef.value?.add(line);
      });
      anchor.on('dragmove', () => {
        if (!tempConnection.value) return;
        const pointer = pointerToWorld();
        const stage = stageRef.value;
        const target = stage
          ? store.nodes.find((item) => item.id !== node.id && pointInNode(pointer, item))
          : undefined;
        const line = guideLayerRef.value?.findOne('.temp-connection') as Konva.Line | undefined;
        line?.points([
          tempConnection.value.start.x,
          tempConnection.value.start.y,
          pointer.x,
          pointer.y,
        ]);
        line?.stroke(target ? '#12805c' : '#1769ff');
        guideLayerRef.value?.batchDraw();
      });
      anchor.on('dragend', () => {
        const pointer = pointerToWorld();
        const target = store.nodes.find((item) => item.id !== node.id && pointInNode(pointer, item));
        if (target) {
          const sideToTarget = nearestSide(pointer, target);
          store.addConnector(node.id, target.id, side, sideToTarget);
        }
        guideLayerRef.value?.findOne('.temp-connection')?.destroy();
        guideLayerRef.value?.batchDraw();
        tempConnection.value = null;
        void nextTick(renderDiagram);
      });
      group.add(anchor);
    });
  }

  return group;
}

function createCenteredText(text: string, width: number, height: number, maxWidth?: number) {
  return new Konva.Text({
    x: 10,
    y: height / 2 - 23,
    width: width - 20,
    height: 46,
    text,
    align: 'center',
    verticalAlign: 'middle',
    fill: '#24344d',
    fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
    fontSize: 14,
    fontStyle: 'bold',
    wrap: 'word',
    ellipsis: true,
    ...(maxWidth ? { width: maxWidth, x: (width - maxWidth) / 2 } : {}),
  });
}

function createConnectorNode(connector: DiagramConnector): Konva.Group {
  const points = routeConnector(connector, store.nodes, store.swimlanes);
  const selected = store.selectedConnectorId === connector.id;
  const group = new Konva.Group({ id: `connector-${connector.id}`, listening: true });
  const arrow = new Konva.Arrow({
    points,
    stroke: selected ? '#1769ff' : connector.color,
    fill: selected ? '#1769ff' : connector.color,
    strokeWidth: selected ? 2.8 : 1.8,
    dash: connector.dashed ? [9, 6] : undefined,
    pointerLength: 10,
    pointerWidth: 9,
    lineJoin: 'round',
    lineCap: 'round',
    hitStrokeWidth: 16,
  });
  group.add(arrow);
  if (connector.label && points.length >= 4) {
    const middle = points.length === 4
      ? { x: points[0], y: points[1] }
      : { x: points[points.length - 2], y: points[points.length - 1] };
    group.add(
      new Konva.Text({
        x: middle.x + 6,
        y: middle.y - 20,
        text: connector.label,
        fill: connector.color,
        fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
        fontSize: 11,
        fontStyle: 'bold',
        padding: 3,
      }),
    );
  }
  group.on('click tap', (event) => {
    event.cancelBubble = true;
    store.selectConnector(connector.id);
  });
  group.on('mouseenter', () => {
    stageRef.value?.container().style.setProperty('cursor', 'pointer');
  });
  group.on('mouseleave', () => {
    stageRef.value?.container().style.setProperty('cursor', 'default');
  });
  return group;
}

/** 只重算受影响（端点图元移动）的连线路径，其余连线保持原样。 */
function refreshConnectorRoutes(affectedNodeIds?: Set<string>, previewNodes?: DiagramNode[]) {
  const layer = contentLayerRef.value;
  if (!layer) return;
  const nodes = previewNodes ?? store.nodes;
  store.connectors.forEach((connector) => {
    if (affectedNodeIds) {
      const from = nodes.find((node) => node.id === connector.fromId);
      const to = nodes.find((node) => node.id === connector.toId);
      if (!from || !to) return;
      if (!affectedNodeIds.has(from.id) && !affectedNodeIds.has(to.id)) return;
    }
    if (isConnectorHidden(connector)) return;
    const group = layer.findOne(`#connector-${connector.id}`) as Konva.Group | undefined;
    if (!group) return;
    const arrow = group.findOne('Arrow') as Konva.Arrow | undefined;
    if (!arrow) return;
    const points = routeConnector(connector, nodes, store.swimlanes);
    if (!points.length) return;
    arrow.points(points);
    const label = group.findOne('Text') as Konva.Text | undefined;
    if (label && connector.label) {
      const middle = points.length === 4
        ? { x: points[0], y: points[1] }
        : { x: points[points.length - 2], y: points[points.length - 1] };
      label.position({ x: middle.x + 6, y: middle.y - 20 });
    }
  });
  layer.batchDraw();
}

function renderGuides(guides: ReturnType<typeof calculateAlignmentGuides>) {
  const layer = guideLayerRef.value;
  if (!layer) return;
  layer.find('.alignment-guide').forEach((node) => node.destroy());
  guides.forEach((guide) => {
    const points =
      guide.orientation === 'vertical'
        ? [guide.position, guide.start, guide.position, guide.end]
        : [guide.start, guide.position, guide.end, guide.position];
    layer.add(
      new Konva.Line({
        name: 'alignment-guide',
        points,
        stroke: '#f79009',
        strokeWidth: 1 / store.zoom,
        dash: [6 / store.zoom, 4 / store.zoom],
        listening: false,
      }),
    );
    const labelX = guide.orientation === 'vertical' ? guide.position + 8 : (guide.start + guide.end) / 2;
    const labelY = guide.orientation === 'vertical' ? (guide.start + guide.end) / 2 : guide.position + 8;
    layer.add(
      new Konva.Label({
        name: 'alignment-guide',
        x: labelX,
        y: labelY,
        listening: false,
        opacity: 0.96,
      })
        .add(
          new Konva.Tag({
            fill: '#b54708',
            cornerRadius: 3,
            pointerDirection: 'down',
            pointerWidth: 5,
            pointerHeight: 5,
          }),
        )
        .add(
          new Konva.Text({
            text: guide.label,
            padding: 4,
            fill: '#ffffff',
            fontSize: 10 / store.zoom,
          }),
        ),
    );
  });
  layer.batchDraw();
}

function clearGuides() {
  const layer = guideLayerRef.value;
  if (!layer) return;
  layer.find('.alignment-guide').forEach((node) => node.destroy());
  layer.batchDraw();
}

function localAnchorPoint(node: DiagramNode, side: AnchorSide): Point {
  if (side === 'top') return { x: node.width / 2, y: 0 };
  if (side === 'right') return { x: node.width, y: node.height / 2 };
  if (side === 'bottom') return { x: node.width / 2, y: node.height };
  return { x: 0, y: node.height / 2 };
}

function pointerToWorld(): Point {
  const pointer = stageRef.value?.getPointerPosition() ?? { x: 0, y: 0 };
  return {
    x: (pointer.x - store.pan.x) / store.zoom,
    y: (pointer.y - store.pan.y) / store.zoom,
  };
}

function pointInNode(point: Point, node: DiagramNode): boolean {
  return (
    point.x >= node.x &&
    point.x <= node.x + node.width &&
    point.y >= node.y &&
    point.y <= node.y + node.height
  );
}

function nearestSide(point: Point, node: DiagramNode): AnchorSide {
  const distances: Array<[AnchorSide, number]> = [
    ['top', Math.abs(point.y - node.y)],
    ['right', Math.abs(point.x - (node.x + node.width))],
    ['bottom', Math.abs(point.y - (node.y + node.height))],
    ['left', Math.abs(point.x - node.x)],
  ];
  return distances.sort((left, right) => left[1] - right[1])[0][0];
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  const kind = event.dataTransfer?.getData('application/x-frameflow-node') as NodeKind | undefined;
  if (!kind) return;
  const container = containerRef.value;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  store.addNode(kind, {
    x: (event.clientX - rect.left - store.pan.x) / store.zoom - 80,
    y: (event.clientY - rect.top - store.pan.y) / store.zoom - 40,
  });
}

function zoomIn() {
  store.zoomBy(0.12);
  applyViewport();
}

function zoomOut() {
  store.zoomBy(-0.12);
  applyViewport();
}

function fit() {
  store.fitToView(viewport.value.width, viewport.value.height);
  applyViewport();
}

function exportSvg() {
  const stage = stageRef.value;
  if (!stage) return;
  const svg = (stage as unknown as { toSVG: () => string }).toSVG();
  downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${store.title}.svg`);
}

function exportJson() {
  const content = JSON.stringify(store.snapshot(), null, 2);
  downloadBlob(
    new Blob([content], { type: 'application/json;charset=utf-8' }),
    `${store.title}.json`,
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleKeyboard(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.matches('input, textarea, [contenteditable="true"]')) return;
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? store.redo() : store.undo();
    void nextTick(renderDiagram);
  } else if (command && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    store.redo();
    void nextTick(renderDiagram);
  } else if (command && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    store.duplicateSelection();
    void nextTick(renderDiagram);
  } else if (command && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    event.shiftKey ? store.ungroupSelection() : store.groupSelection();
    void nextTick(renderDiagram);
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    store.deleteSelection();
    void nextTick(renderDiagram);
  } else if (event.key === 'Escape') {
    store.setToolMode('select');
    store.clearSelection();
    void nextTick(renderDiagram);
  } else if (event.key.startsWith('Arrow') && store.selectedIds.length) {
    event.preventDefault();
    const amount = store.snapToGrid ? store.gridSize : event.shiftKey ? 10 : 1;
    const delta = {
      ArrowLeft: { x: -amount, y: 0 },
      ArrowRight: { x: amount, y: 0 },
      ArrowUp: { x: 0, y: -amount },
      ArrowDown: { x: 0, y: amount },
    }[event.key];
    if (!delta) return;
    store.checkpoint();
    store.commitPositions(
      Object.fromEntries(
        store.selectedNodes.map((node) => [
          node.id,
          { x: node.x + delta.x, y: node.y + delta.y },
        ]),
      ),
    );
    void nextTick(renderDiagram);
  }
}

onMounted(() => {
  initializeStage();
  resizeObserver = new ResizeObserver(([entry]) => {
    viewport.value = { width: entry.contentRect.width, height: entry.contentRect.height };
    stageRef.value?.size(viewport.value);
    renderDiagram();
  });
  if (containerRef.value) resizeObserver.observe(containerRef.value);
  window.addEventListener('keydown', handleKeyboard);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  stageRef.value?.destroy();
  window.removeEventListener('keydown', handleKeyboard);
});

watch(
  () => [store.nodes, store.connectors, store.swimlanes, store.selectedIds, store.selectedConnectorId, store.toolMode],
  () => void nextTick(renderDiagram),
  { deep: true },
);
watch(
  () => [store.zoom, store.pan.x, store.pan.y],
  () => applyViewport(),
);
</script>

<template>
  <section
    ref="containerRef"
    class="diagram-canvas"
    @dragover.prevent
    @drop="handleDrop"
  >
    <div ref="stageHostRef" class="stage-host" />
    <div class="canvas-toolbar">
      <button type="button" title="缩小" @click="zoomOut">−</button>
      <span>{{ zoomPercent }}</span>
      <button type="button" title="放大" @click="zoomIn">＋</button>
      <button type="button" class="fit-button" title="适应画布" @click="fit">适应</button>
    </div>
    <div class="canvas-hint">
      <span v-if="store.toolMode === 'connect'" class="hint-active">
        连线模式：拖动节点边缘蓝色锚点完成连接
      </span>
      <span v-else>选择模式 · 拖动图元查看对齐参考线</span>
    </div>
    <div class="lane-panel">
      <div class="lane-panel__head">
        <strong>泳道</strong>
        <button type="button" title="新增泳道" @click="store.addLane()">＋</button>
      </div>
      <div class="lane-panel__list">
        <div
          v-for="(lane, index) in store.swimlanes"
          :key="lane.id"
          class="lane-row"
          :class="{ 'lane-row--collapsed': lane.collapsed }"
          draggable="true"
          @dragstart="onLaneRowDragstart($event, lane.id)"
          @dragover.prevent="onLaneRowDragover($event, index)"
          @drop.prevent="onLaneRowDrop($event, index)"
        >
          <span class="lane-row__toggle" @click="store.toggleLaneCollapse(lane.id)">
            {{ lane.collapsed ? '▶' : '▼' }}
          </span>
          <span class="lane-row__name" @dblclick="promptLaneName(lane)">{{ lane.name }}</span>
          <span class="lane-row__count">{{ laneNodeCount(lane.id) }}</span>
          <span class="lane-row__delete" @click="removeLane(lane.id)">×</span>
        </div>
        <div v-if="!store.swimlanes.length" class="lane-panel__empty">暂无泳道</div>
      </div>
    </div>
    <MiniMap />
    <div class="canvas-actions">
      <el-button size="small" @click="exportJson">导出 JSON</el-button>
      <el-button size="small" @click="exportSvg">导出 SVG</el-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import Konva from 'konva';
import { ElMessageBox } from 'element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useDiagramStore } from '../stores/diagram';
import type {
  AnchorSide,
  Box,
  DiagramConnector,
  DiagramNode,
  NodeKind,
  Point,
} from '../types/diagram';
import {
  anchorPointForBox,
  calculateAlignmentGuides,
  displayBoxes,
} from '../utils/diagramGeometry';
import {
  LANE_HEADER_HEIGHT,
  computeSwimLayout,
  connectorSignatureInLayout,
  displayToCanonical,
  laneAtDisplayPoint,
  routeLaneConnector,
  type LaneGeometry,
  type SwimLayout,
} from '../utils/swimlaneLayout';
import MiniMap from './MiniMap.vue';

const store = useDiagramStore();
const containerRef = ref<HTMLDivElement | null>(null);
const stageHostRef = ref<HTMLDivElement | null>(null);
const stageRef = shallowRef<Konva.Stage | null>(null);
const gridLayerRef = shallowRef<Konva.Layer | null>(null);
const laneLayerRef = shallowRef<Konva.Layer | null>(null);
const connectorLayerRef = shallowRef<Konva.Layer | null>(null);
const nodeLayerRef = shallowRef<Konva.Layer | null>(null);
const guideLayerRef = shallowRef<Konva.Layer | null>(null);
const viewport = ref({ width: 900, height: 650 });
const isPanning = ref(false);
const tempConnection = ref<{ start: Point; fromId: string } | null>(null);
let panStart = { x: 0, y: 0, panX: 0, panY: 0 };
let resizeObserver: ResizeObserver | null = null;
/** 连线路由缓存：指纹不变的连线直接复用上一次路径，只有受影响连线才重算。 */
const routeCache = new Map<string, { signature: string; points: number[]; hidden: boolean }>();
let dragState:
  | {
      ids: string[];
      primaryId: string;
      startDisplayPositions: Record<string, Point>;
    }
  | null = null;

const zoomPercent = computed(() => `${Math.round(store.zoom * 100)}%`);

function currentLayout(): SwimLayout {
  return computeSwimLayout(store.swimlanes, store.nodes);
}

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
  const gridLayer = new Konva.Layer({ listening: false });
  const laneLayer = new Konva.Layer();
  const connectorLayer = new Konva.Layer();
  const nodeLayer = new Konva.Layer();
  const guideLayer = new Konva.Layer({ listening: false });
  stage.add(gridLayer);
  stage.add(laneLayer);
  stage.add(connectorLayer);
  stage.add(nodeLayer);
  stage.add(guideLayer);
  stageRef.value = stage;
  gridLayerRef.value = gridLayer;
  laneLayerRef.value = laneLayer;
  connectorLayerRef.value = connectorLayer;
  nodeLayerRef.value = nodeLayer;
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
  const layout = currentLayout();
  if (gridLayerRef.value) {
    gridLayerRef.value.destroyChildren();
    renderGrid(gridLayerRef.value);
  }
  if (laneLayerRef.value) {
    laneLayerRef.value.destroyChildren();
    layout.lanes.forEach((lane) => laneLayerRef.value?.add(createLaneNode(lane)));
  }
  if (connectorLayerRef.value) {
    connectorLayerRef.value.destroyChildren();
    [...store.connectors]
      .sort((a, b) => a.zIndex - b.zIndex)
      .forEach((connector) => connectorLayerRef.value?.add(createConnectorNode(connector, layout)));
  }
  if (nodeLayerRef.value) {
    nodeLayerRef.value.destroyChildren();
    [...store.nodes]
      .sort((a, b) => a.zIndex - b.zIndex)
      .forEach((node) => nodeLayerRef.value?.add(createDiagramNode(node, layout)));
  }
  applyViewport();
  stageRef.value?.batchDraw();
}

function renderGrid(layer: Konva.Layer) {
  const zoom = store.zoom;
  const step = store.gridSize * (zoom < 0.55 ? 4 : zoom < 0.85 ? 2 : 1);
  const left = -store.pan.x / zoom;
  const top = -store.pan.y / zoom;
  const right = left + viewport.value.width / zoom;
  const bottom = top + viewport.value.height / zoom;
  for (let x = Math.floor(left / step) * step; x < right + step; x += step) {
    layer.add(
      new Konva.Line({
        points: [x, top, x, bottom],
        stroke: x % (step * 5) === 0 ? '#d8e2ef' : '#eef2f7',
        strokeWidth: x % (step * 5) === 0 ? 1 : 0.7,
      }),
    );
  }
  for (let y = Math.floor(top / step) * step; y < bottom + step; y += step) {
    layer.add(
      new Konva.Line({
        points: [left, y, right, y],
        stroke: y % (step * 5) === 0 ? '#d8e2ef' : '#eef2f7',
        strokeWidth: y % (step * 5) === 0 ? 1 : 0.7,
      }),
    );
  }
}

// ---------- 泳道 ----------

function createLaneNode(lane: LaneGeometry): Konva.Group {
  const group = new Konva.Group({
    id: `lane-${lane.id}`,
    x: lane.x,
    y: lane.y,
    draggable: true,
    dragDistance: 5,
    // 默认锁定原位，mousedown 命中标题条后才允许纵向拖动。
    dragBoundFunc: function (this: Konva.Node, pos) {
      if (!(this as Konva.Node & { _laneDragReady?: boolean })._laneDragReady) {
        return { x: lane.x, y: lane.y };
      }
      return { x: lane.x, y: pos.y };
    },
  });
  const selected = store.selectedLaneId === lane.id;

  const body = new Konva.Rect({
    id: `lane-body-${lane.id}`,
    x: 0,
    y: 0,
    width: lane.width,
    height: lane.height,
    fill: lane.color,
    fillOpacity: 0.32,
    stroke: selected ? '#1769ff' : '#b9c8de',
    strokeWidth: selected ? 2 : 1,
    cornerRadius: 10,
  });
  const header = new Konva.Rect({
    id: `lane-header-${lane.id}`,
    x: 0,
    y: 0,
    width: lane.width,
    height: LANE_HEADER_HEIGHT,
    fill: lane.color,
    fillOpacity: 0.85,
    cornerRadius: 10,
  });
  const headerClip = new Konva.Rect({
    x: 0,
    y: LANE_HEADER_HEIGHT - 10,
    width: lane.width,
    height: 12,
    fill: lane.color,
    fillOpacity: 0.85,
  });
  const name = new Konva.Text({
    name: 'lane-header-text',
    x: 44,
    y: 0,
    height: LANE_HEADER_HEIGHT,
    verticalAlign: 'middle',
    text: lane.name,
    fill: '#234066',
    fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
    fontSize: 13,
    fontStyle: 'bold',
  });
  const memberCount = store.nodes.filter((node) => node.laneId === lane.id).length;
  const count = new Konva.Text({
    x: lane.width - 96,
    y: 0,
    height: LANE_HEADER_HEIGHT,
    verticalAlign: 'middle',
    text: `${memberCount} 个图元`,
    fill: '#5c7191',
    fontSize: 11,
    listening: false,
  });
  const chevron = new Konva.Group({
    id: `lane-chevron-${lane.id}`,
    x: 22,
    y: LANE_HEADER_HEIGHT / 2,
  });
  chevron.add(
    new Konva.Circle({
      radius: 11,
      fill: '#ffffff',
      stroke: selected ? '#1769ff' : '#9db0c9',
      strokeWidth: 1.2,
    }),
  );
  chevron.add(
    new Konva.Shape({
      sceneFunc: (context, shape) => {
        context.beginPath();
        if (lane.collapsed) {
          context.moveTo(-3, -4);
          context.lineTo(4, 0);
          context.lineTo(-3, 4);
        } else {
          context.moveTo(-4, -3);
          context.lineTo(0, 4);
          context.lineTo(4, -3);
        }
        context.closePath();
        context.fillStrokeShape(shape);
      },
      fill: '#43608a',
      strokeWidth: 0,
    }),
  );

  group.add(body, header, headerClip, name, count, chevron);

  function pressInHeader() {
    const pointer = stageRef.value?.getPointerPosition() ?? { x: 0, y: 0 };
    const worldX = (pointer.x - store.pan.x) / store.zoom;
    const worldY = (pointer.y - store.pan.y) / store.zoom;
    return (
      worldX >= lane.x &&
      worldX <= lane.x + lane.width &&
      worldY >= lane.y &&
      worldY <= lane.y + LANE_HEADER_HEIGHT
    );
  }

  // 主体空白处点击选中泳道（图元在更上层，不受影响）。
  (
    [body, header, headerClip, name] as Konva.Shape[]
  ).forEach((shape) => {
    shape.on('click tap', (event: Konva.KonvaEventObject<MouseEvent>) => {
      event.cancelBubble = true;
      store.selectLane(lane.id);
      void nextTick(renderDiagram);
    });
  });

  chevron.on('click tap', (event) => {
    event.cancelBubble = true;
    store.toggleLaneCollapsed(lane.id);
    void nextTick(renderDiagram);
  });
  chevron.on('mouseenter', () => {
    stageRef.value?.container().style.setProperty('cursor', 'pointer');
  });
  chevron.on('mouseleave', () => {
    stageRef.value?.container().style.setProperty('cursor', 'default');
  });

  // 双击标题条改名
  header.on('dblclick dbltap', (event) => {
    event.cancelBubble = true;
    void promptRenameLane(lane.id, lane.name);
  });

  // 拖动标题条调整泳道先后（仅纵向）；折叠圆点不参与拖拽。
  group.on('mousedown touchstart', (event) => {
    const target = event.target as Konva.Node;
    const targetId = target.id() ?? '';
    const parentId = target.getParent()?.id() ?? '';
    const overChevron =
      targetId.startsWith('lane-chevron') || parentId.startsWith('lane-chevron');
    (group as Konva.Group & { _laneDragReady?: boolean })._laneDragReady =
      !overChevron && pressInHeader();
  });
  group.on('dragstart', (event) => {
    if (!(group as Konva.Group & { _laneDragReady?: boolean })._laneDragReady) {
      event.cancelBubble = true;
      group.stopDrag();
      group.position({ x: lane.x, y: lane.y });
      return;
    }
    event.cancelBubble = true;
  });
  group.on('dragmove', () => {
    showInsertionIndicator(lane.id, group.y() + LANE_HEADER_HEIGHT / 2);
  });
  group.on('dragend', () => {
    const target = consumeInsertionTarget();
    group.position({ x: lane.x, y: lane.y });
    if (target) store.moveLane(lane.id, target.laneId, target.placement);
    clearInsertionIndicator();
    void nextTick(renderDiagram);
  });
  header.on('mouseenter', () => {
    stageRef.value?.container().style.setProperty('cursor', 'grab');
  });
  header.on('mouseleave', () => {
    stageRef.value?.container().style.setProperty('cursor', 'default');
  });

  return group;
}

async function promptRenameLane(laneId: string, currentName: string) {
  try {
    const { value } = await ElMessageBox.prompt('请输入泳道（部门）名称', '泳道命名', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: currentName,
      inputValidator: (value) => (value && value.trim().length > 0) || '名称不能为空',
    });
    store.renameLane(laneId, value);
    void nextTick(renderDiagram);
  } catch {
    // 用户取消
  }
}

let insertionIndicator: { laneId: string; placement: 'before' | 'after' } | null = null;

function showInsertionIndicator(draggedLaneId: string, headerCenterY: number) {
  const layout = currentLayout();
  let hit: { laneId: string; placement: 'before' | 'after' } | null = null;
  for (const lane of layout.lanes) {
    if (headerCenterY < lane.y + lane.height / 2) {
      hit = { laneId: lane.id, placement: 'before' };
      break;
    }
    hit = { laneId: lane.id, placement: 'after' };
  }
  insertionIndicator = hit && hit.laneId !== draggedLaneId ? hit : null;
  drawInsertionIndicator(layout);
}

function consumeInsertionTarget() {
  return insertionIndicator;
}

function drawInsertionIndicator(layout: SwimLayout) {
  clearInsertionIndicator(false);
  if (!insertionIndicator) {
    guideLayerRef.value?.batchDraw();
    return;
  }
  const target = layout.laneById.get(insertionIndicator.laneId);
  if (!target) return;
  const y =
    insertionIndicator.placement === 'before'
      ? target.y - 6
      : target.y + target.height + 6;
  guideLayerRef.value?.add(
    new Konva.Line({
      name: 'lane-insert-indicator',
      points: [target.x, y, target.x + target.width, y],
      stroke: '#1769ff',
      strokeWidth: 3,
      dash: [12, 6],
    }),
  );
  guideLayerRef.value?.batchDraw();
}

function clearInsertionIndicator(redraw = true) {
  guideLayerRef.value
    ?.find('.lane-insert-indicator')
    .forEach((node) => node.destroy());
  if (redraw) guideLayerRef.value?.batchDraw();
}

// ---------- 图元 ----------

function createDiagramNode(node: DiagramNode, layout: SwimLayout): Konva.Group {
  const placement = layout.nodes.get(node.id);
  const group = new Konva.Group({
    id: node.id,
    name: 'diagram-node',
    x: node.x,
    y: placement?.y ?? node.y,
    visible: placement?.visible ?? true,
    draggable:
      (placement?.visible ?? true) && !node.locked && store.toolMode === 'select',
  });
  paintNodeSkin(group, node);

  const selected = store.selectedIds.includes(node.id);
  const isMultiSelected = selected && store.selectedIds.length > 1;

  group.on('click tap', (event) => {
    event.cancelBubble = true;
    store.selectNode(node.id, event.evt.shiftKey);
    void nextTick(renderDiagram);
  });
  group.on('dragstart', (event) => {
    if (node.locked) return;
    event.cancelBubble = true;
    // 先收集要一起移动的图元（含旧分组），再更新选择，避免清空多选。
    const ids = new Set(store.selectedIds.includes(node.id) ? store.selectedIds : [node.id]);
    if (node.groupId) {
      store.nodes
        .filter((item) => item.groupId === node.groupId)
        .forEach((item) => ids.add(item.id));
    }
    if (!store.selectedIds.includes(node.id)) store.selectNode(node.id);
    store.checkpoint();
    const layoutAtStart = currentLayout();
    dragState = {
      ids: [...ids],
      primaryId: node.id,
      startDisplayPositions: Object.fromEntries(
        store.nodes
          .filter((item) => ids.has(item.id))
          .map((item) => {
            const placement = layoutAtStart.nodes.get(item.id);
            return [item.id, { x: item.x, y: placement?.y ?? item.y }] as const;
          }),
      ),
    };
  });
  group.on('dragmove', (dragEvent) => handleNodeDragMove(group, dragEvent));
  group.on('dragend', () => handleNodeDragEnd(group));

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
      const local = localAnchorPoint(node, side);
      const anchor = new Konva.Circle({
        x: local.x,
        y: local.y,
        radius: 6 / store.zoom,
        fill: '#ffffff',
        stroke: '#1769ff',
        strokeWidth: 2 / store.zoom,
        draggable: true,
        name: 'connect-anchor',
      });
      anchor.on('dragstart', (event) => {
        event.cancelBubble = true;
        const layoutNow = currentLayout();
        tempConnection.value = {
          start: anchorInLayoutFor(node, side, layoutNow),
          fromId: node.id,
        };
        guideLayerRef.value?.add(
          new Konva.Line({
            name: 'temp-connection',
            points: [tempConnection.value.start.x, tempConnection.value.start.y],
            stroke: '#1769ff',
            strokeWidth: 2 / store.zoom,
            dash: [8 / store.zoom, 5 / store.zoom],
            listening: false,
          }),
        );
      });
      anchor.on('dragmove', () => {
        if (!tempConnection.value) return;
        const pointer = pointerToWorld();
        const layoutNow = currentLayout();
        const target = store.nodes.find(
          (item) =>
            item.id !== node.id &&
            (layoutNow.nodes.get(item.id)?.visible ?? true) &&
            pointInLayoutNode(pointer, item, layoutNow),
        );
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
        const layoutNow = currentLayout();
        const target = store.nodes.find(
          (item) =>
            item.id !== node.id &&
            (layoutNow.nodes.get(item.id)?.visible ?? true) &&
            pointInLayoutNode(pointer, item, layoutNow),
        );
        if (target) {
          store.addConnector(node.id, target.id, side, nearestSide(pointer, target, layoutNow));
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

function anchorInLayoutFor(node: DiagramNode, side: AnchorSide, layout: SwimLayout): Point {
  const box: Box = {
    x: node.x,
    y: layout.nodes.get(node.id)?.y ?? node.y,
    width: node.width,
    height: node.height,
  };
  return anchorPointForBox(box, side);
}

/** 拖拽过程：在显示坐标系中移动，泳道高度冻结，只刷新与被试图元相连的连线。 */
function handleNodeDragMove(group: Konva.Group, dragEvent: Konva.KonvaEventObject<DragEvent>) {
  if (!dragState) return;
  const start = dragState.startDisplayPositions[dragState.primaryId];
  if (!start) return;
  let deltaX = group.x() - start.x;
  let deltaY = group.y() - start.y;
  if (store.snapToGrid && !(dragEvent.evt as MouseEvent).shiftKey) {
    deltaX = Math.round((start.x + deltaX) / store.gridSize) * store.gridSize - start.x;
    deltaY = Math.round((start.y + deltaY) / store.gridSize) * store.gridSize - start.y;
  }

  // 显示坐标预览（布局重算，但泳道高度由未动的图元决定，不会因拖拽而增高）
  const displayPositions: Record<string, Point> = {};
  Object.entries(dragState.startDisplayPositions).forEach(([id, point]) => {
    displayPositions[id] = { x: point.x + deltaX, y: point.y + deltaY };
  });
  const previewLayout = computeSwimLayout(store.swimlanes, store.nodes, {
    positions: displayPositions,
    freezeHeights: true,
  });

  // 移动所有被试图元到其预览显示位置
  const movedIds = new Set(dragState.ids);
  store.nodes.forEach((item) => {
    if (!movedIds.has(item.id)) return;
    const placement = previewLayout.nodes.get(item.id);
    const child = nodeLayerRef.value?.findOne(`#${item.id}`) as Konva.Group | undefined;
    child?.position({
      x: displayPositions[item.id]?.x ?? item.x,
      y: placement?.y ?? displayPositions[item.id]?.y ?? item.y,
    });
  });

  // 高亮指针所在泳道
  const pointer = pointerToWorld();
  const hoverLane = laneAtDisplayPoint(previewLayout, pointer);
  previewLayout.lanes.forEach((lane) => {
    const body = laneLayerRef.value?.findOne(`#lane-body-${lane.id}`) as Konva.Rect | undefined;
    body?.stroke(lane.id === hoverLane ? '#2f7dff' : '#b9c8de');
    body?.strokeWidth(lane.id === hoverLane ? 2.2 : 1);
  });

  // 只重算与被试图元相连的线（直接喂显示坐标；预览结果不写入路径缓存）
  store.connectors.forEach((connector) => {
    if (!movedIds.has(connector.fromId) && !movedIds.has(connector.toId)) return;
    const routed = routeLaneConnector(connector, store.nodes, store.swimlanes, {
      positions: displayPositions,
      freezeHeights: true,
    });
    const view = connectorLayerRef.value?.findOne(`#connector-${connector.id}`) as
      | Konva.Group
      | undefined;
    if (!view) return;
    const arrow = view.findOne('.connector-arrow') as Konva.Arrow | undefined;
    const label = view.findOne('.connector-label') as Konva.Text | undefined;
    view.visible(!routed.hidden);
    arrow?.points(routed.points);
    label?.visible(!routed.hidden && !!connector.label);
  });

  // 对齐参考线（显示坐标）
  const previewBoxes = displayBoxes(store.nodes, previewLayout);
  const activeBoxes = [...movedIds]
    .map((id) => previewBoxes.get(id))
    .filter((box): box is Box => Boolean(box));
  const otherBoxes = store.nodes
    .filter((node) => !movedIds.has(node.id) && previewLayout.nodes.get(node.id)?.visible)
    .map((node) => previewBoxes.get(node.id))
    .filter((box): box is Box => Boolean(box));
  renderGuides(calculateAlignmentGuides(activeBoxes, otherBoxes, 7 / store.zoom));

  nodeLayerRef.value?.batchDraw();
  connectorLayerRef.value?.batchDraw();
  laneLayerRef.value?.batchDraw();
}

function handleNodeDragEnd(group: Konva.Group) {
  if (!dragState) return;
  const start = dragState.startDisplayPositions[dragState.primaryId];
  const deltaX = group.x() - start.x;
  const deltaY = group.y() - start.y;

  const displayPositions: Record<string, Point> = {};
  Object.entries(dragState.startDisplayPositions).forEach(([id, point]) => {
    displayPositions[id] = { x: point.x + deltaX, y: point.y + deltaY };
  });
  const previewLayout = computeSwimLayout(store.swimlanes, store.nodes, {
    positions: displayPositions,
    freezeHeights: true,
  });

  const positions: Record<string, Point> = {};
  const laneIds: Record<string, string | null> = {};
  dragState.ids.forEach((id) => {
    const node = store.nodes.find((item) => item.id === id);
    if (!node) return;
    const displayPoint = displayPositions[id];
    const targetLane = laneAtDisplayPoint(previewLayout, {
      x: displayPoint.x + node.width / 2,
      y: displayPoint.y + node.height / 2,
    });
    const canonical = displayToCanonical(
      store.swimlanes,
      previewLayout,
      displayPoint,
      targetLane,
    );
    positions[id] = canonical;
    laneIds[id] = targetLane;
  });

  store.commitDrag(positions, laneIds);
  dragState = null;
  clearGuides();
  void nextTick(renderDiagram);
}

function paintNodeSkin(group: Konva.Group, node: DiagramNode) {
  const selected = store.selectedIds.includes(node.id);
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

// ---------- 连线 ----------

function createConnectorNode(connector: DiagramConnector, layout: SwimLayout): Konva.Group {
  // 先查指纹：未受影响的连线直接复用缓存路径，不重新走线。
  const signature = connectorSignatureInLayout(connector, store.nodes, layout);
  let cached = routeCache.get(connector.id);
  if (!cached || cached.signature !== signature) {
    const routed = routeLaneConnector(connector, store.nodes, store.swimlanes);
    cached = { signature: routed.signature, points: routed.points, hidden: routed.hidden };
    routeCache.set(connector.id, cached);
  }
  const selected = store.selectedConnectorId === connector.id;
  const group = new Konva.Group({
    id: `connector-${connector.id}`,
    listening: true,
    visible: !cached.hidden,
  });
  const arrow = new Konva.Arrow({
    name: 'connector-arrow',
    points: cached.points,
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
  const points = cached.points;
  if (connector.label && points.length >= 4) {
    const middle =
      points.length === 4
        ? { x: points[0], y: points[1] }
        : { x: points[points.length - 2], y: points[points.length - 1] };
    group.add(
      new Konva.Text({
        name: 'connector-label',
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
    void nextTick(renderDiagram);
  });
  group.on('mouseenter', () => {
    stageRef.value?.container().style.setProperty('cursor', 'pointer');
  });
  group.on('mouseleave', () => {
    stageRef.value?.container().style.setProperty('cursor', 'default');
  });
  return group;
}

// ---------- 对齐参考线 ----------

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

function pointInLayoutNode(point: Point, node: DiagramNode, layout: SwimLayout): boolean {
  const y = layout.nodes.get(node.id)?.y ?? node.y;
  return (
    point.x >= node.x &&
    point.x <= node.x + node.width &&
    point.y >= y &&
    point.y <= y + node.height
  );
}

function nearestSide(point: Point, node: DiagramNode, layout: SwimLayout): AnchorSide {
  const y = layout.nodes.get(node.id)?.y ?? node.y;
  const distances: Array<[AnchorSide, number]> = [
    ['top', Math.abs(point.y - y)],
    ['right', Math.abs(point.x - (node.x + node.width))],
    ['bottom', Math.abs(point.y - (y + node.height))],
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
  const displayPoint = {
    x: (event.clientX - rect.left - store.pan.x) / store.zoom - 80,
    y: (event.clientY - rect.top - store.pan.y) / store.zoom - 40,
  };
  const layout = currentLayout();
  const laneId = laneAtDisplayPoint(layout, {
    x: displayPoint.x + 80,
    y: displayPoint.y + 40,
  });
  const canonical = displayToCanonical(store.swimlanes, layout, displayPoint, laneId);
  store.addNode(kind, canonical, laneId);
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

function addLaneAtCenter() {
  store.addLane();
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
    store.commitDrag(
      Object.fromEntries(
        store.selectedNodes.map((node) => [
          node.id,
          { x: node.x + delta.x, y: node.y + delta.y },
        ]),
      ),
      {},
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
  () => [
    store.nodes,
    store.connectors,
    store.swimlanes,
    store.selectedIds,
    store.selectedConnectorId,
    store.selectedLaneId,
    store.toolMode,
  ],
  () => void nextTick(renderDiagram),
  { deep: true },
);
watch(
  () => [store.zoom, store.pan.x, store.pan.y],
  () => {
    applyViewport();
    renderDiagram();
  },
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
      <span v-else>
        拖动图元进入泳道即归属该泳道 · 拖动泳道标题调整先后 · 双击标题改名 · 圆点折叠
      </span>
    </div>
    <MiniMap />
    <div class="canvas-actions">
      <el-button size="small" @click="addLaneAtCenter">新建泳道</el-button>
      <el-button size="small" @click="exportJson">导出 JSON</el-button>
      <el-button size="small" @click="exportSvg">导出 SVG</el-button>
    </div>
  </section>
</template>

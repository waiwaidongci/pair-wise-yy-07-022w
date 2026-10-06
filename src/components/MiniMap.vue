<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useDiagramStore } from '../stores/diagram';
import { computeSwimLayout } from '../utils/swimlaneLayout';

const store = useDiagramStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const width = 214;
const height = 118;

const layout = computed(() => computeSwimLayout(store.swimlanes, store.nodes));

const bounds = computed(() => {
  const current = layout.value;
  const candidates: Array<{ x: number; y: number; right: number; bottom: number }> = [];
  current.lanes.forEach((lane) => {
    candidates.push({ x: lane.x, y: lane.y, right: lane.x + lane.width, bottom: lane.y + lane.height });
  });
  store.nodes.forEach((node) => {
    const placement = current.nodes.get(node.id);
    if (!placement?.visible) return;
    candidates.push({
      x: node.x,
      y: placement.y,
      right: node.x + node.width,
      bottom: placement.y + node.height,
    });
  });
  if (!candidates.length) return { minX: 0, minY: 0, maxX: 1000, maxY: 700 };
  const minX = Math.min(...candidates.map((item) => item.x)) - 30;
  const minY = Math.min(...candidates.map((item) => item.y)) - 30;
  const maxX = Math.max(...candidates.map((item) => item.right)) + 30;
  const maxY = Math.max(...candidates.map((item) => item.bottom)) + 30;
  return { minX, minY, maxX: Math.max(maxX, minX + 500), maxY: Math.max(maxY, minY + 360) };
});

function getTransform() {
  const worldWidth = bounds.value.maxX - bounds.value.minX;
  const worldHeight = bounds.value.maxY - bounds.value.minY;
  const scale = Math.min(width / worldWidth, height / worldHeight);
  return {
    scale,
    x: (width - worldWidth * scale) / 2,
    y: (height - worldHeight * scale) / 2,
  };
}

function toScreen(x: number, y: number) {
  const transform = getTransform();
  return {
    x: (x - bounds.value.minX) * transform.scale + transform.x,
    y: (y - bounds.value.minY) * transform.scale + transform.y,
  };
}

function draw() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#f7f9fc';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#dce3ed';
  context.lineWidth = 1;
  for (let x = 0; x < width; x += 18) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 0; y < height; y += 18) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  // 泳道
  layout.value.lanes.forEach((lane) => {
    const point = toScreen(lane.x, lane.y);
    context.fillStyle = lane.color + '55';
    context.strokeStyle = store.selectedLaneId === lane.id ? '#1769ff' : '#b9c8de';
    context.lineWidth = store.selectedLaneId === lane.id ? 1.6 : 1;
    context.beginPath();
    context.roundRect(
      point.x,
      point.y,
      Math.max(4, lane.width * getTransform().scale),
      Math.max(lane.collapsed ? 5 : 8, lane.height * getTransform().scale),
      3,
    );
    context.fill();
    context.stroke();
  });

  // 连线（显示坐标，折叠中的隐藏）
  store.connectors.forEach((connector) => {
    const from = store.nodes.find((node) => node.id === connector.fromId);
    const to = store.nodes.find((node) => node.id === connector.toId);
    if (!from || !to) return;
    const fromPlacement = layout.value.nodes.get(from.id);
    const toPlacement = layout.value.nodes.get(to.id);
    if (!fromPlacement?.visible || !toPlacement?.visible) return;
    const start = toScreen(from.x + from.width / 2, fromPlacement.y + from.height / 2);
    const end = toScreen(to.x + to.width / 2, toPlacement.y + to.height / 2);
    context.strokeStyle = connector.color;
    context.lineWidth = 1.2;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  });

  store.nodes.forEach((node) => {
    const placement = layout.value.nodes.get(node.id);
    if (!placement?.visible) return;
    const point = toScreen(node.x, placement.y);
    const transform = getTransform();
    context.fillStyle = node.laneId ? node.color : '#ffffff';
    context.strokeStyle = store.selectedIds.includes(node.id) ? '#1769ff' : '#8b9bb3';
    context.lineWidth = store.selectedIds.includes(node.id) ? 2 : 1;
    context.beginPath();
    context.roundRect(
      point.x,
      point.y,
      Math.max(4, node.width * transform.scale),
      Math.max(4, node.height * transform.scale),
      3,
    );
    context.fill();
    context.stroke();
  });
}

watch(
  () => [store.nodes, store.connectors, store.swimlanes, store.selectedIds, store.selectedLaneId],
  () => void nextTick(draw),
  { deep: true },
);

onMounted(draw);
</script>

<template>
  <div class="mini-map">
    <div class="mini-map__head">
      <strong>缩略图</strong>
      <span>{{ store.swimlanes.length }} 条泳道 · {{ Math.round(store.zoom * 100) }}%</span>
    </div>
    <canvas ref="canvasRef" />
  </div>
</template>

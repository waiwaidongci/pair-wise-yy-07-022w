<script setup lang="ts">
import { Delete, Lock, Unlock } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, ref, watch } from 'vue';
import { useDiagramStore } from '../stores/diagram';
import type { AnchorSide } from '../types/diagram';
import { LANE_HEADER_HEIGHT } from '../utils/swimlaneLayout';

const store = useDiagramStore();
const textDraft = ref('');
const fieldDraft = ref('');

watch(
  () => store.activeNode,
  (node) => {
    textDraft.value = node?.text ?? '';
    fieldDraft.value = node?.fields.join('\n') ?? '';
  },
  { immediate: true, deep: true },
);

const activeConnector = computed(
  () => store.connectors.find((connector) => connector.id === store.selectedConnectorId) ?? null,
);

function patchNode(patch: Parameters<typeof store.patchNode>[1]) {
  if (store.activeNode) store.patchNode(store.activeNode.id, patch);
}

function applyText() {
  if (store.activeNode && textDraft.value.trim() !== store.activeNode.text) {
    patchNode({ text: textDraft.value.trim() || '未命名节点' });
  }
}

function applyFields() {
  if (store.activeNode?.kind !== 'table') return;
  const fields = fieldDraft.value
    .split('\n')
    .map((field) => field.trim())
    .filter(Boolean);
  patchNode({
    fields,
    height: Math.max(120, 76 + fields.length * 34),
  });
}

function changeLane(laneId: string | null) {
  if (store.selectedIds.length) {
    store.assignNodesToLane([...store.selectedIds], laneId);
    ElMessage.success(laneId ? '图元已移入泳道' : '图元已移出泳道');
  } else if (store.activeNode) {
    store.assignNodesToLane([store.activeNode.id], laneId);
  }
}

async function removeSelection() {
  try {
    await ElMessageBox.confirm('删除当前选中的图元和连接线？', '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
    store.deleteSelection();
    ElMessage.success('已删除');
  } catch {
    // 用户取消时保持选择不变。
  }
}

async function renameLane() {
  if (!store.selectedLane) return;
  try {
    const { value } = await ElMessageBox.prompt('请输入泳道（部门）名称', '泳道命名', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: store.selectedLane.name,
      inputValidator: (value) => (value && value.trim().length > 0) || '名称不能为空',
    });
    store.renameLane(store.selectedLane.id, value);
  } catch {
    // 取消
  }
}

async function deleteLane(strategy: 'keepMembers' | 'deleteMembers') {
  const lane = store.selectedLane;
  if (!lane) return;
  try {
    await ElMessageBox.confirm(
      strategy === 'deleteMembers'
        ? `删除泳道「${lane.name}」及其内部全部图元？`
        : `删除泳道「${lane.name}」？内部图元将保留在泳道外。`,
      '删除泳道',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
    store.deleteLane(lane.id, strategy);
    ElMessage.success('泳道已删除');
  } catch {
    // 取消
  }
}
</script>

<template>
  <aside class="properties-panel">
    <div class="panel-title">
      <strong>属性</strong>
      <span>{{ store.selectedIds.length }} 个图元</span>
    </div>

    <template v-if="store.selectedLane">
      <div class="property-group">
        <div class="section-label">泳道信息</div>
        <label>
          <span>名称（部门）</span>
          <el-input
            :model-value="store.selectedLane.name"
            @change="store.renameLane(store.selectedLane!.id, String($event))"
          />
        </label>
        <el-button @click="renameLane">重命名泳道</el-button>
        <label>
          <span>底色</span>
          <el-color-picker
            :model-value="store.selectedLane.color"
            @change="store.patchLane(store.selectedLane!.id, { color: String($event) })"
          />
        </label>
        <div class="two-fields">
          <label>
            <span>宽度</span>
            <el-input-number
              :model-value="store.selectedLane.width"
              :min="320"
              :max="3000"
              controls-position="right"
              @change="store.patchLane(store.selectedLane!.id, { width: Number($event) })"
            />
          </label>
          <label>
            <span>总高度</span>
            <el-input-number
              :model-value="store.selectedLane.height + LANE_HEADER_HEIGHT"
              :min="LANE_HEADER_HEIGHT + 60"
              :max="2000"
              controls-position="right"
              @change="store.patchLane(store.selectedLane!.id, { height: Number($event) })"
            />
          </label>
        </div>
        <el-button
          :type="store.selectedLane.collapsed ? 'primary' : 'default'"
          @click="store.toggleLaneCollapsed(store.selectedLane!.id)"
        >
          {{ store.selectedLane.collapsed ? '展开泳道' : '折叠泳道' }}
        </el-button>
      </div>
      <div class="property-group">
        <div class="section-label">成员图元</div>
        <div class="lane-members">
          {{ store.nodes.filter((node) => node.laneId === store.selectedLane!.id).length }} 个图元归属此泳道
        </div>
        <el-button @click="deleteLane('keepMembers')">删除泳道（保留图元）</el-button>
        <el-button type="danger" plain @click="deleteLane('deleteMembers')">
          删除泳道及内部图元
        </el-button>
      </div>
    </template>

    <template v-else-if="store.activeNode">
      <div class="property-group">
        <div class="section-label">基础信息</div>
        <label>
          <span>名称 / 标题</span>
          <el-input v-model="textDraft" @blur="applyText" @keydown.enter="applyText" />
        </label>
        <label>
          <span>所属泳道（部门）</span>
          <el-select
            :model-value="store.activeNode.laneId"
            placeholder="泳道外（自由图元）"
            clearable
            @change="changeLane(($event as string | null) ?? null)"
          >
            <el-option label="泳道外（自由图元）" :value="null" />
            <el-option
              v-for="lane in store.swimlanes"
              :key="lane.id"
              :label="lane.name"
              :value="lane.id"
            />
          </el-select>
        </label>
        <div class="two-fields">
          <label>
            <span>X</span>
            <el-input-number
              :model-value="Math.round(store.activeNode.x)"
              :min="-2000"
              :max="5000"
              controls-position="right"
              @change="patchNode({ x: Number($event) })"
            />
          </label>
          <label>
            <span>Y</span>
            <el-input-number
              :model-value="Math.round(store.activeNode.y)"
              :min="-2000"
              :max="5000"
              controls-position="right"
              @change="patchNode({ y: Number($event) })"
            />
          </label>
        </div>
        <div class="two-fields">
          <label>
            <span>宽度</span>
            <el-input-number
              :model-value="store.activeNode.width"
              :min="70"
              :max="520"
              controls-position="right"
              @change="patchNode({ width: Number($event) })"
            />
          </label>
          <label>
            <span>高度</span>
            <el-input-number
              :model-value="store.activeNode.height"
              :min="50"
              :max="620"
              controls-position="right"
              @change="patchNode({ height: Number($event) })"
            />
          </label>
        </div>
        <label>
          <span>填充颜色</span>
          <el-color-picker
            :model-value="store.activeNode.color"
            @change="patchNode({ color: String($event) })"
          />
        </label>
      </div>

      <div v-if="store.activeNode.kind === 'table'" class="property-group">
        <div class="section-label">表字段</div>
        <el-input
          v-model="fieldDraft"
          type="textarea"
          :rows="7"
          placeholder="每行一个字段，例如 id BIGINT PK"
          @blur="applyFields"
        />
        <small>支持字段名、类型和 PK / FK 标注，换行自动调整表高。</small>
      </div>

      <div class="property-group">
        <div class="section-label">行为</div>
        <el-button class="full-button" @click="store.toggleLock()">
          <el-icon><Lock v-if="!store.activeNode.locked" /><Unlock v-else /></el-icon>
          {{ store.activeNode.locked ? '解除锁定' : '锁定图元' }}
        </el-button>
        <div class="two-buttons">
          <el-button @click="store.changeLayer('front')">移到顶层</el-button>
          <el-button @click="store.changeLayer('back')">移到底层</el-button>
        </div>
      </div>
    </template>

    <template v-else-if="activeConnector">
      <div class="property-group">
        <div class="section-label">连接线</div>
        <label>
          <span>标签</span>
          <el-input
            :model-value="activeConnector.label"
            @change="store.patchConnector(activeConnector.id, { label: String($event) })"
          />
        </label>
        <label>
          <span>颜色</span>
          <el-color-picker
            :model-value="activeConnector.color"
            @change="store.patchConnector(activeConnector.id, { color: String($event) })"
          />
        </label>
        <label class="switch-row">
          <span>虚线</span>
          <el-switch
            :model-value="activeConnector.dashed"
            @change="store.patchConnector(activeConnector.id, { dashed: Boolean($event) })"
          />
        </label>
        <label>
          <span>起点锚点</span>
          <el-select
            :model-value="activeConnector.fromAnchor"
            @change="store.patchConnector(activeConnector.id, { fromAnchor: $event as AnchorSide })"
          >
            <el-option label="上" value="top" />
            <el-option label="右" value="right" />
            <el-option label="下" value="bottom" />
            <el-option label="左" value="left" />
          </el-select>
        </label>
        <label>
          <span>终点锚点</span>
          <el-select
            :model-value="activeConnector.toAnchor"
            @change="store.patchConnector(activeConnector.id, { toAnchor: $event as AnchorSide })"
          >
            <el-option label="上" value="top" />
            <el-option label="右" value="right" />
            <el-option label="下" value="bottom" />
            <el-option label="左" value="left" />
          </el-select>
        </label>
      </div>
    </template>

    <div v-else class="empty-properties">
      <strong>未选择对象</strong>
      <span>
        单击泳道可重命名、折叠和调整宽度；把图元拖进泳道即归属该泳道，
        也可以在此选择所属部门。
      </span>
    </div>

    <div v-if="store.selectedIds.length || activeConnector" class="danger-zone">
      <el-button type="danger" plain class="full-button" :icon="Delete" @click="removeSelection">
        删除所选对象
      </el-button>
    </div>
  </aside>
</template>

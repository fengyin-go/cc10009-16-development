<template>
  <section class="page" data-module="distbatch">
    <header class="page-head">
      <div>
        <h2>分发批次管理</h2>
        <p class="page-desc">维护分发批次的送达确认与完整性核对结果，记录分发格式、目标系统与校验摘要，为数据分发提供可验证的送达流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="exportIntegrity">导出完整性结果</button>
        <button class="btn" type="button" @click="downloadIndex">下载已导出数据集索引</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td
            v-for="column in columns"
            :key="column"
            :class="{ 'long-cell': column === '分区文件' || column === '目标回执' }"
          >
            {{ row[column] ?? '—' }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无分发批次数据，可先在数据分发通道发起分发</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条分发批次记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadBatchIntegrity,
  downloadDatasetIndex,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('distbatch')
const columns = ["批次编号", "关联通道", "输出数据集", "目标系统", "分发格式", "分区文件", "校验摘要", "目标回执"]
const actions = ["开始分发", "重新检查", "复核通过"]
const statuses = ["待分发", "部分失败", "待复核", "已完成"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stats = computed(() => [
  { label: '分发批次总数', value: total.value },
  { label: '已完成批次', value: rows.value.filter((row) => String(row.status) === '已完成').length },
  { label: '待复核批次', value: rows.value.filter((row) => String(row.status) === '待复核').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportIntegrity() {
  downloadBatchIntegrity()
}

function downloadIndex() {
  downloadDatasetIndex()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '分发批次列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.long-cell {
  max-width: 240px;
  word-break: break-all;
  font-size: 12px;
  color: #475467;
}
</style>

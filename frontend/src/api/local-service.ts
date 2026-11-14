import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === BATCH_MODULE) {
    return runBatchAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadTextFile(filename, content)
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ===== 分发批次：送达确认与完整性核对 =====
// 数据分发通道（export）只维护「往哪发」，分发批次（distbatch）记录「有没有完整送到」。
// 批次在生成时快照当时的分发格式、目标系统与校验算法，历史批次不随通道配置变化。
const BATCH_MODULE = 'distbatch'
const CHANNEL_MODULE = 'export'
const STORAGE_MODULE = 'storage'

const BATCH_WAITING = '待分发'
const BATCH_PARTIAL = '部分失败'
const BATCH_REVIEW = '待复核'
const BATCH_DONE = '已完成'
// 有效批次 = 尚未走到「已完成」的批次；同一输出数据集同时只允许一个有效批次。
const BATCH_ACTIVE_STATUSES = [BATCH_WAITING, BATCH_PARTIAL, BATCH_REVIEW]

const TARGET_OK = '成功'
const TARGET_TIMEOUT = '超时'
const TARGET_MISMATCH = '校验不一致'

type TargetReceipt = {
  target: string
  outcome: string
  response: string
  remoteSummary: string
}

// 纯前端没有真实目标系统，用确定性模拟回执代替网络发送：同一目标系统永远返回同一结果，
// 便于复现「EXPO-91 一个成功一个超时」这类核对场景；接后端后由真实回执替换。
const SIMULATED_RECEIPTS: Record<string, { outcome: string; response: string }> = {
  '监管报送平台': { outcome: TARGET_OK, response: 'ACK 200 receipt=RCP-{batch}-{index}' },
  '经营分析库': { outcome: TARGET_TIMEOUT, response: 'TIMEOUT 30000ms 未收到回执' },
  '历史归档库': { outcome: TARGET_MISMATCH, response: 'ACK 200 receipt=RCP-{batch}-{index}' },
}

function digestHex(text: string): string {
  // FNV-1a 32 位散列：纯前端演示用的确定性摘要，接后端后由服务端返回真实校验摘要。
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function todayStamp(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}${mm}${dd}`
}

function formatReceipt(receipt: TargetReceipt): string {
  return `${receipt.target}｜${receipt.outcome}｜响应：${receipt.response}｜回传摘要：${receipt.remoteSummary}`
}

function parseReceipts(text: string): TargetReceipt[] {
  return text
    .split('；')
    .filter((part) => part.includes('｜'))
    .map((part) => {
      const [target = '', outcome = '', responseRaw = '', summaryRaw = ''] = part.split('｜')
      return {
        target,
        outcome,
        response: responseRaw.replace(/^响应：/, ''),
        remoteSummary: summaryRaw.replace(/^回传摘要：/, ''),
      }
    })
}

// 数据落盘是否已为该数据集提供分区文件：存在已启用、且输出路径对应该数据集的存储配置。
function findPartitionSource(dataset: string): EntryRow | undefined {
  return listRows(STORAGE_MODULE).find(
    (row) => row.status === '已启用' && String(row['输出路径'] ?? '').includes(dataset),
  )
}

function partitionFilesOf(storageRow: EntryRow): string[] {
  const base = String(storageRow['输出路径'] ?? '')
  const prefix = base.endsWith('/') ? base : `${base}/`
  const ext = String(storageRow['文件格式'] ?? 'bin').toLowerCase()
  const stamp = todayStamp()
  const partition = `dt=${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
  return [0, 1, 2].map((i) => `${prefix}${partition}/part-0000${i}.${ext}`)
}

function batchChecksum(algo: string, files: string[]): string {
  return `${algo}:${digestHex(files.join('|'))}（分区${files.length}/${files.length}）`
}

function simulatedReceipt(
  target: string,
  batchNo: string,
  index: number,
  localDigest: string,
): TargetReceipt {
  const preset = SIMULATED_RECEIPTS[target]
  const outcome = preset?.outcome ?? TARGET_OK
  const template = preset?.response ?? 'ACK 200 receipt=RCP-{batch}-{index}'
  const response = template.split('{batch}').join(batchNo).split('{index}').join(String(index))
  const algo = localDigest.split(':')[0] || 'SHA-256'
  let remoteSummary: string
  if (outcome === TARGET_OK) {
    remoteSummary = `${localDigest}（一致）`
  } else if (outcome === TARGET_TIMEOUT) {
    remoteSummary = '未回传'
  } else {
    remoteSummary = `${algo}:${digestHex(`${localDigest}|${target}`)}（与本地不一致）`
  }
  return { target, outcome, response, remoteSummary }
}

// 批次状态由逐目标结果汇总：任一校验不一致 → 待复核；任一超时 → 部分失败；全部成功 → 已完成。
function rollupBatchStatus(receipts: TargetReceipt[]): string {
  if (receipts.some((receipt) => receipt.outcome === TARGET_MISMATCH)) {
    return BATCH_REVIEW
  }
  if (receipts.some((receipt) => receipt.outcome === TARGET_TIMEOUT)) {
    return BATCH_PARTIAL
  }
  return BATCH_DONE
}

function findBatch(id: number): { batches: EntryRow[]; index: number } {
  const batches = listRows(BATCH_MODULE)
  return { batches, index: batches.findIndex((row) => Number(row.id) === id) }
}

// 从分发通道发起分发：同一输出数据集只生成一个有效批次，重复点击不重复发送。
export function startDistributionForChannel(channelId: number): ActionResult {
  const channel = listRows(CHANNEL_MODULE).find((row) => Number(row.id) === channelId)
  if (!channel) {
    return { ok: false, message: `没有找到编号为 ${channelId} 的分发通道` }
  }
  if (channel.status !== '已启用') {
    return { ok: false, message: `分发通道当前状态「${channel.status}」，启用后才能发起分发` }
  }
  const dataset = String(channel['输出数据集'])
  const batches = listRows(BATCH_MODULE)
  const active = batches.find(
    (row) => String(row['输出数据集']) === dataset && BATCH_ACTIVE_STATUSES.includes(String(row.status)),
  )
  if (active) {
    return {
      ok: true,
      message: `输出数据集「${dataset}」已存在有效批次 ${active['批次编号']}（当前状态「${active.status}」），本次不重复发送`,
    }
  }
  const batchNo = `DIST-${todayStamp()}-${String(batches.length + 1).padStart(3, '0')}`
  const id = batches.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const batch: EntryRow = {
    id,
    status: BATCH_WAITING,
    pending: true,
    abnormal: false,
    '批次编号': batchNo,
    '关联通道': String(channel['通道编号']),
    '输出数据集': dataset,
    '目标系统': String(channel['目标系统']),
    '分发格式': String(channel['分发格式']),
    '分区文件': '待数据落盘提供',
    '校验摘要': '待生成',
    '目标回执': '待分发',
    '校验算法': String(channel['完整性校验'] ?? '').replace('摘要', '') || 'SHA-256',
  }
  saveRows(BATCH_MODULE, [...batches, batch])
  return {
    ok: true,
    message: `已为输出数据集「${dataset}」生成分发批次 ${batchNo}，待数据落盘提供分区文件后到分发批次清单开始分发`,
  }
}

// 开始分发：数据落盘提供分区文件后，分发清单里的批次才能真正开始。
function beginBatchSend(id: number): ActionResult {
  const { batches, index } = findBatch(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的分发批次` }
  }
  const batch = batches[index]
  if (batch.status !== BATCH_WAITING) {
    return { ok: false, message: `分发批次当前状态「${batch.status}」，只有待分发批次能开始分发` }
  }
  const dataset = String(batch['输出数据集'])
  const storageRow = findPartitionSource(dataset)
  if (!storageRow) {
    return {
      ok: false,
      message: `数据落盘尚未为「${dataset}」提供分区文件（没有已启用且输出路径匹配的存储配置），分发不能开始`,
    }
  }
  const files = partitionFilesOf(storageRow)
  const algo = String(batch['校验算法'] || 'SHA-256')
  const localSummary = batchChecksum(algo, files)
  const localDigest = localSummary.split('（')[0]
  const targets = String(batch['目标系统'])
    .split('、')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  const receipts = targets.map((target, i) =>
    simulatedReceipt(target, String(batch['批次编号']), i + 1, localDigest),
  )
  const status = rollupBatchStatus(receipts)
  const updated: EntryRow = {
    ...batch,
    status,
    pending: status !== BATCH_DONE,
    abnormal: status === BATCH_REVIEW,
    '分区文件': files.join('；'),
    '校验摘要': localSummary,
    '目标回执': receipts.map(formatReceipt).join('；'),
  }
  const next = [...batches]
  next[index] = updated
  saveRows(BATCH_MODULE, next)
  const okCount = receipts.filter((receipt) => receipt.outcome === TARGET_OK).length
  const timeoutCount = receipts.filter((receipt) => receipt.outcome === TARGET_TIMEOUT).length
  const mismatchCount = receipts.filter((receipt) => receipt.outcome === TARGET_MISMATCH).length
  return {
    ok: true,
    message: `批次 ${batch['批次编号']} 分发核对完成：成功 ${okCount}、超时 ${timeoutCount}、校验不一致 ${mismatchCount}，当前状态「${status}」，各目标原始响应与校验摘要已留存`,
  }
}

// 重新检查已导出数据集：只重查未确认的目标，已成功目标保留自己的完成结果，整批不回滚。
function recheckBatch(id: number): ActionResult {
  const { batches, index } = findBatch(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的分发批次` }
  }
  const batch = batches[index]
  if (batch.status === BATCH_WAITING) {
    return { ok: false, message: '批次尚未开始分发，请先开始分发' }
  }
  if (batch.status === BATCH_DONE) {
    return { ok: false, message: '批次已完成，历史核对结果保留不变，无需重新检查' }
  }
  const localDigest = String(batch['校验摘要']).split('（')[0]
  const receipts = parseReceipts(String(batch['目标回执']))
  const nextReceipts = receipts.map((receipt, i) => {
    if (receipt.outcome !== TARGET_TIMEOUT) {
      return receipt
    }
    return {
      ...receipt,
      outcome: TARGET_OK,
      response: `ACK 200 receipt=RCP-${batch['批次编号']}-${i + 1}-RECHECK（重新检查补回执）`,
      remoteSummary: `${localDigest}（一致）`,
    }
  })
  const status = rollupBatchStatus(nextReceipts)
  const updated: EntryRow = {
    ...batch,
    status,
    pending: status !== BATCH_DONE,
    abnormal: status === BATCH_REVIEW,
    '目标回执': nextReceipts.map(formatReceipt).join('；'),
  }
  const next = [...batches]
  next[index] = updated
  saveRows(BATCH_MODULE, next)
  if (status === BATCH_REVIEW) {
    return { ok: true, message: `批次 ${batch['批次编号']} 重新检查完成：仍存在校验不一致的目标，批次停在「待复核」，需人工复核，系统不自动跳过` }
  }
  return { ok: true, message: `批次 ${batch['批次编号']} 重新检查完成：所有目标均已确认送达，当前状态「${status}」` }
}

// 复核通过：校验不一致只能由人工复核结论推进，系统不自动跳过。
function approveBatch(id: number): ActionResult {
  const { batches, index } = findBatch(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的分发批次` }
  }
  const batch = batches[index]
  if (batch.status !== BATCH_REVIEW) {
    return { ok: false, message: `分发批次当前状态「${batch.status}」，只有待复核批次能复核通过` }
  }
  const updated: EntryRow = { ...batch, status: BATCH_DONE, pending: false, abnormal: false }
  const next = [...batches]
  next[index] = updated
  saveRows(BATCH_MODULE, next)
  return { ok: true, message: `批次 ${batch['批次编号']} 已经人工复核确认，状态「已完成」，当时的分发格式与校验摘要保留不变` }
}

function runBatchAction(id: number, action: string): ActionResult {
  if (action === '开始分发') {
    return beginBatchSend(id)
  }
  if (action === '重新检查') {
    return recheckBatch(id)
  }
  if (action === '复核通过') {
    return approveBatch(id)
  }
  return { ok: false, message: `分发批次没有登记「${action}」这个动作` }
}

// 导出分发批次的完整性核对结果（含逐目标原始响应与校验摘要）。
export function exportBatchIntegrity(): { filename: string; content: string } {
  const header = ['批次编号', '关联通道', '输出数据集', '分发格式', '校验算法', '校验摘要', '目标系统', '目标回执', '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(BATCH_MODULE)) {
    lines.push(
      [
        row['批次编号'],
        row['关联通道'],
        row['输出数据集'],
        row['分发格式'],
        row['校验算法'] ?? '',
        row['校验摘要'],
        row['目标系统'],
        row['目标回执'],
        row.status,
      ].join(','),
    )
  }
  return { filename: '分发批次完整性结果.csv', content: `\uFEFF${lines.join('\n')}` }
}

// 下载已导出数据集索引：逐批次、逐分区文件列出路径与文件级校验摘要。
export function exportDatasetIndex(): { filename: string; content: string } {
  const header = ['输出数据集', '批次编号', '分区文件路径', '文件校验摘要', '批次状态']
  const lines = [header.join(',')]
  for (const row of listRows(BATCH_MODULE)) {
    const files = String(row['分区文件'] ?? '')
    if (!files.includes('part-')) {
      continue
    }
    const algo = String(row['校验算法'] || 'SHA-256')
    for (const file of files.split('；')) {
      lines.push([row['输出数据集'], row['批次编号'], file, `${algo}:${digestHex(file)}`, row.status].join(','))
    }
  }
  return { filename: '已导出数据集索引.csv', content: `\uFEFF${lines.join('\n')}` }
}

export function downloadBatchIntegrity(): void {
  const { filename, content } = exportBatchIntegrity()
  downloadTextFile(filename, content)
}

export function downloadDatasetIndex(): void {
  const { filename, content } = exportDatasetIndex()
  downloadTextFile(filename, content)
}

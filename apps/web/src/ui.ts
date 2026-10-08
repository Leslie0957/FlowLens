import type { Run } from '@flowlens/contracts';
export const statusLabel: Record<Run['status'], string> = {
  PENDING: '等待中',
  RUNNING: '运行中',
  SUCCEEDED: '已完成',
  FAILED: '已失败',
};
export const stepLabel: Record<string, string> = {
  read: '读取数据',
  validate: '校验字段',
  load: '写入数据',
  aggregate: '生成汇总',
};
export const stepOrder = ['read', 'validate', 'load', 'aggregate'];
export function formatTime(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
export function formatDuration(value: number | null) {
  if (value === null) return '—';
  return value < 1000 ? value + ' ms' : (value / 1000).toFixed(1) + ' s';
}
export function shortId(value: string) {
  return value.length > 12 ? value.slice(0, 8) + '…' + value.slice(-4) : value;
}

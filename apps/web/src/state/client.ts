import { computed, reactive } from 'vue';
import type { ApiResponse } from '@simcare/shared';
import { beijingDate } from '@simcare/shared';

export const clock = reactive({ now: Date.now() });
export const today = computed(() => beijingDate(new Date(clock.now)));
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    clock.now = Date.now();
  }, 60000);
  window.addEventListener('focus', () => {
    clock.now = Date.now();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clock.now = Date.now();
  });
}

export const notice = reactive({ message: '', kind: 'success' as 'success' | 'error' });
let noticeTimer: ReturnType<typeof setTimeout>;
export function notify(message: string, kind: 'success' | 'error' = 'success') {
  notice.message = message;
  notice.kind = kind;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.message = '';
  }, 6000);
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') return '验证已取消或超时，请重试';
    if (error.name === 'OperationError') return '解密失败，请检查备份密码和文件';
    return error.message;
  }
  return '操作未完成，请稍后重试';
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error('服务暂不可用，请检查网络后重试');
  const envelope = (await response.json()) as ApiResponse<T>;
  if (!envelope.success) {
    throw new Error(envelope.error.message);
  }
  if (!response.ok) throw new Error(`请求失败（${response.status}）`);
  return envelope.data;
}
export function displayTime(value: string | null | undefined, dateOnly = false): string {
  if (!value) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }),
  }).format(new Date(value));
}
export function downloadFile(filename: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

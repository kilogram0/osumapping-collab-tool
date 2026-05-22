import axios from 'axios';

export function extractApiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const detail = err.response?.data?.detail;
    if (typeof detail === 'string' && detail.length > 0) return detail;
  }
  return err instanceof Error ? err.message : fallback;
}

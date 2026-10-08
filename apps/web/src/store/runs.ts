import { defineStore } from 'pinia';
import { fetchRuns, type RunQuery, ApiError } from '../api.js';
import type { Run } from '@flowlens/contracts';
export const useRunsStore = defineStore('runs', {
  state: () => ({
    runs: [] as Run[],
    total: 0,
    loading: false,
    error: '',
    requestId: '',
    sequence: 0,
    controller: null as AbortController | null,
  }),
  actions: {
    async load(query: RunQuery, background = false) {
      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;
      const sequence = ++this.sequence;
      if (!background) this.loading = true;
      this.error = '';
      try {
        const response = await fetchRuns(query, controller.signal);
        if (sequence !== this.sequence) return;
        this.runs = response.data;
        this.total = response.page_info.total;
      } catch (error) {
        if (sequence !== this.sequence || controller.signal.aborted) return;
        this.error = error instanceof Error ? error.message : '加载失败';
        this.requestId = error instanceof ApiError ? error.requestId : '';
      } finally {
        if (sequence === this.sequence) this.loading = false;
      }
    },
    stop() {
      this.controller?.abort();
      this.sequence++;
    },
  },
});

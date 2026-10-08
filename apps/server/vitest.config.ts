import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A few cases create multiple real stdio services. Allow Windows startup
    // time while retaining explicit per-diagnosis and per-call budget tests.
    testTimeout: 15000,
  },
});

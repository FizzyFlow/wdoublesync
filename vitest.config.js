import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        testTimeout: 300_000,
        hookTimeout: 300_000,
        fileParallelism: false,
        pool: 'forks',
        isolate: false,
        poolOptions: { forks: { singleFork: true } },
        include: ['test/**/*.test.js'],
    },
});

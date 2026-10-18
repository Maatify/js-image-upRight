import { defineConfig, devices } from '@playwright/test';

const PORT = 4319;

export default defineConfig({
    testDir: './e2e',
    testMatch: '**/*.spec.mjs',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://localhost:${PORT}`,
    },
    webServer: {
        command: `node e2e/server.mjs`,
        port: PORT,
        reuseExistingServer: !process.env.CI,
        env: { PORT: String(PORT) },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
});

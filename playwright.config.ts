import { defineConfig, devices } from '@playwright/test'

const testOrigin = 'http://127.0.0.1:5174'
// Serve only the frontend. Missing wire fixtures must fail locally instead of
// reaching the development backend, the user's Codex process, or private data.
const frontendServerCommand = `node --input-type=module -e '
  import { createServer, loadConfigFromFile } from "vite";
  const loaded = await loadConfigFromFile({ command: "serve", mode: "development" });
  if (!loaded) throw new Error("Vite configuration was not found");
  const { proxy, ...serverOptions } = loaded.config.server || {};
  const server = await createServer({
    ...loaded.config,
    configFile: false,
    server: { ...serverOptions, host: "127.0.0.1", port: 5174, strictPort: true },
  });
  await server.listen();
'`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: 'list',
  use: {
    baseURL: testOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: frontendServerCommand,
    url: testOrigin,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})

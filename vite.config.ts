import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function appServiceWorker(): Plugin {
  let outputDirectory = '';
  return {
    name: 'codex-public-app-shell',
    apply: 'build',
    configResolved(config) { outputDirectory = path.resolve(config.root, config.build.outDir); },
    async writeBundle(_options, bundle) {
      const publicFiles = ['index.html', 'offline.html', 'manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
      const files = [...publicFiles, ...Object.keys(bundle).filter((name) => name.startsWith('assets/'))].sort();
      const template = await readFile(path.join(outputDirectory, 'sw.js'), 'utf8');
      const revision = createHash('sha256').update(template);
      for (const file of files) revision.update(file).update(await readFile(path.join(outputDirectory, file)));
      const worker = template.replace('__CODEX_BUILD__', revision.digest('hex').slice(0, 16)).replace('__CODEX_PRECACHE__', JSON.stringify(files.map((file) => `/${file}`)));
      await writeFile(path.join(outputDirectory, 'sw.js'), worker);
    },
  };
}

export default defineConfig({
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(Date.now().toString(36)) },
  plugins: [vue(), appServiceWorker()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } },
  },
  build: { target: 'es2022' },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    include: ['throughput'],
  },
  plugins: [
    react(),
    {
      name: 'jassub-desynchronized-fix',
      transform(code, id) {
        if (id.includes('jassub') && code.includes('desynchronized: true')) {
          return {
            code: code.replace(/desynchronized:\s*true/g, 'desynchronized: false'),
            map: null,
          };
        }
      },
    },
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', 'child_process', 'fs', 'fs/promises', 'path', 'os', 'http', 'url', 'crypto', 'events'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          plugins: [
            {
              name: 'force-cjs-preload',
              config(c) {
                c.build = c.build || {};
                c.build.lib = c.build.lib || {};
                c.build.lib.formats = ['cjs'];
                c.build.lib.fileName = () => 'preload.cjs';
              },
              closeBundle() {
                try {
                  const cjsPath = path.resolve(__dirname, 'dist-electron/preload.cjs');
                  const jsPath = path.resolve(__dirname, 'dist-electron/preload.js');
                  if (fs.existsSync(cjsPath)) {
                    fs.copyFileSync(cjsPath, jsPath);
                  }
                } catch (err) {
                  console.error('[vite.config.ts] Failed to copy preload.cjs to preload.js:', err);
                }
              },
            },
          ],
        },
      },
    ]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  base: './',
  plugins: [
    react(),
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
                } catch {}
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

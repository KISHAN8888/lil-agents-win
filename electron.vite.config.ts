import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          walker: resolve(__dirname, 'src/preload/walker.ts'),
          popover: resolve(__dirname, 'src/preload/popover.ts'),
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          walker: resolve(__dirname, 'src/renderer/walker/index.html'),
          popover: resolve(__dirname, 'src/renderer/popover/index.html'),
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
})

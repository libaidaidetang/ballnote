import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // 分包：Lexical 全家桶独立成 chunk，业务代码改动后缓存不失效，首屏并行加载
        manualChunks(id) {
          if (id.includes('node_modules') && (id.includes('\\lexical') || id.includes('/lexical') || id.includes('lexicals'))) {
            return 'lexical'
          }
        },
      },
    },
  },
  server: { port: 5173, strictPort: true },
})

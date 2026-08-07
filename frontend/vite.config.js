import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 11000,
    proxy: {
      '/api': {
        target: 'http://localhost:11001',
        changeOrigin: true,
      },
    },
  },
})

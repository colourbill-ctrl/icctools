import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy /api/* → validator service so the frontend never touches CORS directly
      '/api': {
        target: process.env.VITE_VALIDATOR_URL || 'http://localhost:3003',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})

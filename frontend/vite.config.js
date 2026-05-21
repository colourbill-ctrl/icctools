import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Production builds emit /profiletool/-rooted asset URLs because profiletool is
// served at chardata.colourbill.com/profiletool/. Dev keeps base='/' so
// http://localhost:5173/ continues to work as before.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/profiletool/' : '/',
  server: { port: 5173 },
}))

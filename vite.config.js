import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { harnessBackendPlugin } from './server/harnessBackend.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      tailwindcss(),
      harnessBackendPlugin({ ...env, ...process.env }),
    ],
    server: {
      host: '127.0.0.1',
      port: 5184,
      strictPort: true,
    },
  }
})

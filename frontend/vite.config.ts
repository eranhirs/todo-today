import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'demo'
    ? '/~REDACTED_USER/claude-todos/'
    : mode === 'gh-pages'
      ? '/claude-todos/'
      : '/',
  server: {
    proxy: {
      '/api': 'http://localhost:5151',
    },
  },
}))

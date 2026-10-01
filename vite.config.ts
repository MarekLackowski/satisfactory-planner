import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// production build is served from GitHub Pages at /satisfactory-planner/
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/satisfactory-planner/' : '/',
  plugins: [react()],
}))

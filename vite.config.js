import { defineConfig } from 'vite'

// Using port 5175 so it never collides with your other local projects (5173/5174)
export default defineConfig({
  server: {
    port: 5175,
    open: true,
  },
  build: {
    target: 'esnext',
  },
})

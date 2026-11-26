import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the same build works from a GitHub Pages project path
  // (https://<user>.github.io/<repo>/) and from inside a packed .ehpk.
  base: './',
  server: { host: true, port: 5173 },
  // Pre-bundling onnxruntime-web moves it away from its .wasm file, so the dev
  // server would answer the wasm request with index.html.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  test: { include: ['tests/**/*.test.ts'] },
})

import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  server: {
    host: "127.0.0.1",
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        terms: fileURLToPath(new URL("./terms.html", import.meta.url)),
      },
    },
  },
});

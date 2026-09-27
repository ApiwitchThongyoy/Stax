import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
// No application SSR, .env loading, database or remote API. Browser fetch is mocked by the fixture.
const server = await createServer({ configFile: false, envDir: false, plugins: [tailwindcss()],
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 5191, strictPort: true },
});
await server.listen();
console.log("STAX UI fixture: http://127.0.0.1:5191/scripts/fixtures/statement-ui/index.html");

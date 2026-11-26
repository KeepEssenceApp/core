import { loadConfig } from "./config.ts";
import { FilteringProxy } from "./proxy.ts";
import { Renderer } from "./render.ts";
import { createRunner } from "./server.ts";

const cfg = loadConfig();
const proxy = new FilteringProxy();
await proxy.listen();
const renderer = new Renderer(cfg, proxy);
const server = createRunner(cfg, renderer);
server.listen(cfg.port, cfg.host, () => console.log(JSON.stringify({ at: new Date().toISOString(), result: "listening", host: cfg.host, port: cfg.port })));

const stop = () => {
  server.close();
  void renderer
    .close()
    .then(() => proxy.close())
    .finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

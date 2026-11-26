import { loadConfig } from "./config.ts";
import { createJobs } from "./jobs.ts";
import { createPipeline } from "./media.ts";
import { FilteringProxy } from "./proxy.ts";
import { Renderer } from "./render.ts";
import { createRunner } from "./server.ts";

const cfg = loadConfig();
const proxy = new FilteringProxy();
await proxy.listen();
const renderer = new Renderer(cfg, proxy);
// What is said in a video post is read in the background, when a transcription worker is set (RUNNER_TRANSCRIBE_URL); otherwise a video post is "unavailable".
const jobs = createJobs({ ...createPipeline(cfg, proxy), enabled: !!cfg.transcribeUrl, maxSeconds: cfg.videoMaxMinutes * 60, concurrency: cfg.videoConcurrency, queue: cfg.videoQueue, cooldownMs: cfg.videoCooldownMs });
await jobs.ready;
const server = createRunner(cfg, renderer, (l) => console.log(l), jobs);
server.listen(cfg.port, cfg.host, () =>
  console.log(JSON.stringify({ at: new Date().toISOString(), result: "listening", host: cfg.host, port: cfg.port, video: cfg.transcribeUrl ? "on" : "off" })),
);

const stop = () => {
  server.close();
  void jobs
    .close()
    .then(() => renderer.close())
    .then(() => proxy.close())
    .finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

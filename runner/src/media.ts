// The media steps with the real programs: ask yt-dlp for a video's length, download it, cut the sound out with
// ffmpeg. Each is a function the jobs take as a parameter (jobs.ts), so the tests can stand in for all of them.
//
// What keeps this inside the rules:
//   - yt-dlp only talks through the filtering proxy (proxy.ts) on a read opened for it: only public addresses, a byte
//     cap, every connection cut when the read is closed. It is told to use its own HLS and DASH downloaders (so that
//     no segment is fetched by an ffmpeg that was not given the proxy), and its environment names the proxy too.
//   - ffmpeg only reads the local file: its protocol whitelist is `file`, so a playlist in a downloaded file cannot
//     make it open an address.
//   - Neither is given an address or path that did not come from detect.ts or from the job's own directory, and they
//     are run with argument lists (exec.ts). The argument lists hold the proxy's password: nothing here prints them.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isPublicUrl } from "../../src/services/publicurl.ts";
import type { Config } from "./config.ts";
import { COOLDOWN_STATUSES } from "./cooldown.ts";
import type { VideoRef } from "./detect.ts";
import { childEnv, run } from "./exec.ts";
import type { FilteringProxy } from "./proxy.ts";
import { transcribeFile, type Transcript } from "./transcribe.ts";

export type MediaRef = Exclude<VideoRef, { kind: "unsupported" }>;

/** The site refused (567, 412 or 429): not a video that cannot be read, but a door that is shut, and the jobs start a cool-down for it. */
export class Refused extends Error {
  status: number;
  constructor(status: number) {
    super(`the site refused (status ${status})`);
    this.status = status;
  }
}

export interface Pipeline {
  /** The length of the video at a media page, in seconds; null when it cannot be told (not found, a live stream, a login). */
  probe(page: string, signal: AbortSignal): Promise<number | null>;
  /** The video's file in `dir`. */
  download(ref: MediaRef, dir: string, signal: AbortSignal): Promise<string>;
  /** The sound of `file` as an .ogg in `dir`. */
  extractAudio(file: string, dir: string, signal: AbortSignal): Promise<string>;
  transcribe(audio: string, signal: AbortSignal): Promise<Transcript>;
}

/** The most a video read may add up to at the proxy, and what yt-dlp is told the file may be; the time a download may take. */
export const VIDEO_BYTES = 150 * 1024 * 1024;
export const DOWNLOAD_MS = 3 * 60 * 1000;
const PROBE_MS = 15000;
const PROBE_BYTES = 8 * 1024 * 1024;
const EXTRACT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- argument lists (pure)

export interface Via {
  /** `http://user:password@127.0.0.1:port`: the filtering proxy, with the credentials of one read. */
  proxy: string;
}

const COMMON = ["--ignore-config", "--no-cache-dir", "--no-warnings", "--no-playlist", "--socket-timeout", "15"];

/** yt-dlp asked for what it found at a media page, and nothing downloaded. */
export function ytdlpProbeArgs(o: Via & { page: string }): string[] {
  return [...COMMON, "--proxy", o.proxy, "--dump-json", "--no-download", "--", o.page];
}

/** yt-dlp asked for the sound (or, where a site has no separate sound, the best file), into `dir` as `media.<extension>`. */
export function ytdlpDownloadArgs(o: Via & { url: string; dir: string; referer?: string; ffmpeg?: string }): string[] {
  return [
    ...COMMON,
    "--proxy", o.proxy,
    "--downloader", "dash,m3u8:native",
    "-f", "ba/b",
    "--max-filesize", "150M",
    "--restrict-filenames",
    "-o", join(o.dir, "media.%(ext)s"),
    ...(o.referer ? ["--add-headers", `Referer:${o.referer}`] : []),
    ...(o.ffmpeg ? ["--ffmpeg-location", o.ffmpeg] : []),
    "--", o.url,
  ];
}

/** ffmpeg: the sound only, one channel, 16 kHz, Opus at 24 kbit/s in an .ogg. The input is the local file and nothing else. */
export function ffmpegArgs(o: { input: string; output: string }): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-protocol_whitelist", "file",
    "-i", `file:${o.input}`,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k",
    "-map_metadata", "-1",
    "-fs", String(64 * 1024 * 1024),
    `file:${o.output}`,
  ];
}

/** The proxy as yt-dlp wants it, and the same for a program it starts: both name the one read. */
const proxyUrl = (port: number, read: { username: string; password: string }) => `http://${read.username}:${read.password}@127.0.0.1:${port}`;
const proxyEnv = (url: string) => childEnv({ http_proxy: url, https_proxy: url, all_proxy: url, HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, no_proxy: "", NO_PROXY: "" });

/** `media.<extension>` in `dir`, not a half-written `media.mp4.part`. */
async function mediaIn(dir: string): Promise<string | null> {
  const found = (await readdir(dir)).filter((f) => /^media\.[A-Za-z0-9]{1,8}$/.test(f)).sort();
  return found.length ? join(dir, found[0]) : null;
}

// ---------------------------------------------------------------- with the programs

export function createPipeline(cfg: Config, proxy: FilteringProxy): Pipeline {
  // `--ffmpeg-location` only when the program was named by a path; a bare name is found on the search path as it is.
  const ffmpegLocation = cfg.ffmpeg.includes("/") ? cfg.ffmpeg : undefined;
  return {
    async probe(page, signal) {
      if (!isPublicUrl(page)) return null;
      const read = proxy.open(PROBE_BYTES);
      try {
        const via = proxyUrl(proxy.port, read);
        const out = await run(cfg.ytdlp, ytdlpProbeArgs({ proxy: via, page }), { signal, timeoutMs: PROBE_MS, capture: 4 * 1024 * 1024, env: proxyEnv(via), watchStatus: true });
        if (out.code !== 0) {
          if (out.status !== null && COOLDOWN_STATUSES.has(out.status)) throw new Refused(out.status);
          return null;
        }
        const line = out.stdout.split("\n").find((l) => l.trim());
        if (!line) return null;
        const info = JSON.parse(line) as { duration?: unknown; is_live?: unknown };
        if (info.is_live === true || typeof info.duration !== "number" || !Number.isFinite(info.duration) || info.duration <= 0) return null;
        return Math.ceil(info.duration);
      } finally {
        read.close();
      }
    },

    async download(ref, dir, signal) {
      const urls = (ref.kind === "direct" ? ref.urls : [ref.page]).filter(isPublicUrl);
      const referer = ref.kind === "direct" ? ref.referer : undefined;
      const until = Date.now() + DOWNLOAD_MS;
      let refused: number | null = null;
      for (const url of urls) {
        const left = until - Date.now();
        if (left <= 0) break;
        const read = proxy.open(VIDEO_BYTES);
        try {
          const via = proxyUrl(proxy.port, read);
          const out = await run(cfg.ytdlp, ytdlpDownloadArgs({ proxy: via, url, dir, referer, ffmpeg: ffmpegLocation }), { signal, timeoutMs: left, env: proxyEnv(via), watchStatus: true });
          const file = out.code === 0 ? await mediaIn(dir) : null;
          if (file) return file;
          // A site that has shut the door: the next address of the same video would only be another knock.
          if (out.status !== null && COOLDOWN_STATUSES.has(out.status)) {
            refused = out.status;
            break;
          }
        } catch {
          if (signal.aborted) throw new Error("aborted");
          // This address did not work; the next one may.
        } finally {
          read.close();
        }
      }
      if (refused !== null) throw new Refused(refused);
      throw new Error("no media was downloaded");
    },

    async extractAudio(file, dir, signal) {
      const output = join(dir, "audio.ogg");
      const out = await run(cfg.ffmpeg, ffmpegArgs({ input: file, output }), { signal, timeoutMs: EXTRACT_MS });
      if (out.code !== 0) throw new Error("the sound could not be taken out");
      return output;
    },

    async transcribe(audio, signal) {
      if (!cfg.transcribeUrl) throw new Error("no transcription worker");
      return transcribeFile({ url: cfg.transcribeUrl, bearer: cfg.transcribeKey }, audio, signal);
    },
  };
}

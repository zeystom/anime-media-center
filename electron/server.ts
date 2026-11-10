import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { storage } from './storage';
import { generateSingleThumbnail, readContainerDuration } from './ffmpeg';
import { isEpisodeDownloading } from './torrents';
import { isPathInside } from './pathSafety.ts';

// Implementation lives in pathSafety.ts (shared with libraryManager); re-exported
// so existing importers of server.ts keep working.
export { isPathInside } from './pathSafety.ts';

interface VideoFormatInfo {
  codec: string;
  canDirectStream: boolean;
}

const codecCache = new Map<string, VideoFormatInfo>();
let hasNvencCache: boolean | null = null;

async function checkNvencSupport(ffmpegPath: string): Promise<boolean> {
  if (hasNvencCache !== null) return hasNvencCache;
  if (!ffmpegPath) return false;
  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath, [
        '-hide_banner',
        '-f', 'lavfi',
        '-i', 'color=c=black:s=320x240:d=0.1',
        '-c:v', 'h264_nvenc',
        '-pix_fmt', 'yuv420p',
        '-f', 'null',
        '-',
      ], { windowsHide: true });
      p.on('close', (code) => {
        hasNvencCache = code === 0;
        resolve(hasNvencCache);
      });
      p.on('error', () => {
        hasNvencCache = false;
        resolve(false);
      });
    } catch {
      hasNvencCache = false;
      resolve(false);
    }
  });
}

async function getVideoFormat(filePath: string, ffmpegPath: string): Promise<VideoFormatInfo> {
  const cached = codecCache.get(filePath);
  if (cached) return cached;
  if (!ffmpegPath) return { codec: 'hevc', canDirectStream: false };

  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      p.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      p.on('close', () => {
        // Example: Stream #0:0(jpn): Video: hevc (Main 10), yuv420p10le...
        // Or:      Stream #0:0(jpn): Video: h264 (High), yuv420p...
        const match = stderr.match(/Stream #0:\d+.*?: Video: ([a-zA-Z0-9_-]+)(?:.*?, ([a-zA-Z0-9_]+))?/i);
        const codec = match ? match[1].toLowerCase() : 'hevc';
        const pixFmt = match && match[2] ? match[2].toLowerCase() : '';
        const is10Bit = /10|12|p10|p12/i.test(pixFmt) || /10/i.test(stderr.split('Video:')[1]?.split(',')[0] || '');
        const isH264 = /h264|avc/i.test(codec);
        // Chromium can direct-play standard 8-bit H.264 with zero-transcode copy.
        // 10-bit HEVC/H.264 or other codecs must be transcoded to 8-bit H.264.
        const canDirectStream = isH264 && !is10Bit;
        const info: VideoFormatInfo = { codec, canDirectStream };
        codecCache.set(filePath, info);
        resolve(info);
      });
      p.on('error', () => resolve({ codec: 'hevc', canDirectStream: false }));
    } catch {
      resolve({ codec: 'hevc', canDirectStream: false });
    }
  });
}

class ThumbnailQueue {
  private running = 0;
  private queue: (() => void)[] = [];
  private concurrency: number;

  constructor(concurrency = 3) {
    this.concurrency = concurrency;
  }

  async acquire(): Promise<() => void> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

function isAllowedFilePath(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;

  const settings = storage.getSettings();
  const roots: string[] = [];
  if (Array.isArray(settings.libraryFolders)) {
    roots.push(...settings.libraryFolders);
  }
  if (settings.defaultLibraryRoot) {
    roots.push(settings.defaultLibraryRoot);
  }
  // Also allow thumbnail directory for /thumb
  const thumbDir = storage.getThumbnailDir();
  roots.push(thumbDir);

  for (const root of roots) {
    if (!root) continue;
    if (isPathInside(targetPath, root)) {
      return true;
    }
  }
  return false;
}

export class LocalStreamServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private activeStreams: Set<ChildProcess> = new Set();
  private currentStreamProcess: ChildProcess | null = null;
  private currentStreamResponse: http.ServerResponse | null = null;
  private inFlightThumbs: Map<string, Promise<string>> = new Map();
  private cachedThumbFiles: Set<string> = new Set();
  private cardThumbQueue = new ThumbnailQueue(3);
  private scrubberThumbQueue = new ThumbnailQueue(2);

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Listen on 127.0.0.1 and random free port
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          console.log(`[StreamServer] Running on http://127.0.0.1:${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error('Failed to obtain server address'));
        }
      });

      this.server.on('error', (err) => {
        console.error('[StreamServer] Error:', err);
        reject(err);
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = req.headers.origin;
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;

    let allowedOrigin: string | null = null;
    if (!origin) {
      // Direct media requests from <video> / <img> tags without Origin header are permitted
    } else if (
      origin === 'null' ||
      origin.startsWith('file://') ||
      (devServerUrl && (origin === devServerUrl || origin === devServerUrl.replace(/\/$/, '')))
    ) {
      allowedOrigin = origin;
    } else {
      res.writeHead(403);
      res.end('Forbidden: Origin not allowed');
      return;
    }

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname;

    if (pathname === '/stream') {
      this.handleStream(req, res, parsedUrl.query).catch((err) => {
        console.error('[StreamServer] handleStream unhandled rejection:', err);
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
          try {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Internal Server Error: ${err?.message || 'Streaming failed'}`);
          } catch {}
        }
      });
    } else if (pathname === '/thumb') {
      this.handleThumb(req, res, parsedUrl.query);
    } else if (pathname?.startsWith('/font/')) {
      this.handleFont(req, res, pathname);
    } else if (pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: this.port }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private async handleStream(req: http.IncomingMessage, res: http.ServerResponse, query: any) {
    try {
      const filePath = query.file as string;
      const audioTrackStr = (query.audioTrack as string) || '0';
      const startTimeStr = (query.startTime as string) || '0';

      if (!filePath || !isAllowedFilePath(filePath) || !fs.existsSync(filePath)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Access denied or file not found');
        return;
      }

      // Guard against streaming partially downloaded or sparse torrent files
      try {
        const dir = path.dirname(filePath);
        const filesInDir = new Set(fs.readdirSync(dir).map((f) => f.toLowerCase()));
        const stat = fs.statSync(filePath);
        if (isEpisodeDownloading(filePath, filesInDir, stat)) {
          res.writeHead(423, { 'Content-Type': 'text/plain' });
          res.end('File is currently downloading in torrent client and cannot be streamed yet.');
          return;
        }
      } catch {}

      const settings = storage.getSettings();
      const ffmpegPath = settings.ffmpegPath;
      const startTime = Math.max(0, parseFloat(startTimeStr) || 0);
      const audioTrack = parseInt(audioTrackStr, 10) || 0;

      console.log(`[StreamServer] Streaming: "${filePath}" audioIndex:${audioTrack} startTime:${startTime}s`);

      // Check NVENC hardware encoder and video profile
      const videoFormat = await getVideoFormat(filePath, ffmpegPath);
      const hasNvenc = await checkNvencSupport(ffmpegPath);

      // Kill any previous stream processes to free up CPU, file handles, and memory
      this.stopActiveStreams();

      // Stream FFmpeg Fragmented MP4 (fMP4) directly to pipe:
      // Chromium natively supports hardware-accelerated H.264 with 100% rock-solid stability.
      // Fragmented MP4 with frag_keyframe+empty_moov+default_base_moof writes an initialization 'moov' atom at byte 0,
      // allowing Chromium to immediately initialize the video decoder with 0ms lag.
      // -map_chapters -1, -dn, -sn strictly prevent chapter/data/subtitle text streams from being muxed into MP4,
      // which otherwise triggers Chromium's 'ffmpeg_common.cc: Unsupported pixel format: -1' error!
      // -g 24 -forced-idr 1 ensures keyframe fragments are generated immediately every 1s, preventing FFmpeg
      // from buffering dozens of seconds of video in memory before flushing!
      const args = [
        '-hide_banner',
        '-ss', startTime.toString(),
        '-i', filePath,
        '-map', '0:v:0',
        '-map', `0:a:${audioTrack}?`,
      ];

      if (hasNvenc) {
        // Hardware NVENC encode: runs on NVIDIA ASIC at 500+ FPS with ~0% CPU usage.
        // Re-encodes frames with exact PTS starting at 0, fixes negative DTS desync,
        // generates clean IDR keyframes every 1s, and guarantees zero audio lag!
        args.push(
          '-c:v', 'h264_nvenc',
          '-pix_fmt', 'yuv420p',
          '-preset', 'p1',
          '-tune', 'll',
          '-cq', '19',
          '-g', '24',
          '-forced-idr', '1'
        );
      } else if (!videoFormat.canDirectStream) {
        // CPU fallback: ultrafast libx264 with bounded threads and 1080p scale cap to prevent CPU starvation on weak PCs
        const cpuThreads = Math.max(1, Math.min(4, (os.cpus()?.length || 2) - 1));
        args.push(
          '-vf', "scale=w='min(1920,iw)':h=-2",
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-crf', '20',
          '-g', '24',
          '-threads', cpuThreads.toString()
        );
      } else {
        // Native 8-bit H.264 input is copied directly with 0% CPU
        args.push('-c:v', 'copy');
      }

      args.push(
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '256k',
        '-af', 'aresample=async=1000:min_hard_comp=0.100000',
        '-max_muxing_queue_size', '1024',
        '-avoid_negative_ts', 'make_zero',
        '-map_chapters', '-1',
        '-dn',
        '-sn',
        '-flush_packets', '1',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'
      );

      // Important: stdio: ['ignore', 'pipe', 'ignore'] prevents the Windows OS pipe buffer from
      // filling up with FFmpeg progress text on stderr, which would cause FFmpeg to deadlock/freeze!
      let ffmpeg: ChildProcess;
      try {
        ffmpeg = spawn(ffmpegPath, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch (spawnErr: any) {
        console.error('[StreamServer] Failed to spawn FFmpeg:', spawnErr);
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Failed to spawn FFmpeg: ${spawnErr.message}`);
        }
        return;
      }

      this.currentStreamProcess = ffmpeg;
      this.currentStreamResponse = res;
      this.activeStreams.add(ffmpeg);

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Accept-Ranges': 'none',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'close',
      });

      ffmpeg.stdout?.pipe(res);

      let killed = false;
      const cleanup = () => {
        if (!killed) {
          killed = true;
          this.activeStreams.delete(ffmpeg);
          if (this.currentStreamProcess === ffmpeg) {
            this.currentStreamProcess = null;
          }
          if (this.currentStreamResponse === res) {
            this.currentStreamResponse = null;
          }
          try {
            ffmpeg.stdout?.unpipe();
            ffmpeg.stdout?.destroy();
          } catch {}
          try {
            ffmpeg.kill();
          } catch {}
        }
      };

      req.on('close', cleanup);
      res.on('close', cleanup);
      ffmpeg.on('close', cleanup);
      ffmpeg.on('error', (err) => {
        console.error('[StreamServer] FFmpeg process error:', err);
        cleanup();
      });
    } catch (err: any) {
      console.error('[StreamServer] Stream handling error:', err);
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Streaming error: ${err.message || 'Stream processing failed'}`);
        } catch {}
      }
    }
  }

  private async handleThumb(req: http.IncomingMessage, res: http.ServerResponse, query: any) {
    const filePath = query.file as string;
    const timeStr = (query.time as string) || '0';
    const isCard = query.type === 'card';

    if (!filePath || !isAllowedFilePath(filePath) || !fs.existsSync(filePath)) {
      res.writeHead(403);
      res.end('Access denied or file not found');
      return;
    }

    // 1. For card thumbnails, check if a local sidecar image exists next to the video file
    if (isCard) {
      const dir = path.dirname(filePath);
      const base = path.parse(filePath).name;
      const candidates = [
        path.join(dir, `${base}.jpg`),
        path.join(dir, `${base}.png`),
        path.join(dir, `${base}-thumb.jpg`),
        path.join(dir, `${base}-thumb.png`),
        path.join(dir, `${base}.thumb.jpg`),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.writeHead(200, {
              'Content-Type': cand.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
            });
            const sidecarStream = fs.createReadStream(cand);
            sidecarStream.on('error', () => {
              try { sidecarStream.destroy(); } catch {}
            });
            sidecarStream.pipe(res);
          }
          return;
        }
      }
    }

    const queryDuration = parseFloat(query.duration as string);
    let duration: number | undefined =
      !isNaN(queryDuration) && queryDuration > 0
        ? queryDuration
        : storage.getAllPlaybackProgress()[filePath]?.duration;
    if (!duration || duration <= 0) {
      const containerDur = readContainerDuration(filePath);
      if (containerDur && containerDur > 0) {
        duration = Math.round(containerDur);
      }
    }

    // Safe timestamp: for cards, default to 280 seconds (~4.5 minutes in) to avoid intro/OP; for scrubber, use requested time
    const rawTargetTime = isCard
      ? (timeStr && timeStr !== '60' && timeStr !== '0' ? parseFloat(timeStr) : 280)
      : Math.floor((Math.max(0, parseFloat(timeStr) || 0)) / 5) * 5;

    // Clamp seek time to duration so short videos (<280s) never seek past EOF and fail with 404
    let targetTime = rawTargetTime;
    if (duration && duration > 0) {
      if (isCard) {
        targetTime = Math.min(rawTargetTime, Math.max(1, duration * 0.2));
      } else {
        targetTime = Math.min(rawTargetTime, Math.max(0, duration - 1));
      }
    }

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
    const thumbDir = path.join(storage.getThumbnailDir(), fileHash);

    // For cards: dedicated card_hq.jpg. For scrubber: quantized 5-second interval bucket
    const thumbFile = isCard
      ? path.join(thumbDir, 'card_hq.jpg')
      : path.join(thumbDir, `thumb_${Math.floor(targetTime / 5) * 5}.jpg`);

    // 2. Fast Cache Hit (in-memory or disk)
    if (this.cachedThumbFiles.has(thumbFile) || fs.existsSync(thumbFile)) {
      this.cachedThumbFiles.add(thumbFile);
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        });
        const hitStream = fs.createReadStream(thumbFile);
        hitStream.on('error', () => {
          try { hitStream.destroy(); } catch {}
        });
        hitStream.pipe(res);
      }
      return;
    }

    try {
      const settings = storage.getSettings();
      let thumbPromise = this.inFlightThumbs.get(thumbFile);
      if (!thumbPromise) {
        thumbPromise = (async () => {
          const release = isCard
            ? await this.cardThumbQueue.acquire()
            : await this.scrubberThumbQueue.acquire();
          try {
            return await generateSingleThumbnail(
              filePath,
              targetTime,
              settings.ffmpegPath,
              thumbFile,
              { isCard }
            );
          } finally {
            release();
          }
        })();
        this.inFlightThumbs.set(thumbFile, thumbPromise);
        thumbPromise.finally(() => this.inFlightThumbs.delete(thumbFile));
      }

      const generated = await thumbPromise;

      if (res.writableEnded || res.destroyed || !res.socket?.writable) {
        return;
      }

      if (generated && fs.existsSync(generated)) {
        this.cachedThumbFiles.add(generated);
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          });
          const genStream = fs.createReadStream(generated);
          genStream.on('error', (err) => {
            console.error('[StreamServer] Thumbnail stream pipe error:', err);
            try { genStream.destroy(); } catch {}
          });
          genStream.pipe(res);
        }
      } else {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(404);
          res.end('Thumbnail not ready');
        }
      }
    } catch (e) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          res.writeHead(500);
          res.end('Error generating thumbnail');
        } catch {}
      }
    }
  }

  private handleFont(req: http.IncomingMessage, res: http.ServerResponse, rawPathname: string) {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPathname);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (!decodedPath.startsWith('/font/')) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const segments = decodedPath.slice('/font/'.length).split('/').filter(Boolean);
    if (segments.length !== 2) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const [fileHash, fontName] = segments;

    // Validate fileHash format (strictly 16 hex characters)
    if (!/^[a-f0-9]{16}$/i.test(fileHash)) {
      res.writeHead(400);
      res.end('Invalid file hash');
      return;
    }

    // Reject '..', path separators, or absolute paths in fontName
    if (fontName.includes('..') || fontName.includes('/') || fontName.includes('\\') || path.isAbsolute(fontName)) {
      res.writeHead(400);
      res.end('Invalid font name');
      return;
    }

    const fontsBaseDir = path.resolve(storage.getThumbnailDir(), 'fonts', fileHash);
    const resolvedFontPath = path.resolve(fontsBaseDir, fontName);

    // Verify resolved path is strictly within fontsBaseDir
    if (!isPathInside(resolvedFontPath, fontsBaseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let finalFontPath = resolvedFontPath;
    if (!fs.existsSync(finalFontPath)) {
      const fontsRoot = path.resolve(storage.getThumbnailDir(), 'fonts');
      try {
        const subdirs = fs.readdirSync(fontsRoot, { withFileTypes: true });
        for (const dir of subdirs) {
          if (dir.isDirectory() && dir.name !== fileHash && /^[a-f0-9]{16}$/i.test(dir.name)) {
            const candidate = path.resolve(fontsRoot, dir.name, fontName);
            if (fs.existsSync(candidate) && isPathInside(candidate, fontsRoot)) {
              finalFontPath = candidate;
              break;
            }
          }
        }
      } catch {}
    }

    if (fs.existsSync(finalFontPath)) {
      const ext = path.extname(fontName).toLowerCase();
      const contentType =
        ext === '.otf' ? 'font/otf' :
        ext === '.woff2' ? 'font/woff2' :
        ext === '.woff' ? 'font/woff' : 'font/ttf';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(finalFontPath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Font not found');
  }

  stopActiveStreams() {
    for (const p of this.activeStreams) {
      try {
        p.stdout?.unpipe();
        p.stdout?.destroy();
        p.kill();
      } catch {}
    }
    this.activeStreams.clear();
    this.currentStreamProcess = null;
    if (this.currentStreamResponse && !this.currentStreamResponse.writableEnded) {
      try {
        this.currentStreamResponse.end();
      } catch {}
      this.currentStreamResponse = null;
    }
  }

  stop() {
    this.stopActiveStreams();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

export const streamServer = new LocalStreamServer();

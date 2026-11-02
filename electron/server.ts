import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { storage } from './storage';
import { generateSingleThumbnail } from './ffmpeg';

interface VideoFormatInfo {
  codec: string;
  canDirectStream: boolean;
}

const codecCache = new Map<string, VideoFormatInfo>();
let hasNvencCache: boolean | null = null;

async function checkNvencSupport(ffmpegPath: string): Promise<boolean> {
  if (hasNvencCache !== null) return hasNvencCache;
  return new Promise((resolve) => {
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
  });
}

async function getVideoFormat(filePath: string, ffmpegPath: string): Promise<VideoFormatInfo> {
  const cached = codecCache.get(filePath);
  if (cached) return cached;

  return new Promise((resolve) => {
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
  });
}

export class LocalStreamServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private activeStreams: Set<ChildProcess> = new Set();
  private currentStreamProcess: ChildProcess | null = null;
  private currentStreamResponse: http.ServerResponse | null = null;
  private inFlightThumbs: Map<string, Promise<string>> = new Map();
  private cachedThumbFiles: Set<string> = new Set();
  private activeThumbAbort: AbortController | null = null;

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
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname;

    if (pathname === '/stream') {
      this.handleStream(req, res, parsedUrl.query);
    } else if (pathname === '/thumb') {
      this.handleThumb(req, res, parsedUrl.query);
    } else if (pathname?.startsWith('/font/')) {
      this.handleFont(req, res, pathname);
    } else if (pathname?.startsWith('/jassub/')) {
      this.handleJassub(req, res, pathname);
    } else if (pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: this.port }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private async handleStream(req: http.IncomingMessage, res: http.ServerResponse, query: any) {
    const filePath = query.file as string;
    const audioTrackStr = (query.audioTrack as string) || '0';
    const startTimeStr = (query.startTime as string) || '0';

    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing or invalid file parameter');
      return;
    }

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
      // CPU fallback: ultrafast libx264
      args.push(
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '20',
        '-g', '24'
      );
    } else {
      // Native 8-bit H.264 input is copied directly with 0% CPU
      args.push('-c:v', 'copy');
    }

    args.push(
      '-c:a', 'aac',
      '-ac', '2',
      '-b:a', '256k',
      '-af', 'aresample=async=1:first_pts=0',
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
    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this.currentStreamProcess = ffmpeg;
    this.currentStreamResponse = res;
    this.activeStreams.add(ffmpeg);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Transfer-Encoding': 'chunked',
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'close',
    });

    ffmpeg.stdout.pipe(res);

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
  }

  private async handleThumb(req: http.IncomingMessage, res: http.ServerResponse, query: any) {
    const filePath = query.file as string;
    const timeStr = (query.time as string) || '0';
    const isCard = query.type === 'card';

    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(400);
      res.end('File not found');
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
          res.writeHead(200, {
            'Content-Type': cand.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          });
          fs.createReadStream(cand).pipe(res);
          return;
        }
      }
    }

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
    const thumbDir = path.join(storage.getThumbnailDir(), fileHash);

    // For cards: dedicated card_hq.jpg. For scrubber: quantized 5-second interval bucket
    const thumbFile = isCard
      ? path.join(thumbDir, 'card_hq.jpg')
      : path.join(thumbDir, `thumb_${Math.floor((Math.max(0, parseFloat(timeStr) || 0)) / 5) * 5}.jpg`);

    // Safe timestamp: for cards, default to 280 seconds (~4.5 minutes in) to avoid intro/OP; for scrubber, use requested time
    const targetTime = isCard
      ? (timeStr && timeStr !== '60' && timeStr !== '0' ? parseFloat(timeStr) : 280)
      : Math.floor((Math.max(0, parseFloat(timeStr) || 0)) / 5) * 5;

    // 2. Fast Cache Hit (in-memory or disk)
    if (this.cachedThumbFiles.has(thumbFile) || fs.existsSync(thumbFile)) {
      this.cachedThumbFiles.add(thumbFile);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(thumbFile).pipe(res);
      return;
    }

    // 3. Abort any previous extraction in flight if a newer position has arrived
    if (this.activeThumbAbort) {
      try {
        this.activeThumbAbort.abort();
      } catch {}
      this.activeThumbAbort = null;
    }

    const abortController = new AbortController();
    this.activeThumbAbort = abortController;

    // Handle client disconnect / cancellation
    req.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    try {
      const settings = storage.getSettings();
      let thumbPromise = this.inFlightThumbs.get(thumbFile);
      if (!thumbPromise) {
        thumbPromise = generateSingleThumbnail(
          filePath,
          targetTime,
          settings.ffmpegPath,
          thumbFile,
          { isCard },
          abortController.signal
        );
        this.inFlightThumbs.set(thumbFile, thumbPromise);
        thumbPromise.finally(() => this.inFlightThumbs.delete(thumbFile));
      }

      const generated = await thumbPromise;

      if (abortController.signal.aborted || res.writableEnded) {
        return;
      }

      if (generated && fs.existsSync(generated)) {
        this.cachedThumbFiles.add(generated);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        });
        fs.createReadStream(generated).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Thumbnail not ready');
      }
    } catch (e) {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end('Error generating thumbnail');
      }
    }
  }

  private handleFont(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const parts = pathname.slice('/font/'.length).split('/');
    if (parts.length >= 2) {
      const fileHash = parts[0];
      const fontName = decodeURIComponent(parts.slice(1).join('/'));
      const fontPath = path.join(storage.getThumbnailDir(), 'fonts', fileHash, fontName);
      if (fs.existsSync(fontPath)) {
        const ext = path.extname(fontName).toLowerCase();
        const contentType =
          ext === '.otf' ? 'font/otf' :
          ext === '.woff2' ? 'font/woff2' :
          ext === '.woff' ? 'font/woff' : 'font/ttf';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
        });
        fs.createReadStream(fontPath).pipe(res);
        return;
      }
    }
    res.writeHead(404);
    res.end('Font not found');
  }

  private handleJassub(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const fileName = path.basename(pathname);
    const possiblePaths = [
      path.join(__dirname, '../public/jassub', fileName),
      path.join(__dirname, '../dist/jassub', fileName),
      path.join(process.cwd(), 'public/jassub', fileName),
      path.join(__dirname, '../../node_modules/jassub/dist/wasm', fileName),
      path.join(__dirname, '../../node_modules/jassub/dist', fileName),
    ];
    const foundPath = possiblePaths.find((p) => fs.existsSync(p));
    if (foundPath) {
      const ext = path.extname(fileName).toLowerCase();
      const contentType =
        ext === '.wasm' ? 'application/wasm' :
        ext === '.js' ? 'application/javascript' :
        ext === '.woff2' ? 'font/woff2' : 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(foundPath).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('JASSUB asset not found');
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

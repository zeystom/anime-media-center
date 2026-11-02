import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { storage } from './storage';
import { generateSingleThumbnail } from './ffmpeg';

export class LocalStreamServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private activeStreams: Set<ChildProcess> = new Set();
  private currentStreamProcess: ChildProcess | null = null;

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
    } else if (pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: this.port }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private handleStream(req: http.IncomingMessage, res: http.ServerResponse, query: any) {
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

    // Kill any previous stream process to free up CPU, file handles, and memory
    if (this.currentStreamProcess && !this.currentStreamProcess.killed) {
      try {
        this.currentStreamProcess.stdout?.destroy();
        this.currentStreamProcess.kill();
      } catch {}
      this.currentStreamProcess = null;
    }

    // Stream FFmpeg Matroska remuxing directly to pipe:
    // -ss before -i enables fast keyframe seek (<150ms)
    // -avoid_negative_ts make_zero aligns timestamps starting at 0 (placed on output)
    // -max_interleave_delta 100000 tightly interleaves audio packets with video frames (every 100ms)
    // -c:v copy preserves 10-bit HEVC/H.264 video with 0% CPU
    // -c:a aac -ac 2 transcodes any audio stream to standard stereo AAC
    // -flush_packets 1 forces immediate packet delivery over the pipe
    // (Note: -re is intentionally NOT used, so Chromium can burst-buffer audio & video instantly on seek)
    const args = [
      '-hide_banner',
      '-ss', startTime.toString(),
      '-i', filePath,
      '-map', '0:v:0',
      '-map', `0:a:${audioTrack}`,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ac', '2',
      '-b:a', '256k',
      '-avoid_negative_ts', 'make_zero',
      '-max_interleave_delta', '100000',
      '-flush_packets', '1',
      '-f', 'matroska',
      'pipe:1',
    ];

    // Important: stdio: ['ignore', 'pipe', 'ignore'] prevents the Windows OS pipe buffer from
    // filling up with FFmpeg progress text on stderr, which would cause FFmpeg to deadlock/freeze!
    const ffmpeg = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this.currentStreamProcess = ffmpeg;
    this.activeStreams.add(ffmpeg);

    res.writeHead(200, {
      'Content-Type': 'video/x-matroska',
      'Transfer-Encoding': 'chunked',
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
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
        try {
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

    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(400);
      res.end('File not found');
      return;
    }

    const time = Math.max(0, parseFloat(timeStr) || 0);
    // Quantize to 5-second intervals for caching efficiency
    const bucket = Math.floor(time / 5) * 5;

    const fileHash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
    const thumbDir = path.join(storage.getThumbnailDir(), fileHash);
    const thumbFile = path.join(thumbDir, `thumb_${bucket}.jpg`);

    if (fs.existsSync(thumbFile)) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(thumbFile).pipe(res);
      return;
    }

    try {
      const settings = storage.getSettings();
      const generated = await generateSingleThumbnail(filePath, bucket, settings.ffmpegPath, thumbFile);
      if (generated && fs.existsSync(generated)) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        });
        fs.createReadStream(generated).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Thumbnail generation failed');
      }
    } catch (e) {
      res.writeHead(500);
      res.end('Error generating thumbnail');
    }
  }

  stop() {
    for (const p of this.activeStreams) {
      try {
        p.kill('SIGKILL');
      } catch {}
    }
    this.activeStreams.clear();
    this.currentStreamProcess = null;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

export const streamServer = new LocalStreamServer();

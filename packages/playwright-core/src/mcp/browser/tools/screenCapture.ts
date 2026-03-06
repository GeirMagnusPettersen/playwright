/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';
import { z } from '../../../mcpBundle';
import { defineTabTool } from './tool';

const screenCaptureSchema = z.object({
  duration: z.number().default(2000).describe('Duration to capture in milliseconds (default: 2000ms). For CSS animations, use the animation duration + 500ms buffer.'),
  fps: z.number().default(10).describe('Frames per second to capture (default: 10). Higher = smoother but larger file. 10 is good for 250ms animations, 20 for fast transitions.'),
  filename: z.string().optional().describe('Output GIF filename. Defaults to transition-{timestamp}.gif'),
  format: z.enum(['gif', 'frames']).default('gif').describe('Output format: "gif" produces an animated GIF (requires Python + Pillow), "frames" saves numbered PNGs to a directory.'),
});

const screenCapture = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_screen_capture',
    title: 'Capture screen transition',
    description: 'Record a screen transition as an animated GIF or frame sequence. Use this to capture CSS animations, hover effects, loading states, or any visual change that a single screenshot cannot show. Start the capture, then trigger the transition (click, hover, etc.) — the tool records for the specified duration.',
    inputSchema: screenCaptureSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const duration = params.duration;
    const fps = params.fps;
    const frameInterval = 1000 / fps;
    const totalFrames = Math.ceil(duration / frameInterval);
    const format = params.format;

    // Bring window to foreground first (reuse screenshot's activation logic)
    try {
      const cdpSession = await tab.page.context().newCDPSession(tab.page);
      const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
      await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });

      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process');
          const browser = tab.page.context().browser();
          const browserSession = browser ? await (browser as any).newBrowserCDPSession() : null;
          const result = browserSession ? await browserSession.send('SystemInfo.getProcessInfo').catch(() => null) : null;
          const wv2Pid = result?.processInfo?.[0]?.id;
          if (browserSession)
            await browserSession.detach().catch(() => {});
          if (wv2Pid) {
            execSync(
              `powershell -NoProfile -Command "` +
              `Add-Type -Name WF2 -Namespace U33 -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern IntPtr FindWindow(string c, string t); [DllImport(\\\"user32.dll\\\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\\\"user32.dll\\\")] public static extern bool SetForegroundWindow(IntPtr h);' -EA SilentlyContinue; ` +
              `$ppid = (Get-CimInstance Win32_Process -Filter 'ProcessId=${wv2Pid}' -EA SilentlyContinue).ParentProcessId; ` +
              `if (-not $ppid) { exit }; ` +
              `$proc = Get-Process -Id $ppid -EA SilentlyContinue; ` +
              `$h = $proc.MainWindowHandle; ` +
              `if (-not $h -or $h -eq 0) { $h = [U33.WF2]::FindWindow([NullString]::Value, $proc.ProcessName) }; ` +
              `if ($h -and $h -ne 0) { [U33.WF2]::ShowWindow([IntPtr]$h, 9); [U33.WF2]::SetForegroundWindow([IntPtr]$h) }"`,
              { timeout: 5000, stdio: 'ignore' }
            );
          }
          await new Promise(r => setTimeout(r, 500));
        } catch {
          // Ignore foreground errors
        }
      }
      await cdpSession.detach();
    } catch {
      // Non-CDP — continue
    }
    await tab.page.bringToFront().catch(() => {});

    // Create temp directory for frames
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const framesDir = path.join(process.env.TEMP || '/tmp', `pw-capture-${timestamp}`);
    fs.mkdirSync(framesDir, { recursive: true });

    // Capture frames using CDP Page.captureScreenshot for speed
    const cdp = await tab.page.context().newCDPSession(tab.page);
    const frames: string[] = [];
    const startTime = Date.now();

    response.addCode(`// Capturing ${totalFrames} frames at ${fps}fps for ${duration}ms`);

    for (let i = 0; i < totalFrames; i++) {
      const elapsed = Date.now() - startTime;
      if (elapsed > duration + 500) break; // safety margin

      try {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
        const framePath = path.join(framesDir, `frame-${String(i).padStart(4, '0')}.png`);
        fs.writeFileSync(framePath, Buffer.from(data, 'base64'));
        frames.push(framePath);
      } catch {
        // Skip failed frames
      }

      // Wait for next frame interval
      const nextFrameTime = startTime + (i + 1) * frameInterval;
      const waitTime = nextFrameTime - Date.now();
      if (waitTime > 0)
        await new Promise(r => setTimeout(r, waitTime));
    }

    await cdp.detach();

    if (frames.length === 0)
      throw new Error('No frames were captured.');

    if (format === 'frames') {
      // Just return the frames directory
      response.addTextResult(`Captured ${frames.length} frames in ${Date.now() - startTime}ms\nFrames directory: ${framesDir}\nUse: python developer-knowledge/scripts/capture-transition-gif.py "${framesDir}" output.gif`);
      return;
    }

    // Stitch frames into GIF using Node.js (gif-encoder-2 + pngjs)
    const gifFilename = params.filename || `transition-${timestamp}.gif`;
    const resolvedFile = await response.resolveClientFile({ prefix: 'transition', ext: 'gif', suggestedFilename: gifFilename }, 'Animated transition capture');
    const gifPath = resolvedFile.absoluteName || path.resolve(gifFilename);

    try {
      const { PNG } = require('pngjs');
      const GIFEncoder = require('gif-encoder-2');

      // Read first frame for dimensions
      const firstPng = PNG.sync.read(fs.readFileSync(frames[0]));
      let width = firstPng.width;
      let height = firstPng.height;

      // Scale down if too large (> 800px wide)
      const scale = width > 800 ? 800 / width : 1;
      if (scale < 1) {
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const encoder = new GIFEncoder(width, height);
      encoder.setDelay(Math.round(frameInterval));
      encoder.setRepeat(0);
      encoder.start();

      for (const framePath of frames) {
        const png = PNG.sync.read(fs.readFileSync(framePath));
        if (scale < 1) {
          // Simple nearest-neighbor downscale
          const scaled = Buffer.alloc(width * height * 4);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const srcX = Math.floor(x / scale);
              const srcY = Math.floor(y / scale);
              const srcIdx = (srcY * png.width + srcX) * 4;
              const dstIdx = (y * width + x) * 4;
              scaled[dstIdx] = png.data[srcIdx];
              scaled[dstIdx + 1] = png.data[srcIdx + 1];
              scaled[dstIdx + 2] = png.data[srcIdx + 2];
              scaled[dstIdx + 3] = png.data[srcIdx + 3];
            }
          }
          encoder.addFrame(scaled);
        } else {
          encoder.addFrame(png.data);
        }
      }

      encoder.finish();
      const gifData = encoder.out.getData();
      fs.writeFileSync(gifPath, gifData);
      await response.addFileResult(resolvedFile, gifData);
      response.addTextResult(`Captured ${frames.length} frames in ${Date.now() - startTime}ms → ${gifPath} (${Math.round(gifData.length / 1024)}KB)`);
    } catch (error) {
      // GIF encoding failed — fall back to returning frames directory
      response.addTextResult(
        `Captured ${frames.length} frames in ${Date.now() - startTime}ms\n` +
        `GIF encoding failed: ${(error as Error).message}\n` +
        `Frames saved to: ${framesDir}`
      );
      return; // Don't cleanup frames if GIF failed
    }

    // Cleanup frames
    try {
      for (const f of frames) fs.unlinkSync(f);
      fs.rmdirSync(framesDir);
    } catch {
      // Ignore cleanup errors
    }
  },
});

export default [screenCapture];

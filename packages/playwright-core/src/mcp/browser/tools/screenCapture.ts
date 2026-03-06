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

    // Capture frames using Playwright's page.screenshot() — NOT CDP
    // Page.captureScreenshot. WebView2 companion apps have a transparent
    // background surface; page.screenshot() handles this correctly while
    // CDP captureScreenshot renders black backgrounds.
    const frames: string[] = [];
    const startTime = Date.now();

    response.addCode(`// Capturing ${totalFrames} frames at ${fps}fps for ${duration}ms`);

    for (let i = 0; i < totalFrames; i++) {
      const elapsed = Date.now() - startTime;
      if (elapsed > duration + 500) break;

      try {
        const framePath = path.join(framesDir, `frame-${String(i).padStart(4, '0')}.png`);
        await tab.page.screenshot({ type: 'png', path: framePath });
        frames.push(framePath);
      } catch {
        // Skip failed frames
      }

      // Wait for next frame interval
      const nextFrameTime = startTime + (i + 1) * frameInterval;
      const waitTime = nextFrameTime - Date.now();
      if (waitTime > 0)
        await new Promise(r => globalThis.setTimeout(r, waitTime));
    }

    if (frames.length === 0)
      throw new Error('No frames were captured.');

    if (format === 'frames') {
      // Just return the frames directory
      response.addTextResult(`Captured ${frames.length} frames in ${Date.now() - startTime}ms\nFrames directory: ${framesDir}\nUse: python developer-knowledge/scripts/capture-transition-gif.py "${framesDir}" output.gif`);
      return;
    }

    // Stitch frames into GIF using Node.js (gif-encoder-2 + pngjs)
    // WebView2 renders with transparent background — alpha-composite
    // each frame onto white before encoding to GIF.
    const gifFilename = params.filename || `transition-${timestamp}.gif`;
    const resolvedFile = await response.resolveClientFile({ prefix: 'transition', ext: 'gif', suggestedFilename: gifFilename }, 'Animated transition capture');
    const gifPath = resolvedFile.absoluteName || path.resolve(gifFilename);

    try {
      const GIFEncoder = require('gif-encoder-2');
      const { PNG } = require('pngjs');

      // Read first frame for dimensions
      const firstPng = PNG.sync.read(fs.readFileSync(frames[0]));
      const width = firstPng.width;
      const height = firstPng.height;

      const encoder = new GIFEncoder(width, height);
      encoder.setDelay(Math.round(frameInterval));
      encoder.setRepeat(0);
      encoder.start();

      for (const framePath of frames) {
        const png = PNG.sync.read(fs.readFileSync(framePath));
        // Alpha-composite onto white background
        for (let i = 0; i < png.data.length; i += 4) {
          const a = png.data[i + 3] / 255;
          png.data[i] = Math.round(png.data[i] * a + 255 * (1 - a));
          png.data[i + 1] = Math.round(png.data[i + 1] * a + 255 * (1 - a));
          png.data[i + 2] = Math.round(png.data[i + 2] * a + 255 * (1 - a));
          png.data[i + 3] = 255;
        }
        encoder.addFrame(png.data);
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

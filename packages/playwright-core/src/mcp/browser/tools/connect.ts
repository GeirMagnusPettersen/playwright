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

import { z } from '../../../mcpBundle';
import { defineTool } from './tool';
import * as playwright from '../../../..';

const connectSchema = z.object({
  endpoint: z.string().describe('CDP endpoint URL to connect to, e.g. "http://127.0.0.1:9225"'),
});

const connect = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_connect',
    title: 'Connect to CDP endpoint',
    description: 'Drop the current CDP connection and connect to a new endpoint. Use this to switch between companion apps on different CDP ports (e.g., Calendar:9225, Files:9224, People:9226) without restarting the MCP server.',
    inputSchema: connectSchema,
    type: 'action',
  },

  handle: async (context, params, response) => {
    const endpoint = params.endpoint;

    // Step 1: Close current browser connection
    try {
      const tab = context.currentTab();
      if (tab) {
        const browser = tab.page.context().browser();
        if (browser)
          await browser.close().catch(() => {});
      }
    } catch {
      // Stale connection — ignore
    }

    // Step 2: Connect to new endpoint
    try {
      const browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: 5000 });
      const browserContext = browser.contexts()[0];
      if (!browserContext)
        throw new Error('No browser context available on new endpoint');

      // Step 3: Reset the MCP context with the new browser context
      await context.resetWithBrowserContext(browserContext);

      // Step 4: Verify we have a page
      const tab = context.currentTab();
      const title = tab ? await tab.page.title().catch(() => 'Unknown') : 'No page';
      const url = tab ? tab.page.url() : 'N/A';

      response.addTextResult(`Connected to ${endpoint}\nPage: ${title}\nURL: ${url.slice(0, 80)}`);
      response.setIncludeFullSnapshot();
    } catch (error) {
      response.addError(
        `Failed to connect to ${endpoint}: ${(error as Error).message}\n\n` +
        `Troubleshooting:\n` +
        `  1. Is a companion app running with CDP on this port?\n` +
        `  2. Check: curl http://127.0.0.1:${new URL(endpoint).port}/json\n` +
        `  3. Kill orphans: Get-NetTCPConnection -LocalPort ${new URL(endpoint).port} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
      );
    }
  },
});

export default [connect];

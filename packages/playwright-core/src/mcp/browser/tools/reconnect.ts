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

const reconnect = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_reconnect',
    title: 'Reconnect to CDP',
    description: 'Drop the current CDP connection and reconnect to the configured endpoint. Use this when the target app was restarted and Playwright is connected to a stale or orphaned WebView2 process. After reconnecting, returns a page snapshot.',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (context, _params, response) => {
    // Close existing connection
    try {
      const tab = context.currentTab();
      if (tab) {
        await tab.page.context().browser()?.close().catch(() => {});
      }
    } catch {
      // Ignore errors from closing stale connection
    }

    // Reconnect by ensuring a new tab (triggers CDP reconnection)
    try {
      await context.ensureTab();
      response.setIncludeFullSnapshot();
      response.addTextResult('Successfully reconnected to CDP endpoint.');
    } catch (error) {
      response.addError(
        `Failed to reconnect: ${(error as Error).message}\n` +
        `This may indicate orphaned msedgewebview2 processes on the CDP port.\n` +
        `Fix: Kill all processes on the port, relaunch the app, then try again.\n` +
        `  PowerShell: Get-NetTCPConnection -LocalPort <port> -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
      );
    }
  },
});

export default [reconnect];

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
import { defineTabTool, defineTool } from './tool';
import { renderTabsMarkdown } from '../response';

const close = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_close',
    title: 'Close browser',
    description: 'Close the page',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (context, params, response) => {
    const result = renderTabsMarkdown([]);
    response.addTextResult(result.join('\n'));
    response.addCode(`await page.close()`);
    response.setClose();
  },
});

const resize = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_resize',
    title: 'Resize browser window',
    description: 'Resize the browser window',
    inputSchema: z.object({
      width: z.number().describe('Width of the browser window'),
      height: z.number().describe('Height of the browser window'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    // Block setViewportSize on CDP-connected WebView2 targets — it permanently
    // breaks the host's native viewport control. Layout corrupts and doesn't recover.
    const browser = tab.page.context().browser();
    if (browser && !(browser as any)._isCollocatedWithServer) {
      response.addError(
        'Error: browser_resize is not supported for CDP-connected targets (e.g., WebView2).\n' +
        'setViewportSize permanently breaks the host\'s viewport control.\n' +
        'Use Win32 MoveWindow to resize the native window instead.'
      );
      return;
    }
    response.addCode(`await page.setViewportSize({ width: ${params.width}, height: ${params.height} });`);
    await tab.page.setViewportSize({ width: params.width, height: params.height });
  },
});

export default [
  close,
  resize
];

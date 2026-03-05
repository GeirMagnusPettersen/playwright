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
import { defineTabTool } from './tool';

const clearCache = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_clear_cache',
    title: 'Clear browser cache',
    description: 'Clear the browser cache, cookies, and service workers. Useful when switching between dev server branches or prod/dev environments where stale cached code is served.',
    inputSchema: z.object({
      serviceWorkers: z.boolean().default(true).describe('Unregister all service workers (default: true)'),
      caches: z.boolean().default(true).describe('Delete all CacheStorage caches (default: true)'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const results: string[] = [];

    if (params.serviceWorkers) {
      const swCount = await tab.page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
        return regs.length;
      });
      results.push(`Unregistered ${swCount} service worker(s)`);
      response.addCode(`// Unregister service workers`);
      response.addCode(`const regs = await navigator.serviceWorker.getRegistrations();`);
      response.addCode(`await Promise.all(regs.map(r => r.unregister()));`);
    }

    if (params.caches) {
      const cacheCount = await tab.page.evaluate(async () => {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
        return names.length;
      });
      results.push(`Deleted ${cacheCount} cache(s)`);
      response.addCode(`// Clear CacheStorage`);
      response.addCode(`const names = await caches.keys();`);
      response.addCode(`await Promise.all(names.map(n => caches.delete(n)));`);
    }

    response.addTextResult(results.join('\n') + '\n\nRestart the app to load fresh code.');
  },
});

export default [clearCache];

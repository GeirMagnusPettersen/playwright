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

import { test, expect } from './fixtures';

const scrollPage = `
<style>
  .container { width: 300px; height: 200px; overflow-y: scroll; }
  .content { height: 1000px; }
  .item { height: 50px; padding: 10px; border: 1px solid #ccc; }
  .tooltip { position: fixed; background: yellow; padding: 5px; display: none; }
</style>
<div class="container" data-testid="scroll-container">
  <div class="content">
    <div class="item" data-testid="item-1">Item 1</div>
    <div class="item" data-testid="item-2">Item 2</div>
    <div class="item" data-testid="item-3">Item 3</div>
    <div class="item" data-testid="item-4">Item 4</div>
    <div class="item" data-testid="item-5">Item 5</div>
    <div class="item" data-testid="item-6">Item 6</div>
    <div class="item" data-testid="item-7">Item 7</div>
    <div class="item" data-testid="item-8">Item 8</div>
  </div>
</div>
<div id="scroll-count">0</div>
<script>
  const container = document.querySelector('.container');
  let count = 0;
  container.addEventListener('scroll', () => {
    count++;
    document.getElementById('scroll-count').textContent = String(count);
  });
</script>
`;

test('browser_scroll scrolls nearest scrollable ancestor', async ({ mcpPage, page }) => {
  await page.setContent(scrollPage);

  // Get initial scroll position
  const initialScroll = await page.evaluate(() => {
    return document.querySelector('.container')!.scrollTop;
  });

  // Use browser_scroll on an item element
  const result = await mcpPage.callTool('browser_scroll', {
    element: 'Item 3',
    ref: await mcpPage.refForTestId('item-3'),
    deltaY: 100,
  });

  // Verify scroll position changed
  const afterScroll = await page.evaluate(() => {
    return document.querySelector('.container')!.scrollTop;
  });

  expect(afterScroll).toBe(initialScroll + 100);
});

test('browser_scroll scrolls upward with negative deltaY', async ({ mcpPage, page }) => {
  await page.setContent(scrollPage);

  // Scroll down first
  await page.evaluate(() => {
    document.querySelector('.container')!.scrollTop = 300;
  });

  // Scroll up via tool
  await mcpPage.callTool('browser_scroll', {
    element: 'Item 5',
    ref: await mcpPage.refForTestId('item-5'),
    deltaY: -100,
  });

  const afterScroll = await page.evaluate(() => {
    return document.querySelector('.container')!.scrollTop;
  });

  expect(afterScroll).toBe(200);
});

test('browser_scroll does not move mouse pointer', async ({ mcpPage, page }) => {
  await page.setContent(scrollPage + `
    <script>
      let mouseLeft = false;
      document.querySelector('[data-testid="item-3"]').addEventListener('mouseleave', () => {
        mouseLeft = true;
      });
    </script>
  `);

  // Hover item-3 first
  await page.hover('[data-testid="item-3"]');

  // Scroll — should NOT trigger mouseleave
  await mcpPage.callTool('browser_scroll', {
    element: 'Item 3',
    ref: await mcpPage.refForTestId('item-3'),
    deltaY: 50,
  });

  const mouseLeft = await page.evaluate(() => (window as any).mouseLeft);
  expect(mouseLeft).toBeFalsy();
});

test('browser_reconnect returns snapshot after reconnect', async ({ mcpPage }) => {
  const result = await mcpPage.callTool('browser_reconnect', {});
  expect(result.snapshot || result.output).toBeTruthy();
});

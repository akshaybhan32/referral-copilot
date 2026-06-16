import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Tests ───────────────────────────────────────────────────────────────────

test('smoke test - search page loads', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Referral Copilot' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where should this patient go?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find facilities' })).toBeVisible();

  await expect(page.getByRole('link', { name: 'Search' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'My referrals' })).toBeVisible();
});

test('smoke test - shortlist page loads', async ({ page }) => {
  await page.goto('/shortlist');
  await expect(page.getByRole('heading', { name: 'My referrals' })).toBeVisible();
});

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

let testArtifactsDir: string;
let consoleLogs: string[] = [];
let consoleErrors: string[] = [];
let pageErrors: string[] = [];
let failedRequests: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleLogs = [];
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];

  testArtifactsDir = join(process.cwd(), '.smoke-test');
  mkdirSync(testArtifactsDir, { recursive: true });

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (!text.trim() || /^%[osd]$/.test(text.trim())) {
      return;
    }
    const location = msg.location();
    const locationStr = location.url ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';
    consoleLogs.push(`[${type}] ${text}${locationStr}`);
    if (type === 'error') {
      consoleErrors.push(`${text}${locationStr}`);
    }
  });

  page.on('pageerror', (error) => {
    const errorDetails = `Page error: ${error.message}\nStack: ${error.stack || 'No stack trace available'}`;
    pageErrors.push(errorDetails);
    console.error('Page error detected:', errorDetails);
  });

  page.on('requestfailed', (request) => {
    failedRequests.push(`Failed request: ${request.url()} - ${request.failure()?.errorText}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const testName = testInfo.title.replace(/ /g, '-').toLowerCase();
  const screenshotPath = join(testArtifactsDir, `${testName}-app-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const logsPath = join(testArtifactsDir, `${testName}-console-logs.txt`);
  const allLogs = [
    '=== Console Logs ===',
    ...consoleLogs,
    '\n=== Console Errors (React errors) ===',
    ...consoleErrors,
    '\n=== Page Errors ===',
    ...pageErrors,
    '\n=== Failed Requests ===',
    ...failedRequests,
  ];
  writeFileSync(logsPath, allLogs.join('\n'), 'utf-8');

  console.log(`Screenshot saved to: ${screenshotPath}`);
  console.log(`Console logs saved to: ${logsPath}`);
  if (consoleErrors.length > 0) {
    console.log('Console errors detected:', consoleErrors);
  }
  if (pageErrors.length > 0) {
    console.log('Page errors detected:', pageErrors);
  }
  if (failedRequests.length > 0) {
    console.log('Failed requests detected:', failedRequests);
  }

  await page.close();
});

#!/usr/bin/env node
/**
 * Unit test for src/chrome-use/restricted-url.ts — the chrome-use (CDP/devtools)
 * backend's restricted-URL classifier (issue #1858 / AGE-1310).
 *
 * chrome-use-connection.ts's screenshot() previously had no restricted-page guard
 * at all: CDP's Page.captureScreenshot doesn't require content-script permission,
 * so it would silently succeed and return real pixels of a chrome://, CWS-gallery,
 * or edge:// page instead of surfacing the same typed failure the extension
 * backend now returns for the identical URL (see VibeTechnologies/VibeWebAgent#1858
 * / this repo's chrome-use-connection.ts screenshot() fix). This test exercises
 * the classifier screenshot() now checks before calling into CDP.
 *
 * Run: npx tsx --test scripts/unit/restricted-url.test.ts
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { isRestrictedUrl, RESTRICTED_PAGE_CAPTURE_BLOCKED } from '../../src/chrome-use/restricted-url.js';

describe('isRestrictedUrl (chrome-use backend, issue #1858 / AGE-1310)', () => {
  test('new Chrome Web Store gallery (any path) is restricted', () => {
    assert.equal(isRestrictedUrl('https://chromewebstore.google.com/detail/x'), true);
  });

  test('legacy Chrome Web Store /webstore path is restricted', () => {
    assert.equal(isRestrictedUrl('https://chrome.google.com/webstore/detail/x'), true);
  });

  test('chrome.google.com WITHOUT the /webstore path is NOT restricted', () => {
    assert.equal(isRestrictedUrl('https://chrome.google.com/'), false);
  });

  test('chrome:// and edge:// scheme pages are restricted', () => {
    assert.equal(isRestrictedUrl('chrome://settings'), true);
    assert.equal(isRestrictedUrl('edge://settings'), true);
  });

  test('a normal https page is not restricted', () => {
    assert.equal(isRestrictedUrl('https://example.com/dashboard'), false);
  });

  test('a look-alike attacker subdomain is NOT restricted (proves URL parsing, not startsWith)', () => {
    assert.equal(isRestrictedUrl('https://chromewebstore.google.com.attacker.example/'), false);
  });

  test('RESTRICTED_PAGE_CAPTURE_BLOCKED is a stable, non-empty code string', () => {
    assert.equal(typeof RESTRICTED_PAGE_CAPTURE_BLOCKED, 'string');
    assert.ok(RESTRICTED_PAGE_CAPTURE_BLOCKED.length > 0);
  });
});

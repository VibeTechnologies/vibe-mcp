/**
 * Restricted-URL classifier for the chrome-use (CDP/devtools) backend.
 *
 * Mirrors lib/extension/tools/utils.js's isRestrictedUrl() in the VibeWebAgent
 * (extension) repo (see VibeTechnologies/VibeWebAgent, issue #1858 / AGE-1310) --
 * intentionally duplicated across repos/languages rather than unified, same as
 * that file's cross-reference note about PageContentProvider.ts. Keep both lists
 * in sync if Chrome's restricted-host set ever changes.
 *
 * Source: chromium/src/extensions/common/extension_urls.cc
 *   - kChromeWebstoreBaseURL    = "https://chrome.google.com/webstore"
 *   - kNewChromeWebstoreBaseURL = "https://chromewebstore.google.com/"
 */

const RESTRICTED_URL_SCHEME_PREFIXES = [
  'chrome-extension://',
  'chrome://',
  'edge://',
  'brave://',
  'about:',
  'data:',
  'file:',
  'devtools://',
  'view-source:',
  'chrome-search://',
];

interface RestrictedHost {
  hostname: string;
  pathnamePrefix?: string;
}

const RESTRICTED_HOSTS: RestrictedHost[] = [
  { hostname: 'chromewebstore.google.com' },
  { hostname: 'chrome.google.com', pathnamePrefix: '/webstore' },
  { hostname: 'microsoftedge.microsoft.com', pathnamePrefix: '/addons' },
];

/**
 * Stable typed-failure code for restricted-page screenshot capture (issue #1858 /
 * AGE-1310), matching the RESTRICTED_PAGE_CAPTURE_BLOCKED constant exported by the
 * extension repo's utils.js.
 */
export const RESTRICTED_PAGE_CAPTURE_BLOCKED = 'RESTRICTED_PAGE_CAPTURE_BLOCKED';

export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  if (RESTRICTED_URL_SCHEME_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return RESTRICTED_HOSTS.some(({ hostname: restrictedHostname, pathnamePrefix }) => {
    if (hostname !== restrictedHostname) return false;
    return !pathnamePrefix || parsed.pathname.startsWith(pathnamePrefix);
  });
}

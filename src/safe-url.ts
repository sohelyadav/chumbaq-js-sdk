/**
 * Schemes a page must never be navigated to, however the URL arrived.
 *
 * `javascript:` and `vbscript:` execute in the page's own origin, and `data:`
 * can carry a document that does the same. The destinations this SDK follows
 * — an in-app message button, a banner's call to action, a push campaign's
 * deep link — are all authored in the dashboard and delivered over the
 * network, so following one is running whatever came back from the API.
 *
 * `file:` and `blob:` are refused for the same reason rather than any known
 * exploit: neither is a destination a campaign has any business naming.
 */
const EXECUTABLE_SCHEMES = new Set([
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
]);

/**
 * The URL to navigate to, or `null` when it must not be followed.
 *
 * Checked with the browser's own parser rather than by matching the string,
 * because the string forms that reach a scheme are open-ended — leading
 * whitespace and control characters, mixed case, and HTML-decoded entities
 * all resolve to the same scheme once parsed, and a deny-list applied to the
 * raw text misses every one of them.
 *
 * A relative URL is resolved against the current document, so it keeps the
 * scheme the page already has and is always safe. Anything the parser
 * refuses is refused here too: a destination that cannot be parsed cannot be
 * navigated to in the first place.
 *
 * Custom app schemes (`myapp://product/42`) are allowed deliberately. A
 * Dyplink deep link is very often one, including in a webview, and an
 * allow-list of `http`/`https` would break the SDK's main use.
 */
export function safeNavigationUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Nothing to parse on its own means no scheme of its own, which is a
    // relative URL — it keeps whatever scheme the page already has, so
    // there is no scheme here to refuse. Resolving it against a base
    // separates that case from a destination that is simply malformed; the
    // base is a fixed one rather than `location`, which is not needed to
    // learn a scheme and does not exist outside a browser.
    try {
      new URL(raw, 'https://dyplink.invalid/');
      return raw;
    } catch {
      return null;
    }
  }

  return EXECUTABLE_SCHEMES.has(parsed.protocol.toLowerCase()) ? null : raw;
}

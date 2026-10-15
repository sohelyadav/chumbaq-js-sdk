export interface DeferredMatchResult {
  matched: boolean;
  linkId?: string;
  shortCode?: string;
  deepLinkParams?: Record<string, unknown>;
}

/**
 * The device description the server matches an install against. Mirrors
 * `FingerprintDto` on the API, where only `os` is required.
 *
 * Fingerprint matching needs `ip` — the server pairs an install with a click
 * from the same address — and a page cannot learn its own public address, so
 * from a browser this path only ever answers "not matched". It is here for a
 * caller that does know: a webview inside a native app, or a server relaying
 * on a device's behalf. Cookie matching, which runs first and needs none of
 * this, is the web's real path.
 */
export interface DeferredFingerprint {
  os?: string;
  ip?: string;
  osVersion?: string;
  model?: string;
  screenWidth?: number;
  screenHeight?: number;
}

/** What `POST /api/deferred/match` answers, inside its `data` envelope. */
interface ServerMatch {
  matched?: boolean;
  linkId?: string;
  shortCode?: string;
  params?: Record<string, unknown>;
}

export class DeferredDeepLink {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async match(params?: {
    /**
     * A description of this device. A bare string is read as the OS name,
     * which is the one field the server requires.
     */
    deviceFingerprint?: string | DeferredFingerprint;
    platform?: string;
  }): Promise<DeferredMatchResult> {
    // Check for cookie-based matching first
    const shortCode = this.getCookie('dyplink_ref');
    const paramsStr = this.getCookie('dyplink_params');

    if (shortCode) {
      let deepLinkParams: Record<string, unknown> = {};
      if (paramsStr) {
        try {
          deepLinkParams = JSON.parse(decodeURIComponent(paramsStr));
        } catch {
          // Invalid params
        }
      }
      return {
        matched: true,
        shortCode: decodeURIComponent(shortCode),
        deepLinkParams,
      };
    }

    // Try server-side fingerprint matching
    if (params?.deviceFingerprint) {
      try {
        const response = await fetch(`${this.baseUrl}/api/deferred/match`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
          },
          // `DeferredMatchDto` accepts `fingerprint` and `cookieRef` and
          // nothing else: the API's validation pipe runs with
          // `forbidNonWhitelisted`, so one extra top-level field — a
          // `platform`, say — makes the whole request a 400.
          body: JSON.stringify({
            fingerprint: this.toFingerprint(
              params.deviceFingerprint,
              params.platform,
            ),
          }),
        });

        if (response.ok) {
          const root = await response.json() as
            { data?: ServerMatch } & ServerMatch;
          const match = root.data ?? root;
          return {
            matched: match.matched ?? false,
            linkId: match.linkId,
            shortCode: match.shortCode,
            // The server calls them `params`; this result has always
            // called them `deepLinkParams`, and callers read that.
            deepLinkParams: match.params,
          };
        }
      } catch {
        // Silently fail
      }
    }

    return { matched: false };
  }

  /**
   * Normalises the caller's device description into `FingerprintDto`.
   *
   * `os` is the only field the server requires, so a caller that knows
   * nothing about the device still gets a well-formed request: the browser's
   * own platform stands in.
   */
  private toFingerprint(
    fingerprint: string | DeferredFingerprint,
    platform?: string,
  ): DeferredFingerprint & { os: string } {
    const fields: DeferredFingerprint =
      typeof fingerprint === 'string' ? { os: fingerprint } : fingerprint;

    return {
      ...fields,
      os: fields.os || platform || this.detectPlatform(),
    };
  }

  private getCookie(name: string): string | null {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
  }

  private detectPlatform(): string {
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    return 'web';
  }
}

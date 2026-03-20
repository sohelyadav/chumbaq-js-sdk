export interface DeferredMatchResult {
  matched: boolean;
  linkId?: string;
  shortCode?: string;
  deepLinkParams?: Record<string, unknown>;
}

export class DeferredDeepLink {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async match(params?: {
    deviceFingerprint?: string;
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
        const response = await fetch(`${this.baseUrl}/api/deferred-match`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
          },
          body: JSON.stringify({
            fingerprint: params.deviceFingerprint,
            platform: params.platform || this.detectPlatform(),
          }),
        });

        if (response.ok) {
          return await response.json();
        }
      } catch {
        // Silently fail
      }
    }

    return { matched: false };
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

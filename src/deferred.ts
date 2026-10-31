import { Diagnostics } from './diagnostics';

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
 * Sending one is how a caller opts into fingerprint matching: the server
 * pairs the install with a click from the same address, and it takes that
 * address from the request rather than from this body — so a page gets
 * fingerprint matching for free, and cannot ask for someone else's click.
 */
export interface DeferredFingerprint {
  os?: string;
  /**
   * @deprecated Never sent. `FingerprintDto` rejects it — an address in the
   * body was an instruction to claim whoever's click came from it — and the
   * server derives the real one from the request. Still accepted here so a
   * caller that passes it keeps compiling; it is dropped.
   */
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
  private diagnostics: Diagnostics;

  constructor(baseUrl: string, apiKey: string, diagnostics: Diagnostics = new Diagnostics()) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.diagnostics = diagnostics;
  }

  async match(params?: {
    /**
     * A description of this device. A bare string is read as the OS name,
     * which is the one field the server requires.
     */
    deviceFingerprint?: string | DeferredFingerprint;
    platform?: string;
  }): Promise<DeferredMatchResult> {
    // The redirect sets these on the way through, and they are what the
    // web's real match is made of.
    const cookieRef = this.getCookie('chumbaq_ref');
    const cookieParams = this.readParamsCookie();

    const fingerprint = params?.deviceFingerprint
      ? this.toFingerprint(params.deviceFingerprint, params.platform)
      : undefined;

    if (!cookieRef && !fingerprint) {
      this.diagnostics.debug('no cookie ref and no fingerprint — nothing to match on');
      return { matched: false };
    }

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
        //
        // The cookie ref goes in the body even though this used to answer
        // from the cookie alone and return before ever making the request.
        // The answer looked right, and the whole funnel downstream of it was
        // wrong: the server is what marks `ClickEventEntity.matched`, that
        // column is the join key from a click to its install and
        // conversions, and no `linkId` ever came back either. The Android
        // SDK has always sent it.
        body: JSON.stringify({
          ...(cookieRef ? { cookieRef } : {}),
          ...(fingerprint ? { fingerprint } : {}),
        }),
      });

      if (response.ok) {
        const root = await response.json() as
          { data?: ServerMatch } & ServerMatch;
        const match = root.data ?? root;

        if (!match.matched) {
          this.diagnostics.debug('the server found no click to match this install to');
          return { matched: false };
        }

        return {
          matched: true,
          linkId: match.linkId,
          // The link's own short code and params, as the server resolved
          // them; the cookie's stand in only if it somehow answered without
          // them. The server calls the params `params`, and this result has
          // always called them `deepLinkParams` — callers read that.
          shortCode: match.shortCode ?? cookieRef ?? undefined,
          deepLinkParams: match.params ?? cookieParams,
        };
      }

      this.diagnostics.warn(`deferred match answered ${response.status}`);
    } catch (error) {
      this.diagnostics.warn('deferred match did not reach the API', error);
    }

    // The request failed, and the cookie is still local evidence of where
    // this device came from. Handing it back is what lets an install opened
    // offline still route to the right place — but the server has not been
    // told, so the click stays unmatched until a later call reaches it.
    if (cookieRef) {
      this.diagnostics.debug('answering the deferred match from the cookie; the server has not recorded it');
      return {
        matched: true,
        shortCode: cookieRef,
        deepLinkParams: cookieParams,
      };
    }

    return { matched: false };
  }

  /**
   * Normalises the caller's device description into `FingerprintDto`.
   *
   * `os` is the only field the server requires, so a caller that knows
   * nothing about the device still gets a well-formed request: the browser's
   * own platform stands in. `ip` is dropped rather than forwarded — the DTO
   * refuses it outright, so forwarding one would turn the whole match into a
   * 400.
   */
  private toFingerprint(
    fingerprint: string | DeferredFingerprint,
    platform?: string,
  ): Omit<DeferredFingerprint, 'ip'> & { os: string } {
    const fields: DeferredFingerprint =
      typeof fingerprint === 'string' ? { os: fingerprint } : fingerprint;
    const { ip, ...sendable } = fields;

    if (ip) {
      this.diagnostics.debug('a fingerprint ip was dropped; the server derives the address from the request');
    }

    return {
      ...sendable,
      os: fields.os || platform || this.detectPlatform(),
    };
  }

  /** The deep link params the redirect left behind, if it left any. */
  private readParamsCookie(): Record<string, unknown> {
    // `getCookie` has already percent-decoded it.
    const raw = this.getCookie('chumbaq_params');
    if (!raw) return {};

    try {
      return JSON.parse(raw);
    } catch (error) {
      this.diagnostics.warn('the chumbaq_params cookie could not be read', error);
      return {};
    }
  }

  private getCookie(name: string): string | null {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
  }

  private detectPlatform(): string {
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    return 'web';
  }
}

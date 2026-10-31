import { Diagnostics } from './diagnostics';
import { safeNavigationUrl } from './safe-url';

export interface PushRegistrationResult {
  id: string;
  token: string;
  platform: string;
  isActive: boolean;
}

/**
 * A push payload's data keys, as the campaign sent them.
 *
 * On web this is `payload.data` from a Firebase Messaging `onMessage`
 * handler in a page, or `event.data.json().data` in a service worker's push
 * handler. The keys match the ones the mobile SDKs read, because the server
 * sends one payload to every channel.
 */
export type PushPayloadData = Record<string, unknown>;

/** Campaign id, so a report can say which campaign it belongs to. */
const CAMPAIGN_ID_DATA_KEY = 'chumbaq_campaign_id';
/** Where a tap should land. `link` is Firebase's own key, read second. */
const DEEP_LINK_DATA_KEYS = ['deep_link_url', 'link'];

export class PushManager {
  private baseUrl: string;
  private apiKey: string;
  private projectId: string;
  private diagnostics: Diagnostics;

  constructor(
    baseUrl: string,
    apiKey: string,
    projectId: string,
    diagnostics: Diagnostics = new Diagnostics(),
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.diagnostics = diagnostics;
  }

  async registerToken(params: {
    deviceFingerprint: string;
    token: string;
    platform: 'ios' | 'android' | 'web';
    provider?: 'fcm' | 'apns';
  }): Promise<PushRegistrationResult> {
    const response = await fetch(`${this.baseUrl}/api/push-tokens/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify({
        projectId: this.projectId,
        deviceFingerprint: params.deviceFingerprint,
        token: params.token,
        platform: params.platform,
        provider: params.provider || 'fcm',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register push token: ${error}`);
    }

    const result = await response.json();
    return result.data || result;
  }

  async unregisterToken(token: string): Promise<void> {
    await fetch(
      `${this.baseUrl}/api/push-tokens/unregister?projectId=${this.projectId}&token=${encodeURIComponent(token)}`,
      {
        method: 'DELETE',
        headers: { 'X-API-Key': this.apiKey },
      },
    );
  }

  // ── Campaign engagement ──────────────────────────────────────────────
  //
  // All three mobile SDKs report these; the web one did not, so every web
  // push campaign showed an accepted count and a click-through rate of
  // zero. The SDK never intercepts a message — a page cannot — so the host
  // hands it whatever its own Firebase Messaging handlers receive — in a
  // page or in a service worker, which is where most web pushes land.
  // `reportNotificationReceived` explains how a worker knows which device
  // it is, and the one case where it still cannot.

  /**
   * Reports that a campaign's push reached this browser.
   *
   * Call from a page — a foreground Firebase Messaging `onMessage` handler.
   * A payload that is not a Chumbaq campaign is ignored, so it is safe to
   * call for every message.
   *
   * **From a service worker's push handler too**, which on web is where
   * most deliveries actually arrive — a tab is usually not open, and a push
   * that wakes only the worker is the normal case rather than the edge one.
   *
   * ```ts
   * // sw.js
   * const chumbaq = new Chumbaq({ baseUrl, apiKey, projectId });
   * self.addEventListener('push', (event) => {
   *   const data = event.data.json().data;
   *   event.waitUntil(Promise.all([
   *     self.registration.showNotification(…),
   *     chumbaq.reportPushReceived(data),
   *   ]));
   * });
   * ```
   *
   * Do not call `init()` there: `init()` registers an identity, and in a
   * worker it would register a new one per activation. A worker builds the
   * SDK to report and nothing else.
   *
   * ## How a worker knows which device it is
   *
   * It could not, which is what was wrong here before. Identity lives in
   * `localStorage`, a `ServiceWorkerGlobalScope` has none, so the SDK minted
   * a fresh fingerprint on each activation; every report either created
   * another phantom device or — once the API started requiring an identity
   * row — was rejected outright, silently. The page now mirrors its id into
   * IndexedDB, which both contexts can reach, and a worker reports under
   * that: the same id the page would have reported, and the same one its
   * push token was registered under. The server's unique index on
   * (campaign, device, type) then absorbs the duplicate when a foreground
   * handler and the worker both report the same push, instead of counting it
   * twice.
   *
   * ## The one case that still refuses, and what it costs
   *
   * A worker whose mirror is empty reports nothing, and says so through the
   * diagnostic channel. That is a browser where IndexedDB cannot be opened
   * at all, or a device whose page has not been loaded once since this
   * version shipped — it heals on the next page load. Until then that
   * device's background deliveries go uncounted, which reads as web
   * `delivered` lower than iOS and Android for the same campaign (both of
   * those report receipt from their background handlers unconditionally).
   * Low is the deliberate side to err on: an uncounted delivery is a number
   * that catches up, while one counted against an invented id is a new row
   * in the device list and a permanent distortion of every rate derived
   * from it.
   *
   * `Chumbaq.reportPushReceived` wraps this and resolves the fingerprint —
   * see `Chumbaq.resolveReportingIdentity`.
   */
  async reportNotificationReceived(
    data: PushPayloadData,
    deviceFingerprint: string,
  ): Promise<void> {
    await this.reportEvent(data, deviceFingerprint, 'delivered');
  }

  /**
   * Reports a tap and hands back where it should go.
   *
   * Returns the campaign's deep link, or `null` when it has none — so a
   * caller can route in one step:
   *
   * `Chumbaq.reportPushClicked` wraps this and supplies the fingerprint.
   *
   * The URL is returned even when reporting fails: navigation is what the
   * user asked for and analytics must not stand in its way.
   */
  async reportNotificationClicked(
    data: PushPayloadData,
    deviceFingerprint: string,
  ): Promise<string | null> {
    const destination = this.destinationFor(data);
    await this.reportEvent(data, deviceFingerprint, 'click');
    return destination;
  }

  private async reportEvent(
    data: PushPayloadData,
    deviceFingerprint: string,
    type: 'delivered' | 'click',
  ): Promise<void> {
    const campaignId = this.campaignIdFrom(data);
    if (!campaignId) return;
    if (!deviceFingerprint) {
      this.diagnostics.warn(`a ${type} for campaign ${campaignId} had no device to report it against`);
      return;
    }

    try {
      await fetch(`${this.baseUrl}/api/push-notifications/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          projectId: this.projectId,
          campaignId,
          deviceFingerprint,
          type,
          platform: 'web',
          // A tap taken offline is only reported once the page is back, so
          // server receipt time would be the wrong moment.
          occurredAt: new Date().toISOString(),
        }),
        // A click report usually races a navigation away from the page.
        keepalive: true,
      });
    } catch (error) {
      // Best effort — never let reporting break a notification — but no
      // longer silent either.
      this.diagnostics.warn(`a ${type} for campaign ${campaignId} did not reach the API`, error);
    }
  }

  /** `null` for a push that is not a Chumbaq campaign. */
  private campaignIdFrom(data: PushPayloadData): string | null {
    const value = data?.[CAMPAIGN_ID_DATA_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * The campaign's destination, without reporting anything.
   *
   * Public because a report can be refused — a context with no device
   * identity to report under — and where the tap goes is not contingent on
   * analytics. `Chumbaq.reportPushClicked` uses this on that path.
   *
   * `data` comes from the push payload and may hold anything, so a value
   * that is not a non-empty string is treated as absent and the next key is
   * tried — the same precedence the Android, iOS and Flutter SDKs use.
   *
   * A destination a page must not be navigated to is treated as absent too.
   * This method's whole purpose is to hand a caller something to navigate
   * to, and the documented use is exactly that, so refusing it here is the
   * only place that reliably helps — see `safeNavigationUrl`.
   */
  destinationFor(data: PushPayloadData): string | null {
    for (const key of DEEP_LINK_DATA_KEYS) {
      const value = data?.[key];
      if (typeof value !== 'string' || value.length === 0) continue;
      const destination = safeNavigationUrl(value);
      if (destination) return destination;
    }
    return null;
  }
}

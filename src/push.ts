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
 * handler, or `event.data.json().data` in a service worker. The keys match
 * the ones the mobile SDKs read, because the server sends one payload to
 * every channel.
 */
export type PushPayloadData = Record<string, unknown>;

/** Campaign id, so a report can say which campaign it belongs to. */
const CAMPAIGN_ID_DATA_KEY = 'dyplink_campaign_id';
/** Where a tap should land. `link` is Firebase's own key, read second. */
const DEEP_LINK_DATA_KEYS = ['deep_link_url', 'link'];

export class PushManager {
  private baseUrl: string;
  private apiKey: string;
  private projectId: string;

  constructor(baseUrl: string, apiKey: string, projectId: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.projectId = projectId;
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
  // hands it whatever its own Firebase Messaging handlers receive.

  /**
   * Reports that a campaign's push reached this browser.
   *
   * Call from a foreground `onMessage` handler, or from a service worker's
   * push handler. A payload that is not a Dyplink campaign is ignored, so
   * it is safe to call for every message.
   *
   * `Dyplink.reportPushReceived` wraps this and supplies the fingerprint.
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
   * `Dyplink.reportPushClicked` wraps this and supplies the fingerprint.
   *
   * The URL is returned even when reporting fails: navigation is what the
   * user asked for and analytics must not stand in its way.
   */
  async reportNotificationClicked(
    data: PushPayloadData,
    deviceFingerprint: string,
  ): Promise<string | null> {
    const destination = this.deepLinkFrom(data);
    await this.reportEvent(data, deviceFingerprint, 'click');
    return destination;
  }

  private async reportEvent(
    data: PushPayloadData,
    deviceFingerprint: string,
    type: 'delivered' | 'click',
  ): Promise<void> {
    const campaignId = this.campaignIdFrom(data);
    if (!campaignId || !deviceFingerprint) return;

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
    } catch {
      // Best effort — never let reporting break a notification.
    }
  }

  /** `null` for a push that is not a Dyplink campaign. */
  private campaignIdFrom(data: PushPayloadData): string | null {
    const value = data?.[CAMPAIGN_ID_DATA_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * The campaign's destination.
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
  private deepLinkFrom(data: PushPayloadData): string | null {
    for (const key of DEEP_LINK_DATA_KEYS) {
      const value = data?.[key];
      if (typeof value !== 'string' || value.length === 0) continue;
      const destination = safeNavigationUrl(value);
      if (destination) return destination;
    }
    return null;
  }
}

import { Tracker, TrackOptions } from './tracker';
import { BannerPosition, BannerRenderer } from './banner';
import { DeferredDeepLink, DeferredFingerprint, DeferredMatchResult } from './deferred';
import { IdentityManager, IdentifyParams, IdentifyResult } from './identity';
import { PushManager, PushPayloadData, PushRegistrationResult } from './push';
import { EventTracker } from './events';
import { InAppMessageManager, InAppMessage, MessageAction, MessageCallback, ActionCallback } from './in-app-messages';

export interface DyplinkConfig {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  /** Auto-detect platform. Defaults to 'web'. */
  platform?: string;
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const STORAGE_KEY_ANON_ID = 'dyplink_anonymous_id';
const STORAGE_KEY_FINGERPRINT = 'dyplink_device_fp';
const COOKIE_NAME = 'dyplink_did';

export class Dyplink {
  private tracker: Tracker;
  private banner: BannerRenderer;
  private deferred: DeferredDeepLink;
  private identityManager: IdentityManager;
  private pushManager: PushManager;
  private eventTracker: EventTracker;
  private _inAppMessages: InAppMessageManager;
  private config: DyplinkConfig;

  private _anonymousId: string;
  private _identifiedId: string | null = null;
  private _deviceFingerprint: string;
  private _platform: string;
  private _initialized = false;

  constructor(config: DyplinkConfig) {
    this.config = config;
    this._platform = config.platform || 'web';
    this.tracker = new Tracker(config.baseUrl, config.apiKey);
    this.banner = new BannerRenderer(config.baseUrl, config.apiKey);
    this.deferred = new DeferredDeepLink(config.baseUrl, config.apiKey);
    this.identityManager = new IdentityManager(config.baseUrl, config.apiKey, config.projectId);
    this.pushManager = new PushManager(config.baseUrl, config.apiKey, config.projectId);
    this.eventTracker = new EventTracker(config.baseUrl, config.apiKey, config.projectId);

    // Restore or generate anonymous ID and device fingerprint
    this._anonymousId = this.getStorageItem(STORAGE_KEY_ANON_ID) || generateUUID();
    this._deviceFingerprint = this.getStorageItem(STORAGE_KEY_FINGERPRINT) || generateUUID();
    this.setStorageItem(STORAGE_KEY_ANON_ID, this._anonymousId);
    this.setStorageItem(STORAGE_KEY_FINGERPRINT, this._deviceFingerprint);

    this._inAppMessages = new InAppMessageManager(
      config.baseUrl,
      config.apiKey,
      config.projectId,
      this._deviceFingerprint,
      this._anonymousId,
    );
  }

  /** Initialize the SDK — registers the anonymous device and sets the tracking cookie. */
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    // Set cookie for server-side click attribution
    this.setCookie(COOKIE_NAME, this._deviceFingerprint, 365);

    // Register anonymous identity
    await this.identityManager.identify({
      deviceFingerprint: this._deviceFingerprint,
      platform: this._platform,
      distinctId: this._anonymousId,
    });

    // Start in-app message polling and check on app open
    this._inAppMessages.checkOnAppOpen();
    this._inAppMessages.startPolling(60000);
  }

  /** Access the in-app message manager for advanced configuration. */
  get inAppMessages(): InAppMessageManager {
    return this._inAppMessages;
  }

  /** Notify the SDK of a screen change — triggers screen-based in-app messages. */
  setScreen(screenName: string): void {
    this._inAppMessages.setScreen(screenName);
  }

  /** Get the current distinct ID (anonymous or identified). */
  get distinctId(): string {
    return this._identifiedId || this._anonymousId;
  }

  /** Get the device fingerprint. */
  get deviceFingerprint(): string {
    return this._deviceFingerprint;
  }

  /** Track a custom event. */
  async track(eventName: string, properties?: Record<string, unknown>): Promise<void> {
    return this.eventTracker.track(
      eventName,
      this.distinctId,
      this._deviceFingerprint,
      properties,
    );
  }

  async trackConversion(options: TrackOptions): Promise<void> {
    return this.tracker.trackConversion(options);
  }

  /**
   * Loads a banner widget and renders it as a strip.
   *
   * `widgetId` is a banner category from the dashboard: a project can have
   * several, for different placements, so there is no single "the banner".
   */
  async showBanner(widgetId: string, position: BannerPosition = 'bottom'): Promise<void> {
    await this.banner.load(widgetId);
    this.banner.render(position);
  }

  dismissBanner(): void {
    this.banner.dismiss();
  }

  async matchDeferredDeepLink(params?: {
    deviceFingerprint?: string | DeferredFingerprint;
    platform?: string;
  }): Promise<DeferredMatchResult> {
    return this.deferred.match(params);
  }

  /**
   * Identify the user. If transitioning from anonymous to identified,
   * merges the anonymous event history with the identified user.
   */
  async identify(params: IdentifyParams): Promise<IdentifyResult> {
    const previousDistinctId = this.distinctId;
    const newDistinctId = params.distinctId || params.externalUserId;

    const result = await this.identityManager.identify({
      ...params,
      deviceFingerprint: params.deviceFingerprint || this._deviceFingerprint,
      platform: params.platform || this._platform,
    });

    // If transitioning from anonymous to identified, merge histories
    if (newDistinctId && previousDistinctId !== newDistinctId) {
      this._identifiedId = newDistinctId;
      await this.identityManager.merge(previousDistinctId, newDistinctId);
      this._inAppMessages.setDistinctId(newDistinctId);
    }

    return result;
  }

  async registerPushToken(params: {
    deviceFingerprint?: string;
    token: string;
    platform: 'ios' | 'android' | 'web';
    provider?: 'fcm' | 'apns';
  }): Promise<PushRegistrationResult> {
    return this.pushManager.registerToken({
      ...params,
      deviceFingerprint: params.deviceFingerprint || this._deviceFingerprint,
    });
  }

  async unregisterPushToken(token: string): Promise<void> {
    return this.pushManager.unregisterToken(token);
  }

  /**
   * Reports that a push campaign reached this browser.
   *
   * The SDK never intercepts a message — a page cannot — so hand it the
   * payload your own Firebase Messaging handler receives. A payload that is
   * not a Dyplink campaign is ignored, so it is safe to call for every one.
   *
   * ```ts
   * onMessage(messaging, (payload) =>
   *   dyplink.reportPushReceived(payload.data));
   * ```
   */
  async reportPushReceived(data: PushPayloadData): Promise<void> {
    return this.pushManager.reportNotificationReceived(data, this._deviceFingerprint);
  }

  /**
   * Reports a tap on a push campaign and hands back where it should go.
   *
   * ```ts
   * const url = await dyplink.reportPushClicked(data);
   * if (url) router.push(url);
   * ```
   */
  async reportPushClicked(data: PushPayloadData): Promise<string | null> {
    return this.pushManager.reportNotificationClicked(data, this._deviceFingerprint);
  }

  /** Track a revenue event and update the user's LTV. */
  async trackRevenue(amount: number, currency?: string): Promise<void> {
    return this.identityManager.trackRevenue(
      this._deviceFingerprint,
      amount,
      currency,
    );
  }

  /** Reset the identity — generates new anonymous ID. */
  reset(): void {
    this._identifiedId = null;
    this._anonymousId = generateUUID();
    this.setStorageItem(STORAGE_KEY_ANON_ID, this._anonymousId);
  }

  private getStorageItem(key: string): string | null {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(key);
      }
    } catch { /* SSR/node env */ }
    return null;
  }

  private setStorageItem(key: string, value: string): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
      }
    } catch { /* SSR/node env */ }
  }

  private setCookie(name: string, value: string, days: number): void {
    try {
      if (typeof document !== 'undefined') {
        const d = new Date();
        d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
        document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/;SameSite=Lax`;
      }
    } catch { /* SSR/node env */ }
  }
}

export { Tracker, TrackOptions } from './tracker';
export { Banner, BannerPosition, BannerRenderer, BannerWidget } from './banner';
export { DeferredDeepLink, DeferredFingerprint, DeferredMatchResult } from './deferred';
export { IdentityManager, IdentifyParams, IdentifyResult } from './identity';
export { PushManager, PushPayloadData, PushRegistrationResult } from './push';
export { EventTracker, TrackEventOptions } from './events';
export { InAppMessageManager, InAppMessage, MessageAction, MessageCallback, ActionCallback } from './in-app-messages';
export default Dyplink;

import { Tracker, TrackOptions } from './tracker';
import { BannerPosition, BannerRenderer } from './banner';
import { DeferredDeepLink, DeferredFingerprint, DeferredMatchResult } from './deferred';
import { IdentityManager, IdentifyParams, IdentifyResult } from './identity';
import { PushManager, PushPayloadData, PushRegistrationResult } from './push';
import { EventTracker } from './events';
import { InAppMessageManager, InAppMessage, MessageAction, MessageCallback, ActionCallback } from './in-app-messages';
import { Diagnostics } from './diagnostics';
import { DeviceIdentityStore } from './device-identity-store';

export interface DyplinkConfig {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  /** Auto-detect platform. Defaults to 'web'. */
  platform?: string;
  /**
   * Write the SDK's diagnostics to the console. Off by default — see
   * `Diagnostics` for what lands there and why it is worth turning on while
   * integrating.
   */
  debug?: boolean;
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
  private diagnostics: Diagnostics;
  private deviceStore: DeviceIdentityStore;

  private _anonymousId: string;
  private _identifiedId: string | null = null;
  private _deviceFingerprint: string;
  private _platform: string;
  private _initialized = false;

  /**
   * Whether this is a page rather than a worker.
   *
   * A window's `_deviceFingerprint` is this device's id — restored from
   * `localStorage`, or minted here and used by everything else the page
   * does. A `ServiceWorkerGlobalScope` has no `localStorage` to restore
   * from, so the id the constructor minted there is a different one on every
   * activation and means nothing to the server; identity has to come from
   * the mirror instead. See `resolveReportingIdentity`.
   */
  private _inWindow: boolean;

  /** Whether the fingerprint came from, and was written back to, storage. */
  private _identityIsDurable: boolean;

  constructor(config: DyplinkConfig) {
    this.config = config;
    this._platform = config.platform || 'web';
    this.diagnostics = new Diagnostics(config.debug === true);
    this.tracker = new Tracker(config.baseUrl, config.apiKey, this.diagnostics);
    this.banner = new BannerRenderer(config.baseUrl, config.apiKey, this.diagnostics);
    this.deferred = new DeferredDeepLink(config.baseUrl, config.apiKey, this.diagnostics);
    this.identityManager = new IdentityManager(config.baseUrl, config.apiKey, config.projectId, this.diagnostics);
    this.pushManager = new PushManager(config.baseUrl, config.apiKey, config.projectId, this.diagnostics);
    this.eventTracker = new EventTracker(config.baseUrl, config.apiKey, config.projectId, this.diagnostics);

    // Restore or generate anonymous ID and device fingerprint
    this._anonymousId = this.getStorageItem(STORAGE_KEY_ANON_ID) || generateUUID();
    this._deviceFingerprint = this.getStorageItem(STORAGE_KEY_FINGERPRINT) || generateUUID();
    this.setStorageItem(STORAGE_KEY_ANON_ID, this._anonymousId);
    this.setStorageItem(STORAGE_KEY_FINGERPRINT, this._deviceFingerprint);

    this._inWindow = typeof document !== 'undefined';
    this._identityIsDurable = this.getStorageItem(STORAGE_KEY_FINGERPRINT) === this._deviceFingerprint;
    this.deviceStore = new DeviceIdentityStore(this.diagnostics);

    // Mirror the id for this origin's service workers, which cannot reach
    // `localStorage` and so cannot report push engagement without it. Only
    // a durable id, and only from a page: see `DeviceIdentityStore`. Not
    // awaited — nothing in a page's own work depends on it, and the reader
    // is a different context on a later activation.
    if (this._inWindow && this._identityIsDurable) {
      void this.deviceStore.write(this._deviceFingerprint);
    }

    this._inAppMessages = new InAppMessageManager(
      config.baseUrl,
      config.apiKey,
      config.projectId,
      this._deviceFingerprint,
      this._anonymousId,
      this.diagnostics,
    );
  }

  /** Initialize the SDK — registers the anonymous device and sets the tracking cookie. */
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    // A worker calling this would register a new identity on every
    // activation — it has no `localStorage` to restore the last one from.
    // Reporting push engagement is all a worker should build the SDK for.
    if (!this._inWindow) {
      this.diagnostics.warn('init() outside a window registers a new identity each time it runs; a service worker should only report push engagement');
    }

    // Set cookie for server-side click attribution
    this.setCookie(COOKIE_NAME, this._deviceFingerprint, 365);

    // Register anonymous identity. A failure here costs this device its
    // server-side identity, and with it any segment-targeted message — the
    // delivery service withholds those when it cannot resolve one — but it
    // says nothing about whether messages are eligible. It used to take
    // in-app messaging down with it for the life of the page: `identify`
    // throws on a 400 or a 401, so the two calls below were never reached
    // and nothing retried them.
    let identifyError: unknown;
    try {
      await this.identityManager.identify({
        deviceFingerprint: this._deviceFingerprint,
        platform: this._platform,
        distinctId: this._anonymousId,
      });
    } catch (error) {
      identifyError = error;
      this.diagnostics.warn('the anonymous identity could not be registered; in-app messaging starts anyway', error);
    }

    // Start in-app message polling and check on app open
    this._inAppMessages.checkOnAppOpen();
    this._inAppMessages.startPolling(60000);

    // Still raised, after messaging is running rather than instead of it: a
    // 401 here is usually a wrong API key, and swallowing it would trade one
    // silent failure for another.
    if (identifyError) throw identifyError;
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
   *
   * Callable from a service worker's push handler too, which is where most
   * web deliveries actually arrive — identity comes from the mirror there.
   * See `resolveReportingIdentity` and
   * `PushManager.reportNotificationReceived`.
   */
  async reportPushReceived(data: PushPayloadData): Promise<void> {
    const deviceFingerprint = await this.resolveReportingIdentity('delivery');
    if (!deviceFingerprint) return;

    return this.pushManager.reportNotificationReceived(data, deviceFingerprint);
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
    const deviceFingerprint = await this.resolveReportingIdentity('tap');
    // Where the tap should go is the caller's answer either way: navigation
    // is what the user asked for and analytics must not stand in its way.
    if (!deviceFingerprint) return this.pushManager.destinationFor(data);

    return this.pushManager.reportNotificationClicked(data, deviceFingerprint);
  }

  /**
   * The device id to report push engagement under, or `null` when this
   * context has none to offer.
   *
   * A page answers with its own id. A service worker cannot reach
   * `localStorage`, so the id its constructor minted is a fresh one per
   * activation and nothing the server knows about — it reads the id the page
   * mirrored into IndexedDB instead, which is the same id the page would
   * have reported and the same one its push token was registered under.
   *
   * `null` means the mirror is empty, which happens in exactly two cases: a
   * browser where IndexedDB cannot be opened, and a device whose page has
   * not loaded since this version of the SDK shipped. Both refuse rather
   * than report: a fabricated id is not a smaller error than a missing
   * report, it is a different device in the dashboard's device list, and the
   * API would reject it anyway — `PushAnalyticsService.recordEvent` 404s on
   * a fingerprint with no identity row.
   */
  private async resolveReportingIdentity(intent: string): Promise<string | null> {
    if (this._inWindow) return this._deviceFingerprint;

    const mirrored = await this.deviceStore.read();
    if (!mirrored) {
      this.diagnostics.warn(
        `a push ${intent} cannot be reported from this context: there is no mirrored device identity to report it `
        + 'under, and reporting under a new one would add a device rather than a delivery. '
        + 'It will resolve once the page has loaded once with this SDK version.',
      );
      return null;
    }

    return mirrored;
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

    // The in-app manager holds its own copy of the distinct ID, and it kept
    // the one belonging to the user who just logged out — so a campaign
    // targeted at them was served to whoever used the browser next.
    this._inAppMessages.reset(this._anonymousId);
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

export { Diagnostics } from './diagnostics';
export { Tracker, TrackOptions } from './tracker';
export { Banner, BannerPosition, BannerRenderer, BannerWidget } from './banner';
export { DeferredDeepLink, DeferredFingerprint, DeferredMatchResult } from './deferred';
export { IdentityManager, IdentifyParams, IdentifyResult } from './identity';
export { PushManager, PushPayloadData, PushRegistrationResult } from './push';
export { safeNavigationUrl } from './safe-url';
export { EventTracker, TrackEventOptions } from './events';
export { InAppMessageManager, InAppMessage, MessageAction, MessageCallback, ActionCallback } from './in-app-messages';
export default Dyplink;

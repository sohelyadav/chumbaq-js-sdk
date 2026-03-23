import { Tracker, TrackOptions } from './tracker';
import { BannerRenderer } from './banner';
import { DeferredDeepLink, DeferredMatchResult } from './deferred';
import { IdentityManager, IdentifyParams, IdentifyResult } from './identity';
import { PushManager, PushRegistrationResult } from './push';

export interface DyplinkConfig {
  baseUrl: string;
  apiKey: string;
  projectId: string;
}

export class Dyplink {
  private tracker: Tracker;
  private banner: BannerRenderer;
  private deferred: DeferredDeepLink;
  private identityManager: IdentityManager;
  private pushManager: PushManager;
  private config: DyplinkConfig;

  constructor(config: DyplinkConfig) {
    this.config = config;
    this.tracker = new Tracker(config.baseUrl, config.apiKey);
    this.banner = new BannerRenderer(config.baseUrl, config.projectId);
    this.deferred = new DeferredDeepLink(config.baseUrl, config.apiKey);
    this.identityManager = new IdentityManager(config.baseUrl, config.apiKey, config.projectId);
    this.pushManager = new PushManager(config.baseUrl, config.apiKey, config.projectId);
  }

  async trackConversion(options: TrackOptions): Promise<void> {
    return this.tracker.trackConversion(options);
  }

  async showBanner(): Promise<void> {
    await this.banner.load();
    this.banner.render();
  }

  dismissBanner(): void {
    this.banner.dismiss();
  }

  async matchDeferredDeepLink(params?: {
    deviceFingerprint?: string;
    platform?: string;
  }): Promise<DeferredMatchResult> {
    return this.deferred.match(params);
  }

  async identify(params: IdentifyParams): Promise<IdentifyResult> {
    return this.identityManager.identify(params);
  }

  async registerPushToken(params: {
    deviceFingerprint: string;
    token: string;
    platform: 'ios' | 'android' | 'web';
    provider?: 'fcm' | 'apns';
  }): Promise<PushRegistrationResult> {
    return this.pushManager.registerToken(params);
  }

  async unregisterPushToken(token: string): Promise<void> {
    return this.pushManager.unregisterToken(token);
  }
}

export { Tracker, TrackOptions } from './tracker';
export { BannerRenderer, BannerConfig } from './banner';
export { DeferredDeepLink, DeferredMatchResult } from './deferred';
export { IdentityManager, IdentifyParams, IdentifyResult } from './identity';
export { PushManager, PushRegistrationResult } from './push';
export default Dyplink;

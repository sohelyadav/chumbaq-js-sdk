import { Tracker, TrackOptions } from './tracker';
import { BannerRenderer } from './banner';
import { DeferredDeepLink, DeferredMatchResult } from './deferred';

export interface DyplinkConfig {
  baseUrl: string;
  apiKey: string;
  projectId: string;
}

export class Dyplink {
  private tracker: Tracker;
  private banner: BannerRenderer;
  private deferred: DeferredDeepLink;
  private config: DyplinkConfig;

  constructor(config: DyplinkConfig) {
    this.config = config;
    this.tracker = new Tracker(config.baseUrl, config.apiKey);
    this.banner = new BannerRenderer(config.baseUrl, config.projectId);
    this.deferred = new DeferredDeepLink(config.baseUrl, config.apiKey);
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
}

export { Tracker, TrackOptions } from './tracker';
export { BannerRenderer, BannerConfig } from './banner';
export { DeferredDeepLink, DeferredMatchResult } from './deferred';
export default Dyplink;

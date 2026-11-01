import { Diagnostics } from './diagnostics';

export interface IdentifyParams {
  deviceFingerprint: string;
  platform: string;
  distinctId?: string;
  externalUserId?: string;
  traits?: Record<string, unknown>;
  // Profile
  firstName?: string;
  lastName?: string;
  phone?: string;
  avatar?: string;
  locale?: string;
  language?: string;
  // Device (auto-detected if not provided)
  os?: string;
  osVersion?: string;
  browser?: string;
  browserVersion?: string;
  appVersion?: string;
  appBuild?: string;
  manufacturer?: string;
  brand?: string;
  model?: string;
  screenHeight?: number;
  screenWidth?: number;
  carrier?: string;
  timezone?: string;
  // Attribution
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  installSource?: string;
  installCampaign?: string;
  // Consent
  emailOptIn?: boolean;
  smsOptIn?: boolean;
  whatsappOptIn?: boolean;
  pushOptIn?: boolean;
  gdprConsent?: boolean;
  doNotTrack?: boolean;
}

export interface IdentifyResult {
  id: string;
  projectId: string;
  distinctId?: string;
  externalUserId?: string;
  deviceFingerprint: string;
  platform: string;
  traits?: Record<string, unknown>;
}

export class IdentityManager {
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

  async identify(params: IdentifyParams): Promise<IdentifyResult> {
    const autoDetected = this.autoDetectProperties();
    const utmParams = this.extractUtmParams();

    const body = {
      projectId: this.projectId,
      deviceFingerprint: params.deviceFingerprint,
      platform: params.platform,
      distinctId: params.distinctId,
      externalUserId: params.externalUserId,
      traits: params.traits,
      // Profile
      firstName: params.firstName,
      lastName: params.lastName,
      phone: params.phone,
      avatar: params.avatar,
      locale: params.locale || autoDetected.locale,
      language: params.language || autoDetected.language,
      // Device - user-provided takes precedence over auto-detected
      os: params.os || autoDetected.os,
      osVersion: params.osVersion || autoDetected.osVersion,
      browser: params.browser || autoDetected.browser,
      browserVersion: params.browserVersion || autoDetected.browserVersion,
      appVersion: params.appVersion,
      appBuild: params.appBuild,
      manufacturer: params.manufacturer,
      brand: params.brand,
      model: params.model || autoDetected.model,
      screenHeight: params.screenHeight || autoDetected.screenHeight,
      screenWidth: params.screenWidth || autoDetected.screenWidth,
      carrier: params.carrier,
      timezone: params.timezone || autoDetected.timezone,
      // Attribution - user-provided takes precedence over auto-detected
      referrer: params.referrer || autoDetected.referrer,
      utmSource: params.utmSource || utmParams.utmSource,
      utmMedium: params.utmMedium || utmParams.utmMedium,
      utmCampaign: params.utmCampaign || utmParams.utmCampaign,
      utmContent: params.utmContent || utmParams.utmContent,
      utmTerm: params.utmTerm || utmParams.utmTerm,
      installSource: params.installSource,
      installCampaign: params.installCampaign,
      // Consent
      emailOptIn: params.emailOptIn,
      smsOptIn: params.smsOptIn,
      whatsappOptIn: params.whatsappOptIn,
      pushOptIn: params.pushOptIn,
      gdprConsent: params.gdprConsent,
      doNotTrack: params.doNotTrack ?? autoDetected.doNotTrack,
    };

    // Strip undefined values
    const cleanBody = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );

    const response = await fetch(`${this.baseUrl}/api/identity/identify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify(cleanBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to identify device: ${error}`);
    }

    const result = await response.json();
    return result.data || result;
  }

  async merge(anonymousId: string, identifiedId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/identity/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          projectId: this.projectId,
          anonymousId,
          identifiedId,
        }),
      });
    } catch (error) {
      // Never thrown on, but a failed merge loses the anonymous history
      // this user built before logging in.
      this.diagnostics.warn(`merging ${anonymousId} into ${identifiedId} failed`, error);
    }
  }

  async trackRevenue(
    deviceFingerprint: string,
    amount: number,
    currency?: string,
  ): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/identity/revenue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          projectId: this.projectId,
          deviceFingerprint,
          amount,
          currency,
        }),
      });
    } catch (error) {
      this.diagnostics.warn(`a revenue event of ${amount} was not recorded`, error);
    }
  }

  private autoDetectProperties(): Record<string, any> {
    const props: Record<string, any> = {};

    try {
      if (typeof navigator === 'undefined') return props;

      // Browser & OS from user agent
      const ua = navigator.userAgent || '';
      props.browser = this.detectBrowser(ua);
      props.browserVersion = this.detectBrowserVersion(ua);
      props.os = this.detectOS(ua);
      props.osVersion = this.detectOSVersion(ua);
      props.model = this.detectModel(ua);

      // Screen
      if (typeof screen !== 'undefined') {
        props.screenHeight = screen.height;
        props.screenWidth = screen.width;
      }

      // Locale & language
      props.locale = navigator.language || undefined;
      props.language = (navigator.language || '').split('-')[0] || undefined;

      // Timezone
      try {
        props.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch { /* no timezone support */ }

      // Referrer
      if (typeof document !== 'undefined' && document.referrer) {
        props.referrer = document.referrer;
      }

      // Do Not Track
      if ((navigator as any).doNotTrack === '1' || (window as any).doNotTrack === '1') {
        props.doNotTrack = true;
      }
    } catch { /* SSR/node env */ }

    return props;
  }

  private extractUtmParams(): Record<string, string | undefined> {
    const params: Record<string, string | undefined> = {};
    try {
      if (typeof window === 'undefined') return params;
      const search = new URLSearchParams(window.location.search);
      params.utmSource = search.get('utm_source') || undefined;
      params.utmMedium = search.get('utm_medium') || undefined;
      params.utmCampaign = search.get('utm_campaign') || undefined;
      params.utmContent = search.get('utm_content') || undefined;
      params.utmTerm = search.get('utm_term') || undefined;
    } catch { /* SSR/node env */ }
    return params;
  }

  private detectBrowser(ua: string): string | undefined {
    if (ua.includes('Firefox/')) return 'Firefox';
    if (ua.includes('Edg/')) return 'Edge';
    if (ua.includes('OPR/') || ua.includes('Opera/')) return 'Opera';
    if (ua.includes('Chrome/') && !ua.includes('Edg/')) return 'Chrome';
    if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Safari';
    if (ua.includes('MSIE') || ua.includes('Trident/')) return 'IE';
    return undefined;
  }

  private detectBrowserVersion(ua: string): string | undefined {
    const patterns: [string, RegExp][] = [
      ['Firefox', /Firefox\/([\d.]+)/],
      ['Edge', /Edg\/([\d.]+)/],
      ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
      ['Chrome', /Chrome\/([\d.]+)/],
      ['Safari', /Version\/([\d.]+)/],
    ];
    for (const [, regex] of patterns) {
      const match = ua.match(regex);
      if (match) return match[1];
    }
    return undefined;
  }

  private detectOS(ua: string): string | undefined {
    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'macOS';
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('Linux')) return 'Linux';
    if (ua.includes('CrOS')) return 'Chrome OS';
    return undefined;
  }

  private detectOSVersion(ua: string): string | undefined {
    const patterns: RegExp[] = [
      /Windows NT ([\d.]+)/,
      /Mac OS X ([\d_.]+)/,
      /iPhone OS ([\d_]+)/,
      /iPad.*OS ([\d_]+)/,
      /Android ([\d.]+)/,
    ];
    for (const regex of patterns) {
      const match = ua.match(regex);
      if (match) return match[1].replace(/_/g, '.');
    }
    return undefined;
  }

  private detectModel(ua: string): string | undefined {
    if (ua.includes('iPhone')) return 'iPhone';
    if (ua.includes('iPad')) return 'iPad';
    const androidMatch = ua.match(/;\s*([^;)]+)\s+Build\//);
    if (androidMatch) return androidMatch[1].trim();
    return undefined;
  }
}

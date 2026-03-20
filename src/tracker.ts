export interface TrackOptions {
  linkId?: string;
  shortCode?: string;
  eventType: string;
  metadata?: Record<string, unknown>;
  externalUserId?: string;
}

export class Tracker {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async trackClick(shortCode: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/${shortCode}`, {
        method: 'GET',
        headers: { 'X-API-Key': this.apiKey },
      });
    } catch {
      // Silently fail for tracking
    }
  }

  async trackConversion(options: TrackOptions): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/conversions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          shortCode: options.shortCode,
          linkId: options.linkId,
          eventType: options.eventType,
          metadata: options.metadata,
          externalUserId: options.externalUserId,
        }),
      });
    } catch {
      // Silently fail for tracking
    }
  }
}

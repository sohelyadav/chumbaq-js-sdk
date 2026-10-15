import { Diagnostics } from './diagnostics';

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
  private diagnostics: Diagnostics;

  constructor(baseUrl: string, apiKey: string, diagnostics: Diagnostics = new Diagnostics()) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.diagnostics = diagnostics;
  }

  async trackClick(shortCode: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/${shortCode}`, {
        method: 'GET',
        headers: { 'X-API-Key': this.apiKey },
      });
    } catch (error) {
      // Never thrown on — tracking is not worth breaking a page over.
      this.diagnostics.warn(`the click on ${shortCode} was not reported`, error);
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
    } catch (error) {
      this.diagnostics.warn(`the ${options.eventType} conversion was not reported`, error);
    }
  }
}

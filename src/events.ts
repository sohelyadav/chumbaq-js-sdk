import { Diagnostics } from './diagnostics';

export interface TrackEventOptions {
  eventName: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

export class EventTracker {
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

  async track(
    eventName: string,
    distinctId: string,
    deviceFingerprint: string,
    properties?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/events/track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          projectId: this.projectId,
          eventName,
          distinctId,
          deviceFingerprint,
          properties,
        }),
      });

      if (!response.ok) {
        this.diagnostics.warn(`the ${eventName} event answered ${response.status}`);
      }
    } catch (error) {
      // Never thrown on — tracking is not worth breaking a page over.
      this.diagnostics.warn(`the ${eventName} event did not reach the API`, error);
    }
  }
}

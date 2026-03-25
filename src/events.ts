export interface TrackEventOptions {
  eventName: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

export class EventTracker {
  private baseUrl: string;
  private apiKey: string;
  private projectId: string;

  constructor(baseUrl: string, apiKey: string, projectId: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.projectId = projectId;
  }

  async track(
    eventName: string,
    distinctId: string,
    deviceFingerprint: string,
    properties?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/events/track`, {
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
    } catch {
      // Silently fail for tracking
    }
  }
}

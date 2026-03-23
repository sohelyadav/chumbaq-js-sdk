export interface PushRegistrationResult {
  id: string;
  token: string;
  platform: string;
  isActive: boolean;
}

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
}

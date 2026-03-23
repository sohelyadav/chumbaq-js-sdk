export interface IdentifyParams {
  deviceFingerprint: string;
  platform: string;
  distinctId?: string;
  externalUserId?: string;
  traits?: Record<string, unknown>;
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

  constructor(baseUrl: string, apiKey: string, projectId: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.projectId = projectId;
  }

  async identify(params: IdentifyParams): Promise<IdentifyResult> {
    const response = await fetch(`${this.baseUrl}/api/identity/identify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify({
        projectId: this.projectId,
        deviceFingerprint: params.deviceFingerprint,
        platform: params.platform,
        distinctId: params.distinctId,
        externalUserId: params.externalUserId,
        traits: params.traits,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to identify device: ${error}`);
    }

    const result = await response.json();
    return result.data || result;
  }
}

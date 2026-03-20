export interface BannerConfig {
  title: string;
  description?: string;
  ctaText: string;
  position: 'top' | 'bottom';
  theme?: Record<string, string>;
  targetUrl: string;
}

export class BannerRenderer {
  private baseUrl: string;
  private projectId: string;
  private banner: BannerConfig | null = null;
  private element: HTMLElement | null = null;

  constructor(baseUrl: string, projectId: string) {
    this.baseUrl = baseUrl;
    this.projectId = projectId;
  }

  async load(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/banners/serve/${this.projectId}`);
      if (response.ok) {
        this.banner = await response.json();
      }
    } catch {
      // Silently fail
    }
  }

  render(): void {
    if (!this.banner) return;

    this.element = document.createElement('div');
    this.element.id = 'dyplink-banner';
    const bg = this.banner.theme?.backgroundColor || '#1a1a2e';
    const color = this.banner.theme?.textColor || '#ffffff';
    const btnBg = this.banner.theme?.buttonColor || '#3b82f6';

    this.element.innerHTML = `
      <div style="position:fixed;${this.banner.position}:0;left:0;right:0;background:${bg};color:${color};padding:12px 16px;display:flex;align-items:center;justify-content:space-between;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
        <div style="flex:1;">
          <div style="font-weight:600;font-size:14px;">${this.banner.title}</div>
          ${this.banner.description ? `<div style="font-size:12px;opacity:0.8;margin-top:2px;">${this.banner.description}</div>` : ''}
        </div>
        <a href="${this.banner.targetUrl}" style="background:${btnBg};color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap;margin-left:12px;">${this.banner.ctaText}</a>
        <button id="dyplink-banner-close" style="background:none;border:none;color:${color};font-size:20px;cursor:pointer;margin-left:8px;padding:4px;">&times;</button>
      </div>
    `;

    document.body.appendChild(this.element);

    const closeBtn = document.getElementById('dyplink-banner-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.dismiss());
    }
  }

  dismiss(): void {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }
}

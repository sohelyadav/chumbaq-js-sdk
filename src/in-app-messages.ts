// ═══════════════════════════════════════════════════════
// Dyplink In-App Messages SDK Module
// ═══════════════════════════════════════════════════════

export type InAppMessageType = 'modal' | 'bottom_sheet' | 'banner_top' | 'banner_bottom' | 'fullscreen';
export type ButtonAction = 'dismiss' | 'deep_link' | 'url' | 'custom_event';
export type ButtonStyle = 'primary' | 'secondary' | 'text';

export interface MessageButton {
  id: string;
  text: string;
  action: ButtonAction;
  actionUrl?: string;
  actionEvent?: string;
  style: ButtonStyle;
}

export interface MessageTheme {
  backgroundColor?: string;
  textColor?: string;
  titleColor?: string;
  buttonPrimaryColor?: string;
  buttonSecondaryColor?: string;
  overlayColor?: string;
  borderRadius?: number;
  animation?: 'fade' | 'slide_up' | 'slide_down' | 'scale' | 'none';
}

export interface InAppMessage {
  id: string;
  messageType: InAppMessageType;
  title: string;
  body: string | null;
  imageUrl: string | null;
  imagePosition: string;
  buttons: MessageButton[] | null;
  theme: MessageTheme | null;
  dismissOnTapOutside: boolean;
  autoDismissSeconds: number | null;
  triggerDelay: number;
}

export interface MessageAction {
  messageId: string;
  actionType: 'button_click' | 'dismiss' | 'auto_dismiss' | 'tap_outside';
  button?: MessageButton;
}

export type MessageCallback = (message: InAppMessage) => void;
export type ActionCallback = (action: MessageAction) => void;

// ═══════════════════════════════════════════════════════
// Manager
// ═══════════════════════════════════════════════════════

export class InAppMessageManager {
  private baseUrl: string;
  private apiKey: string;
  private projectId: string;
  private deviceFingerprint: string;
  private distinctId: string;

  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInterval: number = 60000;
  private currentScreen: string = '';
  private activeOverlay: HTMLElement | null = null;
  private messageQueue: InAppMessage[] = [];
  private isShowingMessage: boolean = false;

  private onMessageCallback: MessageCallback | null = null;
  private onActionCallback: ActionCallback | null = null;

  constructor(
    baseUrl: string,
    apiKey: string,
    projectId: string,
    deviceFingerprint: string,
    distinctId: string,
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.deviceFingerprint = deviceFingerprint;
    this.distinctId = distinctId;
  }

  // ── Public API ──

  /** Update the distinct ID (after identify) */
  setDistinctId(id: string): void {
    this.distinctId = id;
  }

  /** Called by host app on navigation */
  setScreen(screenName: string): void {
    this.currentScreen = screenName;
    this.checkMessages({ screen: screenName });
  }

  /** Called by host app when a trackable event fires */
  triggerEvent(eventName: string): void {
    this.checkMessages({ event: eventName });
  }

  /** Check for messages on app open */
  checkOnAppOpen(): void {
    this.checkMessages({});
  }

  /** Start auto-polling for server-triggered messages */
  startPolling(intervalMs: number = 60000): void {
    this.pollingInterval = intervalMs;
    this.stopPolling();
    this.pollingTimer = setInterval(() => {
      this.checkMessages({});
    }, this.pollingInterval);
  }

  /** Stop auto-polling */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /** Manual message check */
  async checkMessages(context: {
    screen?: string;
    event?: string;
  } = {}): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/messages/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          projectId: this.projectId,
          deviceFingerprint: this.deviceFingerprint,
          distinctId: this.distinctId,
          context: {
            screen: context.screen || this.currentScreen,
            event: context.event,
            platform: 'web',
          },
        }),
      });

      if (!response.ok) return;

      // The API wraps every response in `{ data: … }`. Reading `messages`
      // off the root finds nothing and looks exactly like "no messages are
      // eligible", so nothing ever displayed and nothing ever complained.
      // The `?? root` fallback keeps an unwrapped body working.
      const root = await response.json() as
        { data?: { messages?: InAppMessage[] }; messages?: InAppMessage[] };
      const { messages } = root.data ?? root;

      if (messages && messages.length > 0) {
        this.messageQueue.push(...messages);
        this.processQueue();
      }
    } catch {
      // Silently fail
    }
  }

  /** Register a callback for self-handled mode */
  onMessage(callback: MessageCallback): void {
    this.onMessageCallback = callback;
  }

  /** Register a callback for message actions */
  onAction(callback: ActionCallback): void {
    this.onActionCallback = callback;
  }

  /** Dismiss the currently showing message */
  dismissMessage(): void {
    this.removeOverlay();
    this.isShowingMessage = false;
    this.processQueue();
  }

  // ── Private Methods ──

  private processQueue(): void {
    if (this.isShowingMessage || this.messageQueue.length === 0) return;

    const message = this.messageQueue.shift()!;

    // If self-handled mode, delegate to callback
    if (this.onMessageCallback) {
      this.onMessageCallback(message);
      this.trackEvent(message.id, 'delivered');
      return;
    }

    // Apply trigger delay
    if (message.triggerDelay > 0) {
      setTimeout(() => this.showMessage(message), message.triggerDelay * 1000);
    } else {
      this.showMessage(message);
    }
  }

  private showMessage(message: InAppMessage): void {
    if (typeof document === 'undefined') return;

    this.isShowingMessage = true;

    // Track delivery
    this.trackEvent(message.id, 'delivered');

    // Render based on type
    switch (message.messageType) {
      case 'modal':
        this.renderModal(message);
        break;
      case 'bottom_sheet':
        this.renderBottomSheet(message);
        break;
      case 'banner_top':
        this.renderBanner(message, 'top');
        break;
      case 'banner_bottom':
        this.renderBanner(message, 'bottom');
        break;
      case 'fullscreen':
        this.renderFullscreen(message);
        break;
    }

    // Track impression
    this.trackEvent(message.id, 'impression');

    // Auto-dismiss
    if (message.autoDismissSeconds) {
      setTimeout(() => {
        if (this.isShowingMessage) {
          this.trackEvent(message.id, 'auto_dismiss');
          this.dismissMessage();
        }
      }, message.autoDismissSeconds * 1000);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Renderers
  // ═══════════════════════════════════════════════════════

  private renderModal(msg: InAppMessage): void {
    const t = this.resolveTheme(msg.theme);
    const overlay = this.createOverlay(t.overlayColor, msg.dismissOnTapOutside, msg.id);

    const card = document.createElement('div');
    card.style.cssText = `
      position:relative;max-width:420px;width:90%;background:${t.bg};
      border-radius:${t.radius}px;overflow:hidden;
      box-shadow:0 25px 50px -12px rgba(0,0,0,0.4);
      animation:dyplink-scale-in 0.3s cubic-bezier(0.34,1.56,0.64,1);
    `;

    card.innerHTML = this.buildCardContent(msg, t);
    overlay.appendChild(card);
    this.mountOverlay(overlay, msg);
  }

  private renderBottomSheet(msg: InAppMessage): void {
    const t = this.resolveTheme(msg.theme);
    const overlay = this.createOverlay(t.overlayColor, msg.dismissOnTapOutside, msg.id);

    const sheet = document.createElement('div');
    sheet.style.cssText = `
      position:absolute;bottom:0;left:0;right:0;
      max-width:100%;background:${t.bg};
      border-radius:${t.radius}px ${t.radius}px 0 0;overflow:hidden;
      box-shadow:0 -10px 40px rgba(0,0,0,0.3);
      animation:dyplink-slide-up 0.35s cubic-bezier(0.22,1,0.36,1);
    `;

    // Drag handle
    sheet.innerHTML = `
      <div style="width:36px;height:4px;background:rgba(128,128,128,0.4);border-radius:2px;margin:10px auto 0;"></div>
      ${this.buildCardContent(msg, t)}
    `;

    overlay.appendChild(sheet);
    this.mountOverlay(overlay, msg);
  }

  private renderBanner(msg: InAppMessage, position: 'top' | 'bottom'): void {
    const t = this.resolveTheme(msg.theme);

    const banner = document.createElement('div');
    banner.setAttribute('data-dyplink-message', msg.id);

    const slideDir = position === 'top' ? 'dyplink-slide-down' : 'dyplink-slide-up';

    banner.style.cssText = `
      position:fixed;${position}:0;left:0;right:0;z-index:999999;
      background:${t.bg};color:${t.text};
      padding:14px 20px;display:flex;align-items:center;gap:12px;
      box-shadow:${position === 'top' ? '0 4px 20px' : '0 -4px 20px'} rgba(0,0,0,0.15);
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      animation:${slideDir} 0.3s ease-out;
    `;

    const content = document.createElement('div');
    content.style.cssText = 'flex:1;';
    content.innerHTML = `
      <div style="font-weight:600;font-size:14px;color:${t.title};">${this.escapeHtml(msg.title)}</div>
      ${msg.body ? `<div style="font-size:12px;opacity:0.85;margin-top:2px;">${this.escapeHtml(msg.body)}</div>` : ''}
    `;
    banner.appendChild(content);

    // Buttons (show first primary only for banners)
    const primaryBtn = msg.buttons?.find((b) => b.style === 'primary') || msg.buttons?.[0];
    if (primaryBtn) {
      const btn = document.createElement('button');
      btn.style.cssText = `
        background:${t.btnPrimary};color:white;border:none;
        padding:8px 16px;border-radius:6px;font-size:13px;font-weight:600;
        cursor:pointer;white-space:nowrap;
      `;
      btn.textContent = primaryBtn.text;
      btn.addEventListener('click', () => this.handleButtonClick(msg.id, primaryBtn));
      banner.appendChild(btn);
    }

    // Close button
    const close = document.createElement('button');
    close.style.cssText = `
      background:none;border:none;color:${t.text};font-size:20px;
      cursor:pointer;padding:4px;opacity:0.7;line-height:1;
    `;
    close.innerHTML = '&times;';
    close.addEventListener('click', () => {
      this.trackEvent(msg.id, 'dismiss');
      banner.remove();
      this.isShowingMessage = false;
      this.processQueue();
    });
    banner.appendChild(close);

    this.activeOverlay = banner;
    document.body.appendChild(banner);
    this.injectAnimationStyles();
  }

  private renderFullscreen(msg: InAppMessage): void {
    const t = this.resolveTheme(msg.theme);

    const container = document.createElement('div');
    container.setAttribute('data-dyplink-message', msg.id);
    container.style.cssText = `
      position:fixed;inset:0;z-index:999999;
      background:${t.bg};color:${t.text};
      display:flex;flex-direction:column;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      animation:dyplink-fade-in 0.3s ease-out;
      overflow-y:auto;
    `;

    // Close button (top-right)
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = `
      position:absolute;top:16px;right:16px;z-index:10;
      background:rgba(0,0,0,0.3);border:none;color:white;
      width:36px;height:36px;border-radius:50%;font-size:18px;
      cursor:pointer;display:flex;align-items:center;justify-content:center;
    `;
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      this.trackEvent(msg.id, 'dismiss');
      this.dismissMessage();
    });
    container.appendChild(closeBtn);

    // Image (if hero)
    if (msg.imageUrl) {
      const img = document.createElement('img');
      img.src = msg.imageUrl;
      img.alt = msg.title;
      img.style.cssText = msg.imagePosition === 'background'
        ? 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.3;'
        : 'width:100%;max-height:50vh;object-fit:cover;';
      container.appendChild(img);
    }

    // Content area
    const content = document.createElement('div');
    content.style.cssText = `
      flex:1;display:flex;flex-direction:column;justify-content:center;
      align-items:center;text-align:center;padding:32px 24px;
      ${msg.imagePosition === 'background' ? 'position:relative;z-index:1;' : ''}
    `;

    content.innerHTML = `
      <h2 style="font-size:28px;font-weight:700;margin:0 0 12px;color:${t.title};">${this.escapeHtml(msg.title)}</h2>
      ${msg.body ? `<p style="font-size:16px;line-height:1.5;opacity:0.85;margin:0 0 32px;max-width:480px;">${this.escapeHtml(msg.body)}</p>` : '<div style="height:32px;"></div>'}
    `;

    // Buttons
    if (msg.buttons && msg.buttons.length > 0) {
      const btnContainer = document.createElement('div');
      btnContainer.style.cssText = 'display:flex;flex-direction:column;gap:12px;width:100%;max-width:320px;';

      for (const button of msg.buttons) {
        const btn = this.createButton(button, msg.id, t);
        btnContainer.appendChild(btn);
      }
      content.appendChild(btnContainer);
    }

    container.appendChild(content);
    this.activeOverlay = container;
    document.body.appendChild(container);
    this.injectAnimationStyles();
  }

  // ═══════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════

  private resolveTheme(theme: MessageTheme | null) {
    return {
      bg: theme?.backgroundColor || '#ffffff',
      text: theme?.textColor || '#374151',
      title: theme?.titleColor || theme?.textColor || '#111827',
      btnPrimary: theme?.buttonPrimaryColor || '#3b82f6',
      btnSecondary: theme?.buttonSecondaryColor || '#6b7280',
      overlayColor: theme?.overlayColor || 'rgba(0,0,0,0.5)',
      radius: theme?.borderRadius ?? 16,
      animation: theme?.animation || 'fade',
    };
  }

  private buildCardContent(msg: InAppMessage, t: ReturnType<typeof this.resolveTheme>): string {
    let html = '';

    // Image
    if (msg.imageUrl && msg.imagePosition === 'top') {
      html += `<img src="${this.escapeHtml(msg.imageUrl)}" alt="${this.escapeHtml(msg.title)}" style="width:100%;max-height:220px;object-fit:cover;" />`;
    }

    // Body
    html += `<div style="padding:24px;">`;
    html += `<h3 style="margin:0 0 8px;font-size:20px;font-weight:700;color:${t.title};">${this.escapeHtml(msg.title)}</h3>`;
    if (msg.body) {
      html += `<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:${t.text};opacity:0.85;">${this.escapeHtml(msg.body)}</p>`;
    } else {
      html += `<div style="height:20px;"></div>`;
    }

    // Buttons
    if (msg.buttons && msg.buttons.length > 0) {
      html += `<div id="dyplink-btns-${msg.id}" style="display:flex;gap:10px;"></div>`;
    }

    html += `</div>`;
    return html;
  }

  private createOverlay(overlayColor: string, dismissOnTap: boolean, messageId: string): HTMLElement {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-dyplink-message', messageId);
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:999999;
      background:${overlayColor};
      display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      animation:dyplink-fade-in 0.25s ease-out;
    `;

    if (dismissOnTap) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.trackEvent(messageId, 'dismiss');
          this.dismissMessage();
        }
      });
    }

    return overlay;
  }

  private mountOverlay(overlay: HTMLElement, msg: InAppMessage): void {
    this.activeOverlay = overlay;
    document.body.appendChild(overlay);
    this.injectAnimationStyles();

    // Mount button event listeners after DOM insertion
    if (msg.buttons && msg.buttons.length > 0) {
      const btnContainer = document.getElementById(`dyplink-btns-${msg.id}`);
      if (btnContainer) {
        const t = this.resolveTheme(msg.theme);
        for (const button of msg.buttons) {
          const btn = this.createButton(button, msg.id, t);
          btnContainer.appendChild(btn);
        }
      }
    }
  }

  private createButton(
    button: MessageButton,
    messageId: string,
    t: ReturnType<typeof this.resolveTheme>,
  ): HTMLButtonElement {
    const btn = document.createElement('button');

    const styles: Record<string, string> = {
      primary: `background:${t.btnPrimary};color:white;border:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;width:100%;`,
      secondary: `background:transparent;color:${t.btnSecondary};border:2px solid ${t.btnSecondary};padding:10px 24px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;width:100%;`,
      text: `background:transparent;color:${t.btnPrimary};border:none;padding:10px 24px;font-size:14px;font-weight:500;cursor:pointer;text-decoration:underline;width:100%;`,
    };

    btn.style.cssText = styles[button.style] || styles.primary;
    btn.textContent = button.text;
    btn.addEventListener('click', () => this.handleButtonClick(messageId, button));

    return btn;
  }

  private handleButtonClick(messageId: string, button: MessageButton): void {
    this.trackEvent(messageId, 'cta_click', button.id);

    // Execute action
    switch (button.action) {
      case 'url':
        if (button.actionUrl) {
          window.open(button.actionUrl, '_blank');
        }
        break;
      case 'deep_link':
        if (button.actionUrl) {
          window.location.href = button.actionUrl;
        }
        break;
      case 'custom_event':
        // Fire callback
        break;
      case 'dismiss':
      default:
        break;
    }

    // Notify callback
    if (this.onActionCallback) {
      this.onActionCallback({
        messageId,
        actionType: 'button_click',
        button,
      });
    }

    this.dismissMessage();
  }

  private removeOverlay(): void {
    if (this.activeOverlay) {
      this.activeOverlay.remove();
      this.activeOverlay = null;
    }
  }

  private trackEvent(
    messageId: string,
    eventType: string,
    buttonId?: string,
  ): void {
    try {
      fetch(`${this.baseUrl}/api/messages/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          messageId,
          projectId: this.projectId,
          deviceFingerprint: this.deviceFingerprint,
          distinctId: this.distinctId,
          eventType,
          buttonId,
        }),
      }).catch(() => {});
    } catch {
      // Silently fail
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  private injectAnimationStyles(): void {
    if (document.getElementById('dyplink-iam-styles')) return;

    const style = document.createElement('style');
    style.id = 'dyplink-iam-styles';
    style.textContent = `
      @keyframes dyplink-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes dyplink-scale-in {
        from { opacity: 0; transform: scale(0.85); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes dyplink-slide-up {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
      }
      @keyframes dyplink-slide-down {
        from { transform: translateY(-100%); }
        to { transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }
}

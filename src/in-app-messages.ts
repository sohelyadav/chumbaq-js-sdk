import { Diagnostics } from './diagnostics';
import { safeNavigationUrl } from './safe-url';

// ═══════════════════════════════════════════════════════
// Chumbaq In-App Messages SDK Module
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

/** Why a presentation ended, for the paths that know. */
type CloseReason = 'dismiss' | 'auto_dismiss' | 'tap_outside';

/** A message's theme with every default resolved, as a renderer applies it. */
interface ResolvedTheme {
  bg: string;
  text: string;
  title: string;
  btnPrimary: string;
  btnSecondary: string;
  overlayColor: string;
  radius: number;
  animation: string;
}

// ═══════════════════════════════════════════════════════
// Manager
// ═══════════════════════════════════════════════════════

export class InAppMessageManager {
  private baseUrl: string;
  private apiKey: string;
  private projectId: string;
  private deviceFingerprint: string;
  private distinctId: string;
  private diagnostics: Diagnostics;

  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInterval: number = 60000;
  private currentScreen: string = '';
  private activeOverlay: HTMLElement | null = null;
  private messageQueue: InAppMessage[] = [];

  /**
   * The message that owns the screen — from the moment it comes off the
   * queue, which is *before* its trigger delay elapses, until it closes.
   *
   * An identity rather than a boolean because both things that end a
   * presentation are timers. A stale auto-dismiss used to ask "is anything
   * showing?", which after a quick manual dismiss was true of the *next*
   * message, and tore that one down instead.
   */
  private activeMessageId: string | null = null;

  /**
   * Every message queued so far this page load.
   *
   * `maxImpressionsPerUser` and `minIntervalSeconds` are both left null by
   * the dashboard editor, so the server keeps answering a check with the
   * same message for as long as it is active. Without this the 60s poll
   * added another copy each time, and closing one showed the next copy.
   */
  private queuedMessageIds: Set<string> = new Set();

  private triggerDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private autoDismissTimer: ReturnType<typeof setTimeout> | null = null;

  private onMessageCallback: MessageCallback | null = null;
  private onActionCallback: ActionCallback | null = null;

  constructor(
    baseUrl: string,
    apiKey: string,
    projectId: string,
    deviceFingerprint: string,
    distinctId: string,
    diagnostics: Diagnostics = new Diagnostics(),
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.deviceFingerprint = deviceFingerprint;
    this.distinctId = distinctId;
    this.diagnostics = diagnostics;
  }

  // ── Public API ──

  /** Update the distinct ID (after identify) */
  setDistinctId(id: string): void {
    this.distinctId = id;
  }

  /**
   * Forget the current user and take a new distinct ID — a logout.
   *
   * Called by `Chumbaq.reset()`. Everything queued, everything already
   * queued once, and anything on screen belongs to the person who just
   * left: a campaign targeted at them must not be served to whoever uses
   * this browser next.
   */
  reset(distinctId: string): void {
    this.distinctId = distinctId;
    this.messageQueue = [];
    this.queuedMessageIds.clear();
    this.clearPresentationTimers();
    this.removeOverlay();
    this.activeMessageId = null;
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

      if (!response.ok) {
        this.diagnostics.warn(`message check answered ${response.status}; nothing will be shown`);
        return;
      }

      // The API wraps every response in `{ data: … }`. Reading `messages`
      // off the root finds nothing and looks exactly like "no messages are
      // eligible", so nothing ever displayed and nothing ever complained.
      // The `?? root` fallback keeps an unwrapped body working.
      const root = await response.json() as
        { data?: { messages?: InAppMessage[] }; messages?: InAppMessage[] };
      const { messages } = root.data ?? root;

      for (const message of messages ?? []) {
        if (this.queuedMessageIds.has(message.id)) {
          this.diagnostics.debug(`message ${message.id} was already queued this page load; skipped`);
          continue;
        }
        this.queuedMessageIds.add(message.id);
        this.messageQueue.push(message);
      }

      // Unconditionally, including when this check brought nothing new:
      // closing a message no longer drains the queue, so a check is what
      // moves the next one along.
      this.processQueue();
    } catch (error) {
      this.diagnostics.warn('message check did not reach the API', error);
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

  /**
   * Dismiss the currently showing message.
   *
   * Reports nothing: the paths that know *why* a message closed report it
   * themselves, and a host calling this is closing it for a reason only the
   * host knows. It no longer drains the queue either — it used to, and
   * because the server keeps answering with the same message until a cap
   * the editor leaves null is reached, closing a message showed it again
   * immediately. The next check drains the queue.
   */
  dismissMessage(): void {
    this.clearPresentationTimers();
    this.removeOverlay();
    this.activeMessageId = null;
  }

  // ── Private Methods ──

  private processQueue(): void {
    if (this.activeMessageId || this.messageQueue.length === 0) return;

    const message = this.messageQueue.shift()!;

    // If self-handled mode, delegate to callback
    if (this.onMessageCallback) {
      this.onMessageCallback(message);
      // `impression`, not `delivered`: see `showMessage`. In this mode the
      // host owns the screen, so handing the message over is the display —
      // and `delivered` is not counted as an impression anywhere in the
      // dashboard, so a self-handled campaign used to report none at all.
      this.trackEvent(message.id, 'impression');
      return;
    }

    // Claim the screen before the trigger delay rather than after it. A
    // check landing during the delay used to find nothing showing and start
    // a second presentation, which left the first mounted with nothing
    // holding it.
    this.activeMessageId = message.id;

    if (message.triggerDelay > 0) {
      this.triggerDelayTimer = setTimeout(
        () => this.showMessage(message),
        message.triggerDelay * 1000,
      );
    } else {
      this.showMessage(message);
    }
  }

  private showMessage(message: InAppMessage): void {
    if (typeof document === 'undefined') return;

    // A dismiss during the trigger delay releases the screen, and then this
    // message is no longer wanted.
    if (this.activeMessageId !== message.id) {
      this.diagnostics.debug(`message ${message.id} was dismissed before its trigger delay elapsed`);
      return;
    }

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

    // One display, one impression. This used to report `delivered` here as
    // well, and the server's capping query counts both — `event_type IN
    // ('impression', 'delivered')` — so a cap of two allowed one display.
    // iOS and Android report `impression` alone.
    this.trackEvent(message.id, 'impression');

    // Auto-dismiss. Bound to this message: the timer is cleared when the
    // message closes, and checks the identity anyway, because the one thing
    // it must never do is close its successor.
    if (message.autoDismissSeconds) {
      this.autoDismissTimer = setTimeout(() => {
        if (this.activeMessageId !== message.id) return;
        this.closeMessage(message.id, 'auto_dismiss');
      }, message.autoDismissSeconds * 1000);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Renderers
  // ═══════════════════════════════════════════════════════
  //
  // Every renderer builds nodes, sets `textContent`, and assigns style
  // properties one at a time — the way `banner.ts` does, and for the same
  // reason. A message's title, body, image and theme are authored in the
  // dashboard and arrive over the network, so anything interpolated into
  // `innerHTML` is markup the campaign chose. These renderers used to build
  // their markup as strings: the escaper they ran was a `textContent` →
  // `innerHTML` round trip, which escapes `&`, `<` and `>` and leaves
  // quotes alone — harmless between tags, useless in the attribute position
  // it was used in — and theme colours were interpolated with no escaping
  // at all. A `titleColor` of `#000"><img src=q onerror=…>` ran its handler
  // on the host's page, in the host's origin.
  //
  // Assigning a style property instead of concatenating a declaration
  // contains a colour that is not a colour, too: CSSOM drops a value it
  // cannot parse, so the worst a theme can do now is not apply.

  private renderModal(msg: InAppMessage): void {
    const t = this.resolveTheme(msg.theme);
    const overlay = this.createOverlay(t.overlayColor, msg.dismissOnTapOutside, msg.id);

    const card = document.createElement('div');
    Object.assign(card.style, {
      position: 'relative',
      maxWidth: '420px',
      width: '90%',
      backgroundColor: t.bg,
      borderRadius: `${t.radius}px`,
      overflow: 'hidden',
      boxShadow: '0 25px 50px -12px rgba(0,0,0,0.4)',
      animation: 'chumbaq-scale-in 0.3s cubic-bezier(0.34,1.56,0.64,1)',
    } as Partial<CSSStyleDeclaration>);

    this.appendCardContent(card, msg, t);
    overlay.appendChild(card);
    this.mountOverlay(overlay);
  }

  private renderBottomSheet(msg: InAppMessage): void {
    const t = this.resolveTheme(msg.theme);
    const overlay = this.createOverlay(t.overlayColor, msg.dismissOnTapOutside, msg.id);

    const sheet = document.createElement('div');
    Object.assign(sheet.style, {
      position: 'absolute',
      bottom: '0',
      left: '0',
      right: '0',
      maxWidth: '100%',
      backgroundColor: t.bg,
      borderRadius: `${t.radius}px ${t.radius}px 0 0`,
      overflow: 'hidden',
      boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
      animation: 'chumbaq-slide-up 0.35s cubic-bezier(0.22,1,0.36,1)',
    } as Partial<CSSStyleDeclaration>);

    // Drag handle
    const handle = document.createElement('div');
    Object.assign(handle.style, {
      width: '36px',
      height: '4px',
      background: 'rgba(128,128,128,0.4)',
      borderRadius: '2px',
      margin: '10px auto 0',
    } as Partial<CSSStyleDeclaration>);
    sheet.appendChild(handle);

    this.appendCardContent(sheet, msg, t);
    overlay.appendChild(sheet);
    this.mountOverlay(overlay);
  }

  private renderBanner(msg: InAppMessage, position: 'top' | 'bottom'): void {
    const t = this.resolveTheme(msg.theme);

    const banner = document.createElement('div');
    banner.setAttribute('data-chumbaq-message', msg.id);

    Object.assign(banner.style, {
      position: 'fixed',
      [position]: '0',
      left: '0',
      right: '0',
      zIndex: '999999',
      backgroundColor: t.bg,
      color: t.text,
      padding: '14px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      boxShadow: `${position === 'top' ? '0 4px 20px' : '0 -4px 20px'} rgba(0,0,0,0.15)`,
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      animation: `${position === 'top' ? 'chumbaq-slide-down' : 'chumbaq-slide-up'} 0.3s ease-out`,
    } as Partial<CSSStyleDeclaration>);

    const content = document.createElement('div');
    content.style.flex = '1';

    const title = document.createElement('div');
    title.textContent = msg.title;
    Object.assign(title.style, {
      fontWeight: '600',
      fontSize: '14px',
      color: t.title,
    } as Partial<CSSStyleDeclaration>);
    content.appendChild(title);

    if (msg.body) {
      const body = document.createElement('div');
      body.textContent = msg.body;
      Object.assign(body.style, {
        fontSize: '12px',
        opacity: '0.85',
        marginTop: '2px',
      } as Partial<CSSStyleDeclaration>);
      content.appendChild(body);
    }
    banner.appendChild(content);

    // Buttons (show first primary only for banners)
    const primaryBtn = msg.buttons?.find((b) => b.style === 'primary') || msg.buttons?.[0];
    if (primaryBtn) {
      const btn = document.createElement('button');
      Object.assign(btn.style, {
        backgroundColor: t.btnPrimary,
        color: 'white',
        border: 'none',
        padding: '8px 16px',
        borderRadius: '6px',
        fontSize: '13px',
        fontWeight: '600',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      } as Partial<CSSStyleDeclaration>);
      btn.textContent = primaryBtn.text;
      btn.addEventListener('click', () => this.handleButtonClick(msg.id, primaryBtn));
      banner.appendChild(btn);
    }

    banner.appendChild(this.createCloseButton(msg.id, {
      background: 'none',
      border: 'none',
      color: t.text,
      fontSize: '20px',
      cursor: 'pointer',
      padding: '4px',
      opacity: '0.7',
      lineHeight: '1',
    }));

    this.activeOverlay = banner;
    document.body.appendChild(banner);
    this.injectAnimationStyles();
  }

  private renderFullscreen(msg: InAppMessage): void {
    const t = this.resolveTheme(msg.theme);

    const container = document.createElement('div');
    container.setAttribute('data-chumbaq-message', msg.id);
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '999999',
      backgroundColor: t.bg,
      color: t.text,
      display: 'flex',
      flexDirection: 'column',
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      animation: 'chumbaq-fade-in 0.3s ease-out',
      overflowY: 'auto',
    } as Partial<CSSStyleDeclaration>);

    // Close button (top-right)
    container.appendChild(this.createCloseButton(msg.id, {
      position: 'absolute',
      top: '16px',
      right: '16px',
      zIndex: '10',
      background: 'rgba(0,0,0,0.3)',
      border: 'none',
      color: 'white',
      width: '36px',
      height: '36px',
      borderRadius: '50%',
      fontSize: '18px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }));

    // Image (if hero)
    if (msg.imageUrl) {
      const img = document.createElement('img');
      img.src = msg.imageUrl;
      img.alt = msg.title;
      Object.assign(img.style, (msg.imagePosition === 'background'
        ? {
          position: 'absolute',
          inset: '0',
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: '0.3',
        }
        : {
          width: '100%',
          maxHeight: '50vh',
          objectFit: 'cover',
        }) as Partial<CSSStyleDeclaration>);
      container.appendChild(img);
    }

    // Content area
    const content = document.createElement('div');
    Object.assign(content.style, {
      flex: '1',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      textAlign: 'center',
      padding: '32px 24px',
    } as Partial<CSSStyleDeclaration>);
    if (msg.imagePosition === 'background') {
      content.style.position = 'relative';
      content.style.zIndex = '1';
    }

    const title = document.createElement('h2');
    title.textContent = msg.title;
    Object.assign(title.style, {
      fontSize: '28px',
      fontWeight: '700',
      margin: '0 0 12px',
      color: t.title,
    } as Partial<CSSStyleDeclaration>);
    content.appendChild(title);

    if (msg.body) {
      const body = document.createElement('p');
      body.textContent = msg.body;
      Object.assign(body.style, {
        fontSize: '16px',
        lineHeight: '1.5',
        opacity: '0.85',
        margin: '0 0 32px',
        maxWidth: '480px',
      } as Partial<CSSStyleDeclaration>);
      content.appendChild(body);
    } else {
      const spacer = document.createElement('div');
      spacer.style.height = '32px';
      content.appendChild(spacer);
    }

    // Buttons
    if (msg.buttons && msg.buttons.length > 0) {
      const btnContainer = document.createElement('div');
      Object.assign(btnContainer.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        width: '100%',
        maxWidth: '320px',
      } as Partial<CSSStyleDeclaration>);

      for (const button of msg.buttons) {
        btnContainer.appendChild(this.createButton(button, msg.id, t));
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

  private resolveTheme(theme: MessageTheme | null): ResolvedTheme {
    // A radius is interpolated into a length, where the rest of the
    // declaration would go with it; anything that is not a finite number
    // takes the default.
    const radius = theme?.borderRadius;

    return {
      bg: theme?.backgroundColor || '#ffffff',
      text: theme?.textColor || '#374151',
      title: theme?.titleColor || theme?.textColor || '#111827',
      btnPrimary: theme?.buttonPrimaryColor || '#3b82f6',
      btnSecondary: theme?.buttonSecondaryColor || '#6b7280',
      overlayColor: theme?.overlayColor || 'rgba(0,0,0,0.5)',
      radius: typeof radius === 'number' && Number.isFinite(radius) ? radius : 16,
      animation: theme?.animation || 'fade',
    };
  }

  /** The modal and bottom-sheet body: image, copy, buttons. */
  private appendCardContent(parent: HTMLElement, msg: InAppMessage, t: ResolvedTheme): void {
    // Image
    if (msg.imageUrl && msg.imagePosition === 'top') {
      const img = document.createElement('img');
      img.src = msg.imageUrl;
      img.alt = msg.title;
      Object.assign(img.style, {
        width: '100%',
        maxHeight: '220px',
        objectFit: 'cover',
      } as Partial<CSSStyleDeclaration>);
      parent.appendChild(img);
    }

    const body = document.createElement('div');
    body.style.padding = '24px';

    const title = document.createElement('h3');
    title.textContent = msg.title;
    Object.assign(title.style, {
      margin: '0 0 8px',
      fontSize: '20px',
      fontWeight: '700',
      color: t.title,
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(title);

    if (msg.body) {
      const copy = document.createElement('p');
      copy.textContent = msg.body;
      Object.assign(copy.style, {
        margin: '0 0 20px',
        fontSize: '14px',
        lineHeight: '1.5',
        color: t.text,
        opacity: '0.85',
      } as Partial<CSSStyleDeclaration>);
      body.appendChild(copy);
    } else {
      const spacer = document.createElement('div');
      spacer.style.height = '20px';
      body.appendChild(spacer);
    }

    // Buttons. Built here rather than looked up by id after insertion:
    // the id was only needed because the card arrived as a string.
    if (msg.buttons && msg.buttons.length > 0) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        gap: '10px',
      } as Partial<CSSStyleDeclaration>);

      for (const button of msg.buttons) {
        row.appendChild(this.createButton(button, msg.id, t));
      }
      body.appendChild(row);
    }

    parent.appendChild(body);
  }

  private createOverlay(overlayColor: string, dismissOnTap: boolean, messageId: string): HTMLElement {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-chumbaq-message', messageId);
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '999999',
      background: overlayColor,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      animation: 'chumbaq-fade-in 0.25s ease-out',
    } as Partial<CSSStyleDeclaration>);

    if (dismissOnTap) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.closeMessage(messageId, 'tap_outside');
        }
      });
    }

    return overlay;
  }

  private mountOverlay(overlay: HTMLElement): void {
    this.activeOverlay = overlay;
    document.body.appendChild(overlay);
    this.injectAnimationStyles();
  }

  /** The × that closes a banner or a fullscreen message. */
  private createCloseButton(
    messageId: string,
    style: Partial<CSSStyleDeclaration>,
  ): HTMLButtonElement {
    const close = document.createElement('button');
    Object.assign(close.style, style);
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => this.closeMessage(messageId, 'dismiss'));
    return close;
  }

  private createButton(
    button: MessageButton,
    messageId: string,
    t: ResolvedTheme,
  ): HTMLButtonElement {
    const btn = document.createElement('button');

    const styles: Record<string, Partial<CSSStyleDeclaration>> = {
      primary: {
        backgroundColor: t.btnPrimary,
        color: 'white',
        border: 'none',
        padding: '12px 24px',
        borderRadius: '8px',
        fontSize: '15px',
        fontWeight: '600',
        cursor: 'pointer',
        width: '100%',
      },
      secondary: {
        backgroundColor: 'transparent',
        color: t.btnSecondary,
        // Split out of the `border` shorthand so a colour that does not
        // parse loses the colour rather than the whole border.
        borderWidth: '2px',
        borderStyle: 'solid',
        borderColor: t.btnSecondary,
        padding: '10px 24px',
        borderRadius: '8px',
        fontSize: '15px',
        fontWeight: '600',
        cursor: 'pointer',
        width: '100%',
      },
      text: {
        backgroundColor: 'transparent',
        color: t.btnPrimary,
        border: 'none',
        padding: '10px 24px',
        fontSize: '14px',
        fontWeight: '500',
        cursor: 'pointer',
        textDecoration: 'underline',
        width: '100%',
      },
    };

    Object.assign(btn.style, styles[button.style] || styles.primary);
    btn.textContent = button.text;
    btn.addEventListener('click', () => this.handleButtonClick(messageId, button));

    return btn;
  }

  private handleButtonClick(messageId: string, button: MessageButton): void {
    this.trackEvent(messageId, 'cta_click', button.id);

    // Execute action. A button's destination is authored in the dashboard
    // and arrives over the network, so following one is navigating to
    // whatever came back from the API — see `safeNavigationUrl`.
    const destination = safeNavigationUrl(button.actionUrl);
    switch (button.action) {
      case 'url':
        // `noopener` as well: without it the opened page gets a handle on
        // this one through `window.opener`.
        if (destination) {
          window.open(destination, '_blank', 'noopener,noreferrer');
        } else {
          this.diagnostics.warn(`button ${button.id} has no destination this page may be sent to`, button.actionUrl);
        }
        break;
      case 'deep_link':
        if (destination) {
          window.location.href = destination;
        } else {
          this.diagnostics.warn(`button ${button.id} has no destination this page may be sent to`, button.actionUrl);
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

  /**
   * Close the message on screen and report why.
   *
   * `tap_outside` reaches the server as `dismiss`, which is the only one of
   * the three the impression table's event types cover, but reaches
   * `onAction` as itself: `MessageAction` has always declared `dismiss`,
   * `auto_dismiss` and `tap_outside` and only ever fired `button_click`,
   * while the mobile SDKs distinguish all of them.
   */
  private closeMessage(messageId: string, reason: CloseReason): void {
    this.trackEvent(messageId, reason === 'tap_outside' ? 'dismiss' : reason);
    this.dismissMessage();

    if (this.onActionCallback) {
      this.onActionCallback({ messageId, actionType: reason });
    }
  }

  private clearPresentationTimers(): void {
    if (this.triggerDelayTimer) {
      clearTimeout(this.triggerDelayTimer);
      this.triggerDelayTimer = null;
    }
    if (this.autoDismissTimer) {
      clearTimeout(this.autoDismissTimer);
      this.autoDismissTimer = null;
    }
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
      })
        .then((response) => {
          if (!response.ok) {
            this.diagnostics.warn(`${eventType} for message ${messageId} answered ${response.status}`);
          }
        })
        .catch((error) => {
          this.diagnostics.warn(`${eventType} for message ${messageId} did not reach the API`, error);
        });
    } catch (error) {
      this.diagnostics.warn(`${eventType} for message ${messageId} could not be sent`, error);
    }
  }

  private injectAnimationStyles(): void {
    if (document.getElementById('chumbaq-iam-styles')) return;

    const style = document.createElement('style');
    style.id = 'chumbaq-iam-styles';
    style.textContent = `
      @keyframes chumbaq-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes chumbaq-scale-in {
        from { opacity: 0; transform: scale(0.85); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes chumbaq-slide-up {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
      }
      @keyframes chumbaq-slide-down {
        from { transform: translateY(-100%); }
        to { transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }
}

import { Diagnostics } from './diagnostics';
import { safeNavigationUrl } from './safe-url';

/** One banner inside a widget, as `GET /api/in-app-banners/serve/:categoryId` returns it. */
export interface Banner {
  id: string;
  title: string;
  imageUrl: string | null;
  clickUrl: string | null;
  ctaText: string;
  sortOrder: number;
  isActive: boolean;
  metadata?: Record<string, unknown> | null;
}

/** The widget the banners belong to. Supplies the strip's styling. */
export interface BannerWidget {
  id: string;
  name: string;
  heading?: string | null;
  backgroundColor?: string | null;
}

/** Where the strip sits in the viewport. The server has no opinion on this. */
export type BannerPosition = 'top' | 'bottom';

/**
 * Renders one of a project's banner widgets as a dismissible strip.
 *
 * The widget is the unit the dashboard authors and the API serves, and it
 * holds an ordered list of banners. A strip has room for one, so the first
 * active banner is shown — the same list the native SDKs page through in a
 * carousel, degraded rather than reinterpreted.
 */
export class BannerRenderer {
  private baseUrl: string;
  private apiKey: string;
  private widget: BannerWidget | null = null;
  private banner: Banner | null = null;
  private element: HTMLElement | null = null;
  private position: BannerPosition = 'bottom';
  private diagnostics: Diagnostics;

  constructor(baseUrl: string, apiKey: string, diagnostics: Diagnostics = new Diagnostics()) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.diagnostics = diagnostics;
  }

  /**
   * Loads a widget by id.
   *
   * The endpoint is keyed by widget — a project can have several, for
   * different placements — so there is no "the project's banner" to fetch
   * without being told which one.
   */
  async load(widgetId: string): Promise<void> {
    // Whatever was loaded before is gone the moment a new widget is asked
    // for, successful or not. It used to survive a failure, and since a
    // render draws whatever is loaded, `showBanner('A')` followed by a
    // `showBanner('B')` that 404s put A's banner back on the page — and
    // reported the tap against A's id, which is a click the campaign never
    // got.
    this.widget = null;
    this.banner = null;

    try {
      const response = await fetch(
        `${this.baseUrl}/api/in-app-banners/serve/${widgetId}`,
        { headers: { 'X-API-Key': this.apiKey } },
      );
      if (!response.ok) {
        this.diagnostics.warn(`banner widget ${widgetId} answered ${response.status}; nothing will be shown`);
        return;
      }

      // Every API response is wrapped in `{ data: … }`; falling back to the
      // root keeps an unwrapped body working.
      const root = await response.json() as
        { data?: ServeResponse } & ServeResponse;
      const served = root.data ?? root;

      this.widget = served.category ?? null;
      this.banner = (served.banners ?? [])
        .filter((b) => b.isActive !== false)
        .sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null;

      if (!this.banner) {
        this.diagnostics.debug(`banner widget ${widgetId} served no active banner`);
      }
    } catch (error) {
      // Never thrown on — a banner is not worth breaking a page over — but
      // no longer silent either.
      this.diagnostics.warn(`banner widget ${widgetId} did not load`, error);
    }
  }

  render(position: BannerPosition = 'bottom'): void {
    // Taken down first, before anything is known about what replaces it:
    // the strip on screen belongs to whatever was loaded last, and a render
    // with nothing to show must leave nothing behind rather than leave the
    // previous widget's strip collecting taps.
    this.dismiss();

    const banner = this.banner;
    if (!banner) return;

    this.position = position;

    const background = this.widget?.backgroundColor || '#1a1a2e';

    // Built as nodes with `textContent` rather than interpolated into
    // `innerHTML`: a banner's copy comes back from the API, and a title
    // holding markup would otherwise be parsed as markup.
    const strip = document.createElement('div');
    Object.assign(strip.style, {
      position: 'fixed',
      [this.position]: '0',
      left: '0',
      right: '0',
      background,
      color: '#ffffff',
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      zIndex: '99999',
      fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif',
    } as Partial<CSSStyleDeclaration>);

    if (banner.imageUrl) {
      const thumb = document.createElement('img');
      thumb.src = banner.imageUrl;
      thumb.alt = '';
      Object.assign(thumb.style, {
        width: '40px',
        height: '40px',
        borderRadius: '8px',
        objectFit: 'cover',
        marginRight: '12px',
        flex: '0 0 auto',
      } as Partial<CSSStyleDeclaration>);
      strip.appendChild(thumb);
    }

    const copy = document.createElement('div');
    copy.style.flex = '1';

    const title = document.createElement('div');
    title.textContent = banner.title;
    Object.assign(title.style, { fontWeight: '600', fontSize: '14px' } as Partial<CSSStyleDeclaration>);
    copy.appendChild(title);

    if (this.widget?.heading) {
      const heading = document.createElement('div');
      heading.textContent = this.widget.heading;
      Object.assign(heading.style, {
        fontSize: '12px',
        opacity: '0.8',
        marginTop: '2px',
      } as Partial<CSSStyleDeclaration>);
      copy.appendChild(heading);
    }
    strip.appendChild(copy);

    // A `javascript:` href executes on click, and a banner's destination
    // comes back from the API — see `safeNavigationUrl`.
    const destination = safeNavigationUrl(banner.clickUrl);
    if (destination) {
      const cta = document.createElement('a');
      cta.href = destination;
      cta.rel = 'noopener noreferrer';
      cta.textContent = banner.ctaText || 'Open';
      Object.assign(cta.style, {
        background: '#3b82f6',
        color: '#ffffff',
        padding: '8px 16px',
        borderRadius: '6px',
        textDecoration: 'none',
        fontSize: '13px',
        fontWeight: '600',
        whiteSpace: 'nowrap',
        marginLeft: '12px',
      } as Partial<CSSStyleDeclaration>);
      // Reported before the navigation starts, and not awaited: the tap
      // must not wait on analytics, and leaving the page must not cancel it.
      cta.addEventListener('click', () => this.recordClick(banner.id));
      strip.appendChild(cta);
    } else if (banner.clickUrl) {
      this.diagnostics.warn('the banner’s call to action was dropped: its destination is one a page must not be sent to', banner.clickUrl);
    }

    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    Object.assign(close.style, {
      background: 'none',
      border: 'none',
      color: '#ffffff',
      fontSize: '20px',
      cursor: 'pointer',
      marginLeft: '8px',
      padding: '4px',
    } as Partial<CSSStyleDeclaration>);
    close.addEventListener('click', () => this.dismiss());
    strip.appendChild(close);

    this.element = strip;
    document.body.appendChild(strip);
  }

  dismiss(): void {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }

  private recordClick(bannerId: string): void {
    // `keepalive` is what lets the report survive the navigation the tap
    // is about to start.
    void fetch(`${this.baseUrl}/api/in-app-banners/${bannerId}/click`, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
      keepalive: true,
    }).catch((error) => {
      // Best effort — the tap has already happened.
      this.diagnostics.warn(`the click on banner ${bannerId} was not reported`, error);
    });
  }
}

/** What the serve endpoint answers, inside its `data` envelope. */
interface ServeResponse {
  category?: BannerWidget;
  banners?: Banner[];
}

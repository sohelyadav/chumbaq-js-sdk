/**
 * The SDK's diagnostic channel.
 *
 * Almost everything this SDK does on a host's page is best-effort: a failed
 * message check, a dropped event report, a 404 on a banner widget. None of
 * them is worth breaking a page over, so all of them are swallowed — and
 * swallowed silently they are also invisible. That silence is why a deferred
 * match that never reached the server, a queue that grew a copy of the same
 * message every 60 seconds, and a display that spent two impressions of a
 * cap all shipped and stayed.
 *
 * So failures are reported here rather than nowhere, and the host decides
 * whether to listen: `debug: true` on the init config turns the channel on.
 * Off — the default — it costs one boolean test, because a host's console
 * belongs to the host.
 *
 * Nothing here is ever handed the API key. A diagnostic goes to the page's
 * console, which every script on the page can read and anything collecting
 * that console keeps; a key written there outlives the session.
 */
export class Diagnostics {
  private enabled: boolean;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }

  /** Something the SDK was asked to do and could not. */
  warn(message: string, detail?: unknown): void {
    if (!this.enabled) return;
    if (detail === undefined) {
      console.warn(`[dyplink] ${message}`);
    } else {
      console.warn(`[dyplink] ${message}`, detail);
    }
  }

  /**
   * Something the SDK decided, where the decision explains an absence —
   * a message that was not shown, a report that was not sent.
   */
  debug(message: string, detail?: unknown): void {
    if (!this.enabled) return;
    if (detail === undefined) {
      console.debug(`[dyplink] ${message}`);
    } else {
      console.debug(`[dyplink] ${message}`, detail);
    }
  }
}

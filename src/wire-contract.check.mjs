/**
 * Checks for the three places `@dyplink/sdk` talks to the API and reads
 * something back: the deferred matcher, the banner widget renderer, and the
 * in-app message poller.
 *
 * ## Why this is a script and not a test suite
 *
 * `packages/sdk` has no test runner, and installing one failed on this
 * machine with an `EACCES` in the npm cache. So the assertions live here,
 * runnable with nothing but node:
 *
 *     npm run test:logic -w @dyplink/sdk
 *
 * The same arrangement as `apps/web/src/lib/segment-form.check.mjs`, for the
 * same reason, and it converts to a `.spec.ts` almost verbatim if a runner is
 * ever added. `jiti` arrives with vite, so it is present whenever any of this
 * can be built at all.
 *
 * ## Why these assertions and not others
 *
 * Every one of them covers something that was wrong and silent. Each of the
 * three paths failed in a way that looked exactly like an empty answer:
 *
 * 1. **The envelope.** The API wraps every response in `{ data: … }`.
 *    Reading `messages` off the root returns undefined, which is what "no
 *    messages are eligible" looks like — so in-app messages never showed and
 *    nothing ever complained. Confirmed against the live API, which answers
 *    `{"data":{"messages":[…]}}`.
 *
 * 2. **The URLs.** The deferred matcher posted to `/api/deferred-match` and
 *    the banner renderer fetched `/api/banners/serve/:projectId`. Neither
 *    route exists — the real ones are `/api/deferred/match` and
 *    `/api/in-app-banners/serve/:widgetId` — and both callers swallow
 *    failures, so a 404 was indistinguishable from "nothing to show".
 *
 * 3. **The request body.** `DeferredMatchDto` accepts `fingerprint` and
 *    `cookieRef` and nothing else, and the API's validation pipe runs with
 *    `forbidNonWhitelisted`, so the `platform` field the SDK used to send at
 *    the top level made the whole request a 400.
 *
 * 4. **Banner copy is not markup.** The renderer used to interpolate a
 *    banner's title into `innerHTML`. Copy comes back from the API, so a
 *    title holding a tag was parsed as a tag.
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

// ── A DOM small enough to read, large enough for the renderer ─────────

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.textContent = '';
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  get descendants() { return this.children.flatMap((c) => [c, ...c.descendants]); }
}

const body = new El('body');
globalThis.document = {
  body,
  createElement: (tag) => new El(tag),
  cookie: '',
};

// ── A fetch that records what it was asked and answers what we say ────

function stubFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = typeof reply === 'function' ? reply(url) : reply;
    return {
      ok: answer.ok ?? true,
      json: async () => answer.json,
    };
  };
  return calls;
}

const { BannerRenderer } = await jiti.import(path.join(here, 'banner.ts'));
const { DeferredDeepLink } = await jiti.import(path.join(here, 'deferred.ts'));
const { InAppMessageManager } = await jiti.import(path.join(here, 'in-app-messages.ts'));

// ── In-app messages ───────────────────────────────────────────────────

console.log('in-app messages read through the envelope');

// The body the live API returns, copied from a real check.
const served = {
  id: 'c63c74dc', messageType: 'banner_bottom', title: 'Parity probe',
  body: 'Checking the SDK envelope', imageUrl: null, imagePosition: 'top',
  buttons: [{ id: 'b1', text: 'Got it', style: 'primary', action: 'dismiss' }],
  theme: { animation: 'slide_up', backgroundColor: '#101828' },
  dismissOnTapOutside: true, autoDismissSeconds: 6, triggerDelay: 0,
};

async function checkMessages(json) {
  const calls = stubFetch({ json });
  const seen = [];
  const manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
  manager.onMessage((message) => seen.push(message));
  await manager.checkMessages({});
  return { seen, calls };
}

const enveloped = await checkMessages({ data: { messages: [served] } });
check('an enveloped check yields the message', enveloped.seen.length === 1, `got ${enveloped.seen.length}`);
check('its fields survive', enveloped.seen[0]?.title === 'Parity probe' && enveloped.seen[0]?.autoDismissSeconds === 6);
check('it posts to /api/messages/check', enveloped.calls[0]?.url === 'https://api.test/api/messages/check');

const unwrapped = await checkMessages({ messages: [served] });
check('an unwrapped body still works', unwrapped.seen.length === 1);

const empty = await checkMessages({ data: { messages: [] } });
check('no eligible messages shows nothing', empty.seen.length === 0);

const malformed = await checkMessages({ data: {} });
check('a body with no messages key shows nothing', malformed.seen.length === 0);

// ── Deferred matching ─────────────────────────────────────────────────

console.log('\ndeferred matching reaches the real route with a legal body');

const match = { matched: true, linkId: 'link-1', shortCode: 'TWqU1oS', params: { probe: 'ok' } };
let calls = stubFetch({ json: { data: match } });
let result = await new DeferredDeepLink('https://api.test', 'key')
  .match({ deviceFingerprint: { os: 'iOS', ip: '203.0.113.7', model: 'iPhone' } });

check('it posts to /api/deferred/match', calls[0]?.url === 'https://api.test/api/deferred/match', calls[0]?.url);
check('the body carries only fingerprint', Object.keys(calls[0]?.body ?? {}).join() === 'fingerprint', Object.keys(calls[0]?.body ?? {}).join());
check('the fingerprint carries the ip the server matches on', calls[0]?.body?.fingerprint?.ip === '203.0.113.7');
check('a match is reported as matched', result.matched === true);
check('the server’s `params` are handed back as `deepLinkParams`', result.deepLinkParams?.probe === 'ok', JSON.stringify(result));
check('linkId and shortCode survive', result.linkId === 'link-1' && result.shortCode === 'TWqU1oS');

calls = stubFetch({ json: match });
result = await new DeferredDeepLink('https://api.test', 'key').match({ deviceFingerprint: 'ios' });
check('an unwrapped body still works', result.matched === true);
check('a bare string is read as the os', calls[0]?.body?.fingerprint?.os === 'ios');

calls = stubFetch({ json: { data: { matched: false } } });
result = await new DeferredDeepLink('https://api.test', 'key').match({ deviceFingerprint: { os: 'ios' } });
check('no match is reported as unmatched', result.matched === false);

// ── Banner widgets ────────────────────────────────────────────────────

console.log('\nbanner widgets load from the real route and render as text');

const widget = {
  category: { id: 'w1', name: 'Promos', heading: 'Probe heading', backgroundColor: '#101828' },
  banners: [
    { id: 'b-2', title: 'Second', imageUrl: null, clickUrl: null, ctaText: '', sortOrder: 2, isActive: true },
    { id: 'b-1', title: 'Probe banner <b>bold</b>', imageUrl: 'https://cdn.test/i.png', clickUrl: 'https://go.test/x', ctaText: 'Open', sortOrder: 1, isActive: true },
    { id: 'b-0', title: 'Retired', imageUrl: null, clickUrl: null, ctaText: '', sortOrder: 0, isActive: false },
  ],
};

body.children = [];
calls = stubFetch({ json: { data: widget } });
const renderer = new BannerRenderer('https://api.test', 'key');
await renderer.load('w1');
renderer.render('top');

const strip = body.children[0];
const nodes = strip ? [strip, ...strip.descendants] : [];
const texts = nodes.map((n) => n.textContent).filter(Boolean);

check('it fetches /api/in-app-banners/serve/:widgetId', calls[0]?.url === 'https://api.test/api/in-app-banners/serve/w1', calls[0]?.url);
check('it sends the api key the route requires', calls[0]?.init?.headers?.['X-API-Key'] === 'key');
check('a strip is rendered', !!strip);
check('the lowest sortOrder among active banners wins', texts.includes('Probe banner <b>bold</b>'), texts.join(' | '));
check('an inactive banner is not shown', !texts.includes('Retired'));
check(
  'a title holding a tag stays text',
  nodes.some((n) => n.textContent === 'Probe banner <b>bold</b>' && n.children.length === 0),
);
check('the widget heading is shown', texts.includes('Probe heading'));
check('the cta links to the banner’s url', nodes.find((n) => n.tagName === 'A')?.href === 'https://go.test/x');
check('the widget background is used', strip?.style.background === '#101828');
check('top places it at the top', strip?.style.top === '0' && strip?.style.bottom === undefined);

// A tap reports a click before it navigates.
const cta = nodes.find((n) => n.tagName === 'A');
calls = stubFetch({ json: {} });
cta?.listeners?.click?.forEach((fn) => fn());
check('a tap reports the click', calls[0]?.url === 'https://api.test/api/in-app-banners/b-1/click', calls[0]?.url);
check('the click report survives the navigation', calls[0]?.init?.keepalive === true);

// Dismissing removes the strip.
nodes.find((n) => n.tagName === 'BUTTON')?.listeners?.click?.forEach((fn) => fn());
check('dismissing removes the strip', body.children.length === 0);

body.children = [];
stubFetch({ ok: false, json: {} });
const failed = new BannerRenderer('https://api.test', 'key');
await failed.load('w1');
failed.render();
check('a failed load renders nothing', body.children.length === 0);

// ── Push campaign engagement ──────────────────────────────────────────

console.log('\npush campaigns are reported, so web CTR is not always zero');

const { PushManager } = await jiti.import(path.join(here, 'push.ts'));
const push = new PushManager('https://api.test', 'key', 'proj');

calls = stubFetch({ json: {} });
await push.reportNotificationReceived({ dyplink_campaign_id: 'camp-1' }, 'fp-1');
check('a delivery is posted to the ingestion endpoint', calls[0]?.url === 'https://api.test/api/push-notifications/events', calls[0]?.url);
check('it reports `delivered`, which is a client-reportable type', calls[0]?.body?.type === 'delivered');
check('it names the campaign and the device', calls[0]?.body?.campaignId === 'camp-1' && calls[0]?.body?.deviceFingerprint === 'fp-1');
check('the platform is web', calls[0]?.body?.platform === 'web');
check('it carries when it happened, not when it arrived', typeof calls[0]?.body?.occurredAt === 'string');

calls = stubFetch({ json: {} });
let url = await push.reportNotificationClicked(
  { dyplink_campaign_id: 'camp-2', deep_link_url: 'https://app.test/p/42' },
  'fp-1',
);
check('a tap reports `click`', calls[0]?.body?.type === 'click');
check('a tap hands back the destination', url === 'https://app.test/p/42');
check('the report survives the navigation it races', calls[0]?.init?.keepalive === true);

calls = stubFetch({ json: {} });
url = await push.reportNotificationClicked({ dyplink_campaign_id: 'camp-3', link: 'https://app.test/fb' }, 'fp-1');
check('`link` is the fallback, as on every other client', url === 'https://app.test/fb');

calls = stubFetch({ json: {} });
url = await push.reportNotificationClicked({ dyplink_campaign_id: 'camp-4' }, 'fp-1');
check('a campaign with no deep link hands back nothing', url === null);
check('…and is still reported', calls.length === 1);

// Anything that is not a campaign of ours, or is unusable, is ignored: the
// host calls this for every message it receives.
for (const [label, data] of [
  ['a payload with no campaign id', { title: 'hello' }],
  ['a blank campaign id', { dyplink_campaign_id: '' }],
  ['a non-string campaign id', { dyplink_campaign_id: 42 }],
]) {
  calls = stubFetch({ json: {} });
  await push.reportNotificationReceived(data, 'fp-1');
  check(`${label} is ignored`, calls.length === 0);
}

calls = stubFetch({ json: {} });
await push.reportNotificationReceived({ dyplink_campaign_id: 'camp-5' }, '');
check('no device fingerprint means nothing to report', calls.length === 0);

calls = stubFetch({ json: {} });
url = await push.reportNotificationClicked({ dyplink_campaign_id: 'camp-6', deep_link_url: 42, link: 'https://app.test/ok' }, 'fp-1');
check('an unusable deep link falls through to the next key', url === 'https://app.test/ok');

globalThis.fetch = async () => { throw new Error('offline'); };
let threw = false;
try {
  url = await push.reportNotificationClicked({ dyplink_campaign_id: 'camp-7', deep_link_url: 'https://app.test/x' }, 'fp-1');
} catch { threw = true; }
check('a transport failure never reaches the caller', !threw);
check('…and the tap still goes where it was going', url === 'https://app.test/x');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);

/**
 * Checks for the three places `@chumbaq/sdk` talks to the API and reads
 * something back: the deferred matcher, the banner widget renderer, and the
 * in-app message poller.
 *
 * ## Why this is a script and not a test suite
 *
 * The SDK has no test runner, so the assertions live here, runnable with
 * nothing but node (plus `jiti`, a dev dependency, to load the TypeScript):
 *
 *     npm run test:logic
 *
 * It converts to a `.spec.ts` almost verbatim if a runner is ever added.
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
 *
 * 5. **Neither is an in-app message.** The same mistake, one file over, and
 *    worse: all five message renderers built their markup as strings, the
 *    escaper they ran left quotes alone while being used in attribute
 *    position, and theme colours were interpolated raw. A campaign could run
 *    JavaScript on the host's page — proven in a real browser, which is
 *    where the proof belongs; what is checkable here is that no renderer
 *    writes `innerHTML` at all.
 *
 * 6. **The queue, the timers and the impression count.** A dismissed message
 *    came straight back, the 60s poll added another copy of it every time, a
 *    stale auto-dismiss closed its successor, a trigger delay mounted two
 *    messages, and one display spent two impressions of a cap the server
 *    counts as `event_type IN ('impression', 'delivered')`. Every one of
 *    them was invisible, which is why there is now a diagnostic channel too.
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
    // Every `innerHTML` assignment, which is the thing being checked: a
    // renderer that builds nodes never makes one, and a renderer that
    // builds markup cannot avoid it.
    this.innerHTMLWrites = [];
  }
  set innerHTML(value) { this.innerHTMLWrites.push(String(value)); }
  get innerHTML() { return this.innerHTMLWrites[this.innerHTMLWrites.length - 1] ?? ''; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  get descendants() { return this.children.flatMap((c) => [c, ...c.descendants]); }
}

const body = new El('body');
const head = new El('head');
globalThis.document = {
  body,
  head,
  createElement: (tag) => new El(tag),
  getElementById: (id) => [...head.descendants, ...body.descendants].find((n) => n.id === id) ?? null,
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
      status: answer.status ?? (answer.ok === false ? 500 : 200),
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
// `FingerprintDto` dropped `ip` deliberately: an address in the body was an
// instruction to claim whoever's click came from it, so the server derives
// the real one from the request. `forbidNonWhitelisted` makes a body that
// still carries one a 400, which would take the whole match down with it.
check('the fingerprint does not carry an ip', calls[0]?.body?.fingerprint?.ip === undefined, JSON.stringify(calls[0]?.body));
check('…and the rest of the caller’s description survives', calls[0]?.body?.fingerprint?.model === 'iPhone' && calls[0]?.body?.fingerprint?.os === 'iOS');
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

// The cookie the redirect left behind is the web's real match, and it used
// to be answered locally — `matched: true`, returned before the fetch. The
// answer looked right and everything downstream of it was wrong: the server
// is what sets `ClickEventEntity.matched`, that column is the join key from a
// click to its install and conversions, and no `linkId` ever came back.
console.log('\na cookie match is made by the server, not by the client');

document.cookie = 'chumbaq_ref=TWqU1oS; chumbaq_params=%7B%22probe%22%3A%22ok%22%7D';

calls = stubFetch({ json: { data: match } });
result = await new DeferredDeepLink('https://api.test', 'key').match();
check('a cookie ref is posted to the server', calls.length === 1 && calls[0]?.url === 'https://api.test/api/deferred/match', `${calls.length} calls`);
check('the body carries the cookie ref', calls[0]?.body?.cookieRef === 'TWqU1oS', JSON.stringify(calls[0]?.body));
check('the server’s answer is what comes back', result.matched === true && result.linkId === 'link-1');
check('…including the link’s deep link params', result.deepLinkParams?.probe === 'ok');

// The server only matches a click it has not matched before, so "the cookie
// says so" is not an answer it can be overruled on.
calls = stubFetch({ json: { data: { matched: false } } });
result = await new DeferredDeepLink('https://api.test', 'key').match();
check('a cookie the server will not match is not matched', result.matched === false, JSON.stringify(result));

// A caller with both gets both in one request; the server tries the cookie
// first and falls back to the fingerprint.
calls = stubFetch({ json: { data: match } });
await new DeferredDeepLink('https://api.test', 'key').match({ deviceFingerprint: 'ios' });
check('a cookie and a fingerprint travel together', Object.keys(calls[0]?.body ?? {}).sort().join() === 'cookieRef,fingerprint', Object.keys(calls[0]?.body ?? {}).join());

// Only when the request itself fails: the cookie is still local evidence of
// where this device came from, and losing it would strand an install that
// was opened offline on the wrong screen.
globalThis.fetch = async () => { throw new Error('offline'); };
result = await new DeferredDeepLink('https://api.test', 'key').match();
check('an unreachable API falls back to the cookie', result.matched === true && result.shortCode === 'TWqU1oS');
check('…with the params the redirect left behind', result.deepLinkParams?.probe === 'ok', JSON.stringify(result));

document.cookie = '';
calls = stubFetch({ json: { data: match } });
result = await new DeferredDeepLink('https://api.test', 'key').match();
check('nothing to match on makes no request at all', calls.length === 0 && result.matched === false);

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
await push.reportNotificationReceived({ chumbaq_campaign_id: 'camp-1' }, 'fp-1');
check('a delivery is posted to the ingestion endpoint', calls[0]?.url === 'https://api.test/api/push-notifications/events', calls[0]?.url);
check('it reports `delivered`, which is a client-reportable type', calls[0]?.body?.type === 'delivered');
check('it names the campaign and the device', calls[0]?.body?.campaignId === 'camp-1' && calls[0]?.body?.deviceFingerprint === 'fp-1');
check('the platform is web', calls[0]?.body?.platform === 'web');
check('it carries when it happened, not when it arrived', typeof calls[0]?.body?.occurredAt === 'string');

calls = stubFetch({ json: {} });
let url = await push.reportNotificationClicked(
  { chumbaq_campaign_id: 'camp-2', deep_link_url: 'https://app.test/p/42' },
  'fp-1',
);
check('a tap reports `click`', calls[0]?.body?.type === 'click');
check('a tap hands back the destination', url === 'https://app.test/p/42');
check('the report survives the navigation it races', calls[0]?.init?.keepalive === true);

calls = stubFetch({ json: {} });
url = await push.reportNotificationClicked({ chumbaq_campaign_id: 'camp-3', link: 'https://app.test/fb' }, 'fp-1');
check('`link` is the fallback, as on every other client', url === 'https://app.test/fb');

calls = stubFetch({ json: {} });
url = await push.reportNotificationClicked({ chumbaq_campaign_id: 'camp-4' }, 'fp-1');
check('a campaign with no deep link hands back nothing', url === null);
check('…and is still reported', calls.length === 1);

// Anything that is not a campaign of ours, or is unusable, is ignored: the
// host calls this for every message it receives.
for (const [label, data] of [
  ['a payload with no campaign id', { title: 'hello' }],
  ['a blank campaign id', { chumbaq_campaign_id: '' }],
  ['a non-string campaign id', { chumbaq_campaign_id: 42 }],
]) {
  calls = stubFetch({ json: {} });
  await push.reportNotificationReceived(data, 'fp-1');
  check(`${label} is ignored`, calls.length === 0);
}

calls = stubFetch({ json: {} });
await push.reportNotificationReceived({ chumbaq_campaign_id: 'camp-5' }, '');
check('no device fingerprint means nothing to report', calls.length === 0);

calls = stubFetch({ json: {} });
url = await push.reportNotificationClicked({ chumbaq_campaign_id: 'camp-6', deep_link_url: 42, link: 'https://app.test/ok' }, 'fp-1');
check('an unusable deep link falls through to the next key', url === 'https://app.test/ok');

globalThis.fetch = async () => { throw new Error('offline'); };
let threw = false;
try {
  url = await push.reportNotificationClicked({ chumbaq_campaign_id: 'camp-7', deep_link_url: 'https://app.test/x' }, 'fp-1');
} catch { threw = true; }
check('a transport failure never reaches the caller', !threw);
check('…and the tap still goes where it was going', url === 'https://app.test/x');

// ── Destinations the SDK is told to go to ─────────────────────────────

console.log('\nan executable destination is refused, however it is spelled');

const { safeNavigationUrl } = await jiti.import(path.join(here, 'safe-url.ts'));

for (const safe of [
  'https://app.test/products/42',
  'http://app.test/x',
  '/relative/path',
  'myapp://product/42',          // a Chumbaq deep link is very often this
  'mailto:hi@app.test',
  'tel:+15551234',
]) {
  check(`${safe} is followed`, safeNavigationUrl(safe) === safe);
}

for (const unsafe of [
  'javascript:alert(1)',
  'JavaScript:alert(1)',          // scheme matching is case-insensitive
  '  javascript:alert(1)',        // leading whitespace is stripped by the parser
  '\tjavascript:alert(1)',
  '\njavascript:alert(1)',
  'java\tscript:alert(1)',        // a control character inside the scheme
  'vbscript:msgbox(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  'blob:https://app.test/abc',
]) {
  check(
    `${JSON.stringify(unsafe)} is refused`,
    safeNavigationUrl(unsafe) === null,
    `got ${JSON.stringify(safeNavigationUrl(unsafe))}`,
  );
}

check('an empty destination is refused', safeNavigationUrl('') === null);
check('a missing destination is refused', safeNavigationUrl(undefined) === null);
check('an unparseable destination is refused', safeNavigationUrl('http://[') === null);

// It has to hold at the places that actually navigate, not only in the
// helper — that is the whole point.
calls = stubFetch({ json: {} });
url = await push.reportNotificationClicked(
  { chumbaq_campaign_id: 'camp-8', deep_link_url: 'javascript:alert(1)' },
  'fp-1',
);
check('a push campaign cannot hand back an executable destination', url === null);

calls = stubFetch({ json: {} });
url = await push.reportNotificationClicked(
  { chumbaq_campaign_id: 'camp-9', deep_link_url: 'javascript:alert(1)', link: 'https://app.test/ok' },
  'fp-1',
);
check('…and the next key is tried instead', url === 'https://app.test/ok');

body.children = [];
stubFetch({ json: { data: {
  category: { id: 'w1', name: 'Promos' },
  banners: [{ id: 'b-x', title: 'Tap me', imageUrl: null, clickUrl: 'javascript:alert(1)', ctaText: 'Go', sortOrder: 1, isActive: true }],
} } });
const guarded = new BannerRenderer('https://api.test', 'key');
await guarded.load('w1');
guarded.render();
const guardedStrip = body.children[0];
const guardedNodes = guardedStrip ? [guardedStrip, ...guardedStrip.descendants] : [];
check('the banner still renders', !!guardedStrip);
check(
  'but its call to action is dropped rather than made executable',
  !guardedNodes.some((n) => n.tagName === 'A'),
);

// ── In-app message renderers ──────────────────────────────────────────

console.log('\nan in-app message is built from nodes, never from markup');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The three campaign fields that carried the attack, each spelled the way it
 * was spelled in the browser that proved it. `fire` does not exist here —
 * what is checked is that no renderer ever hands these to a parser.
 */
const ATTACK = {
  title: '<img src=q onerror="fire(\'title\')">Spring promo',
  imageUrl: 'q" onerror="fire(\'imageUrl-attr\')" data-x="',
  titleColor: '#000"><img src=q onerror="fire(\'theme-color\')">',
};

function attackMessage(messageType) {
  return {
    id: `m-${messageType}`,
    messageType,
    title: ATTACK.title,
    body: 'Body copy',
    imageUrl: ATTACK.imageUrl,
    imagePosition: 'top',
    buttons: [{ id: 'b1', text: 'Open', action: 'dismiss', style: 'primary' }],
    theme: { backgroundColor: '#ffffff', titleColor: ATTACK.titleColor },
    dismissOnTapOutside: true,
    autoDismissSeconds: null,
    triggerDelay: 0,
  };
}

for (const type of ['modal', 'bottom_sheet', 'banner_top', 'banner_bottom', 'fullscreen']) {
  body.children = [];
  head.children = [];
  stubFetch((url) => (String(url).endsWith('/api/messages/check')
    ? { json: { data: { messages: [attackMessage(type)] } } }
    : { json: {} }));

  const manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
  await manager.checkMessages({});

  const root = body.children[0];
  const nodes = root ? [root, ...root.descendants] : [];
  const writes = nodes.flatMap((n) => n.innerHTMLWrites);

  check(`a ${type} renders`, !!root);
  check(`a ${type} writes no innerHTML`, writes.length === 0, writes.join(' | '));
  check(`a ${type} title stays text`, nodes.some((n) => n.textContent === ATTACK.title));
  check(
    `a ${type} theme colour is a style property, where CSSOM drops what it cannot parse`,
    nodes.some((n) => n.style.color === ATTACK.titleColor),
  );

  const img = nodes.find((n) => n.tagName === 'IMG');
  if (type === 'banner_top' || type === 'banner_bottom') {
    check(`a ${type} has no image to attack`, !img);
  } else {
    check(`a ${type} image url is a property, not an attribute`, img?.src === ATTACK.imageUrl);
    check(`…and the ${type} image carries no attributes at all`, Object.keys(img?.attrs ?? {}).length === 0);
  }
}

// ── The queue, the timers and the impression count ────────────────────

console.log('\none display, one impression, one copy of each message');

/** A check endpoint that answers from a list, one batch per call. */
function scriptMessages(batches) {
  const sent = [];
  let round = 0;
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith('/api/messages/check')) {
      const messages = batches[round] ?? [];
      round += 1;
      return { ok: true, status: 200, json: async () => ({ data: { messages } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return sent;
}

const eventTypes = (sent) => sent.filter((r) => r.url.endsWith('/api/messages/event')).map((r) => r.body?.eventType);
const checkCalls = (sent) => sent.filter((r) => r.url.endsWith('/api/messages/check'));
const onScreen = () => body.children.map((n) => n.getAttribute('data-chumbaq-message'));
// Found by what it is rather than by one of its attributes, so that running
// this suite against a renderer that spelled its × differently still finds
// the same button.
const closeButtonOf = (node) => [node, ...node.descendants].find((n) => (
  n.tagName === 'BUTTON'
  && (n.attrs['aria-label'] === 'Dismiss' || n.textContent === '×' || n.innerHTML === '&times;')
));
const clickOn = (node, event) => node?.listeners?.click?.forEach((fn) => fn(event));

function iam(id, overrides = {}) {
  return {
    id,
    messageType: 'modal',
    title: `Message ${id}`,
    body: null,
    imageUrl: null,
    imagePosition: 'top',
    buttons: null,
    theme: null,
    dismissOnTapOutside: true,
    autoDismissSeconds: null,
    triggerDelay: 0,
    ...overrides,
  };
}

const banner = (id, overrides = {}) => iam(id, { messageType: 'banner_top', ...overrides });

// The server's capping query counts `event_type IN ('impression',
// 'delivered')`, so reporting both spent two of a cap for one display: a cap
// of two allowed one. iOS and Android report `impression` alone.
body.children = [];
let sent = scriptMessages([[iam('a')]]);
let manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
await manager.checkMessages({});
check('one display reports one impression and nothing else', eventTypes(sent).join() === 'impression', eventTypes(sent).join());

// `maxImpressionsPerUser` and `minIntervalSeconds` are null by default, so
// the server keeps answering with the same message on every 60s poll.
body.children = [];
sent = scriptMessages([[iam('a')], [iam('a')]]);
manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
await manager.checkMessages({});
await manager.checkMessages({});
check('a message the server repeats is queued once', body.children.length === 1, `${body.children.length} on screen`);
check('…and shown once', eventTypes(sent).filter((t) => t === 'impression').length === 1, eventTypes(sent).join());

body.children = [];
sent = scriptMessages([[banner('a')], [banner('a')]]);
manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
await manager.checkMessages({});
clickOn(closeButtonOf(body.children[0]));
check('closing a message removes it', body.children.length === 0);
await manager.checkMessages({});
check('a closed message is not shown again', body.children.length === 0, onScreen().join());
check('…and the close was reported once', eventTypes(sent).filter((t) => t === 'dismiss').length === 1, eventTypes(sent).join());

// Closing no longer drains the queue — that is what showed a dismissed
// message again — so the next check is what moves the queue along.
body.children = [];
sent = scriptMessages([[banner('a'), banner('b')], []]);
manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
await manager.checkMessages({});
check('a batch of two shows one', onScreen().join() === 'a', onScreen().join());
clickOn(closeButtonOf(body.children[0]));
check('closing it does not immediately show the next', body.children.length === 0);
await manager.checkMessages({});
check('the next check shows the one still queued', onScreen().join() === 'b', onScreen().join());

// An auto-dismiss used to ask "is anything showing?", which after a manual
// close was true of the next message.
body.children = [];
sent = scriptMessages([[banner('a', { autoDismissSeconds: 0.05 })], [banner('b')]]);
manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
await manager.checkMessages({});
clickOn(closeButtonOf(body.children[0]));
await manager.checkMessages({});
check('the successor is on screen', onScreen().join() === 'b', onScreen().join());
await sleep(140);
check('a stale auto-dismiss does not close its successor', onScreen().join() === 'b', onScreen().join());
check('…and reports no auto-dismiss for a message nobody saw close', !eventTypes(sent).includes('auto_dismiss'), eventTypes(sent).join());

// Two things stop that stale timer — the dismiss clears it, and the callback
// checks which message it belongs to — and either alone is enough, so
// neither is pinned by the check above. This one takes the clock away from
// the SDK and refuses to cancel anything, which leaves the identity check as
// the only thing that can still save the successor.
function uncancellableClock() {
  const pending = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn) => pending.push(fn);
  globalThis.clearTimeout = () => {};
  return {
    pending,
    fire: () => {
      const due = pending.splice(0, pending.length);
      for (const fn of due) fn();
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

body.children = [];
sent = scriptMessages([[banner('a', { autoDismissSeconds: 30 })], [banner('b')]]);
manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
const clock = uncancellableClock();
try {
  await manager.checkMessages({});
  check('the message armed an auto-dismiss', clock.pending.length === 1, `${clock.pending.length} timers`);
  clickOn(closeButtonOf(body.children[0]));
  await manager.checkMessages({});
  check('the successor is on screen, with the first message’s timer still live', onScreen().join() === 'b', onScreen().join());
  clock.fire();
  check('an uncancellable stale timer still cannot close its successor', onScreen().join() === 'b', onScreen().join());
  check('…and does not report an auto-dismiss against it', !eventTypes(sent).includes('auto_dismiss'), eventTypes(sent).join());
} finally {
  clock.restore();
}
manager.dismissMessage();

// The screen is claimed before the trigger delay, not after it.
body.children = [];
sent = scriptMessages([[banner('a', { triggerDelay: 0.08 })], [banner('b')]]);
manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
await manager.checkMessages({});
check('nothing is on screen during a trigger delay', body.children.length === 0);
await manager.checkMessages({});
check('a check during the delay starts nothing', body.children.length === 0, onScreen().join());
await sleep(160);
check('the delayed message mounts alone', onScreen().join() === 'a', onScreen().join());

// Self-handled mode: the handoff is the display, and `delivered` is counted
// as an impression nowhere in the dashboard.
body.children = [];
sent = scriptMessages([[iam('a')]]);
manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon');
const selfHandled = [];
manager.onMessage((message) => selfHandled.push(message));
await manager.checkMessages({});
check('a self-handled message is handed over', selfHandled.length === 1);
check('…and reports an impression, not a delivery', eventTypes(sent).join() === 'impression', eventTypes(sent).join());

// ── Why a message closed ──────────────────────────────────────────────

console.log('\nonAction fires the reason the message actually closed');

const actions = [];
function listeningManager(distinctId = 'anon') {
  const next = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', distinctId);
  next.onAction((action) => actions.push(action));
  return next;
}

body.children = [];
actions.length = 0;
sent = scriptMessages([[iam('a')]]);
manager = listeningManager();
await manager.checkMessages({});
const overlay = body.children[0];
clickOn(overlay, { target: overlay });
check('a tap outside is handed to onAction as tap_outside', actions[0]?.actionType === 'tap_outside', JSON.stringify(actions));
check('…and recorded as dismiss, the event type the API has', eventTypes(sent).join() === 'impression,dismiss', eventTypes(sent).join());

body.children = [];
actions.length = 0;
sent = scriptMessages([[iam('b', { messageType: 'fullscreen' })]]);
manager = listeningManager();
await manager.checkMessages({});
clickOn(closeButtonOf(body.children[0]));
check('a close button is handed to onAction as dismiss', actions[0]?.actionType === 'dismiss', JSON.stringify(actions));

body.children = [];
actions.length = 0;
sent = scriptMessages([[banner('c', { autoDismissSeconds: 0.05 })]]);
manager = listeningManager();
await manager.checkMessages({});
await sleep(140);
check('an auto-dismiss is handed to onAction as auto_dismiss', actions[0]?.actionType === 'auto_dismiss', JSON.stringify(actions));
check('…and recorded as auto_dismiss', eventTypes(sent).join() === 'impression,auto_dismiss', eventTypes(sent).join());
check('…and the message is gone', body.children.length === 0);

// ── A logout ──────────────────────────────────────────────────────────

console.log('\na logout takes the previous user’s campaigns with it');

body.children = [];
sent = scriptMessages([[banner('a'), banner('b')], []]);
manager = new InAppMessageManager('https://api.test', 'key', 'proj', 'fp', 'anon-1');
await manager.checkMessages({});
check('a message is showing before the reset', onScreen().join() === 'a');
manager.reset('anon-2');
check('the reset takes it off the screen', body.children.length === 0);
await manager.checkMessages({});
check('a message queued for the previous user is not served to the next', body.children.length === 0, onScreen().join());
check('the new distinct id is what is asked about', checkCalls(sent).at(-1)?.body?.distinctId === 'anon-2', JSON.stringify(checkCalls(sent).at(-1)?.body));

// ── init, end to end ──────────────────────────────────────────────────

console.log('\ninit starts messaging even when identify fails');

const { Chumbaq } = await jiti.import(path.join(here, 'index.ts'));

body.children = [];
const initSent = [];
globalThis.fetch = async (url, init = {}) => {
  initSent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
  if (String(url).includes('/api/identity/identify')) {
    return { ok: false, status: 401, text: async () => 'Unauthorized', json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => ({ data: { messages: [] } }) };
};

// The 60s poll is the other half of what a thrown identify used to skip,
// and an interval is not observable from outside the manager.
const intervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { intervals.push(ms); return realSetInterval(fn, ms); };

const chumbaq = new Chumbaq({ baseUrl: 'https://api.test', apiKey: 'key', projectId: 'proj' });
let initThrew = false;
try {
  await chumbaq.init();
} catch {
  initThrew = true;
}
globalThis.setInterval = realSetInterval;

check('a failed identify still checks for messages', initSent.some((r) => r.url.endsWith('/api/messages/check')));
check('…and still starts the poll', intervals.includes(60000), intervals.join());
// Reported to the caller all the same, once messaging is running: a 401 here
// is usually a wrong API key, and the fix for one silent failure should not
// be another.
check('…and the caller still hears about the failure', initThrew);

// `Chumbaq.reset()` is the logout a host actually calls.
const beforeReset = chumbaq.distinctId;
chumbaq.reset();
await chumbaq.inAppMessages.checkMessages({});
const resetCheck = initSent.filter((r) => r.url.endsWith('/api/messages/check')).at(-1);
check('reset gives the message manager the new anonymous id', resetCheck?.body?.distinctId === chumbaq.distinctId, JSON.stringify(resetCheck?.body));
check('…which is not the one that just logged out', chumbaq.distinctId !== beforeReset);
chumbaq.inAppMessages.stopPolling();

// ── A banner widget that fails to load ────────────────────────────────

console.log('\na banner widget that fails to load takes the previous one down');

body.children = [];
stubFetch((url) => (String(url).endsWith('/w9') ? { ok: false, json: {} } : { json: { data: widget } }));
const stale = new BannerRenderer('https://api.test', 'key');
await stale.load('w1');
stale.render();
check('the first widget renders', body.children.length === 1);

await stale.load('w9');
stale.render();
check('a 404 on the next widget leaves nothing on screen', body.children.length === 0, `${body.children.length} on screen`);
stale.render();
check('…and nothing is left loaded to render again', body.children.length === 0);

// ── A push report from a service worker ───────────────────────────────

console.log('\na service worker reports under the id the page mirrored');

/**
 * One database, one object store, key and value — enough of the request and
 * event shape for `DeviceIdentityStore` to drive. The real store runs
 * against this; real IndexedDB is covered in the browser.
 */
function fakeIndexedDB() {
  const data = new Map();
  // A store attaches its handlers after the call returns, so a result has to
  // arrive no earlier than the next tick.
  const asRequest = (run) => {
    const request = {};
    queueMicrotask(() => {
      try {
        request.result = run();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
    });
    return request;
  };
  const store = {
    get: (key) => asRequest(() => data.get(key)),
    put: (value, key) => asRequest(() => void data.set(key, value)),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
  };
  globalThis.indexedDB = { open: () => asRequest(() => db) };
  return data;
}

/** A page has durable storage; a worker has neither this nor `document`. */
function fakeLocalStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
  };
  return data;
}

const pushEvents = (calls) => calls
  .filter((c) => c.url.endsWith('/api/push-notifications/events'))
  .map((c) => c.body);

const mirrored = fakeIndexedDB();
const stored = fakeLocalStorage();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A page: restores or mints its id, reports under it, and mirrors it for
// this origin's workers.
calls = stubFetch({ json: {} });
const page = new Chumbaq({ baseUrl: 'https://api.test', apiKey: 'key', projectId: 'proj' });
const pageId = page.deviceFingerprint;
await page.reportPushReceived({ chumbaq_campaign_id: 'camp-page' });
await settle();

check('a page reports under its own device id', pushEvents(calls)[0]?.deviceFingerprint === pageId, JSON.stringify(pushEvents(calls)[0]));
check('the page mirrors that id where a worker can read it', mirrored.get('device_fingerprint') === pageId, JSON.stringify([...mirrored]));
check('…and mirrors the id storage holds, not a second one', stored.get('chumbaq_device_fp') === mirrored.get('device_fingerprint'));

// A worker: no `document`, no `localStorage`. The id its constructor mints
// is a fresh one per activation and means nothing to the server, which is
// why this path was broken; the mirror is the real answer.
const savedDocument = globalThis.document;
const savedStorage = globalThis.localStorage;
delete globalThis.document;
delete globalThis.localStorage;
try {
  calls = stubFetch({ json: {} });
  const worker = new Chumbaq({ baseUrl: 'https://api.test', apiKey: 'key', projectId: 'proj' });
  check('a worker mints an id of its own, which is not the device’s', worker.deviceFingerprint !== pageId);

  await worker.reportPushReceived({ chumbaq_campaign_id: 'camp-sw' });
  check('a worker reports the delivery', pushEvents(calls).length === 1, `${pushEvents(calls).length} reports`);
  check('…under the id the page mirrored, not the one it minted', pushEvents(calls)[0]?.deviceFingerprint === pageId, JSON.stringify(pushEvents(calls)[0]));
  check('…as a delivery, on the web platform', pushEvents(calls)[0]?.type === 'delivered' && pushEvents(calls)[0]?.platform === 'web');

  calls = stubFetch({ json: {} });
  url = await worker.reportPushClicked({ chumbaq_campaign_id: 'camp-sw', deep_link_url: 'https://app.test/x' });
  check('a worker reports a tap under the same id', pushEvents(calls)[0]?.deviceFingerprint === pageId && pushEvents(calls)[0]?.type === 'click');
  check('…and hands back the destination', url === 'https://app.test/x');

  // The one case that still refuses: nothing mirrored to report under.
  // Reporting under a minted id would add a device rather than a delivery,
  // and `PushAnalyticsService.recordEvent` 404s on an unknown fingerprint
  // anyway.
  mirrored.clear();
  calls = stubFetch({ json: {} });
  const orphan = new Chumbaq({ baseUrl: 'https://api.test', apiKey: 'key', projectId: 'proj' });
  await orphan.reportPushReceived({ chumbaq_campaign_id: 'camp-orphan' });
  check('a worker with an empty mirror reports nothing', pushEvents(calls).length === 0, `${pushEvents(calls).length} reports`);

  url = await orphan.reportPushClicked({ chumbaq_campaign_id: 'camp-orphan', deep_link_url: 'https://app.test/y' });
  check('…and a tap it cannot report still goes where it was going', url === 'https://app.test/y');
  check('…and still reports nothing', pushEvents(calls).length === 0);
} finally {
  globalThis.document = savedDocument;
  globalThis.localStorage = savedStorage;
}

// A page whose storage is not durable mints an id per page load. Mirroring
// one of those would leave a worker reporting under an id that died with the
// tab, so it is not mirrored at all.
mirrored.clear();
delete globalThis.localStorage;
try {
  stubFetch({ json: {} });
  const ephemeral = new Chumbaq({ baseUrl: 'https://api.test', apiKey: 'key', projectId: 'proj' });
  await settle();
  check('a page with no durable storage does not mirror its id', mirrored.size === 0, JSON.stringify([...mirrored]));
  check('…and still reports under it itself', await (async () => {
    calls = stubFetch({ json: {} });
    await ephemeral.reportPushReceived({ chumbaq_campaign_id: 'camp-ephemeral' });
    return pushEvents(calls)[0]?.deviceFingerprint === ephemeral.deviceFingerprint;
  })());
} finally {
  globalThis.localStorage = savedStorage;
}

delete globalThis.indexedDB;

// ── Diagnostics ───────────────────────────────────────────────────────

console.log('\ndiagnostics are opt-in, and never carry the api key');

const { Diagnostics } = await jiti.import(path.join(here, 'diagnostics.ts'));

const SECRET = 'chumbaq_0000000000000000000000000000000000000000000000000000000000000000';
const written = [];
const realWarn = console.warn;
const realDebug = console.debug;
const record = (...parts) => written.push(parts.map((part) => (typeof part === 'string' ? part : String(part))).join(' '));

console.warn = record;
console.debug = record;
try {
  stubFetch({ ok: false, json: {} });
  await new InAppMessageManager('https://api.test', SECRET, 'proj', 'fp', 'anon').checkMessages({});
  check('a failure is silent by default', written.length === 0, written.join(' | '));

  stubFetch({ ok: false, json: {} });
  await new InAppMessageManager('https://api.test', SECRET, 'proj', 'fp', 'anon', new Diagnostics(true)).checkMessages({});
  check('with debug on, the failure is reported', written.some((line) => line.includes('message check answered 500')), written.join(' | '));
  check('every line says who wrote it', written.every((line) => line.startsWith('[chumbaq] ')), written.join(' | '));
  check('the api key is never written', written.every((line) => !line.includes(SECRET)));
} finally {
  console.warn = realWarn;
  console.debug = realDebug;
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);

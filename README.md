# Chumbaq JavaScript SDK

`@chumbaq/sdk` — the web SDK for [Chumbaq](https://chumbaq.com): events,
identity, deferred deep links, web push, banners and in-app messages.

## Installation

```sh
npm install @chumbaq/sdk
```

## Getting started

```ts
import { Chumbaq } from '@chumbaq/sdk';

const chumbaq = new Chumbaq({
  baseUrl: 'https://api.your-chumbaq-host.com',
  apiKey: 'YOUR_API_KEY',
  projectId: 'YOUR_PROJECT_ID',
  debug: true, // log SDK diagnostics to the console while integrating
});

await chumbaq.init();
```

`init()` sets the `chumbaq_did` cookie and registers an anonymous device
identity. Server-side click attribution depends on that cookie, so call
`init()` early on every page.

## Events and identity

```ts
await chumbaq.track('signed_up', { plan: 'free' });
await chumbaq.trackRevenue(499, 'INR');

await chumbaq.identify({
  deviceFingerprint: chumbaq.deviceFingerprint,
  platform: 'web',
  externalUserId: 'user-123',
  firstName: 'Jane',
  traits: { plan: 'free' },
});

chumbaq.reset(); // on logout
```

`identify()` merges the anonymous history into the identified user.

## In-app messages and banners

The SDK polls for in-app messages every 60 seconds and whenever the screen
changes:

```ts
chumbaq.setScreen('checkout');
await chumbaq.showBanner('WIDGET_ID', 'bottom');
```

## Deferred deep links

```ts
const match = await chumbaq.matchDeferredDeepLink();
```

## Web push

```ts
await chumbaq.registerPushToken({ token, platform: 'web', provider: 'fcm' });
```

In your service worker, report delivery and clicks with
`reportPushReceived(data)` and `reportPushClicked(data)`.

## Privacy: consent, do-not-track, deletion and export

These controls help you comply with India's DPDP Act. Consent travels with
`identify()`; a field you leave out changes nothing on the server.

```ts
await chumbaq.identify({
  deviceFingerprint: chumbaq.deviceFingerprint,
  platform: 'web',
  externalUserId: 'user-123',
  pushOptIn: false,  // no push to this device
  emailOptIn: true,
  smsOptIn: false,
  whatsappOptIn: false,
  doNotTrack: true,  // stop storing behavioural data from this device
});
```

- `pushOptIn: false` makes every push send skip this device. Left unset, push
  is allowed and the browser's notification permission governs.
- `doNotTrack: true` stops the server storing events, sessions, location and
  campaign sources for this device. It still answers 2xx, so nothing retries.
  It does not block messages; the channel opt-ins decide those. If you don't
  pass `doNotTrack`, the SDK sends `true` when the browser's Do Not Track
  setting is on (including from `init()`).
- It covers this device only. A person-wide objection is an owner action in
  the dashboard API, and the SDK cannot lift that, or any do-not-track set from
  the dashboard, by sending `doNotTrack: false`.
- Every consent change is recorded with its source.
- Known gaps: there is no dedicated consent call (a change needs another
  `identify()`), and the SDK keeps sending events while do-not-track is on
  (the server drops them).

There is no SDK call to delete or export a user, on purpose: the API key ships
in your web app, so anyone can extract it. Have your backend call the server
API with a key created with the server-only `privacy` permission. Never put
that key in client code; SDK routes refuse it.

```sh
curl -X POST https://api.your-chumbaq-host.com/api/privacy/erasures \
  -H 'x-api-key: <privacy key>' -H 'content-type: application/json' \
  -d '{"externalUserId": "user-123"}'
```

`POST /api/privacy/exports` takes the same body and returns the user's data.
For an anonymous device, send `{"deviceFingerprint": "..."}` (from
`chumbaq.deviceFingerprint`) instead. Records that cannot be tied to one person
are kept; the response lists them in `notErased` (`notIncluded` for exports).
After deleting a user, call `chumbaq.reset()` in the browser so it stops
sending their id.

## Development

```sh
npm install
npm run lint         # type-check
npm run test:logic   # wire-contract checks
npm run build        # emit dist/
```

## Related SDKs

- [iOS](https://github.com/sohelyadav/chumbaq-ios-sdk)
- [Android](https://github.com/sohelyadav/chumbaq-android-sdk)
- [Flutter](https://github.com/sohelyadav/chumbaq-flutter-sdk)

## License

Copyright 2026 The Chumbaq Authors.

Licensed under the [Apache License, Version 2.0](LICENSE).

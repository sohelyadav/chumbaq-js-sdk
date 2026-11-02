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

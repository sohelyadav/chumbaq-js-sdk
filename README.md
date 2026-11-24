# Chumbaq JavaScript SDK

`@chumbaq/sdk` — the web SDK for [Chumbaq](https://chumbaq.com): events,
identity, deferred deep links, web push, banners and in-app messages.

## First push in 10 minutes

For a website that has never used Chumbaq. Web push goes through Firebase
Cloud Messaging, so you also need a Firebase project.

**1. Create a project.** In the Chumbaq dashboard, create a project and copy
its project ID and its SDK (project API) key. Under Push Notifications →
Settings, upload your Firebase project's service account key.

**2. Install the package.**

```sh
npm install @chumbaq/sdk
```

**3. Initialise the SDK.** Call this early on every page:

```ts
import { Chumbaq } from '@chumbaq/sdk';

const chumbaq = new Chumbaq({
  baseUrl: 'https://your-chumbaq-host',
  apiKey: '<SDK key>',
  projectId: '<project id>',
});
await chumbaq.init();
```

**4. Get the web push token.** Follow [Get the web push token](#get-the-web-push-token):
it asks for permission, gets the token from Firebase, calls
`chumbaq.registerPushToken`, and sets up the service worker. Log the token
once; you need it in step 6.

**5. Identify the user.** Call `chumbaq.identify` with `externalUserId` and a
`userHash` made on your server. See [Identity verification](#identity-verification)
for the call and how to make the hash.

**6. Send a test push.** In the dashboard, open Push Notifications → Settings
tab → Test send, paste the token and send. If nothing arrives, pass
`debug: true` to `new Chumbaq(...)` and check the browser console.

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
  userHash, // from your server: see Identity verification
  firstName: 'Jane',
  traits: { plan: 'free' },
});

chumbaq.reset(); // on logout
```

`identify()` merges the anonymous history into the identified user.

### Identity verification

An external user id must come with a `userHash`: HMAC-SHA256 of the id under your
project's identity secret (API keys page), made on **your server**, never in the app.
Without it the server refuses the identify, so nobody holding your app's public key
can claim to be one of your users.

```ts
// On your server
const userHash = crypto.createHmac('sha256', IDENTITY_SECRET).update(userId).digest('hex');

// In the app, with the hash your server returned
await chumbaq.identify({ externalUserId: userId, userHash });
```

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

### Get the web push token

Chumbaq sends web push through Firebase Cloud Messaging, so the token comes
from the Firebase JS SDK. The Chumbaq SDK does not fetch it for you.

1. Install Firebase next to the SDK:

   ```sh
   npm install firebase
   ```

2. In the [Firebase console](https://console.firebase.google.com), open
   **Project settings**:
   - **General → Your apps**: add a web app and copy its `firebaseConfig`.
   - **Cloud Messaging → Web configuration → Web Push certificates**: click
     **Generate key pair** and copy the public key. That is your VAPID key.

3. On the page, ask for permission, get the token and register it. Browsers
   (Safari in particular) only show the permission prompt after a user
   action, so call this from a click handler:

   ```ts
   import { initializeApp } from 'firebase/app';
   import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
   import { Chumbaq } from '@chumbaq/sdk';

   const chumbaq = new Chumbaq({ baseUrl, apiKey, projectId });
   await chumbaq.init();

   const app = initializeApp(firebaseConfig);

   async function enablePush() {
     if (!(await isSupported())) return;
     if ((await Notification.requestPermission()) !== 'granted') return;

     const messaging = getMessaging(app);
     const token = await getToken(messaging, { vapidKey: 'YOUR_VAPID_KEY' });
     await chumbaq.registerPushToken({ token, platform: 'web', provider: 'fcm' });

     // A push that arrives while a tab is open and visible goes here, not to
     // the service worker, and Firebase does not show it.
     onMessage(messaging, (payload) => chumbaq.reportPushReceived(payload.data ?? {}));
   }
   ```

   `getToken` registers the service worker at `/firebase-messaging-sw.js`,
   so serve the file below from your site root.

4. The service worker. It imports npm packages, so bundle it with your build
   tool (for example `esbuild sw.js --bundle --outfile=public/firebase-messaging-sw.js`):

   ```js
   // sw.js, bundled to /firebase-messaging-sw.js
   import { initializeApp } from 'firebase/app';
   import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
   import { Chumbaq } from '@chumbaq/sdk';

   // Do not call init() here: a worker builds the SDK only to report.
   const chumbaq = new Chumbaq({ baseUrl, apiKey, projectId });

   // Add this before getMessaging(): Firebase's own click listener stops
   // the event from reaching listeners added after it.
   self.addEventListener('notificationclick', (event) => {
     const data = event.notification.data?.FCM_MSG?.data ?? {};
     event.waitUntil(chumbaq.reportPushClicked(data));
   });

   const messaging = getMessaging(initializeApp(firebaseConfig));

   // Firebase shows the notification itself, so only report it here.
   onBackgroundMessage(messaging, (payload) => chumbaq.reportPushReceived(payload.data ?? {}));
   ```

   Firebase also opens the campaign's deep link on click, so the worker
   ignores the URL `reportPushClicked` returns. `FCM_MSG` is where Firebase
   keeps the original message on a notification it showed.

The worker reports under the device id the page saved during `init()`, which
is why the page calls `init()` before registering the token. Call `chumbaq.unregisterPushToken(token)` when the user turns push off.

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

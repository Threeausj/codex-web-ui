# PWA and background notifications

[简体中文](pwa.md) · **English**

Codex Web UI can be installed on a phone's home screen and use standard Web Push after explicit user permission. The running Node server sends notifications from app-server events, so the page does not need to stay open. Completion, approval/additional input, and failures are independently selectable. A browser can start the Service Worker for an incoming push even when the page is not loaded. [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).

## Deployment requirements

- Use a reachable public HTTPS domain with a trusted certificate and the exact `PUBLIC_ORIGIN`. Docker users can follow the [public HTTPS guide](docker.en.md#public-https).
- Use a production build: `npm run build` followed by `npm start` for Node; Docker already includes it. Vite development mode does not register the Service Worker and is unsuitable for installation/background-push acceptance.
- Keep Node, the relevant app-server, and the task running. The server needs access to the browser vendor's push service. Official FCM, Mozilla, Apple, and Windows endpoints are supported; arbitrary custom endpoints are rejected, with no environment setting to relax the checks.
- Persist `DATA_DIR`. Docker's `webdata` volume already covers push keys and authorized devices. No Apple developer account or separately deployed notification relay is needed.
- Sign in and enable notifications on each device. Installation does not grant notification permission; previously denied permission must be changed in the OS/browser settings.

The user selects **Enable notifications** to request permission. Supporting browsers require a secure context; ordinary public HTTP is insufficient. [MDN notification permission](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static). Loopback development is separate from phone acceptance over a real HTTPS deployment; a LAN HTTP address is not a substitute.

## Android / Chrome

1. Open the HTTPS deployment in Chrome and sign in.
2. Open **Settings → App and notifications** (“应用与通知”). Select **Install app** when available, or use Chrome's installation menu. No repeat prompt appears when already installed or when the browser has not offered installation.
3. Launch the installed app and select **Enable notifications** (“启用通知”), approve the system prompt, and choose categories.
4. Select **Send test notification** (“发送测试通知”) and confirm a system notification appears. Installation and permission menus vary by browser/OS version. [MDN PWA installation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Installing).

## iPhone / iPad

1. On **iOS/iPadOS 16.4 or later**, open the HTTPS deployment in Safari.
2. Select **Share → Add to Home Screen** and confirm.
3. Launch Codex Web UI from its home-screen icon, then sign in there. Check the actual device's login state instead of assuming it matches an ordinary Safari tab.
4. Open **App and notifications**, explicitly select **Enable notifications**, and approve the system prompt. Adding the icon alone does not request permission.
5. Send a test notification and check the app's OS notification settings; Focus modes may silence it.

iOS/iPadOS Web Push is available to home-screen web apps. Permission needs a direct user action, and delivery integrates with the lock screen, Notification Center, and Focus settings. [WebKit's official announcement](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Categories, privacy, and authorization

The test button shows progress, errors, and confirmation that the push provider accepted the request. Acceptance is not a device delivery receipt. **Check system notifications** (“检查系统通知”) displays a notification directly through the device's Service Worker, independently of the remote push network. If this succeeds but remote tests do not arrive, check phone connectivity to Google's push service and battery restrictions. FCM device connections require TCP 443 and 5228–5230; an HTTP proxy cannot proxy that connection. [Firebase network configuration](https://firebase.google.com/docs/cloud-messaging/network-configuration).

Tests use unique notification tags/topics, all user-visible task notifications use high urgency, and replacement notifications alert again.

**Reply completed**, **Approval needed**, and **Run failed** are enabled by default. Approval notifications also cover requests for additional input. Categories are device-specific; other devices can choose differently. **Disable notifications** (“关闭通知”) removes the current device's subscription without changing others.

Task notification titles show the conversation name and the body shows the event, such as the title “Deploy project” with “运行完成” (Run completed), “运行失败” (Run failed), “等待命令执行确认” (Waiting for command approval), or “等待补充输入” (Waiting for additional input) as its body. The conversation name matches the web list: the saved name takes precedence, followed by the preview title, then “未命名对话” (Unnamed conversation) when neither is available. Reply text, file paths, and commands are excluded; the conversation name is visible in system notifications. Navigation data identifies the host/chat to reopen; a valid web login is still required. A notification never approves a request or runs an operation.

Device authorization lasts **up to 30 days**, or less if the browser subscription expires sooner, independently of the **30-day web login session**. Natural login expiration or Node restarts do not directly revoke a still-valid device authorization. Restoring/saving an existing subscription after login renews it. Explicit logout revokes subscriptions associated with that login, leaving other devices unaffected. Changing the access password under Settings → Account → Web access revokes other devices' sessions and push authorizations, retaining devices associated with the current login. After clearing browser data, revoking OS permission, deleting persistent data, or rotating VAPID keys, sign in and enable notifications again. Push-service responses 404/410 remove invalid subscriptions.

Private state is stored with mode `0600` in `DATA_DIR`:

| Setting/file | Purpose |
| --- | --- |
| `push-vapid.json` | Automatically generated VAPID key pair when explicit keys are absent |
| `push-subscriptions.json` | Device endpoints, subscription keys, authorization expiry, and categories |
| `PUSH_VAPID_PUBLIC_KEY` / `PUSH_VAPID_PRIVATE_KEY` | Optional existing key pair; set both or leave both empty for automatic generation |
| `PUSH_SUBJECT` | Optional VAPID contact; a real maintainer `mailto:` address is recommended. Defaults to the first HTTPS `PUBLIC_ORIGIN`, or the project GitHub URL for local HTTP |

Back up this state with private deployment configuration and keep it out of Git. Keeping the same VAPID keys/subscriptions preserves device registration through routine container recreation. Re-register after changing domains or keys. Manual key generation is not required to deploy.

## Background operation, offline behavior, and updates

Reverse proxies/CDNs should honor origin cache headers: revalidate HTML/manifest, never cache `sw.js` or APIs, and cache content-hashed assets long term. Worker registration and entry-file fetches include a build identifier to avoid stale upstream cache entries. If a previous deployment's entry page is already cached, purge `/`, `/index.html`, and `/sw.js`, or initially open `/?update=current-version`; subsequent navigation through the updated Worker bypasses stale entry HTML.

The manifest requests `launch_handler: focus-existing`. Supporting browsers focus an existing app window on an icon relaunch without navigating the current chat to the start page; notification launches still select their host and conversation. Unsupported browsers retain their existing launch behavior. [Chrome Launch Handler API](https://developer.chrome.com/docs/web-platform/launch-handler).

Android Chrome may close the PWA window when Back is used at the root page. Web code cannot call Android's task-backgrounding API or require the OS to retain the window. Use the system Home gesture/button to background the app. Back dismisses open mobile sidebars first; the app does not repeatedly insert history to prevent exiting. Mapping root Back to task suspension requires a native Android wrapper. [Android root Back behavior](https://developer.android.com/about/versions/12/behavior-changes-all#back-press).

Reading positions are stored privately by validated login, host, and conversation, bounded to 32 positions and cleared on logout or session expiry. A fresh window can restore them after its predecessor is discarded. Hiding, freezing, or leaving the page immediately saves reading positions, recent history, and editor drafts without waiting for the normal draft debounce timer.

On becoming visible, resuming from a frozen state, returning from the back/forward cache, or reconnecting to the network, the app checks its session and connection. A bounded read-only request detects sockets that still report OPEN but no longer answer. Recovery reconnects and synchronizes the selected chat; it never resends messages, commands, or approvals. Browser storage preserves the host, project, chat selection, and drafts across reopening. Existing authorized push subscriptions are synchronized and renewed on return.

Private API reads use a unique request query parameter and `no-store` so an upstream cached anonymous response cannot return the app to the login screen. A notification request returning 401 or a WebSocket authentication close first triggers a fresh check of the current cookie's session. Only a confirmed expired session clears login; temporary network failures and delayed responses from an older login do not.

Android may freeze or discard background pages, so a permanent browser WebSocket cannot provide durable execution. The server's app-server keeps running independently of browser clients; the app restores its connection and reads the current task state on return. [Chrome Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

When the page closes or the phone locks, the backend keeps receiving events from existing host connections and attempts push delivery. With valid subscriptions, startup attempts to restore configured host connections. Notifications cannot keep a stopped Node server or Codex task alive. Container restarts end container processes; disk persistence cannot restore execution. Notifications for surviving proxy/remote tasks depend on app-server reconnection events.

Delivery depends on vendor services, network access, permissions, Focus, and OS resource policies. Closed-page push is supported, but immediate delivery after force-stopping apps or under strict power-saving/system restrictions is not guaranteed. Use the actual app-server state/history when returning to the app, rather than relying on notifications as the only result record.

The Service Worker caches only the public app shell and static assets, excluding APIs, uploads, previews, and private conversations. A separate IndexedDB snapshot cache is scoped to a validated login, bounded to 12 chats / 4 MiB / 24 hours, and cleared on logout or expired login. Relaunch restores the last selected chat and cached history before reconciling native state; sending stays disabled until reconciliation. Offline startup cannot show private snapshots without validating the login or send, approve, edit files, or execute tasks.

Snapshots are saved when the page becomes hidden, and foreground recovery checks the session and connection. Android may freeze or discard the page process; a PWA cannot require permanent background residency. Restore and the server's retained runtime handle that lifecycle. [Chrome page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api). Explicitly releasing Web Codex in Resource Management keeps the host paused across automatic reconnects and service restarts until **Connect Web Codex** is selected.

Settings shows **New version available** (“有新版本可用”) when an update is ready. **Update app** (“更新应用”) activates it and reloads only after your action; the button is disabled during a running task. Version detection never automatically refreshes a working page. Plan backend restarts and retain persistent data as described in [Docker operations](docker.en.md#operations-backups-and-upgrades).

Legacy device subscriptions without a credential generation are revoked on upgrade. Enable notifications again on each affected device.

## Real-device acceptance

These steps require actual Android/iOS devices and the deployed HTTPS service. Browser emulation and automated tests do not establish real-device delivery. Real-phone, lock-screen, and public push-service acceptance has not been claimed.

1. Record the device, OS/browser versions, and HTTPS domain. Install and sign in on Android and iOS separately, then explicitly enable notifications.
2. Send a test notification and verify generic wording in the notification center/lock screen. Inspect notification permission, Focus, and power-saving settings.
3. Start an explicitly authorized test task from another signed-in page. Background/close the phone app and lock the phone; confirm the notification shows the conversation name and completion event while Node and the task remain running.
4. Start a task that waits for approval/additional input under the selected policy. Tap its lock-screen notification and verify the correct local/SSH host and chat. Approval must occur in the authenticated page.
5. Use a controlled failure to check the conversation name and **Run failed** event and ensure no reply, command, or path is exposed. Disable each category separately and confirm suppression on that device.
6. Let the web login expire naturally and check delivery while device authorization remains valid. Tap, sign in again, and verify the target chat. Explicitly log out and verify its associated subscriptions stop receiving notifications, while another authorized device remains independent.
7. Check the offline connection state, absence of private API caching, and absence of offline submissions. Reconnect and check authoritative chat state.
8. Deploy an updated build. Confirm the update prompt, disabled update during a task, and explicit update while idle. Recreate while retaining `webdata` and retest the device subscription. Record restarts and force-stop scenarios separately; do not assume active tasks or immediate notifications recover.

For failures, check HTTPS/origin, permission/subscription state, server availability, categories/expiry, persistence, and access to vendor push services. Never publish device endpoints, private keys, or login data in issue logs.

# Combined Chat

One window for Twitch, Kick, and (later) X live chat. Built for Fordenad to load in OBS as a browser dock (reading chat) and as a browser source (optional on-stream overlay).

Defaults are already set to **fordenad** on all three platforms. No stream keys, passwords, or logins are used for reading chat.

## Hosted URL (nothing to run on the stream PC)

The page and Kick relay are set up to be hosted on Render (free plan): the server binds `0.0.0.0` and `process.env.PORT`, and when you open the page over HTTPS it uses a same-origin `wss://…/kick` connection.

Once the service is live, use these in OBS (no local Node process):

- Dock: `https://<service>.onrender.com/combined-chat.html?twitch=fordenad&kick=fordenad&bg=solid`
- Overlay: `https://<service>.onrender.com/combined-chat.html?twitch=fordenad&kick=fordenad&bg=transparent&fade=30`

Free Render web services spin down after a stretch of inactivity. The first open after that can take about 30–60 seconds (sometimes longer). If the dock is blank, wait and refresh once.


## What you get

| File | Role |
|---|---|
| `combined-chat.html` | The chat page itself. Twitch works in this file alone. |
| `kick-relay.mjs` | A tiny local helper required for Kick. Node.js only; no packages to install. |
| `screenshot.png` | A test capture against live Twitch and Kick chats (see “What was tested”). |

X is a visible placeholder only. This page will not scrape X; chat can be added once X Livestream API access is approved.

## Option A — recommended: run the local helper

Kick’s chat socket (Centrifugo, since October 2026) only accepts connections whose Origin is `https://kick.com`. A browser, including OBS, cannot set that header, so Kick chat cannot be read from a local HTML file alone. The helper talks to Kick for you and stays on `127.0.0.1`.

1. Install [Node.js](https://nodejs.org/) 18+ if you don’t already have it (the stream PC likely does).
2. In a terminal, from this folder, leave this running while you stream:

```bash
node kick-relay.mjs
```

3. It prints a URL like `http://127.0.0.1:8787/combined-chat.html`. Query parameters work on this URL, which is more reliable than OBS “Local file”.

### OBS custom dock (for you to read and follow chat)

1. In OBS: **Docks → Custom Browser Docks…**
2. Dock name: `Combined Chat`
3. URL:

```
http://127.0.0.1:8787/combined-chat.html?twitch=fordenad&kick=fordenad&bg=solid&theme=dark
```

4. Click **Apply** and drag the dock where you want it.
5. Leave `node kick-relay.mjs` running. If you close it, Twitch in the page still works; Kick will show “start kick-relay.mjs” until you start it again.

### OBS browser source (optional on-stream overlay)

1. **Sources → + → Browser**
2. Uncheck **Local file**.
3. URL (transparent background, messages fade after 30 seconds — adjust as you like):

```
http://127.0.0.1:8787/combined-chat.html?twitch=fordenad&kick=fordenad&bg=transparent&fade=30&theme=dark
```

4. Width / height: e.g. `400` × `700`.
5. Check **Shutdown source when not visible**. Custom CSS can be left at the default `body { background-color: rgba(0, 0, 0, 0); }`.

## Option B — Twitch only, as a local file (no Node)

If you only need Twitch, or you want a file-based source:

1. **Sources → + → Browser**, check **Local file**, and choose `combined-chat.html`.
2. OBS “Local file” **strips query parameters**. Edit the config block at the top of `combined-chat.html` instead (`window.COMBINED_CHAT_CONFIG`).
3. Alternative: uncheck Local file and set the URL to:

```
file:///full/path/to/combined-chat.html?twitch=fordenad&kick=fordenad&bg=solid
```

Kick still needs `kick-relay.mjs` running in the background. The page will try `ws://127.0.0.1:8787/kick` automatically.

## URL parameters and config

Query params override the config block.

| Param | Config key | Default | Meaning |
|---|---|---|---|
| `twitch` | `twitch` | `fordenad` | Twitch login. Empty = off. |
| `kick` | `kick` | `fordenad` | Kick channel slug. Empty = off. |
| `x` | `x` | `fordenad` | Shown as a placeholder only. |
| `bg` | `bg` | `solid` | `solid` for a dock, `transparent` (or `overlay`) for an overlay. |
| `theme` | `theme` | `dark` | `dark` or `light`. |
| `max` | `maxMessages` | `80` | How many messages to keep. |
| `fade` | `fadeOut` | `0` | Hide messages after N seconds; `0` keeps them. |
| `size` | `fontSize` | `16` | Base font size in pixels. |
| `kickChatroomId` | `kickChatroomId` | *(blank)* | Optional. Only needed if name lookup fails. |
| `kickRelay` | `kickRelay` | auto | Relay URL. Default `ws://127.0.0.1:8787/kick`. Set `off` to skip Kick. |

Example: Twitch + Kick overlay, larger type, faster fade:

```
http://127.0.0.1:8787/combined-chat.html?twitch=fordenad&kick=fordenad&bg=transparent&fade=25&size=18
```

## Finding a Kick chatroom id (rarely needed)

The relay looks this up from your Kick name. If that ever fails, open this in a normal browser tab:

```
https://kick.com/api/v2/channels/fordenad
```

Find `"chatroom":{"id":` and put that number in `kickChatroomId` in the config block, or add `&kickChatroomId=12345` to the URL. Pasting the id into the HTML file alone is **not** enough — the Kick socket still has to go through the relay.

## Kick caveats

- Browser-only Kick reading was tested and does **not** work: the HTTP lookup for a channel allows other sites, but the live chat websocket returns a handshake error unless Origin is `https://kick.com`. That is why `kick-relay.mjs` exists.
- Kick moved public chat from Pusher to Centrifugo around October 2026. This helper uses the current Centrifugo guest-token flow. If Kick changes that again, Twitch in the page will keep working and Kick will need a relay update.
- The helper binds **127.0.0.1 only** (not the LAN). It uses a short-lived Kick guest token and never prints it.
- Kick channel chat exists even when you are offline, so you can test anytime. Official Kick developer webhooks are not used (those need a public URL and app tokens).

## What was tested (12 Nov 2026, Europe/Minsk)

On the build machine, against real live chats (not Fordenad’s offline channels):

- Twitch anonymous IRC (`justinfan` over `wss://irc-ws.chat.twitch.tv`) — connected and received messages from **#xqc** (live).
- Kick Centrifugo — resolved `kick.com/api/v2/channels/xqc`, connected with Origin `https://kick.com`, subscribed to `chatrooms.{id}.v2`, received `ChatMessageEvent` messages. The same websocket failed from Origins `http://localhost:8080`, `https://example.com`, and `null`.
- `kick.com/api/v2/channels/fordenad` resolves (channel id `3479914`, chatroom id `3471552`, not live at test time).
- Headless Chrome loaded the page via the relay at `http://127.0.0.1:8787/combined-chat.html?twitch=xqc&kick=xqc&bg=solid` and a screenshot was saved as `screenshot.png`.

Fordenad’s own chats were not live during the test, so the screenshot uses large live channels as stand-ins. The shipped defaults remain `fordenad`.

/**
 * Fetch and cache Twitch/Kick badges and third-party emotes (7TV, BTTV, FFZ).
 * No auth required. Optional TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are used
 * only as a Helix fallback if the public IVR badge API is unavailable.
 */
const UA = "fordenad-combined-chat/1.0";
const CACHE_MS = 15 * 60 * 1000;
const cache = new Map();

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), "[assets]", ...a);
}

async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA, ...extraHeaders },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return res.json();
}

function settled(value, fallback = null) {
  return value.status === "fulfilled" ? value.value : fallback;
}

function badgeImage(version) {
  if (!version) return null;
  return version.image_url_2x || version.image_url_4x || version.image_url_1x || null;
}

function flattenBadgeSets(sets) {
  const map = {};
  const versions = {};
  for (const set of sets || []) {
    const sid = set.set_id || set.setId;
    if (!sid) continue;
    versions[sid] = [];
    for (const v of set.versions || []) {
      const url = badgeImage(v);
      if (!url) continue;
      const id = String(v.id);
      map[sid + "/" + id] = url;
      const n = Number.parseInt(id, 10);
      versions[sid].push({ id, url, n: Number.isFinite(n) ? n : null });
    }
  }
  return { map, versions };
}

async function ivrUserId(login) {
  const data = await getJson("https://api.ivr.fi/v2/twitch/user?login=" + encodeURIComponent(login));
  const user = Array.isArray(data) ? data[0] : data;
  return user && user.id ? String(user.id) : null;
}

async function ivrBadges(kind, id) {
  const url = kind === "global"
    ? "https://api.ivr.fi/v2/twitch/badges/global"
    : "https://api.ivr.fi/v2/twitch/badges/channel?id=" + encodeURIComponent(id);
  const data = await getJson(url);
  if (!Array.isArray(data)) throw new Error("unexpected IVR badge payload");
  return flattenBadgeSets(data);
}

let helixToken = null;
let helixTokenExp = 0;

async function helixAppToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (helixToken && Date.now() < helixTokenExp - 60_000) {
    return { token: helixToken, clientId };
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials"
  });
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body,
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error("Twitch token " + res.status);
  const data = await res.json();
  helixToken = data.access_token;
  helixTokenExp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return { token: helixToken, clientId };
}

async function helixBadges(kind, broadcasterId) {
  const auth = await helixAppToken();
  if (!auth) return null;
  const url = kind === "global"
    ? "https://api.twitch.tv/helix/chat/badges/global"
    : "https://api.twitch.tv/helix/chat/badges?broadcaster_id=" + encodeURIComponent(broadcasterId);
  const data = await getJson(url, {
    "Client-Id": auth.clientId,
    Authorization: "Bearer " + auth.token
  });
  return flattenBadgeSets(data.data || []);
}

async function twitchBadgePack(login) {
  const result = { id: null, map: {}, versions: {}, source: null };
  if (!login) return result;
  try {
    result.id = await ivrUserId(login);
  } catch (err) {
    log("IVR user lookup failed:", err.message);
  }
  const global = await Promise.allSettled([
    ivrBadges("global"),
    helixBadges("global")
  ]);
  const g = settled(global[0]) || settled(global[1]);
  if (g) {
    Object.assign(result.map, g.map);
    Object.assign(result.versions, g.versions);
    result.source = settled(global[0]) ? "ivr" : "helix";
  }
  if (result.id) {
    const channel = await Promise.allSettled([
      ivrBadges("channel", result.id),
      helixBadges("channel", result.id)
    ]);
    const c = settled(channel[0]) || settled(channel[1]);
    if (c) {
      // Channel sets replace the whole set (don't keep leftover global versions
      // like subscriber/1 when the channel only publishes 0, 2, 2000, …).
      for (const sid of Object.keys(c.versions || {})) {
        for (const key of Object.keys(result.map)) {
          if (key.startsWith(sid + "/")) delete result.map[key];
        }
        delete result.versions[sid];
      }
      Object.assign(result.map, c.map);
      Object.assign(result.versions, c.versions);
      if (!result.source) result.source = settled(channel[0]) ? "ivr" : "helix";
    }
  }
  return result;
}

function sevenTvUrl(emote) {
  const id = emote.id || (emote.data && emote.data.id);
  const host = emote.data && emote.data.host;
  if (!host || !host.url) {
    return id ? "https://cdn.7tv.app/emote/" + id + "/2x.webp" : null;
  }
  const base = (host.url.startsWith("//") ? "https:" : "") + host.url;
  const files = host.files || [];
  const prefer = files.find((f) => f.name === "2x.webp")
    || files.find((f) => /2x/.test(f.name || ""))
    || files[0];
  return prefer ? base + "/" + prefer.name : base + "/2x.webp";
}

function addSevenTv(into, payload) {
  const emotes = (payload && payload.emotes)
    || (payload && payload.emote_set && payload.emote_set.emotes)
    || [];
  for (const e of emotes) {
    if (!e || !e.name) continue;
    const url = sevenTvUrl(e);
    if (url) into[e.name] = url;
  }
}

function addBttvList(into, list) {
  for (const e of list || []) {
    const name = e.code || e.name;
    if (!name || !e.id) continue;
    into[name] = "https://cdn.betterttv.net/emote/" + e.id + "/2x";
  }
}

function addFfzSets(into, sets) {
  for (const set of Object.values(sets || {})) {
    for (const e of set.emoticons || []) {
      if (!e || !e.name) continue;
      const urls = e.urls || {};
      const url = urls["2"] || urls["4"] || urls["1"];
      if (url) into[e.name] = url.startsWith("//") ? "https:" + url : url;
    }
  }
}

async function thirdPartyEmotes(twitchLogin, twitchId, kickUserId) {
  const emotes = {};
  const jobs = {
    stvGlobal: getJson("https://7tv.io/v3/emote-sets/global"),
    bttvGlobal: getJson("https://api.betterttv.net/3/cached/emotes/global"),
    ffzGlobal: getJson("https://api.frankerfacez.com/v1/set/global")
  };
  if (twitchId) {
    jobs.stvTwitch = getJson("https://7tv.io/v3/users/twitch/" + encodeURIComponent(twitchId));
    jobs.bttvTwitch = getJson("https://api.betterttv.net/3/cached/users/twitch/" + encodeURIComponent(twitchId));
    jobs.ffzTwitch = getJson("https://api.frankerfacez.com/v1/room/id/" + encodeURIComponent(twitchId));
  } else if (twitchLogin) {
    jobs.ffzTwitch = getJson("https://api.frankerfacez.com/v1/room/" + encodeURIComponent(twitchLogin));
  }
  if (kickUserId) {
    jobs.stvKick = getJson("https://7tv.io/v3/users/kick/" + encodeURIComponent(kickUserId));
  }
  const keys = Object.keys(jobs);
  const values = await Promise.allSettled(keys.map((k) => jobs[k]));
  const got = {};
  keys.forEach((k, i) => { got[k] = values[i]; });

  // Global first, then channel sets overwrite on name collision.
  if (got.stvGlobal.status === "fulfilled") addSevenTv(emotes, got.stvGlobal.value);
  if (got.bttvGlobal.status === "fulfilled") addBttvList(emotes, got.bttvGlobal.value);
  if (got.ffzGlobal.status === "fulfilled") addFfzSets(emotes, got.ffzGlobal.value.sets);
  if (got.bttvTwitch && got.bttvTwitch.status === "fulfilled") {
    const d = got.bttvTwitch.value || {};
    addBttvList(emotes, d.channelEmotes);
    addBttvList(emotes, d.sharedEmotes);
  }
  if (got.ffzTwitch && got.ffzTwitch.status === "fulfilled") {
    addFfzSets(emotes, got.ffzTwitch.value.sets);
  }
  if (got.stvTwitch && got.stvTwitch.status === "fulfilled") addSevenTv(emotes, got.stvTwitch.value);
  if (got.stvKick && got.stvKick.status === "fulfilled") addSevenTv(emotes, got.stvKick.value);

  const failed = keys.filter((k, i) => values[i].status === "rejected");
  if (failed.length) {
    log("optional sources missed:", failed.map((k, i) => {
      const idx = keys.indexOf(k);
      return k + " (" + (values[idx].reason && values[idx].reason.message) + ")";
    }).join(", "));
  }
  return emotes;
}

async function kickChannel(slug) {
  const out = { id: null, userId: null, subscriberBadges: [] };
  if (!slug) return out;
  const data = await getJson("https://kick.com/api/v2/channels/" + encodeURIComponent(slug), {
    Origin: "https://kick.com",
    Referer: "https://kick.com/"
  });
  out.id = data.id != null ? String(data.id) : null;
  out.userId = data.user_id != null ? String(data.user_id) : null;
  const list = Array.isArray(data.subscriber_badges) ? data.subscriber_badges : [];
  out.subscriberBadges = list
    .map((b) => {
      const url = b && b.badge_image && (b.badge_image.src || (b.badge_image.srcset || "").split(/\s+/)[0]);
      const months = Number(b && b.months);
      return url && Number.isFinite(months) ? { months, url, id: b.id } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.months - b.months);
  return out;
}

export async function loadAssets({ twitch, kick }) {
  const key = "t=" + (twitch || "") + "&k=" + (kick || "");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const twitchPack = await twitchBadgePack(twitch || "");
  let kickPack = { id: null, userId: null, subscriberBadges: [] };
  if (kick) {
    try { kickPack = await kickChannel(kick); }
    catch (err) { log("Kick channel lookup failed:", err.message); }
  }
  const emotes = await thirdPartyEmotes(twitch || "", twitchPack.id, kickPack.userId);

  const data = {
    twitchId: twitchPack.id,
    twitchBadgeSource: twitchPack.source,
    twitchBadges: twitchPack.map,
    twitchBadgeVersions: twitchPack.versions,
    kickId: kickPack.id,
    kickUserId: kickPack.userId,
    kickSubscriberBadges: kickPack.subscriberBadges,
    emotes,
    fetchedAt: new Date().toISOString()
  };
  cache.set(key, { at: Date.now(), data });
  log(
    "loaded",
    "twitch=" + (twitch || "-") + (twitchPack.id ? "(" + twitchPack.id + ")" : ""),
    "kick=" + (kick || "-"),
    "badges=" + Object.keys(twitchPack.map).length,
    "kickSubs=" + kickPack.subscriberBadges.length,
    "emotes=" + Object.keys(emotes).length,
    "source=" + (twitchPack.source || "none")
  );
  return data;
}

export function assetsToHttp(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/assets") return false;
  const twitch = (url.searchParams.get("twitch") || "").replace(/^#/, "").trim();
  const kick = (url.searchParams.get("kick") || "").trim();
  loadAssets({ twitch, kick }).then((data) => {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(body);
  }).catch((err) => {
    log("handler failed:", err.message);
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "asset lookup failed" }));
  });
  return true;
}

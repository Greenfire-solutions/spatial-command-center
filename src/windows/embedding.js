/*
 * Whether a website will let itself be shown inside our panel, and how to find
 * out when it will not.
 *
 * The bug this replaces: blocking was detected by a ten second timeout, and the
 * timeout never fired. A frame refused by X-Frame-Options or a frame-ancestors
 * policy still fires `load` — Chrome loads its own error document into the
 * frame and reports success — so the timeout was cleared and the panel was
 * marked "loaded". The user got a white rectangle with no explanation and no
 * way forward, which is the single worst state this application can present:
 * it looks like our failure, and there is nothing on screen to disagree with.
 *
 * Two mechanisms replace it, in this order.
 *
 * 1. KNOWN POLICY. Most of what anyone puts in a control centre is already
 *    known to refuse framing, and the measurements are in this repository —
 *    docs/XR_FOUNDATION_ARCHITECTURE.md section 14.1 recorded live header
 *    checks. Consulting that first means the panel says the right thing
 *    instantly instead of after a wait, and we never make a request we know
 *    will be refused.
 *
 * 2. THE about:blank PROBE. For anything not on the list, the frame is
 *    attempted and then interrogated after load. A frame showing real
 *    cross-origin content refuses to let us read its location — that throws,
 *    and the throw is the proof it worked. A frame that was REFUSED contains a
 *    blank document from our own origin, so reading its location succeeds and
 *    returns about:blank. The exception is the success signal, which is
 *    backwards enough to be worth stating twice.
 *
 * None of this circumvents anything. It reads what the browser already decided
 * and tells the user the truth about it.
 */

/*
 * Measured 2026-09-03 with live header checks, recorded in the architecture
 * document. Matched by registrable suffix, so app.slack.com matches slack.com.
 *
 * Note the authentication pattern in particular: mail, docs and calendar on
 * google.com serve SAMEORIGIN on the first hop and then redirect to
 * accounts.google.com, which serves DENY. Every authenticated Google surface is
 * unframable by design and permanently.
 */
export const KNOWN_BLOCKED = Object.freeze([
  'google.com', 'youtube.com', 'github.com', 'chatgpt.com', 'claude.ai',
  'notion.so', 'figma.com', 'x.com', 'twitter.com', 'chase.com', 'reddit.com',
  'slack.com', 'linkedin.com', 'stackoverflow.com', 'bing.com',
  'duckduckgo.com', 'developer.mozilla.org', 'accounts.google.com',
  'news.ycombinator.com', 'instagram.com', 'facebook.com', 'amazon.com'
]);

/* Endpoints that exist precisely to be embedded, and beat the blocklist for
 * their own domain — youtube.com is refused, youtube.com/embed/… is not. */
export const KNOWN_EMBEDDABLE_PATHS = Object.freeze([
  { host: 'youtube.com', prefix: '/embed/' },
  { host: 'youtube-nocookie.com', prefix: '/embed/' },
  { host: 'open.spotify.com', prefix: '/embed' },
  { host: 'player.vimeo.com', prefix: '/video/' }
]);

export const FRAMING = Object.freeze({
  ALLOWED: 'allowed',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown'
});

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

const matchesHost = (host, suffix) => host === suffix || host.endsWith(`.${suffix}`);

/**
 * What we already know about a URL's framing policy, before making a request.
 *
 * @returns {'allowed'|'blocked'|'unknown'}
 */
export const knownFramingPolicy = (url) => {
  const host = hostOf(url);
  if (!host) return FRAMING.UNKNOWN;

  const path = pathOf(url);
  for (const entry of KNOWN_EMBEDDABLE_PATHS) {
    if (matchesHost(host, entry.host) && path.startsWith(entry.prefix)) return FRAMING.ALLOWED;
  }

  /* localhost and private addresses are ours, and framing them is a local
   * decision rather than a third party's. */
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return FRAMING.ALLOWED;
  if (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return FRAMING.ALLOWED;
  }

  for (const blocked of KNOWN_BLOCKED) {
    if (matchesHost(host, blocked)) return FRAMING.BLOCKED;
  }
  return FRAMING.UNKNOWN;
};

/**
 * Interrogate a frame that has just reported `load`.
 *
 * `readLocation` is injected so the rule can be tested without a DOM: it should
 * return the frame's location href, or throw the way a browser throws when the
 * document is genuinely cross-origin.
 *
 * @returns {'allowed'|'blocked'}
 */
export const classifyLoadedFrame = (readLocation) => {
  let href;
  try {
    href = readLocation();
  } catch {
    /* Refused access. That is the browser enforcing the origin boundary, which
     * means there is real cross-origin content in there. The throw is the
     * success case. */
    return FRAMING.ALLOWED;
  }
  /* Readable. Either the site was refused and we are looking at a blank
   * document from our own origin, or it is genuinely same-origin content. */
  if (!href || href === 'about:blank') return FRAMING.BLOCKED;
  return FRAMING.ALLOWED;
};

/** A short, honest sentence for the panel. No jargon, no blame. */
export const framingMessage = (url) => {
  const host = hostOf(url) || 'This site';
  return `${host} does not allow itself to be shown inside another page.`;
};

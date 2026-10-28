const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_INPUT_LENGTH = 4096;

const errorResult = (error) => ({ ok: false, url: '', kind: 'invalid', error });

const isIpv4Address = (hostname) => {
  const parts = String(hostname || '').split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
};

const isPrivateIpv4Address = (hostname) => {
  if (!isIpv4Address(hostname)) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168;
};

const isPrivateIpv6Address = (hostname) => {
  const value = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
};

const isLocalDevelopmentHost = (hostname, hasPort) => {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' ||
    value.endsWith('.localhost') ||
    value.endsWith('.local') ||
    isPrivateIpv4Address(value) ||
    isPrivateIpv6Address(value) ||
    Boolean(hasPort && value && !value.includes('.') && !value.includes(':'));
};

const hostCandidate = (raw) => {
  const withoutProtocolSlashes = raw.startsWith('//') ? raw.slice(2) : raw;
  const authority = withoutProtocolSlashes.split(/[/?#]/, 1)[0];
  if (!authority || /\s/.test(authority) || authority.includes('@')) return null;

  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    const hostname = authority.slice(0, end + 1);
    const remainder = authority.slice(end + 1);
    if (remainder && !/^:\d+$/.test(remainder)) return null;
    return { hostname, hasPort: Boolean(remainder) };
  }

  const portMatch = authority.match(/:(\d+)$/);
  const hostname = portMatch ? authority.slice(0, -portMatch[0].length) : authority;
  if (!hostname) return null;
  const urlLike = hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.includes('.') ||
    isIpv4Address(hostname) ||
    Boolean(portMatch && /^[a-z0-9-]+$/i.test(hostname));
  return urlLike ? { hostname, hasPort: Boolean(portMatch) } : null;
};

/*
 * A captured desktop is addressed like a page but is not one.
 *
 * `macos://display/2` names one of the displays the macOS host captures. It
 * never reaches a network stack and no browser navigates to it; the desktop
 * host reads the ordinal and points a capture at that screen.
 *
 * It has to survive normalization because every screen's address passes
 * through here on its way into the workspace schema. It did not, and the
 * failure was close to invisible: the address was blanked, the host received
 * no display number, and its fallback is display zero. One desktop therefore
 * worked perfectly by accident, and five desktops all showed the same one.
 *
 * The allowance stays deliberately narrow — this exact shape, digits only —
 * so it cannot become a general escape from the HTTP-only rule below, which
 * exists to stop a typed address reaching file:, javascript: or similar.
 */
const DISPLAY_ADDRESS = /^macos:\/\/display\/(\d{1,3})$/i;

export const normalizeBrowserInput = (rawValue) => {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return { ok: true, url: '', kind: 'empty' };
  if (raw.length > MAX_INPUT_LENGTH) {
    return errorResult('The address or search is too long.');
  }

  const display = raw.match(DISPLAY_ADDRESS);
  if (display) {
    return { ok: true, url: `macos://display/${Number(display[1])}`, kind: 'display' };
  }

  const hostWithPort = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d+(?:[/?#]|$)/i.test(raw);
  const explicitScheme = hostWithPort ? null : raw.match(/^([a-z][a-z\d+.-]*):/i);
  if (explicitScheme && !/^https?$/i.test(explicitScheme[1])) {
    return errorResult('Only HTTP and HTTPS addresses are supported.');
  }

  const host = explicitScheme ? null : hostCandidate(raw);
  let candidate;
  let kind = 'url';
  if (explicitScheme) {
    candidate = raw;
  } else if (host) {
    const scheme = isLocalDevelopmentHost(host.hostname, host.hasPort) ? 'http:' : 'https:';
    candidate = scheme + '//' + (raw.startsWith('//') ? raw.slice(2) : raw);
  } else {
    kind = 'search';
    candidate = 'https://www.google.com/search?q=' + encodeURIComponent(raw);
  }

  try {
    const parsed = new URL(candidate);
    if (!HTTP_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
      return errorResult('Only HTTP and HTTPS addresses are supported.');
    }
    if (parsed.username || parsed.password) {
      return errorResult('Addresses with embedded usernames or passwords are not supported.');
    }
    return { ok: true, url: parsed.href, kind };
  } catch {
    return errorResult('That does not look like a valid web address or search.');
  }
};


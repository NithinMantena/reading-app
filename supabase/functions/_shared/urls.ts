// URL canonicalisation shared by the frontend and the Edge Function.

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref", "ref_src", "smid", "ocid", "cmpid",
]);

export function canonicalizeUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs are supported");
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  u.hash = "";
  u.username = "";
  u.password = "";
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    const key = k.toLowerCase();
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) continue;
    keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  u.pathname = path;
  return u.toString();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isNytUrl(url: string): boolean {
  const h = hostOf(url);
  return h === "nytimes.com" || h.endsWith(".nytimes.com");
}

export function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s.trim());
}

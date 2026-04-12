export function getHostnameFromUrl(url: string | undefined | null): string {
  if (!url) return "";

  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function getCurrentHostname(): string {
  return globalThis.location?.hostname?.toLowerCase() ?? "";
}

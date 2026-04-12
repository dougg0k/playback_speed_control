export function normalizeRule(rule: string): string {
  return rule.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

export function normalizeRules(rules: string[]): string[] {
  return Array.from(new Set(rules.map(normalizeRule).filter(Boolean))).sort();
}

export function isHostnameDisabled(hostname: string, rules: string[]): boolean {
  const normalizedHostname = normalizeRule(hostname);
  if (!normalizedHostname) return false;

  return rules.some((rule) => {
    const normalizedRule = normalizeRule(rule);
    if (!normalizedRule) return false;
    return (
      normalizedHostname === normalizedRule ||
      normalizedHostname.endsWith(`.${normalizedRule}`)
    );
  });
}

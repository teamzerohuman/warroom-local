export function ownerRepoFromText(value: string | undefined) {
  const ownerRepo = value?.match(
    /^\s*(?:[-*]\s*)?(?:\*\*)?Owner repo\s*:?(?:\*\*)?\s*:?\s*`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?/im
  )?.[1];
  if (ownerRepo) return ownerRepo;

  return value?.match(/implementation should happen in\s+`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?/i)?.[1] ?? null;
}

export function closingIssueRefFromText(defaultRepo: string, value: string | undefined) {
  const keyword = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
  const explicit = value?.match(new RegExp(`${keyword}\\s+([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\\d+)`, 'i'));
  if (explicit?.[1] && explicit[2]) return `${explicit[1]}#${explicit[2]}`;

  const local = value?.match(new RegExp(`${keyword}\\s+#(\\d+)`, 'i'));
  if (local?.[1]) return `${defaultRepo}#${local[1]}`;

  return null;
}

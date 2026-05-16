export type RepoRef = { repo: string; number: number };

const HASH_RE = /^([^\s/#]+\/[^\s/#]+)#(\d+)$/;
const PATH_RE = /^([^\s/#]+\/[^\s/#]+)\/(?:issues|pull|pulls|pr)\/(\d+)$/;

export function parseRepoRef(value: string): RepoRef {
  const cleaned = value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/[#?].*$/, '')
    .replace(/\/$/, '');

  const hash = cleaned.match(HASH_RE) ?? value.trim().match(HASH_RE);
  if (hash) return { repo: hash[1]!, number: Number(hash[2]) };

  const path = cleaned.match(PATH_RE);
  if (path) return { repo: path[1]!, number: Number(path[2]) };

  throw new Error(
    `References must use owner/repo#number or owner/repo/{issues|pull}/number (got "${value}").`
  );
}

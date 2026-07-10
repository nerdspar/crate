/**
 * Minimal GitHub Contents-API helper for config backup (Phase 5).
 *
 * Commits (and reads back) a single file in a user-owned repo via a personal access
 * token. Only what Crate needs: create-or-update one path, and fetch its content.
 */

export interface GithubTarget {
  /** "owner/repo". */
  repo: string;
  branch: string;
  /** Path within the repo, e.g. "crate-backup.json". */
  path: string;
  /** Personal access token (classic `repo`, or fine-grained Contents: read & write). */
  token: string;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error('Repository must be in "owner/repo" form.');
  return { owner, name };
}

function encPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

async function gh(t: GithubTarget, method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${t.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'Crate',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function ghError(res: Response): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const j = (await res.json()) as { message?: string };
    if (j.message) detail = j.message;
  } catch {
    /* keep the status line */
  }
  if (res.status === 401) return new Error('GitHub rejected the token (401). Check it has repo/contents write access.');
  if (res.status === 404) return new Error('GitHub repo, branch, or path not found (404). Check owner/repo and branch.');
  return new Error(`GitHub: ${detail}`);
}

/** Create or update the file, returning the commit + a link to view it. */
export async function githubPush(t: GithubTarget, content: string, message: string): Promise<{ url: string; commit: string }> {
  const { owner, name } = splitRepo(t.repo);
  const path = encPath(t.path);
  // A create-or-update needs the current blob sha when the file already exists.
  let sha: string | undefined;
  const head = await gh(t, 'GET', `/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(t.branch)}`);
  if (head.status === 200) {
    sha = ((await head.json()) as { sha?: string }).sha;
  } else if (head.status !== 404) {
    throw await ghError(head);
  }
  const put = await gh(t, 'PUT', `/repos/${owner}/${name}/contents/${path}`, {
    message,
    branch: t.branch,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  });
  if (!put.ok) throw await ghError(put);
  const j = (await put.json()) as { content?: { html_url?: string }; commit?: { sha?: string } };
  return { url: j.content?.html_url ?? '', commit: j.commit?.sha ?? '' };
}

/** List the repos the token can reach (for the admin repo picker). Newest-updated first. */
export async function githubListRepos(token: string): Promise<Array<{ fullName: string; private: boolean }>> {
  const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'Crate',
    },
  });
  if (!res.ok) throw await ghError(res);
  const j = (await res.json()) as Array<{ full_name?: string; private?: boolean }>;
  return j
    .filter((r) => typeof r.full_name === 'string')
    .map((r) => ({ fullName: r.full_name as string, private: r.private === true }));
}

/** Verify the token can reach the repo + branch (for the "Test" button). Returns the repo's
    default branch as a sanity detail. Throws a friendly error otherwise. */
export async function githubCheck(t: GithubTarget): Promise<{ repo: string; defaultBranch: string }> {
  const { owner, name } = splitRepo(t.repo);
  const res = await gh(t, 'GET', `/repos/${owner}/${name}`);
  if (!res.ok) throw await ghError(res);
  const j = (await res.json()) as { full_name?: string; default_branch?: string };
  return { repo: j.full_name ?? t.repo, defaultBranch: j.default_branch ?? 'main' };
}

/** Fetch the file's decoded text content. */
export async function githubGet(t: GithubTarget): Promise<string> {
  const { owner, name } = splitRepo(t.repo);
  const path = encPath(t.path);
  const res = await gh(t, 'GET', `/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(t.branch)}`);
  if (!res.ok) throw await ghError(res);
  const j = (await res.json()) as { encoding?: string; content?: string };
  if (j.encoding === 'base64' && typeof j.content === 'string') {
    return Buffer.from(j.content, 'base64').toString('utf8');
  }
  throw new Error('Unexpected GitHub response (no base64 content).');
}

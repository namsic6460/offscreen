// Minimal gitignore-flavoured glob matcher: `*`, `**`, `?`.
// A pattern without `/` matches the basename at any depth ("*.log").
// A pattern ending in `/` or `/**` matches everything under that directory.

function toRegex(pattern) {
  let p = pattern.replace(/\\/g, '/').trim();
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // "**/" = zero or more directories
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function makeMatcher(patterns) {
  const compiled = (patterns || []).filter(Boolean).map((p) => {
    const slashed = p.replace(/\\/g, '/');
    const norm = slashed.replace(/^\//, '');
    const anchored = slashed.startsWith('/') || norm.replace(/\/$/, '').includes('/');
    return { re: toRegex(p), anchored, dirRe: norm.endsWith('/') ? null : toRegex(`${norm}/**`) };
  });
  if (compiled.length === 0) return () => false;
  return (file) => {
    const f = file.replace(/\\/g, '/').replace(/\/$/, '');
    const segs = f.split('/');
    for (const { re, anchored, dirRe } of compiled) {
      if (re.test(f)) return true;
      if (dirRe && dirRe.test(f)) return true; // "dist" also matches "dist/a.js"
      if (!anchored) {
        // basename-style pattern: match any path segment (file or parent dir)
        if (segs.some((s) => re.test(s))) return true;
      }
    }
    return false;
  };
}

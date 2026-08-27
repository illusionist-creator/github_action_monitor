// Human formatting helpers. Pure functions, unit tested.

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/**
 * Duration in seconds -> compact human string.
 * The legacy `fmtDur` never produced hours, so a 90-minute ML run rendered as
 * "90m 0s".
 */
export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return '—';
  const whole = Math.round(total);
  if (whole < MINUTE) return `${whole}s`;
  if (whole < HOUR) return `${Math.floor(whole / MINUTE)}m ${whole % MINUTE}s`;
  const hours = Math.floor(whole / HOUR);
  const minutes = Math.floor((whole % HOUR) / MINUTE);
  return `${hours}h ${minutes}m`;
}

/** Duration in seconds -> minutes, one decimal. Used on chart axes. */
export function toMinutes(seconds) {
  return Math.round((Number(seconds) || 0) / 6) / 10;
}

/** Compute-time style total: 930 -> "15h 30m". */
export function fmtComputeMinutes(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60).toLocaleString()}h ${m % 60}m`;
}

/**
 * Relative time. The legacy version rounded to whole minutes, so anything under
 * 30 seconds read "0m ago", and it never said "in ..." for a clock-skewed
 * future timestamp.
 */
export function timeAgo(timestamp, now = Date.now()) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return '—';
  const deltaSeconds = Math.round((now - ts) / 1000);
  const future = deltaSeconds < 0;
  const abs = Math.abs(deltaSeconds);
  if (abs < 10) return 'just now';
  let span;
  if (abs < MINUTE) span = `${abs}s`;
  else if (abs < HOUR) span = `${Math.floor(abs / MINUTE)}m`;
  else if (abs < DAY) span = `${Math.floor(abs / HOUR)}h`;
  else span = `${Math.floor(abs / DAY)}d`;
  return future ? `in ${span}` : `${span} ago`;
}

/** Absolute wall-clock, in the viewer's locale and zone. */
export function fmtDateTime(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtTime(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : '—';
}

export function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

/** "octocat/hello-world" -> "hello-world" */
export function repoShortName(fullName) {
  const text = String(fullName || '');
  const slash = text.lastIndexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}

/** Two-letter monogram for a repo avatar, derived from the name (not its index). */
export function repoInitials(fullName) {
  const name = repoShortName(fullName);
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return (name || '?').toUpperCase().padEnd(2, '?');
}

/** Middle-free truncation with an ellipsis, for axis and cell labels. */
export function truncate(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/**
 * Percentile of a numeric array using nearest-rank.
 * The legacy code indexed `sorted[floor(n * 0.95)]`, which walks off the end for
 * every n where `n * 0.95` rounds up to n (n = 20, 40, 60 ...), yielding
 * `undefined` and a silent `|| 0`.
 */
export function percentile(values, p) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const rank = Math.ceil((p / 100) * nums.length);
  return nums[Math.min(Math.max(rank, 1), nums.length) - 1];
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

export function sum(values) {
  return values.reduce((a, v) => a + v, 0);
}

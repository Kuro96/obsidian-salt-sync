export const IGNORED_PATH_SEGMENT_NAMES = new Set([
  '.obsidian',
  '.trash',
  '.stfolder',
  '.stversions',
  '.stignore',
]);

export const IGNORED_PATH_SEGMENT_INCLUDES = [
  '.sync-conflict-',
];

export const IGNORED_PATH_SEGMENT_PATTERNS = [
  /^~syncthing~.*\.tmp$/i,
  /^untitled(?: \d+)?(?:\.md)?$/i,
  /^未命名(?: \d+)?(?:\.md)?$/u,
];

export function isIgnoredPathSegment(segment: string): boolean {
  return IGNORED_PATH_SEGMENT_NAMES.has(segment)
    || IGNORED_PATH_SEGMENT_INCLUDES.some((needle) => segment.includes(needle))
    || IGNORED_PATH_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment));
}

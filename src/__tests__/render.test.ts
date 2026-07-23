import { test, expect } from 'bun:test';

import {
  renderMarkdown,
  parseEmbeddedFingerprints,
  parseReviewState,
  buildDiffLineIndex,
} from '../core/render.js';
import { fingerprintFinding } from '../core/schema.js';
import type { CoordinatorOutput, Finding } from '../core/schema.js';

const base: CoordinatorOutput = { decision: 'approve', findings: [], summary: 'ok', incomplete: [] };
const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: 'warning',
  category: 'quality',
  file: 'a.ts',
  line: 1,
  title: 'T',
  rationale: 'r',
  ...over,
});

test('parseEmbeddedFingerprints round-trips even with a regex-metachar comment tag', () => {
  const tag = 'expo.ai+review(x)'; // contains . + ( ) — must be escaped in the parser
  const body = renderMarkdown({ ...base, findings: [finding()] }, tag);
  expect(parseEmbeddedFingerprints(body, tag).length).toBe(1);
});

test('coverage note only renders when incomplete is non-empty (no more wolf-crying)', () => {
  expect(renderMarkdown(base, 'tag')).not.toContain('Coverage note');
  expect(renderMarkdown({ ...base, incomplete: ['a pass timed out'] }, 'tag')).toContain('Coverage note');
});

test('a dismissed finding moves to the collapsed section, not the main list', () => {
  const f = finding({ title: 'W', evidence: 'const somethingLongEnough = 1;' });
  const fp = fingerprintFinding(f);
  const out = renderMarkdown({ ...base, findings: [f] }, 'tag', [{ fp, by: 'x', reason: 'intentional' }]);
  expect(out).toContain('Dismissed on this PR (1)');
  expect(out).toContain(`id:${fp}`);
  expect(out).not.toMatch(/###.*Warning/); // not shown as an active warning
});

test('review state (review + dismissals) round-trips via parseReviewState', () => {
  const dismissed = [{ fp: 'abc123def456', by: 'x' }];
  const body = renderMarkdown({ ...base, findings: [finding()] }, 'tag', dismissed);
  const state = parseReviewState(body, 'tag');
  expect(state).not.toBeNull();
  expect(state!.dismissed).toEqual(dismissed);
  expect(state!.review.findings.length).toBe(1);
});

test('links a finding location to the PR diff line when the line is in the diff', () => {
  const out = renderMarkdown({ ...base, findings: [finding({ file: 'src/a.ts', line: 12 })] }, 'tag', [], {
    repo: 'expo/eas-cli',
    prNumber: 42,
    diffLines: new Map([['src/a.ts', new Set([12])]]),
  });
  // Markdown link wrapping the `file:line`, pointing at the Files-changed diff anchor.
  expect(out).toContain('[`src/a.ts:12`](https://github.com/expo/eas-cli/pull/42/files#diff-');
  expect(out).toMatch(/R12\)/); // right-hand line anchor for line 12
});

test('a finding NOT in the diff is plain text, not a dead link', () => {
  // File is in the diff, but line 99 is not one of its changed lines → no link.
  const out = renderMarkdown({ ...base, findings: [finding({ file: 'src/a.ts', line: 99 })] }, 'tag', [], {
    repo: 'expo/eas-cli',
    prNumber: 42,
    diffLines: new Map([['src/a.ts', new Set([12])]]),
  });
  expect(out).toContain('`src/a.ts:99`');
  expect(out).not.toContain('https://github.com');
});

test('a finding on a file absent from the diff is plain text', () => {
  const out = renderMarkdown({ ...base, findings: [finding({ file: 'other.ts', line: 3 })] }, 'tag', [], {
    repo: 'expo/eas-cli',
    prNumber: 42,
    diffLines: new Map([['src/a.ts', new Set([12])]]),
  });
  expect(out).toContain('`other.ts:3`');
  expect(out).not.toContain('https://github.com');
});

test('location is plain (unlinked) code when no link context is given', () => {
  const out = renderMarkdown({ ...base, findings: [finding({ file: 'src/a.ts', line: 12 })] }, 'tag');
  expect(out).toContain('`src/a.ts:12`');
  expect(out).not.toContain('https://github.com');
});

test('buildDiffLineIndex: collects right-side added + context lines, skips deletions', () => {
  const patch = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,4 @@',
    ' context10', // right line 10 (context)
    '-removed', // left only, no right line
    '+added11', // right line 11
    '+added12', // right line 12
    ' context13', // right line 13
  ].join('\n');
  const index = buildDiffLineIndex([{ path: 'src/a.ts', patch }]);
  expect([...index.get('src/a.ts')!].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
});

test('comment footer no longer says "Phase 1"', () => {
  expect(renderMarkdown(base, 'tag')).not.toContain('Phase 1');
});

test('renders per-severity headers with counts', () => {
  const out = renderMarkdown(
    {
      ...base,
      decision: 'request_changes',
      findings: [
        finding({ severity: 'critical', category: 'security', title: 'C' }),
        finding({ severity: 'warning', title: 'W' }),
      ],
    },
    'tag'
  );
  expect(out).toMatch(/Critical \(1\)/i);
  expect(out).toMatch(/Warning \(1\)/i);
});

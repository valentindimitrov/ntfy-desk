import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { EXTENSION } from '../../scripts/validate-packages.ts';

// The store text in assets/store-listings follows the permissions the release packages must have
// (EXTENSION, checked against the built manifests by pnpm verify:packages).

const listing = (name: string) => readFileSync(`assets/store-listings/${name}`, 'utf8');
const permissions = [...EXTENSION.permissions, ...EXTENSION.optionalPermissions, ...EXTENSION.optionalHostPermissions];

/** The blocks of privacy-fields.txt: a heading line in capitals, then the field's text */
function privacyFields(): Map<string, string> {
  const blocks = listing('chrome-web-store/privacy-fields.txt').split(/\n\n+/);
  return new Map(blocks.map((block) => [block.slice(0, block.indexOf('\n')), block.slice(block.indexOf('\n') + 1)]));
}

it('justifies every permission for the Chrome Web Store, and no other', () => {
  const fields = privacyFields();
  const justified = [...fields.keys()].flatMap((heading) => /^(?:HOST )?PERMISSION JUSTIFICATION: (\S+)/.exec(heading)?.[1] ?? []);
  expect(justified.toSorted()).toEqual(permissions.toSorted());
  for (const [heading, text] of fields) {
    // Kept within 1,000 characters each, the limit of the dashboard's fields as last seen
    if (heading.includes('JUSTIFICATION') || heading.startsWith('SINGLE PURPOSE')) expect(text.length, heading).toBeLessThanOrEqual(1000);
  }
  expect(fields.get('REMOTE CODE')).toContain('No, I am not using remote code');
});

it('explains every permission and data category to the Firefox reviewers', () => {
  const notes = listing('firefox-add-ons/reviewer-notes.txt');
  for (const name of [...permissions, ...EXTENSION.firefoxDataCollection]) expect(notes, name).toContain(name);
  expect(notes).toContain('pnpm install --frozen-lockfile');
  expect(notes).toContain('pnpm zip:firefox');
  expect(notes).toContain('https://ntfy.sh');
  // The part pasted into AMO's "Notes to Reviewer", below the separator line: AMO accepts at most 3,000 characters
  const pasted = notes.slice(notes.indexOf('-'.repeat(70)) + 70).trim();
  expect(pasted.length).toBeLessThanOrEqual(3000);
});

it('keeps the summaries within the stores’ limits and says the extension is unofficial', () => {
  expect(listing('firefox-add-ons/summary.txt').trim().length).toBeLessThanOrEqual(250);
  for (const name of ['chrome-web-store/description.txt', 'firefox-add-ons/description.md', 'firefox-add-ons/summary.txt']) {
    expect(listing(name), name).toMatch(/unofficial/i);
    expect(listing(name), name).toMatch(/not affiliated with/);
  }
});

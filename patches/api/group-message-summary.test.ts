import { describe, expect, it } from 'vitest';
import { summarizeSharedBlocks } from './group-message-summary.js';

const names = (id: string) => (id === 'bot_b' ? 'Beta' : undefined);

describe('summarizeSharedBlocks', () => {
  it('keeps text and summarizes tool steps with status', () => {
    const out = summarizeSharedBlocks(
      [
        { kind: 'steps', steps: [{ label: 'Shell', count: 2 }, { label: 'Browser navigate', count: 1 }], durationMs: 25918 },
        { kind: 'text', text: 'Done.' },
      ],
      names,
    );
    expect(out.text).toBe('Done.');
    expect(out.activity).toEqual(['Used tools: Shell ×2, Browser navigate · done in 26s']);
  });

  it('names handoff targets the viewer can resolve', () => {
    expect(summarizeSharedBlocks([{ kind: 'handoff', toBotId: 'bot_b', text: '' }], names).activity).toEqual(['Handed off to Beta']);
    expect(summarizeSharedBlocks([{ kind: 'handoff', toBotId: 'bot_x' }], names).activity).toEqual(['Handed off to another bot']);
  });

  it('never copies owner-only prompt text, answers or artifacts', () => {
    const blocks = [
      { kind: 'ask', text: 'Please paste your GitHub token', status: 'answered', answer: 'choice-1', actions: [{ id: 'choice-1', label: 'Provide credentials' }] },
      { kind: 'computer', text: 'Enter your password in the browser', state: 'Needs you' },
      { kind: 'choice', question: 'Secret plan?', options: [{ id: 'a', label: 'Plan A' }], answerId: 'a' },
      { kind: 'image', name: 'private-scan.png', artifactId: 'art_1', mimeType: 'image/png' },
    ];
    const out = summarizeSharedBlocks(blocks, names);
    const joined = JSON.stringify(out);
    for (const secret of ['GitHub token', 'password', 'Secret plan', 'Plan A', 'private-scan', 'art_1', 'Provide credentials']) {
      expect(joined).not.toContain(secret);
    }
    expect(out.activity).toEqual([
      'Asked the owner a question · answered',
      'Working on its computer · waiting for the owner',
      'Asked the owner to pick an option · answered',
      'Shared an image · visible to the owner only',
    ]);
  });

  it('handles junk and unknown kinds safely', () => {
    expect(summarizeSharedBlocks(null, names)).toEqual({ text: '', activity: [] });
    expect(summarizeSharedBlocks([{ kind: 'mystery' }, 7, null], names).activity).toEqual(['Other bot activity']);
  });
});

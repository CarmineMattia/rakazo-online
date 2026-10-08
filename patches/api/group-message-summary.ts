/**
 * Readable one-line summaries of non-text bot turns for the shared-group view.
 *
 * Shared members see the group's conversation but not the owner's private
 * surfaces. Questions/approvals addressed to the owner, computer prompts and
 * artifacts stay owner-only, so a member only learns that the step happened
 * and its status, never the prompt text, answers or file contents.
 */

type Block = Record<string, unknown> & { kind?: unknown };

const MAX_LABEL = 60;
const MAX_STEPS = 5;

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

function stepsSummary(block: Block): string {
  const steps = Array.isArray(block.steps) ? block.steps : [];
  const labels = steps
    .map((step) => {
      const s = step as { label?: unknown; count?: unknown };
      const label = clip(s.label);
      if (!label) return '';
      const count = typeof s.count === 'number' && Number.isFinite(s.count) ? s.count : 1;
      return count > 1 ? `${label} ×${count}` : label;
    })
    .filter(Boolean);
  const shown = labels.slice(0, MAX_STEPS).join(', ') + (labels.length > MAX_STEPS ? ', …' : '');
  const seconds =
    typeof block.durationMs === 'number' && block.durationMs > 0 ? Math.max(1, Math.round(block.durationMs / 1000)) : 0;
  const base = shown ? `Used tools: ${shown}` : 'Used tools';
  return seconds ? `${base} · done in ${seconds}s` : `${base} · done`;
}

/** Text parts plus activity lines for one stored message. */
export function summarizeSharedBlocks(
  blocks: unknown,
  botName: (botId: string) => string | undefined,
): { text: string; activity: string[] } {
  const list: Block[] = Array.isArray(blocks) ? (blocks.filter((b) => b && typeof b === 'object') as Block[]) : [];
  const text = list
    .filter((b) => b.kind === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
  const activity: string[] = [];
  for (const block of list) {
    switch (block.kind) {
      case 'text':
        break;
      case 'steps':
        activity.push(stepsSummary(block));
        break;
      case 'progress':
        // Live progress rows are transient UI state, not part of the record.
        break;
      case 'handoff': {
        const name = typeof block.toBotId === 'string' ? botName(block.toBotId) : undefined;
        activity.push(name ? `Handed off to ${name}` : 'Handed off to another bot');
        break;
      }
      case 'ask':
        activity.push(
          block.status === 'answered'
            ? 'Asked the owner a question · answered'
            : 'Waiting for the owner to answer a question',
        );
        break;
      case 'choice':
        activity.push(
          block.answerId ? 'Asked the owner to pick an option · answered' : 'Waiting for the owner to pick an option',
        );
        break;
      case 'computer':
        activity.push(
          block.state === 'Needs you' ? 'Working on its computer · waiting for the owner' : 'Working on its computer',
        );
        break;
      case 'image':
        activity.push('Shared an image · visible to the owner only');
        break;
      case 'cloud_agent':
        activity.push('Ran a cloud agent task');
        break;
      default:
        activity.push('Other bot activity');
    }
  }
  return { text, activity: [...new Set(activity)] };
}

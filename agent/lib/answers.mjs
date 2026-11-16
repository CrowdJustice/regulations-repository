// The exact shape of the answers the AI must give.

const text = { type: 'string' };
const textOrNull = { type: ['string', 'null'] };

export const WRITER_ANSWER = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason', 'record_id', 'published', 'history_event', 'record'],
  properties: {
    decision: { type: 'string', enum: ['new', 'update', 'ignore'] },
    reason: text,
    record_id: textOrNull,
    published: textOrNull,
    history_event: textOrNull,
    record: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'regulator', 'title', 'summary', 'what_changes', 'applies_to', 'who_it_applies_to', 'topic', 'stage', 'dates', 'source_name'],
          properties: {
            id: text,
            regulator: text,
            title: text,
            summary: text,
            what_changes: { type: 'array', items: text },
            applies_to: { type: 'array', items: text },
            who_it_applies_to: text,
            topic: text,
            stage: { type: 'string', enum: ['proposed', 'decided', 'in_force', 'guidance'] },
            dates: {
              type: 'object',
              additionalProperties: false,
              required: ['proposed', 'decided', 'in_force', 'in_force_text', 'published'],
              properties: { proposed: textOrNull, decided: textOrNull, in_force: textOrNull, in_force_text: textOrNull, published: textOrNull },
            },
            source_name: text,
          },
        },
      ],
    },
  },
};

export const CHECKER_ANSWER = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'problems', 'duplicate_of'],
  properties: {
    pass: { type: 'boolean' },
    problems: { type: 'array', items: text },
    duplicate_of: textOrNull,
  },
};

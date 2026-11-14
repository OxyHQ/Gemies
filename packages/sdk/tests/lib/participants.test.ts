import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/agent-character', () => ({
  readAgentCharacter: (value: unknown, color: unknown) => ({
    drawn: value ?? 'default',
    in: color ?? 'default',
  }),
}));
vi.mock('../../src/lib/alia-character', () => ({ ALIA_AVATAR: { preset: 'alia' } }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({}) }));

const { ALIA_LEAD, leadOf, participantOf } = await import('../../src/lib/participants');
const { ALIA_GEMIE_ID } = await import('../../src/lib/alia-gemie');
const { leadToProfile, ANCHORS } = await import('../../src/lib/flights');
const { featureOffer, readAgentFeatures, readAgentProfile } = await import(
  '../../src/runtime/agents'
);

/** Who leads a conversation and who has joined it, as data. */
describe('the lead', () => {
  it('is Alia when no agent is named', () => {
    expect(leadOf(undefined)).toBe(ALIA_LEAD);
    expect(leadOf(null)).toBe(ALIA_LEAD);
    expect(ALIA_LEAD).toMatchObject({ name: 'Alia', isAlia: true, character: { preset: 'alia' } });
  });

  it('is the agent the chat was opened on: its name, look, greeting and starters', () => {
    const profile = readAgentProfile({
      id: 'sindi',
      name: 'Sindi',
      handle: 'sindibot',
      character: { shape: 'heart' },
      color: 'teal',
      greeting: 'Hola, ¿buscas piso?',
      starters: [{ title: 'Pisos', prompt: 'Busca pisos en Barcelona' }, { title: 'bad' }],
      features: [{ key: 'attachments.documents', gated: true }],
    });
    expect(leadOf(profile)).toEqual({
      id: 'sindi',
      name: 'Sindi',
      handle: 'sindibot',
      // Painted in its account's colour, the profile's `color`.
      character: { drawn: { shape: 'heart' }, in: 'teal' },
      color: 'teal',
      isAlia: false,
      greeting: 'Hola, ¿buscas piso?',
      starters: [{ title: 'Pisos', prompt: 'Busca pisos en Barcelona' }],
    });
  });

  it('flies from the greeting into the header’s participants as the lead it is', () => {
    const spec = leadToProfile(leadOf(readAgentProfile({ id: 's', name: 'S' })));
    expect(spec).toMatchObject({ from: ANCHORS.welcome, to: ANCHORS.profile });
    expect(spec.character).toEqual({ drawn: 'default', in: 'default' });
  });

  it('refuses a profile without an id or a name', () => {
    expect(readAgentProfile({ name: 'x' })).toBeNull();
    expect(readAgentProfile('x')).toBeNull();
  });
});

describe('a gemie as a message carries it', () => {
  it('is drawn in its own look, painted in its colour', () => {
    expect(
      participantOf({ id: 'lumen', name: 'Lumen', character: { shape: 'star' }, color: 'teal' }),
    ).toMatchObject({
      id: 'lumen',
      name: 'Lumen',
      character: { drawn: { shape: 'star' }, in: 'teal' },
    });
  });

  it('is Alia drawn as herself, though her gemie carries no character', () => {
    expect(participantOf({ id: ALIA_GEMIE_ID, name: 'Alia' }).character).toEqual({
      preset: 'alia',
    });
  });
});

describe('the attach menu’s offer', () => {
  it('is everything for Alia, and for an agent exactly what its features answer lists', () => {
    expect(featureOffer(undefined, 'attachments.documents')).toBe('available');
    const features = readAgentFeatures({
      features: [
        { key: 'attachments.documents', state: 'locked', remaining: 0 },
        { key: 'attachments.images', state: 'available' },
        { key: 'x', state: 'maybe' },
      ],
    });
    expect(featureOffer(features, 'attachments.documents')).toBe('locked');
    expect(featureOffer(features, 'attachments.images')).toBe('available');
    expect(featureOffer([], 'attachments.images')).toBe('absent');
    expect(features).toHaveLength(2);
  });
});

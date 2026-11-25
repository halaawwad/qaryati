import { describe, expect, it } from 'vitest';
import { createEventSchema, updateEventSchema } from '../src/modules/events/events.schemas.js';
import { validateEventsTarget } from '../scripts/events-integration-safety.mjs';

describe('Events write schemas', () => {
  it('accepts title alone and defaults approximation only on creation', () => {
    expect(createEventSchema.parse({ title: ' Event ' })).toEqual({ title: 'Event', isApproximate: false });
    expect(updateEventSchema.parse({ version: 1, title: ' Event ' })).toEqual({ version: 1, title: 'Event' });
  });
  it.each([-2147483648, -500, 0, 2147483647])('accepts independent historical year %s', eventYear => {
    expect(createEventSchema.parse({ title: 'Event', eventYear }).eventYear).toBe(eventYear);
  });
  it('accepts nullable model fields and normalizes timestamps', () => {
    expect(createEventSchema.parse({ title: 'Event', eventDate: '2024-02-29T12:30:00+02:00' }).eventDate)
      .toEqual(new Date('2024-02-29T10:30:00Z'));
    const fields = { description: null, category: null, sourceId: null, eventYear: null, eventDate: null };
    expect(updateEventSchema.parse({ version: 1, ...fields })).toEqual({ version: 1, ...fields });
  });
  it.each(['2023-02-29T00:00:00Z', '2024-04-31T00:00:00Z', '2024-01-01', '2024-01-01T00:00:00',
    'not-a-date', '0000-01-01T00:00:00Z', '0001-01-01T00:00:00+01:00'])('rejects invalid/unsupported date %s', eventDate => {
    expect(createEventSchema.safeParse({ title: 'Event', eventDate }).success).toBe(false);
  });
  it.each([
    {}, { title: ' ' }, { title: 'x'.repeat(201) }, { title: 'Event', category: ' ' },
    { title: 'Event', category: 'x'.repeat(101) }, { title: 'Event', description: 'x'.repeat(5001) },
    { title: 'Event', eventYear: 2147483648 }, { title: 'Event', eventYear: '1900' },
    { title: 'Event', isApproximate: null }, { title: 'Event', sourceId: 'invalid' },
    { title: 'Event', version: 1 }, { title: 'Event', eventDate: 0 },
  ])('rejects invalid creation %j', value => expect(createEventSchema.safeParse(value).success).toBe(false));
  it.each([{}, { version: 1 }, { title: 'X' }, { version: 0, title: 'X' },
    { version: '1', title: 'X' }, { version: 1.5, title: 'X' }, { version: 2147483647, title: 'X' }])(
    'rejects invalid version/empty PATCH %j', value => expect(updateEventSchema.safeParse(value).success).toBe(false));
  it.each(['verificationStatus','createdById','updatedById','deletedAt','villageId','id','unknown'])(
    'rejects protected field %s on POST and PATCH', key => {
      expect(createEventSchema.safeParse({ title: 'X', [key]: 'protected' }).success).toBe(false);
      expect(updateEventSchema.safeParse({ version: 1, title: 'X', [key]: 'protected' }).success).toBe(false);
    });
});

describe('Disposable Events safety guard', () => {
  const token = 'a'.repeat(24), name = `events_it_${token}`;
  const env = { QARYATI_EVENTS_RUN: token, DATABASE_URL: `postgresql://${name}:${'b'.repeat(48)}@127.0.0.1:55123/${name}`, REDIS_URL: 'redis://127.0.0.1:55124/0' };
  it('accepts run-specific local targets', () => expect(validateEventsTarget(env)).toEqual({ token, name }));
  it.each([{ QARYATI_EVENTS_RUN: undefined }, { DATABASE_URL: 'postgresql://user:pass@localhost:5432/qaryati' },
    { DATABASE_URL: env.DATABASE_URL.replace('/' + name, '/qaryati_local') }, { DATABASE_URL: env.DATABASE_URL + '?schema=public' },
    { REDIS_URL: 'redis://localhost:6379/0' }, { REDIS_URL: 'redis://127.0.0.1:55124/1' }, { REDIS_URL: 'redis://127.0.0.1:55123/0' }])(
    'rejects unsafe configuration %j', override => expect(() => validateEventsTarget({ ...env, ...override })).toThrow());
});

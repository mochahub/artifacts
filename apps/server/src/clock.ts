/** All time comes through here, so tests can move it (purge, expiry, sessions). */
export type Clock = { now(): Date };

export const systemClock: Clock = { now: () => new Date() };

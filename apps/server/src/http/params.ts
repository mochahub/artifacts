const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ids in paths are UUIDs. Anything else is the same 404 as an id that isn't there. */
export const isUuid = (value: string | undefined): value is string => !!value && UUID.test(value);

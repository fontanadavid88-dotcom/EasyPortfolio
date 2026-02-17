export const createUuid = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  const rnd = Math.random().toString(16).slice(2);
  return `uuid-${Date.now().toString(16)}-${rnd}`;
};

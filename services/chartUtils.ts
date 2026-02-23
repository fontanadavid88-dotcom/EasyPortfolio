export const downsampleSeries = <T>(data: T[], maxPoints: number): T[] => {
  if (!Array.isArray(data)) return [];
  if (maxPoints <= 0) return [];
  if (data.length <= maxPoints) return data;
  if (maxPoints === 1) return [data[0]];

  const lastIndex = data.length - 1;
  const step = lastIndex / (maxPoints - 1);
  const result: T[] = [];

  for (let i = 0; i < maxPoints; i += 1) {
    const idx = i === maxPoints - 1 ? lastIndex : Math.floor(i * step);
    result.push(data[idx]);
  }

  return result;
};

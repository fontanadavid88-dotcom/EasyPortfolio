import { RebalancePlan } from '../types';

export const toCsvValue = (value: any): string => {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export const buildRebalancePlanCsv = (plan: RebalancePlan): string => {
  const header = [
    'CreatedAt',
    'ValuationDate',
    'PortfolioId',
    'Ticker',
    'Action',
    'AmountCHF',
    'Units',
    'InstrumentCurrency',
    'Price',
    'PriceCurrency',
    'Note'
  ];

  const rows = plan.items
    .filter(item => (item.action === 'COMPRA' || item.action === 'VENDI'))
    .filter(item => typeof item.amountBase === 'number' && item.amountBase > 0)
    .map(item => {
      const createdAt = new Date(plan.createdAt).toISOString();
      const amount = Math.abs(item.amountBase ?? 0);
      return [
        createdAt,
        plan.valuationDate || '',
        plan.portfolioId,
        item.ticker,
        item.action,
        amount,
        item.units ?? '',
        item.instrumentCurrency ?? '',
        item.price ?? '',
        item.priceCurrency ?? '',
        item.reason ?? ''
      ].map(toCsvValue).join(',');
    });

  return [header.join(','), ...rows].join('\n');
};

export const downloadCsv = (filename: string, csv: string): void => {
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

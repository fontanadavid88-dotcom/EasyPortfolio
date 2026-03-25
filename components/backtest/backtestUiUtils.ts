import { BacktestScenarioInput } from '../../services/backtestTypes';
import { BacktestScenarioRecord } from '../../types';

type ContributionFrequency = BacktestScenarioInput['contributionFrequency'];

export const contributionFrequencyLabel = (frequency: ContributionFrequency): string => {
  switch (frequency) {
    case 'monthly':
      return 'Mensile';
    case 'quarterly':
      return 'Trimestrale';
    case 'semiannual':
      return 'Semestrale';
    case 'annual':
      return 'Annuale';
    default:
      return 'Nessuno';
  }
};

export const resolveContributionFields = (
  scenario: BacktestScenarioInput | BacktestScenarioRecord
): { amount: number; frequency: ContributionFrequency } => {
  const legacyAnnual = typeof (scenario as BacktestScenarioRecord).annualContribution === 'number'
    ? (scenario as BacktestScenarioRecord).annualContribution!
    : 0;
  const amount = typeof (scenario as BacktestScenarioRecord).periodicContributionAmount === 'number'
    ? (scenario as BacktestScenarioRecord).periodicContributionAmount!
    : legacyAnnual;
  const frequency = (scenario as BacktestScenarioRecord).contributionFrequency
    ?? (legacyAnnual > 0 ? 'annual' : 'none');
  return { amount, frequency };
};

export const formatContributionLabel = (
  amount: number,
  frequency: ContributionFrequency,
  currency: string
): string => {
  if (!amount || amount <= 0 || frequency === 'none') return 'Nessuno';
  const formatted = new Intl.NumberFormat('it-CH', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(amount);
  return `${formatted} - ${contributionFrequencyLabel(frequency)}`;
};

export const formatScenarioContribution = (
  scenario: BacktestScenarioInput | BacktestScenarioRecord
): string => {
  const { amount, frequency } = resolveContributionFields(scenario);
  const currency = (scenario as BacktestScenarioInput).baseCurrency
    || (scenario as BacktestScenarioRecord).baseCurrency
    || 'CHF';
  return formatContributionLabel(amount, frequency, String(currency));
};

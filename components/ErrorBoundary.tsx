import React from 'react';

export type ErrorBoundaryState = {
  hasError: boolean;
  error?: Error;
  componentStack?: string | null;
};

type Props = {
  children: React.ReactNode;
};

export class ErrorBoundary extends React.Component<Props, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (import.meta.env?.DEV) {
      console.error('[ErrorBoundary] runtime error', error, info);
    } else {
      console.warn('[ErrorBoundary] runtime error', error.message);
    }
    this.setState({ componentStack: info.componentStack });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.hash = '#/';
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen bg-[#020617] text-slate-200 flex items-center justify-center p-6">
        <div className="ui-panel w-full max-w-2xl p-6 shadow-2xl">
          <h1 className="text-lg font-bold text-amber-700">Si e verificato un errore</h1>
          <p className="mt-2 text-sm text-slate-600">
            Qualcosa e andato storto. Puoi ricaricare la pagina o tornare alla Dashboard.
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.handleReload}
              className="ui-btn-primary px-4 py-2 text-sm"
            >
              Ricarica
            </button>
            <button
              type="button"
              onClick={this.handleGoHome}
              className="ui-btn-secondary px-4 py-2 text-sm"
            >
              Vai alla Dashboard
            </button>
          </div>

          <details className="mt-5 ui-panel-dense p-4 text-xs text-slate-700">
            <summary className="cursor-pointer font-semibold text-slate-700">Dettagli tecnici</summary>
            <div className="mt-2 whitespace-pre-wrap break-words">
              {this.state.error?.stack || this.state.error?.message || 'N/D'}
            </div>
            {this.state.componentStack && (
              <div className="mt-3 whitespace-pre-wrap break-words text-slate-500">
                {this.state.componentStack}
              </div>
            )}
          </details>
        </div>
      </div>
    );
  }
}

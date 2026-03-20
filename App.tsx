import React, { Suspense, useEffect, useState } from 'react';
import { createHashRouter, RouterProvider, Navigate, Outlet } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { db, initSettings, seedDatabase, ensureDefaultPortfolio } from './db';
import { runSymbolMigrationOnce } from './services/symbolMigration';

const InitErrorContext = React.createContext<string | null>(null);

const Dashboard = React.lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Transactions = React.lazy(() => import('./pages/Transactions').then(m => ({ default: m.Transactions })));
const Rebalance = React.lazy(() => import('./pages/Rebalance').then(m => ({ default: m.Rebalance })));
const Backtest = React.lazy(() => import('./pages/Backtest').then(m => ({ default: m.Backtest })));
const Macro = React.lazy(() => import('./pages/Macro').then(m => ({ default: m.Macro })));
const Settings = React.lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const Data = React.lazy(() => import('./pages/Data').then(m => ({ default: m.Data })));
const Report = React.lazy(() => import('./pages/Report').then(m => ({ default: m.Report })));

const PageLoader: React.FC<{ label?: string }> = ({ label = 'Caricamento…' }) => (
  <div className="flex items-center justify-center py-12 text-sm text-slate-500 gap-2">
    <span className="material-symbols-outlined animate-spin text-primary">donut_large</span>
    <span>{label}</span>
  </div>
);

const withSuspense = (node: React.ReactNode) => (
  <Suspense fallback={<PageLoader />}>
    {node}
  </Suspense>
);

const isDexieVersionError = (error: unknown) => {
  const err = error as { name?: string; message?: string; inner?: { name?: string; message?: string } };
  const parts = [
    err?.name,
    err?.message,
    err?.inner?.name,
    err?.inner?.message
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return parts.includes('versionerror')
    && parts.includes('requested version')
    && parts.includes('existing version');
};

const DbRecoveryScreen: React.FC<{ onReset: () => Promise<void>; isResetting: boolean }> = ({ onReset, isResetting }) => (
  <div className="min-h-screen flex items-center justify-center bg-[#020617] text-slate-200 p-6">
    <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl">
      <div className="flex items-center gap-2 text-amber-300">
        <span className="material-symbols-outlined">database</span>
        <h1 className="text-lg font-bold text-amber-200">Database non compatibile (versione)</h1>
      </div>
      <p className="mt-3 text-sm text-slate-300">
        Nel browser è presente un database creato con una versione più recente dell’app.
      </p>
      <p className="text-sm text-slate-300">
        Per sbloccare l’app è necessario resettare i dati locali.
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onReset}
          disabled={isResetting}
          className="px-4 py-2 rounded-lg text-sm font-bold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isResetting ? 'Reset in corso…' : 'Reset DB (cancella dati locali)'}
        </button>
      </div>

      <div className="mt-5 rounded-xl border border-white/10 bg-black/30 p-4 text-xs text-slate-300">
        <div className="font-semibold text-slate-200">Come ripristinare il backup</div>
        <div className="mt-1">Dopo il reset vai in Settings → Import e carica il backup JSON.</div>
      </div>
    </div>
  </div>
);

const LayoutShell: React.FC = () => {
  const initError = React.useContext(InitErrorContext);

  return (
    <Layout>
      {initError && (
        <div className="bg-red-50 text-red-700 border border-red-200 px-4 py-3 text-sm text-center">
          Errore inizializzazione: {initError}
        </div>
      )}
      <Outlet />
    </Layout>
  );
};

const router = createHashRouter(
  [
    { path: '/report', element: withSuspense(<Report />) },
    {
      element: <LayoutShell />,
      children: [
        { path: '/', element: withSuspense(<Dashboard />) },
        { path: '/transactions', element: withSuspense(<Transactions />) },
        { path: '/rebalance', element: withSuspense(<Rebalance />) },
        { path: '/backtest', element: withSuspense(<Backtest />) },
        { path: '/macro', element: withSuspense(<Macro />) },
        { path: '/settings', element: withSuspense(<Settings />) },
        { path: '/data', element: withSuspense(<Data />) },
        { path: '*', element: <Navigate to="/" replace /> }
      ]
    }
  ],
  { future: { v7_startTransition: true, v7_relativeSplatPath: true } as any }
);

const App: React.FC = () => {
  const [initialized, setInitialized] = useState(false);
  const [status, setStatus] = useState<string>('Avvio applicazione...');
  const [initError, setInitError] = useState<string | null>(null);
  const [dbBlocked, setDbBlocked] = useState(false);
  const [dbResetting, setDbResetting] = useState(false);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const init = async () => {
      try {
        console.log('[INIT] start');
        await db.open();
        if (cancelled) return;
        await ensureDefaultPortfolio();
        setStatus('Inizializzazione impostazioni...');
        await initSettings();
        setStatus('Seeding dati demo...');
        await seedDatabase();
        await runSymbolMigrationOnce();
        console.log('[INIT] completed');
      } catch (e) {
        if (isDexieVersionError(e)) {
          console.warn('[INIT] db version mismatch detected');
          setDbBlocked(true);
          return;
        }
        console.error("Initialization error:", e);
        setInitError(e instanceof Error ? e.message : String(e));
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (!cancelled) setInitialized(true);
      }
    };

    // Safety timeout to avoid perma-loading if Dexie resta bloccato
    timeoutId = setTimeout(() => {
      if (!initialized) {
        console.warn('[INIT] timeout reached, forcing UI to render');
        setInitError(prev => prev ?? 'Timeout inizializzazione. IndexedDB potrebbe essere bloccato nel browser.');
        setInitialized(true);
      }
    }, 6000);

    init();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  const handleResetDb = async () => {
    if (dbResetting) return;
    setDbResetting(true);
    try {
      await db.delete();
    } catch (err) {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase('EasyPortfolioDB');
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => resolve();
        });
      } catch (fallbackErr) {
        console.error('DB delete fallback failed:', fallbackErr);
      }
    } finally {
      window.location.reload();
    }
  };

  if (dbBlocked) {
    return <DbRecoveryScreen onReset={handleResetDb} isResetting={dbResetting} />;
  }

  if (!initialized) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#020617] text-gray-400 gap-3">
        <span className="material-symbols-outlined animate-spin text-primary text-3xl">donut_large</span>
        <div className="flex flex-col">
          <span className="font-medium tracking-wide">{status}</span>
          <span className="text-xs text-gray-500">Se resta qui, controlla console (IndexedDB/Service Worker).</span>
        </div>
      </div>
    );
  }

  return (
    <InitErrorContext.Provider value={initError}>
      <ErrorBoundary>\n      <RouterProvider router={router} />\n    </ErrorBoundary>
    </InitErrorContext.Provider>
  );
};

export default App;




import React, { useEffect, useState } from 'react';
import { createHashRouter, RouterProvider, Navigate, Outlet } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Transactions } from './pages/Transactions';
import { Rebalance } from './pages/Rebalance';
import { Macro } from './pages/Macro';
import { Settings } from './pages/Settings';
import { Data } from './pages/Data';
import { Report } from './pages/Report';
import { initSettings, seedDatabase, ensureDefaultPortfolio } from './db';

const InitErrorContext = React.createContext<string | null>(null);

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
    { path: '/report', element: <Report /> },
    {
      element: <LayoutShell />,
      children: [
        { path: '/', element: <Dashboard /> },
        { path: '/transactions', element: <Transactions /> },
        { path: '/rebalance', element: <Rebalance /> },
        { path: '/macro', element: <Macro /> },
        { path: '/settings', element: <Settings /> },
        { path: '/data', element: <Data /> },
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

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const init = async () => {
      try {
        console.log('[INIT] start');
        await ensureDefaultPortfolio();
        setStatus('Inizializzazione impostazioni...');
        await initSettings();
        setStatus('Seeding dati demo...');
        await seedDatabase();
        console.log('[INIT] completed');
      } catch (e) {
        console.error("Initialization error:", e);
        setInitError(e instanceof Error ? e.message : String(e));
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        setInitialized(true);
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
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

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
      <RouterProvider router={router} />
    </InitErrorContext.Provider>
  );
};

export default App;



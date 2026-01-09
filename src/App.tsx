import React, { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Transactions } from './pages/Transactions';
import { Rebalance } from './pages/Rebalance';
import { Macro } from './pages/Macro';
import { Settings } from './pages/Settings';
import { initSettings, seedDatabase } from './db';

const App: React.FC = () => {
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        await initSettings();
        await seedDatabase();
      } catch (e) {
        console.error("Initialization error:", e);
      } finally {
        setInitialized(true);
      }
    };
    init();
  }, []);

  if (!initialized) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#f8f9fa] text-gray-500 gap-2">
        <span className="material-symbols-outlined animate-spin">refresh</span>
        <span>Caricamento dati...</span>
      </div>
    );
  }

  return (
    <HashRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/rebalance" element={<Rebalance />} />
          <Route path="/macro" element={<Macro />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
};

export default App;
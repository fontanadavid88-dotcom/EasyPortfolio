import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';

const NavItem = ({ to, icon, label, collapsed }: { to: string, icon: string, label: string, collapsed: boolean }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      clsx(
        "flex items-center gap-4 px-4 py-3 mx-2 rounded-xl transition-all duration-200 mb-1 border border-transparent",
        isActive
          ? "bg-primary/20 text-primary font-semibold shadow-sm border-primary/20 backdrop-blur-sm"
          : "text-textMuted hover:bg-white/5 hover:text-textPrimary"
      )
    }
  >
    {({ isActive }) => (
      <>
        <span className={clsx("material-symbols-outlined transition-colors", isActive ? "text-primary" : "text-gray-500")}>{icon}</span>
        {!collapsed && <span className="text-sm tracking-wide">{label}</span>}
      </>
    )}
  </NavLink>
);

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isSidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex h-screen bg-[#020617] text-textPrimary font-sans overflow-hidden bg-gradient-to-br from-backgroundDark via-backgroundElevated to-backgroundDark">

      {/* Sidebar - Desktop & Mobile Drawer */}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-20 bg-backgroundElevated/50 backdrop-blur-xl border-r border-borderSoft transition-all duration-300 ease-in-out flex flex-col shadow-2xl",
          isSidebarOpen ? "w-64 translate-x-0" : "w-20 -translate-x-full md:translate-x-0 md:w-20"
        )}
      >
        {/* Logo Area */}
        <div className="h-20 flex items-center px-6 border-b border-borderSoft bg-transparent">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-blue-700 text-white flex items-center justify-center mr-3 shadow-lg shadow-primary/30">
            <span className="material-symbols-outlined text-[24px]">monitoring</span>
          </div>
          {isSidebarOpen && <span className="font-bold text-xl text-textPrimary tracking-tight">EasyPortfolio</span>}
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 py-6 overflow-y-auto space-y-1">
          <NavItem to="/" icon="dashboard" label="Dashboard" collapsed={!isSidebarOpen} />
          <NavItem to="/transactions" icon="receipt_long" label="Transazioni" collapsed={!isSidebarOpen} />
          <NavItem to="/rebalance" icon="balance" label="Ribilanciamento" collapsed={!isSidebarOpen} />
          <NavItem to="/macro" icon="speed" label="Macro Indicator" collapsed={!isSidebarOpen} />
          <div className="my-4 border-t border-borderSoft mx-6"></div>
          <NavItem to="/settings" icon="settings" label="Impostazioni" collapsed={!isSidebarOpen} />
        </nav>

        {/* User / Footer Area */}
        {isSidebarOpen && (
          <div className="p-4 text-xs text-textMuted text-center border-t border-borderSoft bg-black/20">
            v1.4.0 • Offline Mode
          </div>
        )}
      </aside>

      {/* Main Content Wrapper */}
      <div className={clsx(
        "flex-1 flex flex-col transition-all duration-300 h-full relative",
        isSidebarOpen ? "md:ml-64" : "md:ml-20"
      )}>

        {/* Background Gradients (Decorative) */}
        <div className="absolute top-[-20%] right-[-10%] w-[500px] h-[500px] bg-primary/20 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[400px] h-[400px] bg-secondary/10 rounded-full blur-[100px] pointer-events-none" />

        {/* Top App Bar */}
        <header className="h-20 bg-backgroundDark/50 backdrop-blur-md border-b border-borderSoft flex items-center justify-between px-6 sticky top-0 z-10">
          <button
            onClick={() => setSidebarOpen(!isSidebarOpen)}
            className="p-2 -ml-2 rounded-full hover:bg-white/10 text-textMuted focus:outline-none transition-colors"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>

          <div className="flex items-center gap-4">
            <div className="text-right hidden sm:block">
              <div className="text-xs font-medium text-textMuted uppercase tracking-wider">Portafoglio Principale</div>
              <div className="text-sm font-bold text-textPrimary">My Wealth</div>
            </div>
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-800 to-gray-900 border border-borderSoft text-textPrimary flex items-center justify-center font-bold text-xs shadow-lg ring-2 ring-primary/20">
              MW
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8 relative z-0 hide-scrollbar">
          <div className="max-w-7xl mx-auto w-full animate-fade-in">
            {children}
          </div>
        </main>
      </div>

      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-10"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
};
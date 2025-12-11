import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';

// Update: Active state now uses Secondary (Orange) as requested
const NavItem = ({ to, icon, label, collapsed }: { to: string, icon: string, label: string, collapsed: boolean }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      clsx(
        "flex items-center gap-4 px-4 py-3 mx-3 rounded-lg transition-all duration-200 mb-1.5 group border border-transparent",
        isActive 
          ? "bg-secondary/10 border-secondary/20 text-white shadow-[0_0_15px_rgba(249,115,22,0.2)]" 
          : "text-shell-muted hover:bg-white/5 hover:text-white"
      )
    }
  >
    {({ isActive }) => (
      <>
        <span className={clsx("material-symbols-outlined transition-colors text-[22px]", isActive ? "text-secondary" : "text-shell-muted group-hover:text-white")}>{icon}</span>
        {!collapsed && <span className="text-sm tracking-wide font-medium">{label}</span>}
      </>
    )}
  </NavLink>
);

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isSidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex h-screen bg-shell text-shell-text font-sans overflow-hidden">
      
      {/* Sidebar - Elevated Dark */}
      <aside 
        className={clsx(
          "fixed inset-y-0 left-0 z-30 bg-shell-elevated border-r border-shell-border transition-all duration-300 ease-in-out flex flex-col shadow-2xl",
          isSidebarOpen ? "w-64 translate-x-0" : "w-20 -translate-x-full md:translate-x-0 md:w-20"
        )}
      >
        {/* Logo Area */}
        <div className="h-20 flex items-center px-6 border-b border-shell-border mb-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary-dark flex items-center justify-center mr-3 shadow-lg shadow-primary/20 border border-white/10">
            <span className="material-symbols-outlined text-white text-[24px]">account_balance_wallet</span>
          </div>
          {isSidebarOpen && (
            <div>
              <span className="font-bold text-lg text-white tracking-wide block leading-none">EasyPortfolio</span>
              <span className="text-[10px] text-shell-muted uppercase tracking-widest">Finance Tracker</span>
            </div>
          )}
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 py-2 overflow-y-auto space-y-1">
          <div className="px-6 mb-3 text-[10px] font-bold text-shell-muted uppercase tracking-widest opacity-60">
            {isSidebarOpen ? 'Menu Principale' : '...'}
          </div>
          <NavItem to="/" icon="dashboard" label="Dashboard" collapsed={!isSidebarOpen} />
          <NavItem to="/transactions" icon="receipt_long" label="Transazioni" collapsed={!isSidebarOpen} />
          <NavItem to="/rebalance" icon="balance" label="Ribilanciamento" collapsed={!isSidebarOpen} />
          <NavItem to="/macro" icon="speed" label="Macro View" collapsed={!isSidebarOpen} />
          
          <div className="my-6 border-t border-shell-border mx-6"></div>
          
          <div className="px-6 mb-3 text-[10px] font-bold text-shell-muted uppercase tracking-widest opacity-60">
            {isSidebarOpen ? 'Configurazione' : '...'}
          </div>
          <NavItem to="/settings" icon="settings" label="Impostazioni" collapsed={!isSidebarOpen} />
        </nav>

        {/* Footer Area */}
        {isSidebarOpen && (
          <div className="p-4 bg-black/20 text-xs text-shell-muted text-center border-t border-shell-border">
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 bg-positive rounded-full animate-pulse"></span>
              <span className="font-medium">Online Mode</span>
            </div>
            v1.6.0 • Dark Theme
          </div>
        )}
      </aside>

      {/* Main Content Wrapper */}
      <div className={clsx(
        "flex-1 flex flex-col transition-all duration-300 h-full",
        isSidebarOpen ? "md:ml-64" : "md:ml-20"
      )}>
        
        {/* Top Header - Dark Transparent */}
        <header className="h-20 bg-shell/80 backdrop-blur-md border-b border-shell-border flex items-center justify-between px-8 sticky top-0 z-20">
          <button 
            onClick={() => setSidebarOpen(!isSidebarOpen)}
            className="p-2 -ml-2 rounded-lg hover:bg-white/5 text-shell-muted hover:text-white transition-colors focus:outline-none"
          >
            <span className="material-symbols-outlined">menu_open</span>
          </button>
          
          <div className="flex items-center gap-5">
             <div className="text-right hidden sm:block">
                <div className="text-[10px] font-bold text-shell-muted uppercase tracking-widest">Portafoglio Attivo</div>
                <div className="text-sm font-bold text-white flex items-center justify-end gap-1">
                  My Personal Wealth <span className="material-symbols-outlined text-sm text-secondary">verified</span>
                </div>
             </div>
             <div className="w-10 h-10 rounded-full bg-shell-elevated border border-shell-border text-primary font-bold flex items-center justify-center shadow-lg shadow-black/20">
                MP
             </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-6 md:p-10 relative">
          {/* Subtle background glow effect */}
          <div className="absolute top-0 left-0 w-full h-96 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 pointer-events-none"></div>
          
          <div className="max-w-7xl mx-auto w-full animate-fade-in relative z-10">
            {children}
          </div>
        </main>
      </div>

      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div 
          className="md:hidden fixed inset-0 bg-black/80 backdrop-blur-sm z-20"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
};
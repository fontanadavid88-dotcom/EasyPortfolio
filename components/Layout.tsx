import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';

const NavItem = ({ to, icon, label, collapsed }: { to: string, icon: string, label: string, collapsed: boolean }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      clsx(
        "flex items-center gap-4 px-4 py-3 mx-2 rounded-full transition-colors mb-1",
        isActive ? "bg-blue-100 text-blue-800 font-medium" : "text-gray-600 hover:bg-gray-100"
      )
    }
  >
    <span className="material-symbols-outlined text-[24px]">{icon}</span>
    {!collapsed && <span className="text-sm tracking-wide">{label}</span>}
  </NavLink>
);

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isSidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex h-screen bg-[#f8f9fa] text-gray-900 font-sans overflow-hidden">
      
      {/* Sidebar - Desktop & Mobile Drawer */}
      <aside 
        className={clsx(
          "fixed inset-y-0 left-0 z-20 bg-white border-r border-gray-200 transition-all duration-300 ease-in-out flex flex-col",
          isSidebarOpen ? "w-64 translate-x-0" : "w-20 -translate-x-full md:translate-x-0 md:w-20"
        )}
      >
        {/* Logo Area */}
        <div className="h-16 flex items-center px-6 border-b border-gray-100">
          <span className="material-symbols-outlined text-blue-600 text-3xl mr-2">monitoring</span>
          {isSidebarOpen && <span className="font-bold text-xl text-gray-700 tracking-tight">EasyPortfolio</span>}
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 py-4 overflow-y-auto">
          <NavItem to="/" icon="dashboard" label="Dashboard" collapsed={!isSidebarOpen} />
          <NavItem to="/transactions" icon="receipt_long" label="Transazioni" collapsed={!isSidebarOpen} />
          <NavItem to="/portfolio" icon="pie_chart" label="Portafoglio" collapsed={!isSidebarOpen} />
          <NavItem to="/rebalance" icon="balance" label="Ribilanciamento" collapsed={!isSidebarOpen} />
          <NavItem to="/macro" icon="speed" label="Macro Indicator" collapsed={!isSidebarOpen} />
          <div className="my-2 border-t border-gray-100 mx-4"></div>
          <NavItem to="/settings" icon="settings" label="Impostazioni" collapsed={!isSidebarOpen} />
        </nav>

        {/* User / Footer Area */}
        {isSidebarOpen && (
          <div className="p-4 text-xs text-gray-400 text-center">
            v1.0.0 • Offline
          </div>
        )}
      </aside>

      {/* Main Content Wrapper */}
      <div className={clsx(
        "flex-1 flex flex-col transition-all duration-300 h-full",
        isSidebarOpen ? "md:ml-64" : "md:ml-20"
      )}>
        
        {/* Top App Bar */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 sticky top-0 z-10 shadow-sm">
          <button 
            onClick={() => setSidebarOpen(!isSidebarOpen)}
            className="p-2 rounded-full hover:bg-gray-100 text-gray-600 focus:outline-none"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
          
          <div className="flex items-center gap-3">
             {/* Add top bar actions here if needed */}
             <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-sm">
                EP
             </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-5xl mx-auto w-full animate-fade-in">
            {children}
          </div>
        </main>
      </div>

      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div 
          className="md:hidden fixed inset-0 bg-black/50 z-10"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
};
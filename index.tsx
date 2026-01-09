import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

console.log("Starting application mount...");

try {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    console.error("FATAL: Root element not found!");
  } else {
    console.log("Root element found:", rootElement);
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
    console.log("Render called successfully.");
  }
} catch (err) {
  console.error("FATAL: Error during React mount:", err);
}
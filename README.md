<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1K_4zP_gCiwEpqIRATO8uBrEn_7y35Oh5

## Run Locally

**Prerequisites:**  Node.js (consigliato LTS 20/22)


1. Install dependencies:
   `npm install`
2. Set `EODHD_API_KEY` in [.env.local](.env.local) for the server-side proxy.
3. Run the app:
   - UI only: `npm run dev` (http://localhost:5173)
   - UI + /api/*: `npm run dev:vercel` (http://localhost:3000)

## Production (Vercel)

This app uses server-side proxies for price and sheet data to avoid CORS and keep secrets out of the client.

- Set `EODHD_API_KEY` in Vercel Environment Variables (server-side only, not `VITE_*`).
- The frontend calls `/api/eodhd-proxy` and `/api/sheets` (do not call EODHD or Google Sheets directly).
- For local testing with proxies, use `npm run dev:vercel` and set `EODHD_API_KEY` in `.env.local`.

## Troubleshooting vercel dev 502 (Windows)

**Sintomo**
- 502 `NO_RESPONSE_FROM_FUNCTION`
- Log con `internal/preload` e path troncato su spazi (es. `Cannot find module 'F:\\...\\15'`)

**Causa**
- Variabile d'ambiente globale `NODE_OPTIONS` con `--require/--import` non quotato.

**Fix definitivo**
- Rimuovere `NODE_OPTIONS` da Environment Variables (User/Machine).

**Workaround per sessione (se non puoi modificare variabili di sistema)**
```powershell
$env:NODE_OPTIONS=""
Remove-Item Env:NODE_OPTIONS
```

**Script sicuro**
- Usa `npm run vercel:dev` (alias di `vercel:dev:safe`) per avviare `vercel dev` con `NODE_OPTIONS` forzato a vuoto anche su PC aziendali.

## Troubleshooting Chrome (proxy gestito dall'IT)

**Sintomo**
- `localhost:3000` non si apre in Chrome, ma funziona in Firefox.

**Causa**
- Chrome forza il traffico locale attraverso il proxy aziendale, che blocca/buca il loopback.

**Workaround**
- Usa Firefox per lo sviluppo.
- In alternativa apri `http://127.0.0.1:3000` o `http://[::1]:3000` (spesso bypassa il proxy).
- Se Chrome ha un Service Worker PWA bloccato, rimuovilo da DevTools → Application → Service Workers.

## Vercel deploy checklist

- Imposta `EODHD_API_KEY` sia su **Preview** che **Production**.
- Deploy Preview: verifica `/api/health` (200, `hasEodhdKey: true`).
- Testa in UI: `Impostazioni > Aggiorna Prezzi` (nessun CORS, errori chiari).
- Nota PWA: i prezzi si aggiornano **on-demand** (click o apertura app), non in background schedulato.

## Nota Node.js (dev Windows)
- Consigliato Node LTS 20/22. Con Node 24 su Windows sono stati osservati crash/asserzioni `UV_HANDLE_CLOSING` in libuv.

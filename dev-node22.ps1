$env:PATH="C:\Users\tspl010\tools\node-v22.22.0-win-x64;$env:PATH"
Write-Host ("Node: " + (node -v))
Write-Host ("npm:  " + (npm -v))
npm run vercel:dev

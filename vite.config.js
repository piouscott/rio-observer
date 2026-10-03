import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig(({ mode }) => ({
  // Chemins relatifs : l'application peut être hébergée dans un sous-dossier.
  base: './',
  // `npm run dev:phone` : HTTPS avec certificat auto-signé, car un téléphone refuse la caméra
  // et le calcul d'empreinte sur une adresse http:// autre que localhost.
  plugins: mode === 'phone' ? [basicSsl()] : [],
}))

/* ============================================================
   FIREBASE CONFIG
   ------------------------------------------------------------
   COLE AQUI as credenciais do seu projeto Firebase.
   Você obtém isso no Console do Firebase:
     Configurações do projeto → Seus apps → Configuração do SDK

   ATENÇÃO:
   - Estas chaves são públicas por design (Firebase Web SDK).
   - A SEGURANÇA real do banco vem das REGRAS DO FIRESTORE
     (veja a seção "Regras Firestore" no README.md).
   ============================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyCrrTLJMWve_8mNptzAiMxz5ejTFE58GXA",
  authDomain: "pagamentos-site.firebaseapp.com",
  projectId: "pagamentos-site",
  storageBucket: "pagamentos-site.firebasestorage.app",
  messagingSenderId: "350551469871",
  appId: "1:350551469871:web:98ef3105c2590f9df23bda",
  measurementId: "G-DR9Z41XCZN"
};

/* ============================================================
   MERCADO PAGO — PUBLIC KEY (produção)
   ------------------------------------------------------------
   Pública por design. Só é usada se você for embutir o
   Brick / Checkout Bricks no frontend. Para Checkout Pro
   (redirect ao init_point) NÃO é necessária — mas deixamos
   aqui para uso futuro.
   ============================================================ */
const MERCADO_PAGO_PUBLIC_KEY = "APP_USR-cdcc85cf-78f3-475e-a39d-d301180c4c12";

/* ============================================================
   URL DA API (Vercel Functions)
   ------------------------------------------------------------
   COLE AQUI o domínio onde está hospedado o backend
   (as funções /api/criar-preferencia e /api/webhook-mercadopago).

   Exemplos:
     "https://seu-projeto.vercel.app"
     "https://api.seusite.com.br"

   Se você ainda não publicou as APIs, deixe vazio "" para usar
   caminho relativo (útil apenas quando frontend e backend
   estiverem no mesmo domínio).
   ============================================================ */

const API_BASE_URL = "https://pagamentos-site.vercel.app";

/* ============================================================
   INICIALIZAÇÃO DO FIREBASE (compat SDK — funciona sem build)
   ------------------------------------------------------------
   Os scripts compat são carregados via <script> nos HTMLs:
     - firebase-app-compat.js
     - firebase-firestore-compat.js
     - firebase-auth-compat.js  (opcional, ver README)
   ============================================================ */

if (typeof firebase !== "undefined" && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = (typeof firebase !== "undefined") ? firebase.firestore() : null;

// Expõe globalmente para os outros scripts
window.__FB = {
  db,
  apiBaseUrl: API_BASE_URL || "",
  firebaseConfig,
  mercadoPagoPublicKey: typeof MERCADO_PAGO_PUBLIC_KEY !== "undefined" ? MERCADO_PAGO_PUBLIC_KEY : ""
};

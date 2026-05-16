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
  apiKey: "COLE_AQUI",
  authDomain: "COLE_AQUI",
  projectId: "COLE_AQUI",
  storageBucket: "COLE_AQUI",
  messagingSenderId: "COLE_AQUI",
  appId: "COLE_AQUI",
  measurementId: "COLE_AQUI"
};

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

const API_BASE_URL = "COLE_AQUI_URL_DA_API";

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
  firebaseConfig
};

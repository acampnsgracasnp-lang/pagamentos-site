# pagamentos-site

Sistema **reutilizável** de inscrições para eventos (acampamentos, retiros, encontros, etc.) em **HTML + CSS + JavaScript puro**, integrado com **Firebase Firestore** (banco de dados) e **Mercado Pago** (pagamento via PIX e cartão).

- **Frontend** (estático): pode ser publicado no **GitHub Pages**, Netlify, Cloudflare Pages, Vercel, ou qualquer hosting estático.
- **Backend** (2 functions): publicado em **Vercel** (Node.js Serverless). O backend é necessário para guardar o **Access Token** do Mercado Pago em segurança.

> ⚠️ **Importante:** o Access Token do Mercado Pago **nunca** pode ficar no frontend. Por isso há um backend Serverless.

---

## 📁 Estrutura

```
pagamentos-site/
├── index.html              ← página pública (?evento=slug)
├── admin.html              ← painel administrativo
├── sucesso.html            ← retorno de pagamento aprovado
├── pendente.html           ← retorno de pagamento pendente (PIX)
├── erro.html               ← retorno de pagamento recusado/cancelado
├── css/
│   └── style.css
├── js/
│   ├── firebase-config.js  ← cole AQUI o firebaseConfig
│   ├── app.js              ← lógica do index.html
│   └── admin.js            ← lógica do admin.html
├── api/                    ← Vercel Functions (backend)
│   ├── criar-preferencia.js
│   └── webhook-mercadopago.js
└── README.md               (este arquivo)
```

---

## 🔥 Passo 1 — Configurar o Firebase

1. No [Console Firebase](https://console.firebase.google.com), crie (ou abra) seu projeto.
2. Ative o **Cloud Firestore** (modo nativo).
3. Vá em **Configurações do projeto → Seus apps → Web** e copie o objeto `firebaseConfig`.
4. Abra `js/firebase-config.js` e substitua os valores `COLE_AQUI`:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
  measurementId: "..."
};

const API_BASE_URL = "https://seu-projeto.vercel.app"; // URL das functions (passo 4)
```

### Coleções usadas no Firestore

| Coleção         | O quê armazena |
|-----------------|----------------|
| `events`        | Os eventos (criados via painel admin) |
| `registrations` | Cada inscrição (com participantes) |
| `payments`      | Log de notificações do Mercado Pago |
| `admins`        | (opcional, para Firebase Auth) |
| `settings`      | (reservado para configurações gerais) |

Você **não precisa criar** essas coleções manualmente — elas são criadas automaticamente no primeiro uso.

---

## 🔐 Passo 2 — Regras do Firestore (recomendado para produção)

No Console Firebase, vá em **Firestore Database → Regras** e use algo como o exemplo abaixo. **Estas regras assumem que você vai usar Firebase Authentication para o admin.** Veja a seção "Login admin" mais abaixo.

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ----- helper: admin autenticado existente em /admins/{uid}
    function isAdmin() {
      return request.auth != null &&
             exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    // ----- events
    // Qualquer um pode LER eventos (precisa para abrir o link público).
    // Somente admin pode criar / editar / excluir.
    match /events/{eventId} {
      allow read: if true;
      allow create, update, delete: if isAdmin();
    }

    // ----- registrations
    // Qualquer um pode CRIAR sua inscrição (pendente).
    // Somente admin pode listar todas / editar / excluir.
    // O webhook do MP usa Service Account (admin SDK) → bypass das regras.
    match /registrations/{regId} {
      allow create: if request.resource.data.statusPagamento == 'pendente'
                    && request.resource.data.valorTotal is number
                    && request.resource.data.valorTotal > 0;
      allow read, update, delete: if isAdmin();
    }

    // ----- payments (log)
    // Somente backend (admin SDK) escreve. Admin pode ler.
    match /payments/{p} {
      allow read: if isAdmin();
      allow write: if false;
    }

    // ----- admins
    match /admins/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if false;
    }

    // ----- settings
    match /settings/{key} {
      allow read: if true;
      allow write: if isAdmin();
    }
  }
}
```

> ⚠️ Enquanto estiver em **modo de teste**, o Firestore aceita leitura/escrita de qualquer um por 30 dias. **Antes do go-live, aplique regras como as acima**.

### Login do admin (em produção)

Hoje o `admin.html` usa uma **senha simples em JS** (`ADMIN_PASSWORD` em `js/admin.js`) — útil para testes, mas **insegura** (qualquer pessoa vê a senha no código).

Para produção, troque por **Firebase Authentication**:

1. No Console Firebase: **Authentication → Sign-in method**, habilite **E-mail/Senha**.
2. Crie seu usuário admin (E-mail/Senha) na aba Users.
3. Na coleção `admins`, crie um documento com **ID = UID do usuário** e qualquer conteúdo (ex.: `{ nome: "Você", role: "owner" }`).
4. Substitua a função `login()` em `js/admin.js` por:
   ```js
   firebase.auth().signInWithEmailAndPassword(email, senha)
   ```
   e o `isLoggedIn()` por `firebase.auth().currentUser != null` (após `onAuthStateChanged`).

Lembre de carregar o SDK no `admin.html`:
```html
<script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js"></script>
```

---

## 💳 Passo 3 — Configurar o Mercado Pago

1. Crie uma conta no [Mercado Pago](https://www.mercadopago.com.br/developers).
2. Em **Suas integrações**, crie uma aplicação.
3. Copie o **Access Token de Produção** (`APP_USR-...`).
4. Em **Webhooks**, configure:
   - URL: `https://SEU-PROJETO.vercel.app/api/webhook-mercadopago`
   - Eventos: marque **Pagamentos**.
5. Para testes iniciais, você pode usar o Access Token de **TEST** e o sandbox.

> Os links de retorno (sucesso/pendente/erro) já são montados em `criar-preferencia.js` a partir de `PUBLIC_SITE_URL`.

---

## ☁️ Passo 4 — Publicar o backend na Vercel

1. Crie uma conta em [vercel.com](https://vercel.com) e instale a CLI (opcional):  `npm i -g vercel`.
2. Crie um repositório no GitHub apenas com a pasta `api/` (ou com o projeto inteiro — a Vercel detecta automaticamente).
3. **Importante:** crie um `package.json` na raiz do projeto Vercel:

   ```json
   {
     "name": "pagamentos-site-api",
     "version": "1.0.0",
     "private": true,
     "dependencies": {
       "firebase-admin": "^12.0.0"
     }
   }
   ```

4. Importe o repositório no painel da Vercel. Não precisa configurar build — ela detecta automaticamente que `api/*.js` são Serverless Functions.

5. Em **Settings → Environment Variables**, adicione (para *Production* e *Preview*):

   | Nome | Valor |
   |---|---|
   | `MERCADO_PAGO_ACCESS_TOKEN` | `APP_USR-...` (token do MP) |
   | `PUBLIC_SITE_URL` | URL pública do frontend, ex.: `https://seu-usuario.github.io/pagamentos-site` |
   | `API_BASE_URL` | URL da Vercel, ex.: `https://seu-projeto.vercel.app` |
   | `FIREBASE_SERVICE_ACCOUNT` | JSON do service account em **uma linha só** |
   | `FIREBASE_PROJECT_ID` | (opcional) ID do projeto Firebase |

   **Como obter o `FIREBASE_SERVICE_ACCOUNT`:**
   - Console Firebase → **Configurações do projeto → Contas de serviço → Gerar nova chave privada**.
   - Abra o JSON baixado.
   - Cole o conteúdo inteiro em uma única linha na variável da Vercel.
     (As quebras `\n` dentro do `private_key` são tratadas automaticamente no código.)

6. Faça **Redeploy** após adicionar as variáveis.

7. Teste:
   - `https://SEU-PROJETO.vercel.app/api/criar-preferencia` → deve responder `405 Método não permitido. Use POST.`
   - `https://SEU-PROJETO.vercel.app/api/webhook-mercadopago` → deve responder algo (200 ou similar).

---

## 🌐 Passo 5 — Publicar o frontend no GitHub Pages

1. Crie um repositório no GitHub (ex.: `pagamentos-site`).
2. Suba **toda a pasta `pagamentos-site/`** (menos a `api/`, se preferir — o GitHub Pages ignora o backend).
3. No repositório, vá em **Settings → Pages**:
   - Source: **Deploy from a branch**.
   - Branch: `main` (ou `master`), pasta `/ (root)`.
4. Aguarde alguns minutos. Seu site estará em:
   `https://SEU-USUARIO.github.io/pagamentos-site/`.

> Lembre-se: o `PUBLIC_SITE_URL` na Vercel precisa apontar para essa URL.

---

## 🚀 Passo 6 — Criar o primeiro evento

1. Acesse `admin.html` no seu domínio: `https://SEU-USUARIO.github.io/pagamentos-site/admin.html`.
2. Digite a senha (`admin123` por padrão — **troque** em `js/admin.js`).
3. Clique em **+ Novo evento** e preencha:
   - **Nome**: ex. *Acampamento Jovem 2026*
   - **Slug**: `acampamento` (este será o link público)
   - **Valor**: 120
   - **Limite ingressos**: 100
   - **Data / Local**: opcional
   - **Banner URL**: opcional (qualquer imagem pública)
   - **Exige camiseta**: Sim / Não
   - **Tamanhos**: `PP, P, M, G, GG, XG`
4. Salve.

O link público fica `https://SEU-USUARIO.github.io/pagamentos-site/index.html?evento=acampamento`.

Você pode criar quantos eventos quiser e reutilizar o mesmo sistema:
- `?evento=mulheres`
- `?evento=acampamento`
- `?evento=retiro`

Se você abrir `index.html` **sem** `?evento=...`, o sistema carrega automaticamente o primeiro evento ativo.

---

## 🧮 Como o fluxo funciona

1. Usuário abre `index.html?evento=slug` → carrega o evento do Firestore.
2. Preenche quantidade + dados de cada participante (com tamanho de camiseta, se exigido).
3. Clica em **Continuar para pagamento**:
   - Cria a `registration` no Firestore com `statusPagamento: "pendente"`.
   - Chama `/api/criar-preferencia` (Vercel).
   - Redireciona o usuário para o **Checkout do Mercado Pago**.
4. Após o pagamento, o usuário volta para `sucesso.html`, `pendente.html` ou `erro.html`.
5. Em paralelo, o Mercado Pago chama `/api/webhook-mercadopago`:
   - Consulta o pagamento.
   - Atualiza `registrations[*].statusPagamento`.
   - Se aprovado, **incrementa `ingressosVendidos`** do evento (em transação atômica).
   - Salva um log na coleção `payments`.

> ✅ A contagem de vagas só é incrementada **após o pagamento ser aprovado**. Isso evita marcar vagas para inscrições que ficaram pendentes ou foram canceladas.

---

## 🧪 Testes locais

Você pode testar o frontend abrindo `index.html` direto no navegador (com `?evento=slug`).
Para testar o backend localmente, instale a CLI da Vercel e rode:

```bash
npm i -g vercel
vercel dev
```

(Lembre de criar um arquivo `.env.local` com as mesmas variáveis de ambiente.)

---

## 📝 Checklist de personalização

- [ ] Colar `firebaseConfig` em `js/firebase-config.js`.
- [ ] Colar `API_BASE_URL` em `js/firebase-config.js` (URL da Vercel).
- [ ] Trocar a senha em `js/admin.js` (`ADMIN_PASSWORD`) **ou** migrar para Firebase Auth.
- [ ] Criar as variáveis na Vercel (`MERCADO_PAGO_ACCESS_TOKEN`, `PUBLIC_SITE_URL`, `API_BASE_URL`, `FIREBASE_SERVICE_ACCOUNT`).
- [ ] Configurar o webhook no painel do Mercado Pago.
- [ ] Aplicar as **Regras do Firestore** antes do go-live.
- [ ] Criar o primeiro evento no `admin.html`.
- [ ] Testar uma inscrição completa do início ao fim (com pagamento de teste).

---

## ❓ Dúvidas comuns

**"Posso usar o mesmo sistema para vários eventos diferentes?"**
Sim — é exatamente o propósito. Crie quantos eventos quiser pelo admin, cada um com seu slug, e divulgue links `?evento=NOME-DO-SLUG`.

**"E se eu não quiser perguntar sobre camiseta?"**
No admin, edite o evento e marque **Exige camiseta = Não**. Os campos somem do formulário.

**"O Access Token aparece no frontend?"**
Não. Ele só existe nas variáveis de ambiente da Vercel e no código de `api/`. O frontend apenas chama `/api/criar-preferencia`.

**"Posso usar PIX?"**
Sim. O Checkout Pro do Mercado Pago já oferece PIX, cartão de crédito e débito por padrão (configurado em `api/criar-preferencia.js`).

**"Como funciona o controle de vagas concorrentes?"**
A incrementação de `ingressosVendidos` é feita em uma **transação Firestore** dentro do webhook. Para casos com altíssima concorrência, você pode adicionar uma reserva temporária (campo `reservadoAte`) — sugerido como melhoria futura no `app.js`.

/* ============================================================
   /api/criar-pix.js
   ------------------------------------------------------------
   Vercel Function (Node.js runtime).

   Cria um pagamento PIX DIRETO no Mercado Pago (sem Checkout Pro)
   usando POST /v1/payments. Retorna o QR Code (base64 + texto
   copia-cola) para o frontend renderizar dentro do próprio site.

   Por que Pix direto em vez de Checkout Pro?
     - Checkout Pro não auto-redireciona após pagamento Pix
       (auto_return só funciona para cartão). O usuário fica
       preso em /checkout/v1/payment/redirect/.../congrats/...
     - Com Pix direto, o QR Code aparece na nossa página /sucesso
       e o usuário nunca sai do nosso domínio. O polling em
       /sucesso vê statusPagamento virar "pago" no Firestore e
       mostra a mensagem de boas-vindas + WhatsApp automaticamente.

   FLUXO:
     1. Recebe dados completos da inscrição.
     2. Valida vagas/evento ativo no Firestore.
     3. Salva /pending_checkouts (NÃO em /registrations).
     4. Chama POST /v1/payments do MP com payment_method_id=pix
        e external_reference = id do pending_checkout.
     5. Salva qrCodeBase64 + qrCodeText + paymentId no pending
        (auditoria + possível reuso).
     6. Retorna { pendingCheckoutId, paymentId, qrCodeBase64,
        qrCodeText, expiresAt, valor }.

   O webhook (api/webhook-mercadopago.js) já está preparado:
   ele busca pelo external_reference e cria/atualiza o
   registration normalmente — mesmo caminho do Checkout Pro.

   VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS:
     - MERCADO_PAGO_ACCESS_TOKEN
     - FIREBASE_SERVICE_ACCOUNT
     - FIREBASE_PROJECT_ID (opcional)
     - API_BASE_URL (para notification_url)
   ============================================================ */

const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT não configurado.");
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT precisa ser JSON válido em uma única linha."); }
  if (serviceAccount.private_key && serviceAccount.private_key.includes("\\n")) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
  });
}

function sanitizeParticipantes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(p => {
    const desejaCamiseta =
      p && p.desejaCamiseta === true ? true :
      p && p.desejaCamiseta === false ? false : null;
    const tamanho = String((p && p.tamanhoCamiseta) || "").trim();
    return {
      nome: String((p && p.nome) || "").trim(),
      email: String((p && p.email) || "").trim(),
      telefone: String((p && p.telefone) || "").trim(),
      cidade: String((p && p.cidade) || "").trim(),
      comunidade: String((p && p.comunidade) || "").trim(),
      pastoral: String((p && p.pastoral) || "").trim(),
      endereco: String((p && p.endereco) || "").trim(),
      desejaCamiseta: desejaCamiseta,
      tamanhoCamiseta: desejaCamiseta === false ? "" : tamanho
    };
  });
}

// Pix exige date_of_expiration no formato ISO 8601 com offset (-03:00).
// Sem isso o pagamento herda o default da conta MP (geralmente 24h).
// 30 minutos é o suficiente e mantém o pending pequeno.
function pixExpirationISO(minutesFromNow) {
  // Momento absoluto no tempo (em ms desde epoch UTC)
  const futureUTCMs = Date.now() + minutesFromNow * 60 * 1000;
  // Para representar esse mesmo instante em BRT (UTC-3), basta deslocar
  // -3h e usar os getters UTC — eles retornam então os componentes BRT.
  // Independe do timezone do servidor (Vercel é UTC; localhost pode variar).
  const brtMs = futureUTCMs - 3 * 60 * 60 * 1000;
  const d = new Date(brtMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
         `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000-03:00`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido. Use POST." });
    return;
  }

  const ACCESS_TOKEN = (process.env.MERCADO_PAGO_ACCESS_TOKEN || "").trim();
  if (!ACCESS_TOKEN) {
    res.status(500).json({ error: "MERCADO_PAGO_ACCESS_TOKEN não configurado." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const {
    eventId,
    eventSlug,
    eventNome,
    quantidade,
    valorTotal,
    valorUnitario,
    participantes,
    titulo,
    descricao,
    payer
  } = body;

  if (!eventId || typeof eventId !== "string") {
    res.status(400).json({ error: "eventId é obrigatório." });
    return;
  }
  const sanitized = sanitizeParticipantes(participantes);
  if (sanitized.length < 1 || sanitized.length > 100) {
    res.status(400).json({
      error: "Lista de participantes vazia ou inválida.",
      debug: {
        participantesRecebidos: Array.isArray(participantes) ? participantes.length : `tipo=${typeof participantes}`,
        bodyKeys: Object.keys(body)
      }
    });
    return;
  }
  const qtd = sanitized.length;
  const valor = Number(valorTotal);
  if (!isFinite(valor) || valor <= 0 || valor > 1000000) {
    res.status(400).json({ error: "valorTotal inválido." });
    return;
  }
  for (let i = 0; i < sanitized.length; i++) {
    if (!sanitized[i].nome || sanitized[i].nome.length < 3) {
      res.status(400).json({ error: `Participante ${i + 1}: nome inválido.` });
      return;
    }
    const tel = sanitized[i].telefone.replace(/\D/g, "");
    if (tel.length < 10) {
      res.status(400).json({ error: `Participante ${i + 1}: telefone inválido.` });
      return;
    }
  }
  const emailPrincipal = sanitized[0].email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPrincipal)) {
    res.status(400).json({ error: "E-mail do responsável inválido." });
    return;
  }

  let db;
  try {
    initFirebase();
    db = admin.firestore();
  } catch (err) {
    console.error("Firebase init falhou:", err);
    res.status(500).json({ error: "Falha ao inicializar Firebase.", message: err.message });
    return;
  }

  // Validação server-side de evento + vagas
  let evento;
  try {
    const evSnap = await db.collection("events").doc(eventId).get();
    if (!evSnap.exists) {
      res.status(404).json({ error: "Evento não encontrado." });
      return;
    }
    evento = evSnap.data();
  } catch (err) {
    console.error("Erro ao ler evento:", err);
    res.status(500).json({ error: "Erro ao consultar evento.", message: err.message });
    return;
  }

  if (!evento.ativo) {
    res.status(400).json({ error: "Inscrições encerradas para este evento." });
    return;
  }
  const limite = Number(evento.limiteIngressos) || 0;
  const vendidos = Number(evento.ingressosVendidos) || 0;
  const restantes = Math.max(0, limite - vendidos);
  if (limite > 0 && qtd > restantes) {
    res.status(400).json({ error: `Apenas ${restantes} vaga(s) disponível(is).` });
    return;
  }

  // Cria pending_checkout (mesmo formato do criar-preferencia para o
  // webhook não precisar distinguir Pix vs Checkout Pro)
  const checkoutRef = db.collection("pending_checkouts").doc();
  const checkoutId = checkoutRef.id;

  const pendingData = {
    eventId,
    eventSlug: typeof eventSlug === "string" ? eventSlug : (evento.slug || ""),
    eventNome: typeof eventNome === "string" ? eventNome : (evento.nome || ""),
    quantidade: qtd,
    valorTotal: valor,
    valorUnitario: Number(valorUnitario) || (Number(evento.valor) || 0),
    participantes: sanitized,
    status: "aguardando",
    metodo: "pix",
    preferenceId: "",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  try {
    await checkoutRef.set(pendingData);
  } catch (err) {
    console.error("Erro ao salvar pending_checkout:", err);
    res.status(500).json({ error: "Falha ao iniciar checkout.", message: err.message });
    return;
  }

  const API_BASE_URL = (process.env.API_BASE_URL || "").replace(/\/$/, "");
  const notificationUrl =
    process.env.MERCADO_PAGO_NOTIFICATION_URL ||
    (API_BASE_URL ? `${API_BASE_URL}/api/webhook-mercadopago` : "");

  // Monta payer — para Pix o email é obrigatório.
  const nomeCompleto = (payer && payer.name) || sanitized[0].nome;
  const parts = String(nomeCompleto).trim().split(/\s+/);
  const firstName = parts.shift() || "Cliente";
  const lastName = parts.length ? parts.join(" ") : "MP";

  const mpPayer = {
    email: (payer && payer.email) || emailPrincipal,
    first_name: firstName,
    last_name: lastName
  };
  // CPF é opcional aqui; algumas contas MP exigem para Pix em produção.
  // Se o payer enviar um CPF válido (11 dígitos), incluímos.
  const cpfDigits = String((payer && payer.cpf) || "").replace(/\D/g, "");
  if (cpfDigits.length === 11) {
    mpPayer.identification = { type: "CPF", number: cpfDigits };
  }

  const tituloFinal = (titulo && String(titulo).slice(0, 250)) || `Inscrição — ${pendingData.eventNome || "Evento"}`;
  const descricaoFinal = (descricao && String(descricao).slice(0, 600)) || `${qtd} inscrição(ões)`;

  const paymentBody = {
    transaction_amount: Math.round(valor * 100) / 100,
    description: descricaoFinal,
    payment_method_id: "pix",
    payer: mpPayer,
    external_reference: checkoutId,
    date_of_expiration: pixExpirationISO(30),
    metadata: {
      pending_checkout_id: checkoutId,
      event_id: eventId,
      quantidade: qtd,
      titulo: tituloFinal
    }
  };

  if (notificationUrl) {
    paymentBody.notification_url = notificationUrl;
  }

  try {
    const mpResp = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `${checkoutId}-${Date.now()}`
      },
      body: JSON.stringify(paymentBody)
    });

    const text = await mpResp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!mpResp.ok) {
      console.error("Erro MP /v1/payments:", mpResp.status, data);
      await checkoutRef.delete().catch(() => {});
      res.status(502).json({
        error: "Falha ao criar pagamento Pix no Mercado Pago.",
        details: data
      });
      return;
    }

    const poi = (data.point_of_interaction && data.point_of_interaction.transaction_data) || {};
    const qrCodeText = poi.qr_code || "";
    const qrCodeBase64 = poi.qr_code_base64 || "";
    const ticketUrl = poi.ticket_url || "";

    if (!qrCodeText || !qrCodeBase64) {
      console.error("MP retornou pagamento Pix sem QR:", data);
      await checkoutRef.delete().catch(() => {});
      res.status(502).json({
        error: "Mercado Pago não retornou o QR Code.",
        details: data
      });
      return;
    }

    // Salva QR + paymentId no pending (auditoria + para a página /sucesso
    // poder buscar de novo se o usuário recarregar e perder o localStorage)
    await checkoutRef.update({
      pixPaymentId: String(data.id || ""),
      pixQrCodeText: qrCodeText,
      pixQrCodeBase64: qrCodeBase64,
      pixTicketUrl: ticketUrl,
      pixExpiresAt: paymentBody.date_of_expiration,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(err => console.warn("Falha ao salvar dados do Pix:", err));

    res.status(200).json({
      pendingCheckoutId: checkoutId,
      paymentId: String(data.id || ""),
      qrCodeText,
      qrCodeBase64,
      ticketUrl,
      expiresAt: paymentBody.date_of_expiration,
      valor: paymentBody.transaction_amount,
      status: data.status || "pending"
    });
  } catch (err) {
    console.error("Exceção criar-pix:", err);
    await checkoutRef.delete().catch(() => {});
    res.status(500).json({ error: "Erro interno.", message: err.message });
  }
};

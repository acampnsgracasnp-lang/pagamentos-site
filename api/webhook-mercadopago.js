/* ============================================================
   /api/webhook-mercadopago.js
   ------------------------------------------------------------
   Vercel Function (Node.js runtime).

   Recebe notificações do Mercado Pago e materializa o documento
   definitivo em /registrations a partir do pending_checkout
   correspondente.

   IDEMPOTÊNCIA:
     - O external_reference da preferência É o id do pending_checkout
       E também é o id do registration. Repetições do mesmo paymentId
       sempre caem no mesmo documento.
     - A transação garante que dois webhooks simultâneos não criem
       dois registrations nem incrementem ingressosVendidos duas vezes.

   REGRAS:
     - Primeira notificação (registration ainda não existe) → cria o
       registration copiando os dados do pending_checkout. Marca o
       pending_checkout como "consumido".
     - Status approved → "pago" + incrementa events.ingressosVendidos e
       events.vendidoCamisetas (apenas na transição → pago).
     - Status pending/in_process → "pendente" (sem incrementar nada).
     - Status rejected → "recusado".
     - Status cancelled/refunded/charged_back → "cancelado". Se já
       estava "pago", decrementa contadores (estorno real).
     - Notificações fora de ordem (pending depois de approved) NÃO
       rebaixam o status para pendente.

   VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS:
     - MERCADO_PAGO_ACCESS_TOKEN
     - FIREBASE_SERVICE_ACCOUNT
     - FIREBASE_PROJECT_ID (opcional)

   Configure este URL no painel do Mercado Pago em
   "Suas integrações" → "Webhooks" → "Eventos: Pagamentos":
     https://SEU-PROJETO.vercel.app/api/webhook-mercadopago
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

function mapStatus(mpStatus) {
  switch (mpStatus) {
    case "approved": return "pago";
    case "pending":
    case "in_process":
    case "authorized": return "pendente";
    case "rejected": return "recusado";
    case "cancelled":
    case "refunded":
    case "charged_back": return "cancelado";
    default: return "pendente";
  }
}

function computeCamisetasPorTamanho(participantes) {
  const out = {};
  (participantes || []).forEach(p => {
    const sz = p && p.tamanhoCamiseta;
    if (sz && !/n[ãa]o\s*dese/i.test(String(sz))) {
      out[sz] = (out[sz] || 0) + 1;
    }
  });
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).end("Método não permitido");
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
  const query = req.query || {};

  const type = body.type || query.type || query.topic;
  const paymentId =
    (body.data && (body.data.id || body.data["id"])) ||
    query["data.id"] ||
    query.id ||
    body.id ||
    null;

  const isPaymentTopic =
    type === "payment" ||
    query.topic === "payment" ||
    (typeof type === "string" && type.includes("payment"));

  if (!isPaymentTopic || !paymentId) {
    res.status(200).json({ ok: true, ignored: true, type, paymentId });
    return;
  }

  try {
    initFirebase();
    const db = admin.firestore();

    // Consulta o pagamento no MP
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` }
    });
    if (!mpResp.ok) {
      const t = await mpResp.text();
      console.error("Falha ao consultar pagamento:", mpResp.status, t);
      res.status(200).json({ ok: false, error: "Falha ao buscar pagamento.", status: mpResp.status });
      return;
    }
    const payment = await mpResp.json();

    const externalRef =
      payment.external_reference ||
      (payment.metadata && (payment.metadata.pending_checkout_id || payment.metadata.pendingCheckoutId)) ||
      (payment.metadata && (payment.metadata.registration_id || payment.metadata.registrationId));

    if (!externalRef) {
      console.warn("Pagamento sem external_reference:", paymentId);
      res.status(200).json({ ok: true, warning: "sem external_reference" });
      return;
    }

    const mpStatus = payment.status;
    const novoStatus = mapStatus(mpStatus);

    const regRef = db.collection("registrations").doc(externalRef);
    const pendingRef = db.collection("pending_checkouts").doc(externalRef);

    const result = await db.runTransaction(async (tx) => {
      // === TODAS AS LEITURAS PRIMEIRO ===
      const regSnap = await tx.get(regRef);
      const pendingSnap = regSnap.exists ? null : await tx.get(pendingRef);

      // Determina eventId para possível update de contadores
      let eventId = null;
      if (regSnap.exists) eventId = regSnap.data().eventId;
      else if (pendingSnap && pendingSnap.exists) eventId = pendingSnap.data().eventId;

      const evRef = eventId ? db.collection("events").doc(eventId) : null;
      const incrementaPago = novoStatus === "pago"; // só leremos o evento se for relevante
      // Sempre lemos o evento se houver evRef e a operação puder afetar contadores
      // (criação com pago, transição pendente→pago, ou estorno pago→cancelado).
      const evSnap = evRef ? await tx.get(evRef) : null;

      // === LÓGICA ===
      const novoUpdate = {
        statusPagamento: novoStatus,
        mercadoPagoPaymentId: String(paymentId),
        mercadoPagoStatusDetail: payment.status_detail || "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      let statusAnterior;
      let registrationData; // dados completos do registration (para calcular camisetas)
      let acao;

      if (regSnap.exists) {
        // Já existe — apenas atualiza
        const reg = regSnap.data();
        statusAnterior = reg.statusPagamento || "pendente";
        registrationData = reg;
        acao = "update";

        // Preserva "pago" se chegar notificação atrasada que não é estorno real
        const isEstornoReal = statusAnterior === "pago" && novoStatus === "cancelado";
        if (statusAnterior === "pago" && novoStatus !== "pago" && !isEstornoReal) {
          // Não rebaixa: mantém pago, mas registra o paymentId/detail
          tx.update(regRef, {
            mercadoPagoPaymentId: String(paymentId),
            mercadoPagoStatusDetail: payment.status_detail || "",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          tx.update(regRef, novoUpdate);
        }
      } else if (pendingSnap && pendingSnap.exists) {
        // Primeira notificação: cria o registration a partir do pending_checkout
        const pending = pendingSnap.data();
        statusAnterior = "pendente"; // "anterior" virtual para fins de incremento
        registrationData = pending;
        acao = "create";

        tx.set(regRef, {
          eventId: pending.eventId,
          eventSlug: pending.eventSlug || "",
          eventNome: pending.eventNome || "",
          quantidade: Number(pending.quantidade) || 1,
          valorTotal: Number(pending.valorTotal) || 0,
          valorUnitario: Number(pending.valorUnitario) || 0,
          participantes: pending.participantes || [],
          statusPagamento: novoStatus,
          mercadoPagoPreferenceId: pending.preferenceId || "",
          mercadoPagoPaymentId: String(paymentId),
          mercadoPagoStatusDetail: payment.status_detail || "",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Marca o pending_checkout como consumido (não apaga — útil pra auditoria)
        tx.update(pendingRef, {
          status: "consumido",
          consumedAt: admin.firestore.FieldValue.serverTimestamp(),
          mercadoPagoPaymentId: String(paymentId)
        });
      } else {
        // Nem registration nem pending_checkout existe — registra log e sai
        return { skipped: true, reason: "sem pending_checkout nem registration" };
      }

      // === CONTADORES DO EVENTO ===
      const camisetasPorTamanho = computeCamisetasPorTamanho(registrationData.participantes);
      const qtd = Number(registrationData.quantidade) || 1;

      if (novoStatus === "pago" && statusAnterior !== "pago" && evSnap && evSnap.exists) {
        const ev = evSnap.data();
        const vendidos = Number(ev.ingressosVendidos) || 0;
        const vendidoCam = Object.assign({}, ev.vendidoCamisetas || {});
        Object.entries(camisetasPorTamanho).forEach(([sz, n]) => {
          vendidoCam[sz] = (Number(vendidoCam[sz]) || 0) + n;
        });
        tx.update(evRef, {
          ingressosVendidos: vendidos + qtd,
          vendidoCamisetas: vendidoCam,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      const isEstornoReal = statusAnterior === "pago" && novoStatus === "cancelado";
      if (isEstornoReal && evSnap && evSnap.exists) {
        const ev = evSnap.data();
        const vendidos = Number(ev.ingressosVendidos) || 0;
        const vendidoCam = Object.assign({}, ev.vendidoCamisetas || {});
        Object.entries(camisetasPorTamanho).forEach(([sz, n]) => {
          vendidoCam[sz] = Math.max(0, (Number(vendidoCam[sz]) || 0) - n);
        });
        tx.update(evRef, {
          ingressosVendidos: Math.max(0, vendidos - qtd),
          vendidoCamisetas: vendidoCam,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      return { acao, statusAnterior, novoStatus };
    });

    // Log em /payments (fora da transação — não precisa ser atômico com o resto)
    const logDocId = `${paymentId}_${mpStatus || "unknown"}`;
    await db.collection("payments").doc(logDocId).set({
      registrationId: externalRef,
      paymentId: String(paymentId),
      mpStatus,
      mpStatusDetail: payment.status_detail || "",
      novoStatus,
      valor: payment.transaction_amount || 0,
      metodo: payment.payment_method_id || "",
      tipo: payment.payment_type_id || "",
      payerEmail: (payment.payer && payment.payer.email) || "",
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      rawPaymentDateApproved: payment.date_approved || null,
      acao: (result && result.acao) || null
    }, { merge: true });

    res.status(200).json({ ok: true, status: novoStatus, result });
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.status(200).json({ ok: false, error: err.message });
  }
};

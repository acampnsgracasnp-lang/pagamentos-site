/* ============================================================
   /api/webhook-mercadopago.js
   ------------------------------------------------------------
   Vercel Function (Node.js runtime).

   Recebe notificações do Mercado Pago (Webhooks/IPN), busca o
   pagamento detalhado e atualiza no Firestore:
     - registrations.statusPagamento
     - registrations.mercadoPagoPaymentId
     - events.ingressosVendidos  (apenas quando aprovado, dentro de transação)
     - payments  (log do evento)

   VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS:
     - MERCADO_PAGO_ACCESS_TOKEN
     - FIREBASE_SERVICE_ACCOUNT
         JSON do service account COMO STRING (uma única linha,
         use JSON.stringify ao colar).
         Obtenha em: Console Firebase → Configurações do projeto →
         Contas de serviço → Gerar nova chave privada.
     - FIREBASE_PROJECT_ID
         (opcional se já estiver no service account)

   DEPENDÊNCIAS (package.json no diretório do projeto Vercel):
     {
       "dependencies": {
         "firebase-admin": "^12.0.0"
       }
     }

   ENDPOINT NO MP:
     Configure este URL no painel do Mercado Pago em
       "Suas integrações" → "Webhooks" → "Eventos: Pagamentos"
     URL: https://SEU-PROJETO.vercel.app/api/webhook-mercadopago
   ============================================================ */

const admin = require("firebase-admin");

// Inicializa Firebase Admin apenas uma vez (cold start)
function initFirebase() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT não configurado.");
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT precisa ser JSON válido em uma única linha.");
  }
  // Corrige \n em private_key quando colado como string
  if (serviceAccount.private_key && serviceAccount.private_key.includes("\\n")) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
  });
}

module.exports = async function handler(req, res) {
  // O MP envia POST. Aceitamos também GET para validação manual.
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).end("Método não permitido");
    return;
  }

  const ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!ACCESS_TOKEN) {
    res.status(500).json({ error: "MERCADO_PAGO_ACCESS_TOKEN não configurado." });
    return;
  }

  // -------- Identificar o paymentId --------
  // MP envia o ID por várias formas dependendo do tipo de notificação.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const query = req.query || {};

  const type = body.type || query.type || query.topic;
  let paymentId =
    (body.data && (body.data.id || body.data["id"])) ||
    query["data.id"] ||
    query.id ||
    body.id ||
    null;

  // Somente notificações de pagamento nos interessam
  const isPaymentTopic =
    type === "payment" ||
    query.topic === "payment" ||
    (typeof type === "string" && type.includes("payment"));

  if (!isPaymentTopic || !paymentId) {
    // Responder 200 para o MP não reenviar essa notificação
    res.status(200).json({ ok: true, ignored: true, type, paymentId });
    return;
  }

  try {
    initFirebase();
    const db = admin.firestore();

    // -------- Consultar o pagamento no MP --------
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` }
    });
    if (!mpResp.ok) {
      const t = await mpResp.text();
      console.error("Falha ao consultar pagamento:", mpResp.status, t);
      // Retornamos 200 para o MP NÃO reenviar infinitamente, mas logamos
      res.status(200).json({ ok: false, error: "Falha ao buscar pagamento.", status: mpResp.status });
      return;
    }
    const payment = await mpResp.json();

    // external_reference foi setado como registrationId em criar-preferencia.js
    const registrationId =
      payment.external_reference ||
      (payment.metadata && payment.metadata.registration_id) ||
      (payment.metadata && payment.metadata.registrationId);

    if (!registrationId) {
      console.warn("Pagamento sem registrationId associado:", paymentId);
      res.status(200).json({ ok: true, warning: "sem registrationId" });
      return;
    }

    // Mapear status MP → nosso status
    const mpStatus = payment.status; // approved, pending, in_process, rejected, cancelled, refunded, charged_back
    const novoStatus = mapStatus(mpStatus);

    // -------- Atualiza no Firestore --------
    const externalReference = registrationId;
    const regRef = db.collection("registrations").doc(externalReference);
    const pendingRef = db.collection("pending_checkouts").doc(externalReference);
    const eventoIdFromPayment = (payment.metadata && (payment.metadata.event_id || payment.metadata.eventId)) || null;

    await db.runTransaction(async (tx) => {
      const regSnap = await tx.get(regRef);
      let pendingSnap = null;
      let reg = null;
      let criandoAPartirDoPending = false;

      if (regSnap.exists) {
        reg = regSnap.data();
      } else {
        // No fluxo Pix direto, o /api/criar-pix salva primeiro em
        // pending_checkouts e usa esse ID como external_reference. Quando o
        // Mercado Pago confirma, este webhook cria a inscrição final em
        // registrations sem perder nenhum campo dos participantes.
        pendingSnap = await tx.get(pendingRef);
        if (!pendingSnap.exists) {
          console.warn("Registration/pending_checkout não encontrado:", externalReference);
          return;
        }
        const pending = pendingSnap.data() || {};
        reg = {
          eventId: pending.eventId || eventoIdFromPayment || "",
          eventSlug: pending.eventSlug || "",
          eventNome: pending.eventNome || "",
          quantidade: Number(pending.quantidade) || (Array.isArray(pending.participantes) ? pending.participantes.length : 1) || 1,
          valorTotal: Number(pending.valorTotal) || Number(payment.transaction_amount) || 0,
          valorUnitario: Number(pending.valorUnitario) || 0,
          precoCamiseta: Number(pending.precoCamiseta) || 0,
          comCamiseta: Number(pending.comCamiseta) || 0,
          participantes: Array.isArray(pending.participantes) ? pending.participantes : [],
          metodo: pending.metodo || payment.payment_method_id || "",
          mercadoPagoPreferenceId: pending.preferenceId || "",
          pendingCheckoutId: externalReference,
          createdAt: pending.createdAt || admin.firestore.FieldValue.serverTimestamp(),
          createdFromPendingCheckout: true
        };
        criandoAPartirDoPending = true;
      }

      const statusAnterior = reg.statusPagamento || "pendente";
      const isEstornoReal = statusAnterior === "pago" && novoStatus === "cancelado";
      const statusFinal = (statusAnterior === "pago" && novoStatus !== "pago" && !isEstornoReal)
        ? "pago"
        : novoStatus;

      const eventId = reg.eventId || eventoIdFromPayment;
      const evRef = eventId ? db.collection("events").doc(eventId) : null;
      const evSnap = evRef ? await tx.get(evRef) : null;

      // Calcula quantas camisetas por tamanho esta inscrição consumiu.
      const camisetasPorTamanho = {};
      (reg.participantes || []).forEach(p => {
        const sz = p && p.tamanhoCamiseta;
        if (sz && !/n[ãa]o\s*dese/i.test(String(sz))) {
          camisetasPorTamanho[sz] = (camisetasPorTamanho[sz] || 0) + 1;
        }
      });

      const dadosPagamento = {
        statusPagamento: statusFinal,
        mercadoPagoPaymentId: String(paymentId),
        mercadoPagoStatusDetail: payment.status_detail || "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (criandoAPartirDoPending) {
        tx.set(regRef, {
          ...reg,
          eventId: eventId || "",
          statusPagamento: statusFinal,
          mercadoPagoPaymentId: String(paymentId),
          mercadoPagoStatusDetail: payment.status_detail || "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        tx.update(pendingRef, {
          status: statusFinal,
          statusPagamento: statusFinal,
          mercadoPagoPaymentId: String(paymentId),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        tx.update(regRef, dadosPagamento);
      }

      // Se mudou para PAGO, incrementa ingressosVendidos + vendidoCamisetas.
      if (statusFinal === "pago" && statusAnterior !== "pago" && evRef && evSnap && evSnap.exists) {
        const ev = evSnap.data();
        const vendidos = Number(ev.ingressosVendidos) || 0;
        const qtd = Number(reg.quantidade) || 1;
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

      // Se houve estorno real, decrementa vagas/camisetas.
      if (isEstornoReal && evRef && evSnap && evSnap.exists) {
        const ev = evSnap.data();
        const vendidos = Number(ev.ingressosVendidos) || 0;
        const qtd = Number(reg.quantidade) || 1;
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
    });

    // -------- Log em /payments --------
    // Doc ID determinístico: re-deliveries do MESMO estado não duplicam log.
    // Mudanças de estado (pending → approved) geram docs distintos.
    const logDocId = `${paymentId}_${mpStatus || "unknown"}`;
    await db.collection("payments").doc(logDocId).set({
      registrationId,
      paymentId: String(paymentId),
      mpStatus,
      mpStatusDetail: payment.status_detail || "",
      novoStatus,
      valor: payment.transaction_amount || 0,
      metodo: payment.payment_method_id || "",
      tipo: payment.payment_type_id || "",
      payerEmail: (payment.payer && payment.payer.email) || "",
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      rawPaymentDateApproved: payment.date_approved || null
    }, { merge: true });

    res.status(200).json({ ok: true, status: novoStatus });
  } catch (err) {
    console.error("Erro no webhook:", err);
    // Responder 200 evita reentregas infinitas. Você ainda verá nos logs da Vercel.
    res.status(200).json({ ok: false, error: err.message });
  }
};

function mapStatus(mpStatus) {
  switch (mpStatus) {
    case "approved":
      return "pago";
    case "pending":
    case "in_process":
    case "authorized":
      return "pendente";
    case "rejected":
      return "recusado";
    case "cancelled":
    case "refunded":
    case "charged_back":
      return "cancelado";
    default:
      return "pendente";
  }
}

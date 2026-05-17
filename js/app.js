/* ============================================================
   APP.JS — Página pública de inscrição (index.html)
   ------------------------------------------------------------
   - Carrega o evento pelo slug da URL (?evento=slug).
   - Se não houver slug, carrega o primeiro evento ativo.
   - Renderiza formulário dinâmico por quantidade.
   - Valida vagas, cria registration no Firestore.
   - Chama a API /api/criar-preferencia e redireciona pro MP.
   ============================================================ */

(function () {
  "use strict";

  const { db, apiBaseUrl } = window.__FB || {};

  if (!db) {
    showError("Firebase não foi configurado. Cole as credenciais em js/firebase-config.js.");
    return;
  }

  // -------------------------- ESTADO --------------------------
  const state = {
    event: null,
    eventId: null,
    quantity: 1,
    maxQuantity: 10 // limite por inscrição (frontend); validação final usa vagasRestantes
  };

  // -------------------------- HELPERS -------------------------
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  function formatBRL(value) {
    const n = Number(value) || 0;
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatDate(dateStr) {
    if (!dateStr) return "—";
    // aceita yyyy-mm-dd ou ISO
    try {
      const d = new Date(dateStr.includes("T") ? dateStr : dateStr + "T12:00:00");
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("pt-BR", {
        day: "2-digit", month: "long", year: "numeric"
      });
    } catch { return dateStr; }
  }

  function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function showError(msg) {
    $("#loading-state").classList.add("hidden");
    $("#event-state").classList.add("hidden");
    $("#error-state").classList.remove("hidden");
    $("#error-message").textContent = msg;
  }

  function blockEvent(msg) {
    $("#event-blocked").textContent = msg;
    $("#event-blocked").classList.remove("hidden");
    $("#registration-form").classList.add("hidden");
  }

  // ------------------- CARREGAR EVENTO ------------------------
  async function loadEvent() {
    const slug = getQueryParam("evento");

    try {
      let docRef = null;
      let eventData = null;
      let eventId = null;

      if (slug) {
        const snap = await db.collection("events")
          .where("slug", "==", slug)
          .limit(1)
          .get();

        if (snap.empty) {
          showError(`Nenhum evento encontrado para "${slug}".`);
          return;
        }
        docRef = snap.docs[0];
      } else {
        const snap = await db.collection("events")
          .where("ativo", "==", true)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();

        if (snap.empty) {
          showError("Nenhum evento ativo no momento. Use o link completo do evento.");
          return;
        }
        docRef = snap.docs[0];
      }

      eventData = docRef.data();
      eventId = docRef.id;

      state.event = eventData;
      state.eventId = eventId;

      renderEvent();
    } catch (err) {
      console.error("Erro ao carregar evento:", err);
      showError("Erro ao carregar evento. Verifique sua conexão e as regras do Firestore.");
    }
  }

  // ------------------- RENDERIZAR EVENTO ----------------------
  function renderEvent() {
    const ev = state.event;
    $("#loading-state").classList.add("hidden");
    $("#event-state").classList.remove("hidden");

    document.title = `Inscrição — ${ev.nome || "Evento"}`;

    $("#event-name").textContent = ev.nome || "Evento";
    $("#event-subtitle").textContent = ev.local ? ev.local : "";
    $("#event-date").textContent = formatDate(ev.dataEvento);
    $("#event-location").textContent = ev.local || "—";
    $("#event-price").textContent = formatBRL(ev.valor);

    const vendidos = Number(ev.ingressosVendidos) || 0;
    const limite = Number(ev.limiteIngressos) || 0;
    const restantes = Math.max(0, limite - vendidos);
    $("#event-remaining").textContent = limite > 0 ? `${restantes} de ${limite}` : "—";

    if (ev.bannerUrl) {
      const img = $("#event-banner-img");
      img.src = ev.bannerUrl;
      img.style.display = "block";
    }

    if (ev.descricao) {
      $("#event-description").textContent = ev.descricao;
    } else {
      $("#event-description-card").classList.add("hidden");
    }

    // Bloqueios
    if (!ev.ativo) {
      blockEvent("As inscrições para este evento estão encerradas.");
      return;
    }
    if (limite > 0 && vendidos >= limite) {
      blockEvent("As inscrições estão ESGOTADAS. Não há mais vagas disponíveis.");
      return;
    }

    // Configura max
    state.maxQuantity = Math.min(10, Math.max(1, restantes || 1));
    $("#qty-hint").textContent = restantes > 0
      ? `Restam ${restantes} vagas neste evento.`
      : "";

    renderParticipants();
    updateTotal();
    bindFormEvents();
  }

  // ------------------- PARTICIPANTES --------------------------
  function renderParticipants() {
    const container = $("#participants-container");
    const ev = state.event;
    const exigeCamiseta = !!ev.exigeCamiseta;
    const tamanhos = Array.isArray(ev.tamanhosCamiseta) && ev.tamanhosCamiseta.length
      ? ev.tamanhosCamiseta
      : ["PP", "P", "M", "G", "GG", "XG"];

    // Preservar valores já preenchidos
    const oldData = collectParticipants();

    container.innerHTML = "";

    for (let i = 0; i < state.quantity; i++) {
      const old = oldData[i] || {};
      const block = document.createElement("div");
      block.className = "participant-block";
      block.setAttribute("data-index", i);

      block.innerHTML = `
        <div class="participant-header">
          <div class="participant-number">${i + 1}</div>
          <div class="participant-title">Participante ${i + 1}</div>
        </div>

        <div class="form-group">
          <label>Nome completo <span class="required">*</span></label>
          <input type="text" name="nome" required value="${escapeAttr(old.nome)}">
          <div class="field-error">Informe o nome completo.</div>
        </div>

        ${i === 0 ? `
        <div class="form-group">
          <label>E-mail <span class="required">*</span></label>
          <input type="email" name="email" required placeholder="seu@email.com" value="${escapeAttr(old.email)}">
          <div class="field-error">Informe um e-mail válido.</div>
        </div>
        ` : ""}

        <div class="form-row">
          <div class="form-group">
            <label>Telefone com DDD <span class="required">*</span></label>
            <input type="tel" name="telefone" required placeholder="(11) 99999-0000" value="${escapeAttr(old.telefone)}">
            <div class="field-error">Informe um telefone válido.</div>
          </div>
          <div class="form-group">
            <label>Cidade</label>
            <input type="text" name="cidade" value="${escapeAttr(old.cidade)}">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Comunidade / paróquia</label>
            <input type="text" name="comunidade" value="${escapeAttr(old.comunidade)}">
          </div>
          <div class="form-group">
            <label>Pastoral / movimento</label>
            <input type="text" name="pastoral" value="${escapeAttr(old.pastoral)}">
          </div>
        </div>

        <div class="form-group">
          <label>Endereço</label>
          <input type="text" name="endereco" value="${escapeAttr(old.endereco)}">
        </div>

        ${exigeCamiseta ? `
          <div class="camiseta-section ${old.desejaCamiseta ? "show-tamanho" : ""}">
            <label>Deseja camiseta? <span class="required">*</span></label>
            <div class="radio-group" data-radio="camiseta-${i}">
              <label class="radio-option ${old.desejaCamiseta === true ? "checked" : ""}">
                <input type="radio" name="desejaCamiseta-${i}" value="sim" ${old.desejaCamiseta === true ? "checked" : ""} required>
                <span>Sim, desejo</span>
              </label>
              <label class="radio-option ${old.desejaCamiseta === false ? "checked" : ""}">
                <input type="radio" name="desejaCamiseta-${i}" value="nao" ${old.desejaCamiseta === false ? "checked" : ""}>
                <span>Não desejo</span>
              </label>
            </div>
            <div class="tamanho-wrapper">
              <label>Tamanho da camiseta <span class="required">*</span></label>
              <select name="tamanhoCamiseta">
                <option value="">Selecione...</option>
                ${tamanhos.map(t => `<option value="${t}" ${old.tamanhoCamiseta === t ? "selected" : ""}>${t}</option>`).join("")}
              </select>
              <div class="field-error">Selecione o tamanho.</div>
            </div>
          </div>
        ` : ""}
      `;
      container.appendChild(block);
    }

    // Eventos dos radios de camiseta
    $$(".camiseta-section").forEach(section => {
      const radios = section.querySelectorAll('input[type="radio"]');
      radios.forEach(r => {
        r.addEventListener("change", () => {
          // toggle checked classes
          section.querySelectorAll(".radio-option").forEach(opt => opt.classList.remove("checked"));
          const opt = r.closest(".radio-option");
          if (opt) opt.classList.add("checked");

          if (r.value === "sim" && r.checked) {
            section.classList.add("show-tamanho");
          } else if (r.value === "nao" && r.checked) {
            section.classList.remove("show-tamanho");
            const sel = section.querySelector('select[name="tamanhoCamiseta"]');
            if (sel) sel.value = "";
          }
        });
      });
    });
  }

  function escapeAttr(v) {
    if (v === undefined || v === null) return "";
    return String(v).replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function collectParticipants() {
    const blocks = $$(".participant-block");
    return blocks.map(b => {
      const get = (n) => {
        const el = b.querySelector(`[name="${n}"]`);
        return el ? el.value.trim() : "";
      };
      const i = b.getAttribute("data-index");
      const desejaRadio = b.querySelector(`input[name="desejaCamiseta-${i}"]:checked`);
      let desejaCamiseta = null;
      if (desejaRadio) desejaCamiseta = desejaRadio.value === "sim";
      return {
        nome: get("nome"),
        email: get("email"),
        telefone: get("telefone"),
        comunidade: get("comunidade"),
        pastoral: get("pastoral"),
        endereco: get("endereco"),
        cidade: get("cidade"),
        desejaCamiseta: desejaCamiseta,
        tamanhoCamiseta: get("tamanhoCamiseta")
      };
    });
  }

  // ------------------- TOTAL ----------------------------------
  function updateTotal() {
    const valor = Number(state.event?.valor) || 0;
    const qty = state.quantity;
    const total = valor * qty;
    $("#total-value").textContent = formatBRL(total);
    $("#total-breakdown").textContent = `${qty} × ${formatBRL(valor)}`;
    $("#qty-value").textContent = qty;
    $("#qty-minus").disabled = qty <= 1;
    $("#qty-plus").disabled = qty >= state.maxQuantity;
  }

  // ------------------- VALIDAÇÃO ------------------------------
  function validateParticipants() {
    let valid = true;
    let firstInvalid = null;
    const participantes = collectParticipants();
    const exigeCamiseta = !!state.event.exigeCamiseta;

    $$(".participant-block").forEach((b, idx) => {
      const p = participantes[idx];

      // limpa erros anteriores
      b.querySelectorAll(".field-error").forEach(e => e.classList.remove("show"));
      b.querySelectorAll(".invalid").forEach(e => e.classList.remove("invalid"));

      const nomeEl = b.querySelector('[name="nome"]');
      const telEl = b.querySelector('[name="telefone"]');

      if (!p.nome || p.nome.length < 3) {
        nomeEl.classList.add("invalid");
        nomeEl.nextElementSibling?.classList.add("show");
        valid = false;
        if (!firstInvalid) firstInvalid = nomeEl;
      }

      const telDigits = (p.telefone || "").replace(/\D/g, "");
      if (telDigits.length < 10) {
        telEl.classList.add("invalid");
        telEl.nextElementSibling?.classList.add("show");
        valid = false;
        if (!firstInvalid) firstInvalid = telEl;
      }

      if (idx === 0) {
        const emailEl = b.querySelector('[name="email"]');
        const emailVal = (p.email || "").trim();
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal);
        if (emailEl && !emailOk) {
          emailEl.classList.add("invalid");
          emailEl.nextElementSibling?.classList.add("show");
          valid = false;
          if (!firstInvalid) firstInvalid = emailEl;
        }
      }

      if (exigeCamiseta) {
        if (p.desejaCamiseta === null) {
          valid = false;
          if (!firstInvalid) firstInvalid = b.querySelector('input[type="radio"]');
        } else if (p.desejaCamiseta === true && !p.tamanhoCamiseta) {
          const sel = b.querySelector('select[name="tamanhoCamiseta"]');
          if (sel) {
            sel.classList.add("invalid");
            sel.parentElement.querySelector(".field-error")?.classList.add("show");
          }
          valid = false;
          if (!firstInvalid) firstInvalid = sel;
        }
      }
    });

    if (firstInvalid) {
      firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    return { valid, participantes };
  }

  // ------------------- SUBMIT (criar inscrição + MP) ----------
  async function handleSubmit(e) {
    e.preventDefault();
    const btn = $("#btn-submit");
    const btnText = $("#btn-submit-text");

    // Re-checa vagas em tempo real
    let ev;
    try {
      const fresh = await db.collection("events").doc(state.eventId).get();
      if (!fresh.exists) {
        showError("Evento não encontrado.");
        return;
      }
      ev = fresh.data();
      state.event = ev;
    } catch (err) {
      console.error(err);
      alert("Erro ao validar vagas. Tente novamente.");
      return;
    }

    if (!ev.ativo) {
      blockEvent("As inscrições para este evento estão encerradas.");
      return;
    }
    const limite = Number(ev.limiteIngressos) || 0;
    const vendidos = Number(ev.ingressosVendidos) || 0;
    const restantes = Math.max(0, limite - vendidos);
    if (limite > 0 && state.quantity > restantes) {
      alert(`Restam apenas ${restantes} vagas. Reduza a quantidade.`);
      $("#event-remaining").textContent = `${restantes} de ${limite}`;
      return;
    }

    const { valid, participantes } = validateParticipants();
    if (!valid) return;

    btn.disabled = true;
    btnText.innerHTML = '<span class="spinner spinner-sm" style="border-top-color:#fff;border-color:rgba(255,255,255,0.4)"></span> Processando...';

    try {
      const valorTotal = (Number(ev.valor) || 0) * state.quantity;

      // IMPORTANTE: NÃO salvamos nada no Firestore aqui. A inscrição
      // definitiva é criada pelo webhook quando o Mercado Pago confirma
      // o pagamento. Aqui só enviamos os dados pro backend criar a
      // preferência e redirecionamos pro checkout.
      const apiUrl = (apiBaseUrl ? apiBaseUrl.replace(/\/$/, "") : "") + "/api/criar-preferencia";

      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: state.eventId,
          eventSlug: ev.slug || "",
          eventNome: ev.nome || "",
          quantidade: state.quantity,
          valorTotal: valorTotal,
          valorUnitario: Number(ev.valor) || 0,
          participantes: participantes,
          titulo: `Inscrição — ${ev.nome || "Evento"}`,
          descricao: `${state.quantity} inscrição(ões)`,
          payer: {
            name: participantes[0]?.nome || "",
            email: participantes[0]?.email || "",
            phone: participantes[0]?.telefone || ""
          }
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error("Falha ao criar preferência: " + errText);
      }
      const data = await resp.json();

      if (!data.init_point && !data.sandbox_init_point) {
        throw new Error("API não retornou link de pagamento.");
      }

      window.location.href = data.init_point || data.sandbox_init_point;
    } catch (err) {
      console.error(err);
      alert("Erro ao iniciar pagamento. Tente novamente em instantes.\n\n" + (err.message || ""));
      btn.disabled = false;
      btnText.textContent = "Continuar para pagamento";
    }
  }

  // ------------------- EVENTOS DO FORM ------------------------
  function bindFormEvents() {
    $("#qty-minus").addEventListener("click", () => {
      if (state.quantity > 1) {
        state.quantity--;
        renderParticipants();
        updateTotal();
      }
    });
    $("#qty-plus").addEventListener("click", () => {
      if (state.quantity < state.maxQuantity) {
        state.quantity++;
        renderParticipants();
        updateTotal();
      }
    });
    $("#registration-form").addEventListener("submit", handleSubmit);
  }

  // ------------------- INIT -----------------------------------
  document.addEventListener("DOMContentLoaded", loadEvent);
})();

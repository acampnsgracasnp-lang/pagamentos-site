/* ============================================================
   ADMIN.JS — Painel administrativo (admin.html)
   ------------------------------------------------------------
   Funcionalidades:
   - Login simples (senha local — trocar por Firebase Auth)
   - Cards de resumo (total/ativos/inscritos/receita/vagas)
   - CRUD de eventos
   - Lista de inscritos com filtros + estatísticas + CSV
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     LOGIN SIMPLES (TROCAR EM PRODUÇÃO POR FIREBASE AUTH)
     ------------------------------------------------------------
     IMPORTANTE: senha no frontend é apenas para testes.
     Em produção: Firebase Authentication + regras no Firestore.
     ============================================================ */
  const ADMIN_PASSWORD = "admin123"; // <-- TROQUE ESTA SENHA
  const SESSION_KEY = "__admin_session_v1";

  const { db } = window.__FB || {};
  if (!db) {
    alert("Firebase não foi configurado. Cole as credenciais em js/firebase-config.js.");
    return;
  }

  // -------------------------- HELPERS --------------------------
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.from(document.querySelectorAll(s)); }

  function formatBRL(v) {
    const n = Number(v) || 0;
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  function formatBRLCompact(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 1000) {
      return "R$ " + (n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k";
    }
    return formatBRL(n);
  }

  function formatDate(dateStr) {
    if (!dateStr) return "—";
    try {
      const d = new Date(dateStr.includes && dateStr.includes("T") ? dateStr : dateStr + "T12:00:00");
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("pt-BR");
    } catch { return dateStr; }
  }
  function formatTimestamp(ts) {
    try {
      if (!ts) return "—";
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    } catch { return "—"; }
  }

  function slugify(s) {
    return (s || "")
      .toString()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  }

  function escapeHTML(s) {
    return (s == null ? "" : String(s))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function badgeStatus(status) {
    const map = {
      pago: "badge-success",
      pendente: "badge-warning",
      recusado: "badge-danger",
      cancelado: "badge-muted"
    };
    const label = { pago: "Pago", pendente: "Pendente", recusado: "Recusado", cancelado: "Cancelado" };
    return `<span class="badge ${map[status] || "badge-muted"}">${label[status] || status || "—"}</span>`;
  }

  // Mini-ícones SVG inline
  const ICONS = {
    calendar: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    pin: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    tag: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.59 13.41 13.41 20.59a2 2 0 0 1-2.82 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    link: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    edit: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    pause: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    play: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    users: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
    eye: '<svg class="icon-inline" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  };

  // -------------------------- LOGIN ---------------------------
  function isLoggedIn() {
    try { return sessionStorage.getItem(SESSION_KEY) === "ok"; } catch { return false; }
  }
  function login(pw) {
    if (pw === ADMIN_PASSWORD) {
      try { sessionStorage.setItem(SESSION_KEY, "ok"); } catch {}
      return true;
    }
    return false;
  }
  function logout() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    location.reload();
  }
  function bindLogin() {
    $("#login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const pw = $("#login-password").value;
      if (login(pw)) showAdmin();
      else alert("Senha incorreta.");
    });
    $("#btn-logout").addEventListener("click", logout);
  }

  function showAdmin() {
    $("#login-screen").classList.add("hidden");
    $("#admin-screen").classList.remove("hidden");
    bindTabs();
    bindEventModal();
    bindRegistrations();
    loadEvents();
  }

  // -------------------------- TABS ----------------------------
  function bindTabs() {
    $$(".tab").forEach(t => {
      t.addEventListener("click", () => {
        $$(".tab").forEach(x => { x.classList.remove("active"); x.setAttribute("aria-selected","false"); });
        $$(".tab-content").forEach(x => x.classList.remove("active"));
        t.classList.add("active");
        t.setAttribute("aria-selected", "true");
        const target = "tab-" + t.getAttribute("data-tab");
        document.getElementById(target).classList.add("active");

        if (t.getAttribute("data-tab") === "registrations") {
          populateEventFilter();
        }
      });
    });
  }

  // -------------------------- EVENTOS -------------------------
  let currentEvents = [];

  async function loadEvents() {
    $("#events-loading").classList.remove("hidden");
    $("#events-empty").classList.add("hidden");
    $("#events-list").innerHTML = "";

    try {
      const snap = await db.collection("events").orderBy("createdAt", "desc").get();
      currentEvents = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      $("#events-loading").classList.add("hidden");
      updateSummaryStats();

      if (!currentEvents.length) {
        $("#events-empty").classList.remove("hidden");
        return;
      }

      const list = $("#events-list");
      currentEvents.forEach(ev => {
        const limite = Number(ev.limiteIngressos) || 0;
        const vendidos = Number(ev.ingressosVendidos) || 0;
        const restantes = Math.max(0, limite - vendidos);
        const percent = limite > 0 ? Math.min(100, Math.round((vendidos / limite) * 100)) : 0;
        const esgotado = limite > 0 && vendidos >= limite;

        const statusBadge = !ev.ativo
          ? '<span class="badge badge-muted">Pausado</span>'
          : esgotado
            ? '<span class="badge badge-danger">Esgotado</span>'
            : '<span class="badge badge-success">Ativo</span>';

        const card = document.createElement("div");
        card.className = "event-card";
        card.innerHTML = `
          <div class="ev-head">
            <div style="min-width:0">
              <div class="ev-title">${escapeHTML(ev.nome || "Sem nome")}</div>
              <span class="slug">?evento=${escapeHTML(ev.slug || "")}</span>
            </div>
            ${statusBadge}
          </div>

          <div class="meta-line">
            <span>${ICONS.calendar}${ev.dataEvento ? escapeHTML(formatDate(ev.dataEvento)) : "Sem data"}</span>
            <span>${ICONS.pin}${ev.local ? escapeHTML(ev.local) : "Local não definido"}</span>
            <span>${ICONS.tag}${formatBRL(ev.valor)}</span>
          </div>

          <div>
            <div class="progress" aria-label="Progresso de vendas">
              <div class="progress-bar" style="width:${percent}%"></div>
            </div>
            <div class="progress-meta">
              <span>${vendidos} de ${limite || "—"} vendidos</span>
              <span>${percent}%</span>
            </div>
          </div>

          <div class="stats-row">
            <div class="mini-stat">
              <div class="ms-label">Valor</div>
              <div class="ms-value">${formatBRLCompact(ev.valor)}</div>
            </div>
            <div class="mini-stat">
              <div class="ms-label">Vendidos</div>
              <div class="ms-value">${vendidos}</div>
            </div>
            <div class="mini-stat">
              <div class="ms-label">Restam</div>
              <div class="ms-value">${restantes}</div>
            </div>
          </div>

          <div class="card-actions">
            <button class="btn btn-primary btn-sm" data-edit="${ev.id}">${ICONS.edit}<span>Editar</span></button>
            <button class="btn btn-secondary btn-sm" data-toggle="${ev.id}">
              ${ev.ativo ? ICONS.pause : ICONS.play}<span>${ev.ativo ? "Pausar" : "Ativar"}</span>
            </button>
            <button class="btn btn-secondary btn-sm" data-link="${ev.slug || ""}">${ICONS.link}<span>Copiar link</span></button>
            <button class="btn btn-ghost btn-sm" data-regs="${ev.id}">${ICONS.users}<span>Inscritos</span></button>
          </div>
        `;
        list.appendChild(card);
      });

      // bind actions
      list.querySelectorAll("[data-edit]").forEach(b => {
        b.addEventListener("click", () => openEditModal(b.getAttribute("data-edit")));
      });
      list.querySelectorAll("[data-toggle]").forEach(b => {
        b.addEventListener("click", () => toggleEvent(b.getAttribute("data-toggle")));
      });
      list.querySelectorAll("[data-link]").forEach(b => {
        b.addEventListener("click", () => {
          const slug = b.getAttribute("data-link");
          /* URL pública do evento: usa rewrite limpo /mulheres (ou /<slug> se existir uma página dedicada).
             Fallback com ?evento=<slug> aponta para a página padrão de evento.
             A página /mulheres lê o slug por DEFAULT_SLUG e/ou ?evento=<slug>. */
          const url = `${location.origin}/mulheres?evento=${encodeURIComponent(slug)}`;
          try { navigator.clipboard?.writeText(url); } catch {}
          alert("Link copiado:\n" + url);
        });
      });
      list.querySelectorAll("[data-regs]").forEach(b => {
        b.addEventListener("click", () => {
          $$(".tab").forEach(x => { x.classList.remove("active"); x.setAttribute("aria-selected","false"); });
          $$(".tab-content").forEach(x => x.classList.remove("active"));
          const tabBtn = document.querySelector('[data-tab="registrations"]');
          tabBtn.classList.add("active");
          tabBtn.setAttribute("aria-selected","true");
          $("#tab-registrations").classList.add("active");
          populateEventFilter().then(() => {
            $("#filter-event").value = b.getAttribute("data-regs");
            loadRegistrations();
          });
        });
      });
    } catch (err) {
      console.error(err);
      $("#events-loading").classList.add("hidden");
      alert("Erro ao carregar eventos. Verifique as regras do Firestore.");
    }
  }

  // ------------------- SUMMARY STATS --------------------------
  function updateSummaryStats() {
    const totalEventos = currentEvents.length;
    const eventosAtivos = currentEvents.filter(e => e.ativo).length;

    let totalLimite = 0;
    let totalVendidos = 0;
    currentEvents.forEach(e => {
      totalLimite += Number(e.limiteIngressos) || 0;
      totalVendidos += Number(e.ingressosVendidos) || 0;
    });
    const vagasDisponiveis = Math.max(0, totalLimite - totalVendidos);

    $("#admin-stat-events-total").textContent = totalEventos;
    $("#admin-stat-events-hint").textContent = totalEventos === 0
      ? "Nenhum evento criado"
      : `${eventosAtivos} ativo${eventosAtivos === 1 ? "" : "s"}`;
    $("#admin-stat-events-ativos").textContent = eventosAtivos;
    $("#admin-stat-vagas").textContent = vagasDisponiveis;

    $("#tab-count-events").textContent = totalEventos;

    // Inscritos + receita: precisamos consultar registrations
    loadAggregateRegistrations().catch(err => console.warn(err));
  }

  async function loadAggregateRegistrations() {
    // Para evitar chamadas pesadas, fazemos apenas se não foram ainda calculadas
    // e quando há eventos.
    if (!currentEvents.length) {
      $("#admin-stat-inscritos").textContent = 0;
      $("#admin-stat-inscritos-hint").textContent = "Sem eventos";
      $("#admin-stat-receita").textContent = formatBRL(0);
      return;
    }

    try {
      // Limit defensivo — pega até 1000 registrations recentes
      const snap = await db.collection("registrations").limit(1000).get();
      let totalInscricoes = 0;
      let totalParticipantes = 0;
      let receita = 0;
      snap.docs.forEach(d => {
        const r = d.data();
        totalInscricoes++;
        totalParticipantes += Number(r.quantidade) || 1;
        if (r.statusPagamento === "pago") {
          receita += Number(r.valorTotal) || 0;
        }
      });
      $("#admin-stat-inscritos").textContent = totalParticipantes;
      $("#admin-stat-inscritos-hint").textContent =
        `${totalInscricoes} inscrição${totalInscricoes === 1 ? "" : "s"} no total`;
      $("#admin-stat-receita").textContent = formatBRL(receita);
    } catch (err) {
      console.warn("Falha ao agregar registrations:", err);
      $("#admin-stat-inscritos").textContent = "—";
      $("#admin-stat-inscritos-hint").textContent = "Sem permissão de leitura";
      $("#admin-stat-receita").textContent = formatBRL(0);
    }
  }

  async function toggleEvent(id) {
    const ev = currentEvents.find(e => e.id === id);
    if (!ev) return;
    try {
      await db.collection("events").doc(id).update({
        ativo: !ev.ativo,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      loadEvents();
    } catch (err) {
      alert("Erro ao atualizar: " + err.message);
    }
  }

  // ------------------- MODAL EVENTO ---------------------------
  function bindEventModal() {
    $("#btn-new-event").addEventListener("click", () => openEditModal(null));
    const btnNew2 = document.getElementById("btn-new-event-2");
    if (btnNew2) btnNew2.addEventListener("click", () => openEditModal(null));

    $("#ev-nome").addEventListener("input", (e) => {
      const slugField = $("#ev-slug");
      if (!slugField.value || slugField.dataset.auto === "1") {
        slugField.value = slugify(e.target.value);
        slugField.dataset.auto = "1";
      }
      $("#slug-preview").textContent = slugField.value || "slug";
    });
    $("#ev-slug").addEventListener("input", (e) => {
      e.target.value = slugify(e.target.value);
      e.target.dataset.auto = "0";
      $("#slug-preview").textContent = e.target.value || "slug";
    });

    $$("[data-close]").forEach(b => {
      b.addEventListener("click", () => {
        document.getElementById(b.getAttribute("data-close")).classList.remove("show");
      });
    });

    // Fechar ao clicar fora do .modal
    $$(".modal-overlay").forEach(o => {
      o.addEventListener("click", (e) => {
        if (e.target === o) o.classList.remove("show");
      });
    });

    $("#event-form").addEventListener("submit", saveEvent);
  }

  function openEditModal(id) {
    const form = $("#event-form");
    form.reset();
    $("#event-id").value = "";
    $("#ev-slug").dataset.auto = "1";
    $("#slug-preview").textContent = "slug";

    if (id) {
      const ev = currentEvents.find(e => e.id === id);
      if (!ev) return;
      $("#event-modal-title").textContent = "Editar evento";
      $("#event-id").value = id;
      $("#ev-nome").value = ev.nome || "";
      $("#ev-slug").value = ev.slug || "";
      $("#ev-slug").dataset.auto = "0";
      $("#slug-preview").textContent = ev.slug || "slug";
      $("#ev-descricao").value = ev.descricao || "";
      $("#ev-valor").value = ev.valor != null ? ev.valor : "";
      $("#ev-limite").value = ev.limiteIngressos != null ? ev.limiteIngressos : "";
      $("#ev-vendidos").value = ev.ingressosVendidos != null ? ev.ingressosVendidos : 0;
      $("#ev-data").value = ev.dataEvento || "";
      $("#ev-local").value = ev.local || "";
      $("#ev-banner").value = ev.bannerUrl || "";
      $("#ev-ativo").value = String(!!ev.ativo);
      $("#ev-exige-camiseta").value = String(!!ev.exigeCamiseta);
      $("#ev-tamanhos").value = (ev.tamanhosCamiseta || ["PP","P","M","G","GG","XG"]).join(", ");
    } else {
      $("#event-modal-title").textContent = "Novo evento";
      $("#ev-vendidos").value = 0;
      $("#ev-ativo").value = "true";
      $("#ev-exige-camiseta").value = "true";
      $("#ev-tamanhos").value = "PP, P, M, G, GG, XG";
    }

    $("#event-modal").classList.add("show");
  }

  async function saveEvent(e) {
    e.preventDefault();
    const id = $("#event-id").value;
    const slug = slugify($("#ev-slug").value);

    if (!slug) {
      alert("Slug inválido.");
      return;
    }

    try {
      const dupSnap = await db.collection("events").where("slug", "==", slug).get();
      const dup = dupSnap.docs.find(d => d.id !== id);
      if (dup) {
        alert("Este slug já está em uso por outro evento. Escolha outro.");
        return;
      }
    } catch (err) {
      console.warn("Não foi possível verificar duplicidade:", err);
    }

    const tamanhos = $("#ev-tamanhos").value
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    const data = {
      nome: $("#ev-nome").value.trim(),
      slug: slug,
      descricao: $("#ev-descricao").value.trim(),
      valor: Number($("#ev-valor").value) || 0,
      limiteIngressos: Number($("#ev-limite").value) || 0,
      ingressosVendidos: Number($("#ev-vendidos").value) || 0,
      ativo: $("#ev-ativo").value === "true",
      dataEvento: $("#ev-data").value || "",
      local: $("#ev-local").value.trim(),
      bannerUrl: $("#ev-banner").value.trim(),
      exigeCamiseta: $("#ev-exige-camiseta").value === "true",
      tamanhosCamiseta: tamanhos.length ? tamanhos : ["PP","P","M","G","GG","XG"],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
      if (id) {
        await db.collection("events").doc(id).update(data);
      } else {
        data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection("events").add(data);
      }
      $("#event-modal").classList.remove("show");
      loadEvents();
    } catch (err) {
      alert("Erro ao salvar: " + err.message);
    }
  }

  // ------------------- INSCRITOS ------------------------------
  let currentRegs = [];

  async function populateEventFilter() {
    const select = $("#filter-event");
    const currentValue = select.value;
    select.innerHTML = '<option value="">Todos os eventos</option>';
    if (!currentEvents.length) {
      try {
        const snap = await db.collection("events").orderBy("createdAt", "desc").get();
        currentEvents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch {}
    }
    currentEvents.forEach(ev => {
      const opt = document.createElement("option");
      opt.value = ev.id;
      opt.textContent = ev.nome || ev.slug || ev.id;
      select.appendChild(opt);
    });
    if (currentValue) select.value = currentValue;
  }

  function bindRegistrations() {
    $("#btn-load-regs").addEventListener("click", loadRegistrations);
    $("#btn-export-csv").addEventListener("click", exportCSV);
    populateEventFilter();
  }

  async function loadRegistrations() {
    $("#regs-loading").classList.remove("hidden");
    $("#regs-table-wrap").style.display = "none";
    $("#regs-stats").classList.add("hidden");
    const emptyEl = document.getElementById("regs-empty");
    if (emptyEl) emptyEl.classList.add("hidden");

    const eventId = $("#filter-event").value;
    const status = $("#filter-status").value;

    try {
      let q = db.collection("registrations");
      if (eventId) q = q.where("eventId", "==", eventId);
      if (status) q = q.where("statusPagamento", "==", status);
      let snap;
      try {
        snap = await q.orderBy("createdAt", "desc").limit(500).get();
      } catch (err) {
        snap = await q.limit(500).get();
      }
      currentRegs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      renderRegs();
    } catch (err) {
      console.error(err);
      alert("Erro ao carregar inscritos: " + err.message);
      $("#regs-loading").classList.add("hidden");
    }
  }

  function renderRegs() {
    $("#regs-loading").classList.add("hidden");
    const tbody = $("#regs-tbody");
    tbody.innerHTML = "";
    const emptyEl = document.getElementById("regs-empty");

    if (!currentRegs.length) {
      $("#regs-table-wrap").style.display = "none";
      $("#regs-stats").classList.add("hidden");
      if (emptyEl) emptyEl.classList.remove("hidden");
      return;
    }
    if (emptyEl) emptyEl.classList.add("hidden");

    let totalArrecadado = 0;
    let pagos = 0, pendentes = 0;
    currentRegs.forEach(r => {
      if (r.statusPagamento === "pago") {
        pagos++;
        totalArrecadado += Number(r.valorTotal) || 0;
      } else if (r.statusPagamento === "pendente") {
        pendentes++;
      }
    });

    $("#stat-total").textContent = currentRegs.length;
    $("#stat-pagos").textContent = pagos;
    $("#stat-pendentes").textContent = pendentes;
    $("#stat-arrecadado").textContent = formatBRL(totalArrecadado);
    $("#regs-stats").classList.remove("hidden");

    currentRegs.forEach(r => {
      const tr = document.createElement("tr");
      const principal = (r.participantes && r.participantes[0]) || {};
      tr.innerHTML = `
        <td>${formatTimestamp(r.createdAt)}</td>
        <td>${escapeHTML(r.eventNome || r.eventSlug || "—")}</td>
        <td>${escapeHTML(principal.nome || "—")}</td>
        <td>${escapeHTML(principal.telefone || "—")}</td>
        <td>${r.quantidade || 1}</td>
        <td>${formatBRL(r.valorTotal)}</td>
        <td>${badgeStatus(r.statusPagamento)}</td>
        <td><button class="btn btn-secondary btn-xs" data-view="${r.id}">${ICONS.eye}<span>Ver</span></button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("[data-view]").forEach(b => {
      b.addEventListener("click", () => openRegModal(b.getAttribute("data-view")));
    });

    $("#regs-table-wrap").style.display = "block";
  }

  function openRegModal(id) {
    const r = currentRegs.find(x => x.id === id);
    if (!r) return;
    const body = $("#reg-modal-body");

    const participantesHtml = (r.participantes || []).map((p, i) => `
      <div class="participant-block" style="margin-bottom:12px">
        <div class="participant-header">
          <div class="participant-number">${i + 1}</div>
          <div class="participant-title">${escapeHTML(p.nome || "Participante " + (i+1))}</div>
        </div>
        <div style="font-size:14px;line-height:1.7">
          <div><b>Telefone:</b> ${escapeHTML(p.telefone || "—")}</div>
          <div><b>Cidade:</b> ${escapeHTML(p.cidade || "—")}</div>
          <div><b>Comunidade:</b> ${escapeHTML(p.comunidade || "—")}</div>
          <div><b>Pastoral:</b> ${escapeHTML(p.pastoral || "—")}</div>
          <div><b>Endereço:</b> ${escapeHTML(p.endereco || "—")}</div>
          <div><b>Camiseta:</b> ${
            p.desejaCamiseta
              ? "Sim — tamanho " + escapeHTML(p.tamanhoCamiseta || "?")
              : (p.desejaCamiseta === false ? "Não" : "—")
          }</div>
        </div>
      </div>
    `).join("");

    body.innerHTML = `
      <div class="card-section">
        <div class="card-section-title">Resumo</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;line-height:1.7">
          <div><b>Evento:</b><br>${escapeHTML(r.eventNome || r.eventSlug || r.eventId)}</div>
          <div><b>Status:</b><br>${badgeStatus(r.statusPagamento)}</div>
          <div><b>Valor total:</b><br>${formatBRL(r.valorTotal)}</div>
          <div><b>Criado em:</b><br>${formatTimestamp(r.createdAt)}</div>
          <div style="grid-column:1/-1;font-size:12px;color:var(--text-muted);word-break:break-all;border-top:1px dashed var(--border);padding-top:10px;margin-top:4px">
            <div><b>Preference ID:</b> ${escapeHTML(r.mercadoPagoPreferenceId || "—")}</div>
            <div><b>Payment ID:</b> ${escapeHTML(r.mercadoPagoPaymentId || "—")}</div>
            <div><b>Registration ID:</b> <code>${r.id}</code></div>
          </div>
        </div>
      </div>
      <div class="card-section">
        <div class="card-section-title">Participantes (${r.quantidade || 1})</div>
        ${participantesHtml}
      </div>
    `;
    $("#reg-modal").classList.add("show");
  }

  // ------------------- EXPORTAR CSV ---------------------------
  function exportCSV() {
    if (!currentRegs.length) {
      alert("Carregue os inscritos primeiro.");
      return;
    }

    const rows = [[
      "Data", "Evento", "Status", "Valor Total", "Qtd",
      "Nome", "Telefone", "Cidade", "Comunidade", "Pastoral",
      "Endereço", "Camiseta", "Tamanho",
      "PreferenceId", "PaymentId", "RegistrationId"
    ]];

    currentRegs.forEach(r => {
      const evNome = r.eventNome || r.eventSlug || "";
      const created = formatTimestamp(r.createdAt);
      (r.participantes || [{}]).forEach((p, idx) => {
        rows.push([
          idx === 0 ? created : "",
          idx === 0 ? evNome : "",
          idx === 0 ? (r.statusPagamento || "") : "",
          idx === 0 ? String(r.valorTotal ?? "") : "",
          idx === 0 ? String(r.quantidade ?? "") : "",
          p.nome || "",
          p.telefone || "",
          p.cidade || "",
          p.comunidade || "",
          p.pastoral || "",
          p.endereco || "",
          p.desejaCamiseta ? "Sim" : (p.desejaCamiseta === false ? "Não" : ""),
          p.tamanhoCamiseta || "",
          idx === 0 ? (r.mercadoPagoPreferenceId || "") : "",
          idx === 0 ? (r.mercadoPagoPaymentId || "") : "",
          idx === 0 ? r.id : ""
        ]);
      });
    });

    const csv = rows.map(r =>
      r.map(cell => {
        const s = String(cell ?? "").replace(/"/g, '""');
        return /[",;\n]/.test(s) ? `"${s}"` : s;
      }).join(";")
    ).join("\r\n");

    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inscritos_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // -------------------------- INIT ---------------------------
  document.addEventListener("DOMContentLoaded", () => {
    bindLogin();
    if (isLoggedIn()) showAdmin();
  });
})();

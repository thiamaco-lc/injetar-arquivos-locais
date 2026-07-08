$(function () {
  const $container = $("#files-container");

  // Estado em memória. Persistido em chrome.storage.local como:
  //   perfis: { [dominio]: { itens, autoInject, autoReload, intervalo } }
  //   dominioAtual: string   (último domínio editado)
  //   habilitado: boolean    (liga/desliga geral)
  const estado = {
    perfis: {},
    dominio: "", // domínio em edição no popup
    habilitado: true,
  };

  const TIPOS = ["css", "js", "html"];

  // ---------------------------------------------------------------- utils ----
  function gerarId() {
    return (
      (crypto?.randomUUID?.() || "id-" + Math.random().toString(36).slice(2)) +
      Date.now().toString(36)
    );
  }

  function detectarTipo(str) {
    const s = (str || "").split("?")[0].split("#")[0].toLowerCase();
    if (s.endsWith(".css")) return "css";
    if (s.endsWith(".js") || s.endsWith(".mjs")) return "js";
    if (s.endsWith(".html") || s.endsWith(".htm")) return "html";
    return "";
  }

  function itemNovo() {
    return {
      id: gerarId(),
      tipo: "",
      tipoManual: false,
      url: "",
      seletor: "body",
      posicao: "append",
      ativo: true,
    };
  }

  function perfilVazio() {
    return { itens: [], autoInject: true, autoReload: false, intervalo: 1000 };
  }

  // Perfil do domínio atualmente em edição (cria em memória se não existir).
  function P() {
    if (!estado.perfis[estado.dominio]) estado.perfis[estado.dominio] = perfilVazio();
    return estado.perfis[estado.dominio];
  }

  // ------------------------------------------------------- persistência ----
  let salvarTimer = null;
  function salvar(aplicarDepois = true) {
    clearTimeout(salvarTimer);
    salvarTimer = setTimeout(() => {
      // Remove perfis vazios (sem itens) que não sejam o que está em edição.
      Object.keys(estado.perfis).forEach((k) => {
        const p = estado.perfis[k];
        if (k !== estado.dominio && (!p.itens || p.itens.length === 0)) {
          delete estado.perfis[k];
        }
      });
      chrome.storage.local.set({
        perfis: estado.perfis,
        dominioAtual: estado.dominio,
        habilitado: estado.habilitado,
      });
      if (aplicarDepois) aplicar();
    }, 250);
  }

  let aplicarTimer = null;
  function aplicar(feedback = false) {
    clearTimeout(aplicarTimer);
    aplicarTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ action: "aplicar", forcar: true }, (resp) => {
        void chrome.runtime.lastError;
        if (feedback) mostrarStatus(resp);
      });
    }, 200);
  }

  let statusTimer = null;
  function mostrarStatus(resp) {
    const $s = $("#status").removeClass("warn err ok");
    clearTimeout(statusTimer);
    if (resp && resp.ok) {
      $s.addClass("ok").text("✔️ Aplicado nesta aba.");
      statusTimer = setTimeout(() => $s.text("").removeClass("ok"), 2000);
      return;
    }
    const msgs = {
      "sem-dominio": "⚠️ Defina um domínio base para a extensão agir (🎯 usa a aba atual).",
      "fora-dominio": "Esta aba não bate com nenhum domínio configurado — nada foi injetado.",
      "pagina-interna": "Página interna do navegador — não é possível injetar aqui.",
    };
    const motivo = (resp && resp.motivo) || "";
    $s.addClass(motivo === "sem-dominio" ? "warn" : "err").text(
      msgs[motivo] || "Não foi possível aplicar."
    );
  }

  // ------------------------------------------------------------- render ----
  function renderPerfil() {
    const p = P();
    if (p.itens.length === 0) p.itens.push(itemNovo());

    $container.empty();
    p.itens.forEach((item) => {
      const $row = renderLinha(item).data("id", item.id);
      $container.append($row);
    });

    $("#master-toggle").prop("checked", estado.habilitado);
    $("#auto-inject").prop("checked", p.autoInject !== false);
    $("#auto-reload").prop("checked", !!p.autoReload);
    $("#intervalo").val(p.intervalo || 1000);
  }

  function renderLinha(item) {
    const $row = $(`
      <div class="file-row" draggable="true">
        <span class="drag-handle" title="Arraste para reordenar">⠿</span>
        <span class="type-badge" data-tipo="${item.tipo}" title="Clique para trocar o tipo">${
          (item.tipo || "auto").toUpperCase()
        }</span>
        <input type="text" class="file-url"
          placeholder="URL do arquivo (ex: http://localhost:3000/css/style.css)"
          value="${item.url}" />
        <label class="toggle" title="Ativar/desativar esta injeção">
          <input type="checkbox" class="ativo" ${item.ativo ? "checked" : ""}>
          <div class="track"></div>
        </label>
        <button class="icon-btn remove-btn" title="Remover">✕</button>
        <div class="html-opts ${item.tipo === "html" ? "" : "hidden"}">
          <input type="text" class="html-selector" placeholder="Seletor (ex: body, #app, .header)"
            value="${item.seletor || "body"}">
          <label>onde:</label>
          <select class="html-pos">
            <option value="append" ${item.posicao === "append" ? "selected" : ""}>no fim</option>
            <option value="prepend" ${item.posicao === "prepend" ? "selected" : ""}>no início</option>
            <option value="replace" ${item.posicao === "replace" ? "selected" : ""}>substituir</option>
          </select>
        </div>
      </div>
    `);

    const $url = $row.find(".file-url");
    const $badge = $row.find(".type-badge");
    const $htmlOpts = $row.find(".html-opts");

    function atualizarBadge() {
      $badge.attr("data-tipo", item.tipo).text((item.tipo || "auto").toUpperCase());
      $htmlOpts.toggleClass("hidden", item.tipo !== "html");
    }

    $url.on("input", function () {
      item.url = this.value.trim();
      if (!item.tipoManual) {
        item.tipo = detectarTipo(item.url);
        atualizarBadge();
      }
      salvar();
    });

    $badge.on("click", function () {
      const idx = TIPOS.indexOf(item.tipo);
      item.tipo = TIPOS[(idx + 1) % TIPOS.length];
      item.tipoManual = true;
      atualizarBadge();
      salvar();
    });

    $row.find(".ativo").on("change", function () {
      item.ativo = this.checked;
      salvar();
    });

    $row.find(".remove-btn").on("click", () => {
      P().itens = P().itens.filter((i) => i.id !== item.id);
      $row.remove();
      salvar();
    });

    $row.find(".html-selector").on("input", function () {
      item.seletor = this.value.trim() || "body";
      salvar();
    });
    $row.find(".html-pos").on("change", function () {
      item.posicao = this.value;
      salvar();
    });

    return $row;
  }

  // --------------------------------------------------- drag & drop reorder ----
  let $dragging = null;
  $container.on("dragstart", ".file-row", function (e) {
    if ($(e.target).is("input, select, textarea")) {
      e.preventDefault();
      return;
    }
    $dragging = $(this);
    $(this).addClass("dragging");
    e.originalEvent.dataTransfer.effectAllowed = "move";
  });
  $container.on("dragend", ".file-row", function () {
    $(this).removeClass("dragging");
    $dragging = null;
    reordenarEstado();
  });
  $container.on("dragover", ".file-row", function (e) {
    e.preventDefault();
    if (!$dragging || this === $dragging[0]) return;
    const rect = this.getBoundingClientRect();
    const depois = (e.originalEvent.clientY - rect.top) / rect.height > 0.5;
    this.parentNode.insertBefore($dragging[0], depois ? this.nextSibling : this);
  });

  function reordenarEstado() {
    const novos = [];
    $container.find(".file-row").each(function () {
      const it = P().itens.find((i) => i.id === $(this).data("id"));
      if (it) novos.push(it);
    });
    if (novos.length === P().itens.length) {
      P().itens = novos;
      salvar();
    }
  }

  // ----------------------------------------------------- troca de domínio ----
  function trocarDominio(novo) {
    novo = (novo || "").trim();
    if (novo === estado.dominio) return;
    const antigo = estado.dominio;

    // Se estava no "balde sem domínio" e tem itens, leva-os para o novo domínio.
    if (
      antigo === "" &&
      estado.perfis[""] &&
      (estado.perfis[""].itens || []).length &&
      !estado.perfis[novo]
    ) {
      estado.perfis[novo] = estado.perfis[""];
      delete estado.perfis[""];
    }

    estado.dominio = novo;
    if (!estado.perfis[novo]) estado.perfis[novo] = perfilVazio();
    $("#base-domain").val(novo);
    renderPerfil();
    salvar();
  }

  // ---------------------------------------------------------- controles ----
  $("#add").on("click", () => {
    const it = itemNovo();
    P().itens.push(it);
    const $row = renderLinha(it).data("id", it.id);
    $container.append($row);
  });

  $("#apply").on("click", () => aplicar(true));

  $("#master-toggle").on("change", function () {
    estado.habilitado = this.checked;
    salvar();
  });

  $("#auto-inject").on("change", function () {
    P().autoInject = this.checked;
    salvar(false);
  });

  $("#auto-reload").on("change", function () {
    P().autoReload = this.checked;
    salvar();
  });

  $("#intervalo").on("input", function () {
    const v = parseInt(this.value, 10);
    P().intervalo = isNaN(v) || v < 100 ? 1000 : v;
    salvar(false);
  });

  // Trocar o domínio (blur/Enter) carrega o perfil daquele domínio.
  $("#base-domain").on("change", function () {
    trocarDominio(this.value);
  });

  $("#use-tab").on("click", () => {
    origemAbaAtiva((origin) => {
      if (origin) trocarDominio(origin);
    });
  });

  // ----------------------------------------------------------- carregar ----
  function origemAbaAtiva(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      let origin = "";
      try {
        if (tab && tab.url) {
          const u = new URL(tab.url);
          origin = `${u.protocol}//${u.host}`;
        }
      } catch {}
      cb(origin);
    });
  }

  function migrarParaPerfis(r) {
    const perfis = {};
    let itens = Array.isArray(r.itens)
      ? r.itens
      : Array.isArray(r.arquivos)
      ? r.arquivos.map((a) => ({
          ...itemNovo(),
          tipo: a.tipo || detectarTipo(a.url) || "",
          tipoManual: !!a.tipo,
          url: a.url || "",
          ativo: a.ativo !== false,
        }))
      : [];
    if (itens.length) {
      perfis[r.baseDomain || ""] = {
        itens,
        autoInject: r.autoInject !== false,
        autoReload: !!r.autoReload,
        intervalo: Number(r.intervalo) || 1000,
      };
    }
    return perfis;
  }

  chrome.storage.local.get(null, (r) => {
    estado.perfis =
      r.perfis && typeof r.perfis === "object" ? r.perfis : migrarParaPerfis(r);
    estado.habilitado = r.habilitado !== false;

    // Normaliza cada perfil/itens.
    Object.values(estado.perfis).forEach((p) => {
      p.itens = Array.isArray(p.itens) ? p.itens : [];
      if (p.autoInject === undefined) p.autoInject = true;
      p.intervalo = Number(p.intervalo) || 1000;
      p.itens.forEach((i) => {
        if (i.id == null) i.id = gerarId();
        if (i.seletor == null) i.seletor = "body";
        if (i.posicao == null) i.posicao = "append";
      });
    });

    origemAbaAtiva((tabOrigin) => {
      // Mostra o perfil do site atual só se ele já foi configurado.
      // Caso contrário, deixa o domínio vazio para o usuário configurar.
      // (o perfil "" guarda itens adicionados antes de definir um domínio)
      let dominio = "";
      if (tabOrigin && estado.perfis[tabOrigin]) dominio = tabOrigin;
      else if (estado.perfis[""]) dominio = "";
      estado.dominio = dominio;

      $("#base-domain").val(estado.dominio);
      renderPerfil();
      aplicar(true);
    });
  });
});

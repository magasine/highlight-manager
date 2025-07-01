javascript: (() => {
  class HighlightManager {
    constructor() {
      if (window.highlightManagerInstance) {
        window.highlightManagerInstance.destroy();
      }
      window.highlightManagerInstance = this;

      // Permanent method binding
      this.handleMouseUp = this.handleMouseUp.bind(this);
      this.handleBeforeUnload = this.handleBeforeUnload.bind(this);
      this.destroy = this.destroy.bind(this);
      this.handleThemeChange = this.handleThemeChange.bind(this); // Novo binding
      this.copyHighlightText = this.copyHighlightText.bind(this); // Novo binding para copiar texto
      this.checkGlobalVisibilityState =
        this.checkGlobalVisibilityState.bind(this); // NOVO BINDING
      this.handleMergeHighlights = this.handleMergeHighlights.bind(this); // NOVO BINDING para merge

      // Trusted Types policy creation
      this.trustedTypesPolicy = this.createTrustedTypesPolicy();

      // Initialize properties
      this.initProperties();

      // Initialize components
      this.injectGlobalHighlightStyle(); // Será chamado dentro de applyTheme
      this.attachPopup(); // Será atualizado para considerar o tema
      this.loadUISettings();
      this.loadFromStorage();

      // Setup observers and events
      this.setupMutationObserver();
      this.setupEventListeners();
      this.setupThemeDetection(); // Novo: Configurar detecção de tema

      // Initial UI update
      setTimeout(() => this.updateHighlightListUI(), 0);
    }

    createTrustedTypesPolicy() {
      return window.trustedTypes?.createPolicy("highlightManager", {
        createHTML: (string) => string,
        createScript: (string) => string,
        createScriptURL: (string) => string,
      });
    }

    initProperties() {
      this.popupId = "highlight-popup";
      this.highlights = new Map();
      this.hidden = false; // Estado global para o botão "Hide/Show"
      this.updatePending = false;
      this.restoreQueue = new Map();
      this.sortOrder = "creation";
      this.maxSelectionLength = 10000;
      this.currentTheme = "light"; // Padrão: light

      this.strings = {
        confirmClear:
          "Tem certeza que deseja limpar todos os destaques?\nEsta ação não pode ser desfeita.",
        highlightCreated: "Texto destacado!",
        invalidSelection: "Seleção deve estar em texto simples.",
        highlightError:
          "Erro ao aplicar destaque. Tente selecionar texto contíguo.",
        storageExceeded:
          "Limite de armazenamento excedido. Removidos destaques antigos.",
        hideHighlights: "Hide",
        showHighlights: "Show",
        selectionTooLong: `Seleção muito longa (máximo ${this.maxSelectionLength} caracteres)`,
        copiedToClipboard: "Copiado para a área de transferência!", // Nova string
        mergePrompt: "Qual separador você gostaria de usar?", // Nova string
        defaultSeparator: "---", // Nova string
        noVisibleHighlights: "Nenhum destaque visível para mesclar.", // Nova string
        mergeSuccess: "Destaques mesclados e copiados!", // Nova string
      };

      // Styles e popupHTML serão definidos e atualizados dinamicamente
      this.styles = this.getStyles(this.currentTheme);
      this.popupHTML = this.getPopupHTML();
    }

    setupEventListeners() {
      document.addEventListener("mouseup", this.handleMouseUp);
      window.addEventListener("beforeunload", this.handleBeforeUnload);

      // SPA handling
      if (window.history.pushState) {
        this.patchHistoryAPI();
      }
    }

    patchHistoryAPI() {
      const originalPushState = window.history.pushState;
      window.history.pushState = (...args) => {
        originalPushState.apply(window.history, args);
        this.handleBeforeUnload();
      };
    }

    /* ========== CORE HIGHLIGHTING FUNCTIONALITY ========== */
    handleMouseUp(e) {
      if (e.ctrlKey) {
        const selection = window.getSelection();
        if (!selection.isCollapsed) {
          const range = selection.getRangeAt(0);
          if (range.toString().trim().length > 0) {
            this.highlightSelection(range, this.generateUniqueId());
            selection.removeAllRanges();
          }
        }
      }
    }

    handleBeforeUnload() {
      this.saveUISettings();
    }

    destroy() {
      this.cleanup();
      if (window.highlightManagerInstance === this) {
        window.highlightManagerInstance = null;
      }
    }

    cleanup() {
      this.saveUISettings();
      this.removeEventListeners();
      this.clearPendingRestorations();
      this.disconnectObservers();
      this.removeDOMElements();
      this.removeThemeListeners(); // Novo: Remover listeners de tema
      // Remover event listeners dos destaques existentes para evitar vazamento de memória
      document.querySelectorAll(".highlight").forEach((el) => {
        el.removeEventListener("click", (e) => {
          e.stopPropagation();
          const highlightId = el.id.split('-')[0]; // Pega o ID original do destaque
          const highlightData = this.highlights.get(highlightId);
          if (highlightData) {
            this.copyHighlightText(highlightData.text);
          }
        });
      });
    }

    removeEventListeners() {
      document.removeEventListener("mouseup", this.handleMouseUp);
      window.removeEventListener("beforeunload", this.handleBeforeUnload);
    }

    clearPendingRestorations() {
      this.restoreQueue.forEach(clearTimeout);
      this.restoreQueue.clear();
    }

    disconnectObservers() {
      this.mutationObserver?.disconnect();
    }

    removeDOMElements() {
      if (this.shadowHost) {
        this.shadowHost.style.position = "fixed";
        this.shadowHost.style.left = "auto";
        this.shadowHost.style.right = "20px";
        this.shadowHost.style.top = "20px";
        this.shadowHost.remove();
      }
      document.getElementById("highlight-style-injected")?.remove();

      this.shadowHost = null;
      this.shadowRoot = null;
      this.mutationObserver = null;
    }

    generateUniqueId() {
      return Date.now().toString(36) + Math.random().toString(36).substring(2);
    }

    /* ========== TRUSTED HTML UTILITIES ========== */
    setInnerHTMLSafely(element, htmlString) {
      if (this.trustedTypesPolicy) {
        element.innerHTML = this.trustedTypesPolicy.createHTML(htmlString);
      } else {
        element.innerHTML = htmlString;
      }
    }

    createElementSafely(tagName, options = {}) {
      try {
        const element = document.createElement(tagName);

        if (options.className) {
          element.className =
            typeof options.className === "string"
              ? options.className
              : options.className.join(" ").trim();
        }

        if (options.id) {
          element.id = String(options.id);
        }

        if (options.textContent !== undefined) {
          element.textContent = this.escapeHTML(String(options.textContent));
        }

        if (options.html) {
          this.setInnerHTMLSafely(element, options.html);
        }

        if (options.style) {
          this.applyStyles(element, options.style);
        }

        if (options.attributes) {
          this.setAttributes(element, options.attributes);
        }

        if (options.dataset) {
          this.setDataset(element, options.dataset);
        }

        return element;
      } catch (e) {
        console.error("Error creating element:", e);
        return document.createDocumentFragment();
      }
    }

    applyStyles(element, style) {
      const styleString =
        typeof style === "string" ? style : this.styleObjectToString(style);

      if (this.trustedTypesPolicy) {
        element.style.cssText = this.trustedTypesPolicy.createHTML(styleString);
      } else {
        element.style.cssText = styleString;
      }
    }

    setAttributes(element, attributes) {
      Object.entries(attributes).forEach(([key, value]) => {
        try {
          if (value !== null && value !== undefined) {
            const attrValue = String(value);
            if (key === "style" && this.trustedTypesPolicy) {
              element.setAttribute(
                key,
                this.trustedTypesPolicy.createHTML(attrValue)
              );
            } else {
              element.setAttribute(key, attrValue);
            }
          }
        } catch (e) {
          console.error(`Error setting attribute ${key}:`, e);
        }
      });
    }

    setDataset(element, dataset) {
      Object.entries(dataset).forEach(([key, value]) => {
        try {
          if (value !== null && value !== undefined) {
            element.dataset[key] = String(value);
          }
        } catch (e) {
          console.error(`Error setting dataset ${key}:`, e);
        }
      });
    }

    styleObjectToString(styleObj) {
      return Object.entries(styleObj)
        .map(([key, value]) => `${key}:${value};`)
        .join("");
    }

    escapeHTML(str) {
      if (!str) return "";
      return String(str).replace(
        /[&<>'"]/g,
        (tag) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            '"': "&quot;",
          }[tag])
      );
    }

    /* ========== HIGHLIGHT MANAGEMENT ========== */
    highlightSelection(range, id) {
      const selectedText = range.toString();
      if (selectedText.length === 0) return false;

      if (selectedText.length > this.maxSelectionLength) {
        this.showFeedback(this.strings.selectionTooLong, "error");
        return false;
      }

      const highlightData = this.createHighlightData(range, id, selectedText);
      const span = this.createHighlightSpan(id);

      try {
        range.surroundContents(span);
      } catch (err) {
        console.error("Error applying highlight:", err);
        this.fallbackHighlightCreation(range, span, selectedText);
      }

      this.highlights.set(id, highlightData);
      this.saveToStorage();
      this.addHighlightItem(highlightData);
      this.updateHighlightListUI();
      this.checkGlobalVisibilityState(); // NOVO: Atualiza o estado do botão "Hide/Show"

      return true;
    }

    createHighlightData(range, id, text) {
      const stableParentInfo = this.getStableParentInfo(
        range.commonAncestorContainer
      );
      const parentElement = stableParentInfo.element;
      const parentTextContent = parentElement.textContent;
      const startIndex = this.findTextStartIndex(
        range,
        parentElement,
        parentTextContent,
        text
      );

      return {
        id,
        text,
        parts: [
          {
            stableParentSelector: stableParentInfo.selector,
            textSegment: text,
            startOffsetInParentText: startIndex,
            endOffsetInParentText: startIndex + text.length,
          },
        ],
        createdAt: Date.now(),
        visible: true, // Adiciona a propriedade 'visible' ao dado do destaque, padrão true
      };
    }

    findTextStartIndex(range, parentElement, parentTextContent, text) {
      let startIndex = -1;
      const tempRange = document.createRange();
      tempRange.selectNodeContents(parentElement);
      const walker = document.createTreeWalker(
        parentElement,
        NodeFilter.SHOW_TEXT
      );
      let currentOffset = 0;
      let node;

      while ((node = walker.nextNode())) {
        if (node === range.startContainer) {
          startIndex = currentOffset + range.startOffset;
          break;
        }
        currentOffset += node.length;
      }

      if (startIndex === -1) {
        startIndex = parentTextContent.indexOf(text, 0);
      }

      return startIndex;
    }

    createHighlightSpan(id) {
      const span = this.createElementSafely("span", {
        className: "highlight",
        id: `${id}-0`,
        style: this.getHighlightStyle(),
      });
      // Adicionar event listener para copiar o texto ao clicar
      span.addEventListener("click", (e) => {
        e.stopPropagation(); // Evita que o clique se propague e afete outras coisas (como fechar seleções)
        const highlightData = this.highlights.get(id);
        if (highlightData) {
          this.copyHighlightText(highlightData.text);
        }
      });
      return span;
    }

    fallbackHighlightCreation(range, span, text) {
      span.textContent = text;
      range.deleteContents();
      range.insertNode(span);
    }

    getHighlightStyle(isVisible = true) {
      // Adicionado parâmetro isVisible
      // Estilo de destaque baseado no tema atual
      if (!isVisible) {
        // Se não estiver visível (checkbox desmarcado)
        return "background-color: transparent; box-shadow: none; border-radius: 0; padding: 0;";
      } else {
        // Se estiver visível (checkbox marcado)
        return this.currentTheme === "dark"
          ? "background-color: #ffd700; box-shadow: 0 0 0 1px rgba(255, 215, 0, 0.5); border-radius: 3px; padding: 0 2px; color: black; cursor: pointer;"
          : "background-color: yellow; box-shadow: 0 0 0 1px rgba(255, 255, 0, 0.5); border-radius: 3px; padding: 0 2px; color: black; cursor: pointer;";
      }
    }

    /* ========== RESTORATION LOGIC ========== */
    restoreHighlight(highlightData) {
      try {
        const part = highlightData.parts[0];
        if (!part) return false;

        const fullId = `${highlightData.id}-0`;
        if (document.getElementById(fullId)) return true;

        const parentElement = document.querySelector(part.stableParentSelector);
        if (!parentElement) {
          console.warn(
            `Parent element not found for highlight ${highlightData.id}: ${part.stableParentSelector}`
          );
          return false;
        }

        return this.findAndHighlightText(
          parentElement,
          part.textSegment,
          part.startOffsetInParentText,
          fullId,
          highlightData.id,
          highlightData.visible // Passa o estado de visibilidade
        );
      } catch (error) {
        console.error(`Error restoring highlight ${highlightData.id}:`, error);
        return false;
      }
    }

    findAndHighlightText(
      parentEl,
      textToFind,
      initialOffset,
      highlightId,
      originalHighlightId,
      isVisible = true
    ) {
      const fullText = parentEl.textContent;
      let foundIndex =
        fullText.indexOf(textToFind, initialOffset) ||
        fullText.indexOf(textToFind);

      if (foundIndex === -1) {
        console.warn(
          `Text '${textToFind}' not found in parent element for highlight ${highlightId}`
        );
        return false;
      }

      const range = document.createRange();
      const nodes = this.findTextNodesForRange(
        parentEl,
        foundIndex,
        textToFind.length
      );

      if (nodes.startNode && nodes.endNode) {
        const span = this.createHighlightSpan(originalHighlightId); // Usar o ID original
        // Aplica o estilo de visibilidade inicial baseado no isVisible
        this.applyStyles(span, this.getHighlightStyle(isVisible));
        if (!isVisible) span.classList.add("hidden"); // Adiciona a classe hidden se não for visível

        try {
          range.setStart(nodes.startNode, nodes.startOffset);
          range.setEnd(nodes.endNode, nodes.endOffset);
          range.surroundContents(span);
          return true;
        } catch (err) {
          console.error(`Error restoring highlight ${highlightId}:`, err);
          return this.fallbackHighlightCreation(range, span, textToFind);
        }
      }
      return false;
    }

    findTextNodesForRange(parentEl, startIndex, length) {
      const range = document.createRange();
      let currentOffset = 0;
      let startNode = null,
        endNode = null;
      let startOffset = 0,
        endOffset = 0;

      const walker = document.createTreeWalker(parentEl, NodeFilter.SHOW_TEXT);
      let node;

      while ((node = walker.nextNode())) {
        const nodeLength = node.length;

        if (startNode === null && currentOffset + nodeLength > startIndex) {
          startNode = node;
          startOffset = startIndex - currentOffset;
        }

        if (
          endNode === null &&
          currentOffset + nodeLength >= startIndex + length
        ) {
          endNode = node;
          endOffset = startIndex + length - currentOffset;
          break;
        }
        currentOffset += nodeLength;
      }

      return { startNode, startOffset, endNode, endOffset };
    }

    scheduleHighlightRestore(id) {
      if (!this.restoreQueue.has(id)) {
        this.restoreQueue.set(
          id,
          setTimeout(() => {
            const data = this.highlights.get(id);
            if (data) {
              // Passa o estado de visibilidade salvo
              const success = this.restoreHighlight(data);
              if (!success) {
                console.warn(`Failed to restore highlight ${id}`);
                this.highlights.delete(id);
                this.saveToStorage();
              }
            }
            this.restoreQueue.delete(id);
            this.checkGlobalVisibilityState(); // Garante que o botão global se atualize após restauração
          }, 1000)
        );
      }
    }

    /* ========== COPY TO CLIPBOARD FUNCTIONALITY ========== */
    async copyHighlightText(text) {
      try {
        await navigator.clipboard.writeText(text);
        this.showFeedback(this.strings.copiedToClipboard, "success");
      } catch (err) {
        console.error("Failed to copy text: ", err);
        this.showFeedback("Falha ao copiar o texto.", "error");
      }
    }

    /* ========== MERGE HIGHLIGHTS FUNCTIONALITY ========== */
    async handleMergeHighlights() {
      const visibleHighlights = Array.from(this.highlights.values()).filter(
        (h) => h.visible
      );

      if (visibleHighlights.length === 0) {
        this.showFeedback(this.strings.noVisibleHighlights, "warning");
        return;
      }

      // Sort highlights by their appearance order in the DOM
      visibleHighlights.sort((a, b) => {
        const elA = document.getElementById(`${a.id}-0`);
        const elB = document.getElementById(`${b.id}-0`);

        if (!elA || !elB) {
          // Fallback to creation date if elements not found in DOM
          return a.createdAt - b.createdAt;
        }

        // Compare positions using compareDocumentPosition
        const position = elA.compareDocumentPosition(elB);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
          return -1; // A comes before B
        } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
          return 1; // B comes before A
        }
        return 0; // Same position or not comparable
      });

      const separator = prompt(
        this.strings.mergePrompt,
        this.strings.defaultSeparator
      );

      if (separator === null) {
        // User cancelled the prompt
        return;
      }

      const mergedText = visibleHighlights
        .map((h) => h.text)
        .join(`\n${separator}\n`);

      try {
        await navigator.clipboard.writeText(mergedText);
        this.showFeedback(this.strings.mergeSuccess, "success");
      } catch (err) {
        console.error("Failed to copy merged text: ", err);
        this.showFeedback("Falha ao copiar o texto mesclado.", "error");
      }
    }

    /* ========== STORAGE MANAGEMENT ========== */
    saveToStorage() {
      const data = Array.from(this.highlights.values());
      try {
        localStorage.setItem("highlights", JSON.stringify(data));
      } catch (e) {
        if (e.name === "QuotaExceededError") {
          this.handleStorageQuotaExceeded(data);
        }
      }
    }

    handleStorageQuotaExceeded(data) {
      const half = Math.floor(data.length / 2);
      const newData = data.slice(half);
      localStorage.setItem("highlights", JSON.stringify(newData));
      this.highlights = new Map(newData.map((item) => [item.id, item]));
      this.showFeedback(this.strings.storageExceeded, "warning");
    }

    saveUISettings() {
      const settings = {
        position: {
          top: this.shadowHost.style.top,
          left: this.shadowHost.style.left,
        },
        sortOrder: this.sortOrder,
        hidden: this.hidden, // Salva o estado global do botão Hide/Show
        minimized:
          this.shadowRoot?.querySelector(".content").style.display === "none",
        theme: this.currentTheme,
      };
      localStorage.setItem(
        "highlightManagerUISettings",
        JSON.stringify(settings)
      );
    }

    loadUISettings() {
      try {
        const saved = localStorage.getItem("highlightManagerUISettings");
        if (!saved) {
          this.hidden = false;
          this.currentTheme = this.getSystemPreferredTheme();
          return;
        }
        const settings = JSON.parse(saved);
        this.applyUISettings(settings);
      } catch (e) {
        this.hidden = false;
        this.currentTheme = this.getSystemPreferredTheme();
        console.warn("Failed to load UI settings:", e);
        localStorage.removeItem("highlightManagerUISettings");
      }
    }

    applyUISettings(settings) {
      if (settings.position && this.shadowHost) {
        this.shadowHost.style.top = settings.position.top || "20px";
        this.shadowHost.style.left = settings.position.left || "auto";
        this.shadowHost.style.right = "auto";
      }

      if (settings.minimized && this.shadowRoot) {
        this.shadowRoot.querySelector(".content").style.display =
          settings.minimized ? "none" : "block";
      }

      if (settings.sortOrder) {
        this.sortOrder = settings.sortOrder;
        this.updateSortButton();
      }

      if (typeof settings.hidden === "boolean") {
        this.hidden = settings.hidden; // Carrega o estado global
      }

      if (
        settings.theme &&
        (settings.theme === "light" || settings.theme === "dark")
      ) {
        this.currentTheme = settings.theme;
      } else {
        this.currentTheme = this.getSystemPreferredTheme();
      }
      this.applyTheme(this.currentTheme);
    }

    loadFromStorage() {
      const saved = localStorage.getItem("highlights");
      if (!saved) return;

      try {
        const parsed = JSON.parse(saved);
        parsed.forEach((item) => {
          // Garante que 'visible' exista, mesmo para destaques antigos
          if (item.visible === undefined) {
            item.visible = true;
          }
          if (!this.highlights.has(item.id)) {
            this.highlights.set(item.id, item);
            this.scheduleHighlightRestore(item.id);
          }
        });
        this.updateHighlightListUI();
        this.checkGlobalVisibilityState(); // NOVO: Verifica o estado global após carregar destaques
      } catch (err) {
        console.error("Error loading highlights:", err);
        localStorage.removeItem("highlights");
      }
    }

    /* ========== UI MANAGEMENT ========== */
    showFeedback(message, type = "success") {
      const feedback = this.createElementSafely("div", {
        textContent: message,
        style: this.styles.feedback(type),
      });

      document.body.appendChild(feedback);
      setTimeout(() => feedback.remove(), 3000);
    }

    attachPopup() {
      document.getElementById(this.popupId)?.remove();

      this.shadowHost = this.createElementSafely("div", {
        id: this.popupId,
        style: this.styles.shadowHost,
      });
      document.body.appendChild(this.shadowHost);

      this.shadowRoot = this.shadowHost.attachShadow({ mode: "open" });
      this.renderPopupContent();
      this.setupPopupEventListeners();
      this.enableDrag();
      this.applyTheme(this.currentTheme); // Aplicar o tema inicial aqui
      this.checkGlobalVisibilityState(); // NOVO: Chamar para garantir que o botão "Hide/Show" esteja correto
    }

    renderPopupContent() {
      const container = this.createElementSafely("div");

      // O texto do botão será definido pelo checkGlobalVisibilityState
      const popupHTML = this.getPopupHTML();
      this.setInnerHTMLSafely(container, popupHTML);
      this.shadowRoot.appendChild(container);

      // Estilos serão injetados por applyTheme
      this.updateHideButton(); // Chamado aqui para definir o estado inicial do botão
    }

    setupPopupEventListeners() {
      const elements = this.getPopupElements();

      elements.clearBtn.addEventListener("click", () =>
        this.handleClearClick()
      );
      elements.hideToggleBtn.addEventListener("click", () =>
        this.handleHideToggle()
      );
      elements.mergeBtn.addEventListener("click", () =>
        this.handleMergeHighlights()
      ); // NOVO: Event listener para o botão Merge
      elements.closeBtn.addEventListener("click", (e) =>
        this.handleCloseClick(e)
      );
      elements.minimizeBtn.addEventListener("click", () =>
        this.handleMinimizeClick()
      );
      elements.searchInput.addEventListener("input", (e) =>
        this.handleSearchInput(e)
      );
      elements.clearSearchBtn.addEventListener("click", () =>
        this.handleClearSearch()
      );
      elements.sortToggleBtn.addEventListener("click", () =>
        this.handleSortToggle()
      );
      elements.themeToggleBtn?.addEventListener("click", () =>
        this.toggleTheme()
      );

      this.enableDrag(this.shadowHost, elements.popupHeader);
    }

    getPopupElements() {
      return {
        clearBtn: this.shadowRoot.getElementById("clear"),
        hideToggleBtn: this.shadowRoot.getElementById("hide-toggle"),
        mergeBtn: this.shadowRoot.getElementById("merge-highlights"), // NOVO: Pega o botão Merge
        closeBtn: this.shadowRoot.getElementById("btn-close"),
        minimizeBtn: this.shadowRoot.getElementById("btn-minimize"),
        searchInput: this.shadowRoot.getElementById("search-input"),
        clearSearchBtn: this.shadowRoot.getElementById("clear-search"),
        sortToggleBtn: this.shadowRoot.getElementById("sort-toggle"),
        popupHeader: this.shadowRoot.getElementById("popup-header"),
        content: this.shadowRoot.querySelector(".content"),
        themeToggleBtn: this.shadowRoot.getElementById("theme-toggle"),
      };
    }

    handleClearClick() {
      if (confirm(this.strings.confirmClear)) {
        this.clearHighlights();
        this.showFeedback("Todos os destaques foram removidos", "success");
        this.checkGlobalVisibilityState(); // NOVO: Atualiza o botão após limpar
      }
    }

    handleHideToggle() {
      // Alterna o estado global
      this.hidden = !this.hidden;
      this.saveUISettings();

      // Aplica o estado de visibilidade a TODOS os destaques e seus checkboxes
      this.highlights.forEach((highlightData, id) => {
        highlightData.visible = !this.hidden; // Atualiza o dado
        this.toggleHighlightVisibility(id, highlightData.visible);

        const checkbox = this.shadowRoot.querySelector(
          `#li-${id} input[type="checkbox"]`
        );
        if (checkbox) {
          checkbox.checked = highlightData.visible;
        }
      });
      // Atualiza o botão "Hide/Show" com base no novo estado global
      this.updateHideButton();
      this.saveToStorage(); // Salva o estado de visibilidade de todos os destaques
    }

    handleCloseClick(e) {
      e.stopPropagation();
      this.animatePopupClose();
    }

    animatePopupClose() {
      this.shadowHost.style.transition = "opacity 0.2s ease";
      this.shadowHost.style.opacity = "0";

      setTimeout(() => {
        this.destroy();
        this.showFeedback("Gerenciador de destaques fechado", "info");
      }, 200);
    }

    handleMinimizeClick() {
      const content = this.shadowRoot.querySelector(".content");
      content.style.display =
        content.style.display === "none" ? "block" : "none";
      this.saveUISettings();
    }

    handleSearchInput(e) {
      this.updateHighlightListUI(e.target.value);
      this.shadowRoot.getElementById("clear-search").style.display = e.target
        .value
        ? "block"
        : "none";
    }

    handleClearSearch() {
      const searchInput = this.shadowRoot.getElementById("search-input");
      searchInput.value = "";
      searchInput.focus();
      this.updateHighlightListUI("");
      this.shadowRoot.getElementById("clear-search").style.display = "none";
    }

    handleSortToggle() {
      if (this.sortOrder === "creation") {
        this.sortOrder = "asc"; // Vai para A-Z
      } else if (this.sortOrder === "asc") {
        this.sortOrder = "desc"; // Vai para Z-A
      } else {
        // this.sortOrder === "desc"
        this.sortOrder = "creation"; // Volta para ordem de criação
      }
      this.updateSortButton();
      this.updateHighlightListUI(
        this.shadowRoot.getElementById("search-input").value
      );
      this.saveUISettings();
      this.updateSortButton();
      this.updateHighlightListUI(
        this.shadowRoot.getElementById("search-input").value
      );
      this.saveUISettings();
    }

    updateSortButton() {
      const sortBtn = this.shadowRoot.getElementById("sort-toggle");
      if (sortBtn) {
        if (this.sortOrder === "creation") {
          sortBtn.textContent = "↓ Creation (No Sort)"; // Ou "Default", "Definição", "Original"
          sortBtn.title = "Next sort by text (A-Z)";
        } else if (this.sortOrder === "asc") {
          sortBtn.textContent = "↑ Asc (A-Z)";
          sortBtn.title = "Next sort by text (Z-A)";
        } else {
          // this.sortOrder === "desc"
          sortBtn.textContent = "↓ Desc (Z-A)";
          sortBtn.title = "Next sort by creation time"; // Volta para ordem de criação
        }
      }
    }

    // NOVO/ATUALIZADO: Atualiza o texto e estilo do botão Hide/Show baseado em this.hidden
    updateHideButton() {
      const hideBtn = this.shadowRoot.getElementById("hide-toggle");
      if (hideBtn) {
        hideBtn.textContent = this.hidden
          ? this.strings.showHighlights
          : this.strings.hideHighlights;

        if (this.hidden) {
          hideBtn.classList.add("hidden-state");
        } else {
          hideBtn.classList.remove("hidden-state");
        }
      }
    }

    // NOVO MÉTODO: Verifica o estado de visibilidade de todos os destaques
    checkGlobalVisibilityState() {
      if (!this.shadowRoot) return;

      const totalHighlights = this.highlights.size;
      if (totalHighlights === 0) {
        this.hidden = false; // Se não houver destaques, o botão deve mostrar "Hide" (ou seja, não há nada escondido)
        this.updateHideButton();
        return;
      }

      let anyVisible = false;
      let anyHidden = false;

      this.highlights.forEach((highlightData) => {
        if (!highlightData.visible) {
          anyHidden = true;
        } else {
          anyVisible = true;
        }
      });

      // Se todos estiverem escondidos (e houver destaques), o botão global deve ser "Show"
      if (!anyVisible && anyHidden) { // This means all existing highlights are currently hidden
        this.hidden = true; 
      } else if (anyVisible && !anyHidden) { // All existing highlights are visible
        this.hidden = false;
      } else if (anyVisible && anyHidden) { // Some visible, some hidden
        // This case is tricky for the global button. 
        // We'll set 'hidden' based on the last state applied by 'handleHideToggle'
        // or by default, if some are hidden, the global 'Hide' button should conceptually imply 'show all'.
        // Let's re-evaluate the intended behavior of the global button.
        // If 'hidden' means "all highlights are currently hidden by the global toggle",
        // then if even one is visible, the global toggle state should reflect "hide all".
        // Let's stick to: if ANY highlight is hidden, the global button should say "Show".
        // If ALL highlights are visible, the global button should say "Hide".
        this.hidden = anyHidden; // If any are hidden, the global toggle should prompt to "Show"
      } else { // No highlights at all
         this.hidden = false;
      }
      this.updateHideButton();
    }

    addHighlightItem({ id, text, visible }) {
      // Adiciona 'visible' como parâmetro
      const list = this.shadowRoot?.querySelector(".highlight-list");
      if (!list || this.shadowRoot.getElementById(`li-${id}`)) return;

      const li = this.createElementSafely("li", { id: `li-${id}` });
      const removeBtn = this.createRemoveButton(id);
      const checkbox = this.createVisibilityCheckbox(id, visible); // Passa 'visible' para o checkbox
      const link = this.createHighlightLink(id, text);

      li.append(removeBtn, checkbox, link);
      list.appendChild(li);
      // A visibilidade do highlight real no DOM será definida pelo checkbox handler
      // ou pelo toggleHighlightVisibility chamado no restoreHighlight.
      // O importante é que a propriedade 'visible' no highlightData esteja correta.
    }

    createRemoveButton(id) {
      const removeBtn = this.createElementSafely("button", {
        textContent: "✕",
        attributes: { title: "Remover destaque" },
      });
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeHighlightById(id);
        this.checkGlobalVisibilityState(); // NOVO: Atualiza o botão após remover
      });
      return removeBtn;
    }

    createVisibilityCheckbox(id, initialVisibility) {
      // Recebe o estado inicial
      const checkbox = this.createElementSafely("input", {
        attributes: {
          type: "checkbox",
          checked: initialVisibility, // Define o estado inicial do checkbox
        },
      });
      checkbox.addEventListener("change", (e) => {
        e.stopPropagation();
        const highlightData = this.highlights.get(id);
        if (highlightData) {
          highlightData.visible = e.target.checked; // Atualiza o estado no objeto de dados
          this.toggleHighlightVisibility(id, e.target.checked);
          this.saveToStorage(); // Salva a mudança de visibilidade
          this.checkGlobalVisibilityState(); // NOVO: Atualiza o estado do botão "Hide/Show"
        }
      });
      return checkbox;
    }

    createHighlightLink(id, text) {
      const link = this.createElementSafely("a", {
        textContent: this.escapeHTML(
          text.length > 30 ? `${text.slice(0, 30)}…` : text
        ),
        style: "text-decoration:none;cursor:pointer;",
        attributes: { href: `#${id}` },
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.scrollToHighlight(id);
      });
      return link;
    }

    removeHighlightById(id) {
      document.querySelectorAll(`[id^="${id}-"]`).forEach((el) => {
        el.removeEventListener("click", this.copyHighlightText);
        el.replaceWith(...el.childNodes);
      });
      this.highlights.delete(id);
      this.saveToStorage();
      this.shadowRoot.getElementById(`li-${id}`)?.remove();
    }

    toggleHighlightVisibility(id, visible) {
      const highlights = document.querySelectorAll(`[id^="${id}-"]`);
      if (!highlights.length) return;

      const style = this.getHighlightStyle(visible); // Passa o estado de visibilidade
      highlights.forEach((el) => {
        this.applyStyles(el, style);
        visible ? el.classList.remove("hidden") : el.classList.add("hidden");
      });
    }

    scrollToHighlight(id) {
      const firstPart = document.getElementById(`${id}-0`);
      if (!firstPart) return;

      this.applyStyles(firstPart, "animation: highlight-pulse 0.5s 2;");
      firstPart.scrollIntoView({ behavior: "smooth", block: "center" });

      setTimeout(() => {
        // Reaplica o estilo original de visibilidade após a animação
        const highlightData = this.highlights.get(id);
        if (highlightData) {
          this.applyStyles(
            firstPart,
            this.getHighlightStyle(highlightData.visible)
          );
        } else {
          this.applyStyles(firstPart, ""); // Se por algum motivo o destaque sumiu, limpa o estilo
        }
      }, 1000);
    }

    updateHighlightListUI(filterText = "") {
      if (!this.shadowRoot) return;

      const list = this.shadowRoot.querySelector(".highlight-list");
      if (!list) return;

      list.innerHTML = ""; // Clear existing items

      const highlightsArray = this.filterAndSortHighlights(filterText);
      highlightsArray.forEach((item) => this.addHighlightItem(item)); // item agora inclui 'visible'
    }

    filterAndSortHighlights(filterText) {
      let highlightsArray = Array.from(this.highlights.values());

      if (filterText) {
        const searchText = filterText.toLowerCase();
        highlightsArray = highlightsArray.filter((item) =>
          item.text.toLowerCase().includes(searchText)
        );
      }

      return highlightsArray.sort((a, b) => {
        if (this.sortOrder === "creation") {
          return a.createdAt - b.createdAt; // Ordena por data de criação (mais antigo primeiro)
        } else if (this.sortOrder === "asc") {
          const textA = a.text.toLowerCase();
          const textB = b.text.toLowerCase();
          return textA.localeCompare(textB); // Ordenação alfabética A-Z
        } else {
          // this.sortOrder === "desc"
          const textA = a.text.toLowerCase();
          const textB = b.text.toLowerCase();
          return textB.localeCompare(textA); // Ordenação alfabética Z-A
        }
      });
    }

    clearHighlights() {
      this.highlights.forEach((_, id) => {
        document.querySelectorAll(`[id^="${id}-"]`).forEach((el) => {
          el.removeEventListener("click", this.copyHighlightText);
          el.replaceWith(...el.childNodes);
        });
      });
      this.highlights.clear();
      localStorage.removeItem("highlights");
      this.updateHighlightListUI();
    }

    // Este método agora é tratado por handleHideToggle e checkGlobalVisibilityState
    toggleHighlightsVisibility() {
      console.warn(
        "toggleHighlightsVisibility is deprecated. Use handleHideToggle."
      );
    }

    enableDrag() {
      const element = this.shadowHost;
      const handle = this.shadowRoot.getElementById("popup-header");
      const dragThreshold = 3;
      let startX,
        startY,
        initialTop,
        initialLeft,
        isDragging = false;

      const handleMouseDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        element.style.position = "fixed";

        startX = e.clientX;
        startY = e.clientY;
        initialTop = element.offsetTop;
        initialLeft = element.offsetLeft;

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
        document.addEventListener("mouseleave", handleMouseUp);
      };

      const handleMouseMove = (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (
          !isDragging &&
          (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold)
        ) {
          isDragging = true;
          element.style.userSelect = "none";
        }

        if (isDragging) {
          e.preventDefault();
          e.stopImmediatePropagation();

          let newTop = initialTop + dy;
          let newLeft = initialLeft + dx;

          const windowWidth = window.innerWidth;
          const windowHeight = window.innerHeight;
          const elementWidth = element.offsetWidth;
          const elementHeight = element.offsetHeight;

          newTop = Math.max(0, newTop);
          newTop = Math.min(newTop, windowHeight - elementHeight);

          newLeft = Math.max(0, newLeft);
          newLeft = Math.min(newLeft, windowWidth - elementWidth);

          element.style.top = `${newTop}px`;
          element.style.left = `${newLeft}px`;
          element.style.right = "auto";
          element.style.bottom = "auto";
        }
      };

      const handleMouseUp = (e) => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("mouseleave", handleMouseUp);

        if (isDragging) {
          e.preventDefault();
          e.stopPropagation();
          element.style.userSelect = "";
          this.saveUISettings();
        }
        isDragging = false;
      };

      handle.addEventListener("mousedown", handleMouseDown);
      this.cleanupDragListeners = () => {
        handle.removeEventListener("mousedown", handleMouseDown);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("mouseleave", handleMouseUp);
      };
    }

    injectGlobalHighlightStyle() {
      const styleId = "highlight-style-injected";
      let styleElement = document.getElementById(styleId);
      if (!styleElement) {
        styleElement = this.createElementSafely("style", { id: styleId });
        document.head.appendChild(styleElement);
      }
      styleElement.textContent = this.trustedTypesPolicy
        ? this.trustedTypesPolicy.createHTML(this.styles.global)
        : this.styles.global;
    }

    setupMutationObserver() {
      this.mutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            this.highlights.forEach((data, id) => {
              if (!document.getElementById(`${id}-0`)) {
                this.scheduleHighlightRestore(id);
              }
            });
          }
        });
      });

      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    /* ========== TEMA CLARO/ESCURO ========== */
    getSystemPreferredTheme() {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }

    setupThemeDetection() {
      const prefersDarkScheme = window.matchMedia(
        "(prefers-color-scheme: dark)"
      );
      this.currentTheme = this.getSystemPreferredTheme();
      this.applyTheme(this.currentTheme);
      prefersDarkScheme.addEventListener("change", this.handleThemeChange);
      this.mediaQueryList = prefersDarkScheme;
    }

    handleThemeChange(event) {
      this.currentTheme = event.matches ? "dark" : "light";
      this.applyTheme(this.currentTheme);
      this.saveUISettings();
      // Reaplicar estilos de destaque (incluindo visibilidade)
      this.highlights.forEach((highlightData, id) => {
        this.toggleHighlightVisibility(id, highlightData.visible);
      });
      this.updateHighlightListUI(
        this.shadowRoot?.getElementById("search-input")?.value || ""
      );
    }

    removeThemeListeners() {
      if (this.mediaQueryList) {
        this.mediaQueryList.removeEventListener(
          "change",
          this.handleThemeChange
        );
      }
    }

    applyTheme(theme) {
      this.currentTheme = theme;
      if (this.shadowHost) {
        this.shadowHost.classList.remove("light-theme", "dark-theme");
        this.shadowHost.classList.add(`${theme}-theme`);
      }

      this.styles = this.getStyles(theme);

      this.injectGlobalHighlightStyle();

      if (this.shadowRoot) {
        let styleElement = this.shadowRoot.querySelector("style");
        if (!styleElement) {
          styleElement = this.createElementSafely("style");
          this.shadowRoot.appendChild(styleElement);
        }
        styleElement.textContent = this.trustedTypesPolicy
          ? this.trustedTypesPolicy.createHTML(this.styles.popup)
          : this.styles.popup;
      }

      // Reaplicar estilos a todos os destaques existentes com base em seu estado 'visible'
      this.highlights.forEach((highlightData, id) => {
        this.toggleHighlightVisibility(id, highlightData.visible);
      });

      this.shadowRoot?.querySelectorAll(".highlight-list a").forEach((link) => {
        this.applyStyles(link, this.getHighlightLinkStyle(theme));
      });

      const themeToggleBtn = this.shadowRoot?.getElementById("theme-toggle");
      if (themeToggleBtn) {
        themeToggleBtn.textContent =
          this.currentTheme === "dark" ? "☀️ Light" : "🌙 Dark";
      }
    }

    toggleTheme() {
      this.currentTheme = this.currentTheme === "light" ? "dark" : "light";
      this.applyTheme(this.currentTheme);
      this.saveUISettings();
      this.updateHighlightListUI(
        this.shadowRoot?.getElementById("search-input")?.value || ""
      );
    }

    getHighlightLinkStyle(theme) {
      return theme === "dark"
        ? "text-decoration:none;color:#9bc5ef;cursor:pointer;"
        : "text-decoration:none;color:#0645AD;cursor:pointer;";
    }

    getStyles(theme) {
      const isDark = theme === "dark";
      return {
        global: `
          .highlight {
            background-color: ${isDark ? "#ffd700" : "yellow"};
            color: black;
            border-radius: 3px;
            padding: 0 2px;
            box-shadow: 0 0 0 1px ${
              isDark ? "rgba(255, 215, 0, 0.5)" : "rgba(255, 255, 0, 0.5)"
            };
            transition: all 0.3s ease;
            cursor: pointer;
          }

          .highlight.hidden {
            background-color: transparent !important;
            box-shadow: none !important;
          }

          .highlight.pulse-animation {
            animation: highlight-pulse 0.5s 2 !important;
            background-color: ${isDark ? "#ffd700" : "yellow"} !important;
            box-shadow: 0 0 0 1px ${
              isDark ? "rgba(255, 215, 0, 0.5)" : "rgba(255, 215, 0, 0.5)"
            };
          }
          @keyframes highlight-pulse {
            0% { box-shadow: 0 0 0 0 ${
              isDark ? "rgba(255, 215, 0, 0.8)" : "rgba(255, 215, 0, 0.8)"
            }; }
            50% { box-shadow: 0 0 0 15px ${
              isDark ? "rgba(255, 215, 0, 0)" : "rgba(255, 215, 0, 0)"
            }; }
            100% { box-shadow: 0 0 0 0 ${
              isDark ? "rgba(255, 215, 0, 0.8)" : "rgba(255, 215, 0, 0.8)"
            }; }
          }
        `,
        popup: `
          .popup {
            background: ${isDark ? "#282c34" : "#fffbe6"};
            border: 2px solid ${isDark ? "#555" : "#ccc"};
            border-radius: 8px;
            font-family: sans-serif;
            width: 280px;
            max-width: 90vw;
            max-height: 70vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-shadow: 2px 2px 12px rgba(0,0,0,0.1);
            color: ${isDark ? "#e0e0e0" : "black"};
          }
          .header {
            background: ${isDark ? "#3c424a" : "#f9e46c"};
            color: ${isDark ? "#e0e0e0" : "black"};
            padding: 6px 10px;
            font-size: 1rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: move;
            border-bottom: 1px solid ${isDark ? "#555" : "#ccc"};
          }
          .buttons button {
            margin-left: 4px;
            border: none;
            background: none;
            font-size: 1rem;
            cursor: pointer;
            padding: 2px 6px;
            border-radius: 3px;
            color: ${isDark ? "#e0e0e0" : "black"};
          }
          .buttons button:hover {
            background: ${isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"};
          }
          .content {
            padding: 8px;
            overflow-y: auto;
            flex: 1;
          }
          .toolbar {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            gap: 5px; /* Adicionado para espaçamento entre os botões */
          }
          .toolbar button {
            font-size: 0.75rem;
            padding: 4px 6px;
            border: 1px solid ${isDark ? "#888" : "#888"};
            background: ${isDark ? "#444" : "white"};
            color: ${isDark ? "#e0e0e0" : "black"};
            border-radius: 5px;
            cursor: pointer;
            flex-grow: 1; /* Permite que os botões cresçam e preencham o espaço */
          }
          .toolbar button:hover {
            background: ${isDark ? "#555" : "#f0f0f0"};
          }
          .search-sort-container {
            display: flex;
            gap: 5px;
            margin-bottom: 8px;
          }
          .search-wrapper {
            position: relative;
            flex: 1;
          }
          #search-input {
            width: 100%;
            padding: 4px 6px;
            padding-right: 24px;
            border: 1px solid ${isDark ? "#888" : "#888"};
            border-radius: 5px;
            font-size: 0.8rem;
            box-sizing: border-box;
            background: ${isDark ? "#333" : "white"};
            color: ${isDark ? "#e0e0e0" : "black"};
          }
          .clear-search-btn {
            position: absolute;
            right: 6px;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: ${isDark ? "#bbb" : "#999"};
            cursor: pointer;
            font-size: 1rem;
            line-height: 1;
            padding: 0;
            display: none;
          }
          .clear-search-btn:hover {
            color: ${isDark ? "#eee" : "#666"};
          }
          .search-wrapper:has(#search-input:not(:placeholder-shown)) .clear-search-btn {
            display: block;
          }
          #sort-toggle {
            padding: 4px 6px;
            border: 1px solid ${isDark ? "#888" : "#888"};
            background: ${isDark ? "#444" : "white"};
            color: ${isDark ? "#e0e0e0" : "black"};
            border-radius: 5px;
            cursor: pointer;
            font-size: 0.8rem;
            white-space: nowrap;
          }
          .instructions {
            font-size: 0.8rem;
            color: ${isDark ? "#aaa" : "#666"};
            margin: 4px 0;
            padding: 4px 8px;
            background: ${isDark ? "#333" : "#f0f0f0"};
            border-radius: 4px;
            text-align: center;
          }
          .highlight-list {
            list-style: none;
            padding: 0;
            margin: 0;
            max-height: 300px;
            overflow-y: auto;
          }
          .highlight-list li {
            margin: 4px 0;
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 4px;
            border-bottom: 1px solid ${isDark ? "#444" : "#eee"};
            overflow-x: hidden;
          }
          .highlight-list li:last-child {
            border-bottom: none;
          }
          .highlight-list input[type="checkbox"] {
            accent-color: ${isDark ? "#ffd700" : "yellow"};
          }
          .highlight-list input[type="checkbox"]:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .highlight-list li.disabled {
            opacity: 0.6;
          }
          .highlight-list button {
            background: none;
            border: none;
            color: ${isDark ? "#ccc" : "#999"};
            font-size: 1rem;
            cursor: pointer;
            padding: 0 4px;
          }
          .highlight-list button:hover {
            color: ${isDark ? "#eee" : "#666"};
          }
          .highlight-list a {
            color: ${
              isDark ? "#9bc5ef" : "#0645AD"
            }; /* Cor do link adaptada ao tema */
          }

          #hide-toggle.hidden-state {
            opacity: 0.7;
            background-color: ${isDark ? "#3a3f47" : "#f0f0f0"};
          }
          .highlight-manager-footer {
            padding: 8px;
            text-align: center;
            font-size: 12px;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 4px;
            flex-wrap: wrap;
            border-bottom-left-radius: 6px;
            border-bottom-right-radius: 6px;
            background: ${isDark ? "#444" : "#f0f0f0"};
            color: ${isDark ? "#ddd" : "#666"};
            border-top: 1px solid ${isDark ? "#555" : "#ccc"};
          }
          .highlight-manager-footer a {
            color: ${isDark ? "#ddd" : "#666"};
            text-decoration: none;
          }
          .highlight-manager-footer a:hover {
            text-decoration: underline;
          }
        `,
        feedback: (type) => `
          position: fixed;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          padding: 8px 16px;
          border-radius: 4px;
          color: white;
          font-family: sans-serif;
          font-size: 14px;
          z-index: 2147483648;
          background: ${
            type === "error"
              ? "#e74c3c"
              : type === "warning"
              ? "#f39c12"
              : "#27ae60"
          };
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        `,
        shadowHost: `
          position: fixed !important;
          top: 20px;
          right: 20px;
          max-width: 95vw;
          max-height: 95vh;
          overflow: hidden;
          resize: none !important;
          z-index: 2147483647;
        `,
      };
    }

    getPopupHTML() {
      const themeToggleButtonText =
        this.currentTheme === "dark" ? "☀️ Light" : "🌙 Dark";
      return `
        <div class="popup">
          <div class="header" id="popup-header">
            <strong>Highlights</strong>
            <div class="buttons">
              <button id="theme-toggle" title="Alternar Tema">${themeToggleButtonText}</button>
              <button id="btn-minimize" title="Minimizar/Maximizar">_</button>
              <button id="btn-close" title="Fechar">X</button>
            </div>
          </div>
          <div class="content">
            <div class="toolbar">
              <button id="hide-toggle">${
                // Texto inicial será definido por checkGlobalVisibilityState
                this.hidden
                  ? this.strings.showHighlights
                  : this.strings.hideHighlights
              }</button>
              <button id="merge-highlights" title="Mesclar destaques visíveis">Merge</button>
              <button id="clear">Clear</button>
            </div>
            <div class="search-sort-container">
              <div class="search-wrapper">
                <input type="text" id="search-input" placeholder="Search highlights..." />
                <button id="clear-search" class="clear-search-btn">×</button>
              </div>
              <button id="sort-toggle" title="Sort by text (A-Z)">↓ Creation Order</button>
            </div>
            <p class="instructions">To highlight: "Ctrl+Click" on the selection.<br>To copy: "Click" on the highlight.</p>
            <ul class="highlight-list"></ul>
          </div>
          <div class="highlight-manager-footer">
            <span>v20250701</span>
            |
            <a href="https://linktr.ee/magasine" target="_blank">by @magasine</a>
            |
            <a href="https://drive.google.com/file/d/1OBEWwQdb6QCERRy2fciS0bJxMsCaDNCR/view?usp=sharing" target="_blank">Help</a>
          </div>
        </div>
      `;
    }

    getStableParentInfo(node) {
      let current = node;
      while (current && current !== document.body) {
        if (current.id) {
          return { selector: `#${current.id}`, element: current };
        }
        current = current.parentNode;
      }
      return { selector: "body", element: document.body };
    }
  }

  const manager = new HighlightManager();
})();
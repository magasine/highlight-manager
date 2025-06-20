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
      this.hidden = false;
      this.updatePending = false;
      this.restoreQueue = new Map();
      this.sortOrder = "asc";
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
      return this.createElementSafely("span", {
        className: "highlight",
        id: `${id}-0`,
        style: this.getHighlightStyle(),
      });
    }

    fallbackHighlightCreation(range, span, text) {
      span.textContent = text;
      range.deleteContents();
      range.insertNode(span);
    }

    getHighlightStyle() {
      // Estilo de destaque baseado no tema atual
      if (this.hidden) {
        return "background-color: transparent; box-shadow: none; border-radius: 0; padding: 0;";
      } else {
        return this.currentTheme === "dark"
          ? "background-color: #ffd700; box-shadow: 0 0 0 1px rgba(255, 215, 0, 0.5); border-radius: 3px; padding: 0 2px; color: black;"
          : "background-color: yellow; box-shadow: 0 0 0 1px rgba(255, 255, 0, 0.5); border-radius: 3px; padding: 0 2px; color: black;";
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
          fullId
        );
      } catch (error) {
        console.error(`Error restoring highlight ${highlightData.id}:`, error);
        return false;
      }
    }

    findAndHighlightText(parentEl, textToFind, initialOffset, highlightId) {
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
        const span = this.createHighlightSpan(highlightId);
        if (this.hidden) span.classList.add("hidden");

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
              const success = this.restoreHighlight(data);
              if (!success) {
                console.warn(`Failed to restore highlight ${id}`);
                this.highlights.delete(id);
                this.saveToStorage();
              }
            }
            this.restoreQueue.delete(id);
          }, 1000)
        );
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
        hidden: this.hidden,
        minimized:
          this.shadowRoot?.querySelector(".content").style.display === "none",
        theme: this.currentTheme, // Salvar o tema atual
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
          this.hidden = false; // Valor padrão explícito
          this.currentTheme = this.getSystemPreferredTheme(); // Carrega o tema do sistema se não houver configurações salvas
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
        this.hidden = settings.hidden;
        this.updateHideButton();
      }

      // Novo: Aplicar tema salvo, se existir, caso contrário, usar a preferência do sistema
      if (settings.theme && (settings.theme === "light" || settings.theme === "dark")) {
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
          if (!this.highlights.has(item.id)) {
            this.highlights.set(item.id, item);
            this.scheduleHighlightRestore(item.id);
          }
        });
        this.updateHighlightListUI();
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
      this.updateHideButton();
      this.applyTheme(this.currentTheme); // Aplicar o tema inicial aqui
    }

    renderPopupContent() {
      const container = this.createElementSafely("div");

      const initialHideBtnText = this.strings.hideHighlights;
      const popupHTML = this.getPopupHTML().replace(
        "${this.strings.hideHighlights}",
        initialHideBtnText
      );

      this.setInnerHTMLSafely(container, popupHTML);
      this.shadowRoot.appendChild(container);

      // Estilos serão injetados por applyTheme
      this.updateHideButton();
    }

    setupPopupEventListeners() {
      const elements = this.getPopupElements();

      elements.clearBtn.addEventListener("click", () =>
        this.handleClearClick()
      );
      elements.hideToggleBtn.addEventListener("click", () =>
        this.handleHideToggle()
      );
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
      // Novo: Listener para alternar tema manualmente (opcional, se quiser um botão)
      elements.themeToggleBtn?.addEventListener("click", () => this.toggleTheme());


      this.enableDrag(this.shadowHost, elements.popupHeader);
    }

    getPopupElements() {
      return {
        clearBtn: this.shadowRoot.getElementById("clear"),
        hideToggleBtn: this.shadowRoot.getElementById("hide-toggle"),
        closeBtn: this.shadowRoot.getElementById("btn-close"),
        minimizeBtn: this.shadowRoot.getElementById("btn-minimize"),
        searchInput: this.shadowRoot.getElementById("search-input"),
        clearSearchBtn: this.shadowRoot.getElementById("clear-search"),
        sortToggleBtn: this.shadowRoot.getElementById("sort-toggle"),
        popupHeader: this.shadowRoot.getElementById("popup-header"),
        content: this.shadowRoot.querySelector(".content"),
        themeToggleBtn: this.shadowRoot.getElementById("theme-toggle"), // Novo elemento
      };
    }

    handleClearClick() {
      if (confirm(this.strings.confirmClear)) {
        this.clearHighlights();
        this.showFeedback("Todos os destaques foram removidos", "success");
      }
    }

    handleHideToggle() {
      this.hidden = !this.hidden;
      this.updateHideButton();
      this.saveUISettings();

      // Atualizar todos os highlights
      this.highlights.forEach((_, id) => {
        this.toggleHighlightVisibility(id, !this.hidden);

        // Atualizar o estado do checkbox correspondente
        const checkbox = this.shadowRoot.querySelector(
          `#li-${id} input[type="checkbox"]`
        );
        if (checkbox) {
          checkbox.checked = !this.hidden;
        }
      });
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
      this.sortOrder = this.sortOrder === "asc" ? "desc" : "asc";
      this.updateSortButton();
      this.updateHighlightListUI(
        this.shadowRoot.getElementById("search-input").value
      );
      this.saveUISettings();
    }

    updateSortButton() {
      const sortBtn = this.shadowRoot.getElementById("sort-toggle");
      if (sortBtn) {
        sortBtn.textContent = this.sortOrder === "asc" ? "A-Z ↑" : "Z-A ↓";
      }
    }

    updateHideButton() {
      const hideBtn = this.shadowRoot.getElementById("hide-toggle");
      if (hideBtn) {
        hideBtn.textContent = this.hidden
          ? this.strings.showHighlights
          : this.strings.hideHighlights;

        // Adicionar/remover classe para feedback visual
        if (this.hidden) {
          hideBtn.classList.add("hidden-state");
        } else {
          hideBtn.classList.remove("hidden-state");
        }
      }
    }

    addHighlightItem({ id, text }) {
      const list = this.shadowRoot?.querySelector(".highlight-list");
      if (!list || this.shadowRoot.getElementById(`li-${id}`)) return;

      const li = this.createElementSafely("li", { id: `li-${id}` });
      const removeBtn = this.createRemoveButton(id);
      const checkbox = this.createVisibilityCheckbox(id);
      const link = this.createHighlightLink(id, text);

      li.append(removeBtn, checkbox, link);
      list.appendChild(li);
      this.toggleHighlightVisibility(id, checkbox.checked);
    }

    createRemoveButton(id) {
      const removeBtn = this.createElementSafely("button", {
        textContent: "✕",
        attributes: { title: "Remover destaque" },
      });
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeHighlightById(id);
      });
      return removeBtn;
    }

    createVisibilityCheckbox(id) {
      const checkbox = this.createElementSafely("input", {
        attributes: {
          type: "checkbox",
          checked: !this.hidden,
        },
      });
      checkbox.addEventListener("change", (e) => {
        e.stopPropagation();
        this.toggleHighlightVisibility(id, e.target.checked);
      });
      return checkbox;
    }

    createHighlightLink(id, text) {
      const link = this.createElementSafely("a", {
        textContent: this.escapeHTML(
          text.length > 30 ? `${text.slice(0, 30)}…` : text
        ),
        style: "text-decoration:none;cursor:pointer;", // Removendo cor fixa
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
        el.replaceWith(...el.childNodes);
      });
      this.highlights.delete(id);
      this.saveToStorage();
      this.shadowRoot.getElementById(`li-${id}`)?.remove();
    }

    toggleHighlightVisibility(id, visible) {
      const highlights = document.querySelectorAll(`[id^="${id}-"]`);
      if (!highlights.length) return;

      const style = visible
        ? this.getHighlightStyle() // Usar o estilo de destaque do tema
        : "background-color: transparent; box-shadow: none; border-radius: 0; padding: 0;";

      highlights.forEach((el) => {
        this.applyStyles(el, style);

        // Atualizar classe para estilização adicional se necessário
        visible ? el.classList.remove("hidden") : el.classList.add("hidden");
      });
    }

    scrollToHighlight(id) {
      const firstPart = document.getElementById(`${id}-0`);
      if (!firstPart) return;

      this.applyStyles(firstPart, "animation: highlight-pulse 0.5s 2;");
      firstPart.scrollIntoView({ behavior: "smooth", block: "center" });

      setTimeout(() => {
        this.applyStyles(firstPart, "");
      }, 1000);
    }

    updateHighlightListUI(filterText = "") {
      if (!this.shadowRoot) return;

      const list = this.shadowRoot.querySelector(".highlight-list");
      if (!list) return;

      list.innerHTML = ""; // Clear existing items

      const highlightsArray = this.filterAndSortHighlights(filterText);
      highlightsArray.forEach((item) => this.addHighlightItem(item));
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
        const textA = a.text.toLowerCase();
        const textB = b.text.toLowerCase();
        return this.sortOrder === "asc"
          ? textA.localeCompare(textB)
          : textB.localeCompare(textA);
      });
    }

    clearHighlights() {
      this.highlights.forEach((_, id) => {
        document.querySelectorAll(`[id^="${id}-"]`).forEach((el) => {
          el.replaceWith(...el.childNodes);
        });
      });
      this.highlights.clear();
      localStorage.removeItem("highlights");
      this.updateHighlightListUI();
    }

    toggleHighlightsVisibility() {
      this.hidden = !this.hidden;
      this.updateHideButton();

      this.highlights.forEach((_, id) => {
        const checkbox = this.shadowRoot.querySelector(
          `#li-${id} input[type="checkbox"]`
        );
        if (checkbox) {
          checkbox.checked = !this.hidden;
          this.toggleHighlightVisibility(id, !this.hidden);
        }
      });
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

        startX = e.clientX;
        startY = e.clientY;
        initialTop = parseInt(element.style.top) || 0;
        initialLeft = parseInt(element.style.left) || 0;

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

          element.style.top = `${initialTop + dy}px`;
          element.style.left = `${initialLeft + dx}px`;
          element.style.right = "auto";
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
      // Este método será agora chamado por applyTheme
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
            this.highlights.forEach((_, id) => {
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
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    setupThemeDetection() {
        const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)');
        this.currentTheme = this.getSystemPreferredTheme(); // Inicializa com a preferência do sistema
        this.applyTheme(this.currentTheme); // Aplica o tema inicial
        prefersDarkScheme.addEventListener('change', this.handleThemeChange);
        this.mediaQueryList = prefersDarkScheme; // Armazenar para remover o listener
    }

    handleThemeChange(event) {
        this.currentTheme = event.matches ? 'dark' : 'light';
        this.applyTheme(this.currentTheme);
        this.saveUISettings(); // Salva a nova preferência do tema
        this.updateHighlightListUI(this.shadowRoot?.getElementById("search-input")?.value || ""); // Reaplicar estilos de destaque
    }

    removeThemeListeners() {
        if (this.mediaQueryList) {
            this.mediaQueryList.removeEventListener('change', this.handleThemeChange);
        }
    }

    applyTheme(theme) {
        this.currentTheme = theme;
        if (this.shadowHost) {
            this.shadowHost.classList.remove('light-theme', 'dark-theme');
            this.shadowHost.classList.add(`${theme}-theme`);
        }

        // Atualiza os estilos com base no tema
        this.styles = this.getStyles(theme);

        // Reinjeta o estilo global
        this.injectGlobalHighlightStyle();

        // Atualiza o estilo do popup dentro do shadow DOM
        if (this.shadowRoot) {
            let styleElement = this.shadowRoot.querySelector('style');
            if (!styleElement) {
                styleElement = this.createElementSafely("style");
                this.shadowRoot.appendChild(styleElement);
            }
            styleElement.textContent = this.trustedTypesPolicy
                ? this.trustedTypesPolicy.createHTML(this.styles.popup)
                : this.styles.popup;
        }

        // Reaplicar estilos a todos os destaques existentes
        this.highlights.forEach((_, id) => {
            const highlightSpans = document.querySelectorAll(`[id^="${id}-"]`);
            highlightSpans.forEach(span => {
                this.applyStyles(span, this.getHighlightStyle());
            });
        });

        // Atualizar a aparência dos links na lista de destaques
        this.shadowRoot?.querySelectorAll('.highlight-list a').forEach(link => {
            this.applyStyles(link, this.getHighlightLinkStyle(theme));
        });

         // Atualizar o texto do botão de alternância de tema, se existir
         const themeToggleBtn = this.shadowRoot?.getElementById("theme-toggle");
         if (themeToggleBtn) {
             themeToggleBtn.textContent = this.currentTheme === "dark" ? "☀️ Light" : "🌙 Dark";
         }
    }

    toggleTheme() {
        this.currentTheme = this.currentTheme === 'light' ? 'dark' : 'light';
        this.applyTheme(this.currentTheme);
        this.saveUISettings();
        this.updateHighlightListUI(this.shadowRoot?.getElementById("search-input")?.value || "");
    }

    getHighlightLinkStyle(theme) {
        return theme === 'dark' ? "text-decoration:none;color:#9bc5ef;cursor:pointer;" : "text-decoration:none;color:#0645AD;cursor:pointer;";
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
            box-shadow: 0 0 0 1px ${isDark ? "rgba(255, 215, 0, 0.5)" : "rgba(255, 255, 0, 0.5)"};
            transition: all 0.3s ease;
          }

          .highlight.hidden {
            background-color: transparent !important;
            box-shadow: none !important;
          }

          .highlight.pulse-animation {
            animation: highlight-pulse 0.5s 2 !important;
            background-color: ${isDark ? "#ffd700" : "yellow"} !important;
            box-shadow: 0 0 0 1px ${isDark ? "rgba(255, 215, 0, 0.5)" : "rgba(255, 215, 0, 0.5)"};
          }
          @keyframes highlight-pulse {
            0% { box-shadow: 0 0 0 0 ${isDark ? "rgba(255, 215, 0, 0.8)" : "rgba(255, 215, 0, 0.8)"}; }
            50% { box-shadow: 0 0 0 15px ${isDark ? "rgba(255, 215, 0, 0)" : "rgba(255, 215, 0, 0)"}; }
            100% { box-shadow: 0 0 0 0 ${isDark ? "rgba(255, 215, 0, 0.8)" : "rgba(255, 215, 0, 0.8)"}; }
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
          }
          .toolbar button {
            font-size: 0.75rem;
            padding: 4px 6px;
            border: 1px solid ${isDark ? "#888" : "#888"};
            background: ${isDark ? "#444" : "white"};
            color: ${isDark ? "#e0e0e0" : "black"};
            border-radius: 5px;
            cursor: pointer;
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
            color: ${isDark ? "#9bc5ef" : "#0645AD"}; /* Cor do link adaptada ao tema */
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
            border-bottom-left-radius: 6px; /* Adjusted radius to match popup */
            border-bottom-right-radius: 6px; /* Adjusted radius to match popup */
            background: ${isDark ? "#444" : "#f0f0f0"}; /* Adapted to theme */
            color: ${isDark ? "#ddd" : "#666"}; /* Adapted to theme */
            border-top: 1px solid ${isDark ? "#555" : "#ccc"};
          }
          .highlight-manager-footer a {
            color: ${isDark ? "#ddd" : "#666"}; /* Adapted to theme */
            /* color: ${isDark ? "#9bc5ef" : "#0645AD"};  Link color adapted to theme */
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
      // Adicionado um botão para alternar tema manualmente, é opcional.
      const themeToggleButtonText = this.currentTheme === "dark" ? "☀️ Light" : "🌙 Dark";
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
                this.hidden
                  ? this.strings.showHighlights
                  : this.strings.hideHighlights
              }</button>
              <button id="clear">Clear</button>
            </div>
            <div class="search-sort-container">
              <div class="search-wrapper">
                <input type="text" id="search-input" placeholder="Search highlights..." />
                <button id="clear-search" class="clear-search-btn">×</button>
              </div>
              <button id="sort-toggle" title="Sort A-Z/Z-A">A-Z ⇅</button>
            </div>
            <p class="instructions">Ctrl+Click para destacar texto.</p>
            <ul class="highlight-list"></ul>
          </div>
          <div class="highlight-manager-footer">
            <span>v20250619</span>
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
  setTimeout(() => manager.updateHighlightListUI(), 0);
})();

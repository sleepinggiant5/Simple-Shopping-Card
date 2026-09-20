/**
 * Simple Shopping Card for Home Assistant
 * -------------------------------------
 * A shopping-list style card for any `todo.*` entity:
 *   - add / check / delete items
 *   - +/- quantity stepper on every item
 *   - choose how long completed items stay visible (today, 24h, 7d, ...)
 *
 * No build step needed. Plain custom element, themed with HA CSS variables.
 */

const CARD_VERSION = "1.0.0";

const PERIODS = {
  today: {
    label: "Today",
    since: () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    },
  },
  "24h": { label: "Last 24 hours", since: () => Date.now() - 24 * 3600 * 1000 },
  "7d": { label: "Last 7 days", since: () => Date.now() - 7 * 24 * 3600 * 1000 },
  "30d": { label: "Last 30 days", since: () => Date.now() - 30 * 24 * 3600 * 1000 },
  all: { label: "All time", since: () => -Infinity },
  none: { label: "Hide completed", since: () => Infinity },
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

class SimpleShoppingCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._items = [];
    this._stamps = {};
    this._pending = {}; // uid -> qty not yet written to HA
    this._timers = {};
    this._lastStamp = null;
    this._error = null;
    this._loaded = false;
  }

  /* ---------- HA card API ---------- */

  static getStubConfig(hass) {
    const entity = Object.keys(hass.states).find((id) => id.startsWith("todo."));
    return { entity: entity || "todo.shopping_list" };
  }

  setConfig(config) {
    if (!config.entity) throw new Error("Please define an entity (a todo.* entity)");
    this._config = {
      title: null,
      completed_period: "today",
      quantity_storage: "summary", // "summary" -> "2 × Milk", "description" -> description = "2"
      show_period_selector: true,
      show_clear_completed: true,
      ...config,
    };
    const saved = this._loadPref("period");
    this._period = PERIODS[saved] ? saved : PERIODS[this._config.completed_period] ? this._config.completed_period : "today";
    this._build();
    if (this._hass) this._fetch();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const st = hass.states[this._config.entity];
    const stamp = st ? st.last_updated : "missing";
    if (stamp !== this._lastStamp) {
      this._lastStamp = stamp;
      this._fetch();
    }
  }

  getCardSize() {
    return 4;
  }

  /* ---------- storage helpers (per browser) ---------- */

  _key(suffix) {
    return `ha-todo-qty-card:${this._config.entity}:${suffix}`;
  }
  _loadPref(name) {
    try {
      return localStorage.getItem(this._key(name));
    } catch (e) {
      return null;
    }
  }
  _savePref(name, value) {
    try {
      localStorage.setItem(this._key(name), value);
    } catch (e) {}
  }

  /* ---------- item model ---------- */

  _parseSummary(text) {
    const m = String(text).trim().match(/^(\d+)\s*[x×]\s*(.+)$/i);
    return m ? { qty: Math.max(1, parseInt(m[1], 10)), name: m[2].trim() } : { qty: 1, name: String(text).trim() };
  }

  _parse(raw) {
    let name = raw.summary || "";
    let qty = 1;
    if (this._config.quantity_storage === "description") {
      const m = String(raw.description || "").match(/^\s*(\d+)\s*$/);
      if (m) qty = Math.max(1, parseInt(m[1], 10));
    } else {
      ({ name, qty } = this._parseSummary(name));
    }
    return { uid: raw.uid, name, qty, done: raw.status === "completed" };
  }

  _qtyPayload(name, qty) {
    return this._config.quantity_storage === "description"
      ? { description: String(qty) }
      : { rename: qty > 1 ? `${qty} × ${name}` : name };
  }

  /* ---------- completion timestamps ----------
   * Todo entities don't record *when* an item was completed, so the card
   * remembers it itself (in this browser). Items already completed the first
   * time the card runs get timestamp 0 ("old"), so they only show under
   * "All time".
   */
  _syncStamps() {
    let map = null;
    try {
      const s = localStorage.getItem(this._key("completed"));
      map = s ? JSON.parse(s) : null;
    } catch (e) {}
    const first = !map;
    map = map || {};
    const now = Date.now();
    const seen = new Set();
    for (const it of this._items) {
      seen.add(it.uid);
      if (it.done) {
        if (!(it.uid in map)) map[it.uid] = first ? 0 : now;
      } else {
        delete map[it.uid];
      }
    }
    for (const uid of Object.keys(map)) if (!seen.has(uid)) delete map[uid];
    this._stamps = map;
    this._saveStamps();
  }

  _saveStamps() {
    try {
      localStorage.setItem(this._key("completed"), JSON.stringify(this._stamps));
    } catch (e) {}
  }

  /* ---------- data ---------- */

  async _fetch() {
    if (!this._hass || !this._config) return;
    try {
      const res = await this._hass.callWS({
        type: "call_service",
        domain: "todo",
        service: "get_items",
        target: { entity_id: this._config.entity },
        service_data: { status: ["needs_action", "completed"] },
        return_response: true,
      });
      const raw = res?.response?.[this._config.entity]?.items ?? [];
      this._items = raw.map((r) => this._parse(r));
      for (const it of this._items) if (it.uid in this._pending) it.qty = this._pending[it.uid];
      this._syncStamps();
      this._error = null;
      this._loaded = true;
    } catch (e) {
      this._error = e?.message || "Could not load items. Is the entity a todo list?";
    }
    this._render();
  }

  async _call(service, data) {
    try {
      await this._hass.callService("todo", service, data, { entity_id: this._config.entity });
    } catch (e) {
      this._error = e?.message || `Action failed: ${service}`;
      this._render();
    }
  }

  /* ---------- actions ---------- */

  async _add(text) {
    const { name, qty } = this._parseSummary(text);
    if (!name) return;
    if (this._config.quantity_storage === "description") {
      await this._call("add_item", qty > 1 ? { item: name, description: String(qty) } : { item: name });
    } else {
      await this._call("add_item", { item: qty > 1 ? `${qty} × ${name}` : name });
    }
    this._fetch();
  }

  _toggle(uid) {
    const it = this._items.find((i) => i.uid === uid);
    if (!it) return;
    it.done = !it.done;
    if (it.done) this._stamps[uid] = Date.now();
    else delete this._stamps[uid];
    this._saveStamps();
    this._render();
    this._call("update_item", { item: uid, status: it.done ? "completed" : "needs_action" });
  }

  _changeQty(uid, delta) {
    const it = this._items.find((i) => i.uid === uid);
    if (!it) return;
    const qty = Math.max(1, it.qty + delta);
    if (qty === it.qty) return;
    it.qty = qty;
    this._pending[uid] = qty;
    this._render();
    clearTimeout(this._timers[uid]);
    this._timers[uid] = setTimeout(async () => {
      delete this._timers[uid];
      await this._call("update_item", { item: uid, ...this._qtyPayload(it.name, qty) });
      delete this._pending[uid];
    }, 600);
  }

  async _remove(uid) {
    this._items = this._items.filter((i) => i.uid !== uid);
    this._render();
    await this._call("remove_item", { item: uid });
    this._fetch();
  }

  async _clearCompleted() {
    if (!confirm("Remove ALL completed items from this list, including ones hidden by the time filter?")) return;
    await this._call("remove_completed_items", {});
    this._fetch();
  }

  /* ---------- DOM ---------- */

  _build() {
    const periodOptions = Object.entries(PERIODS)
      .map(([k, v]) => `<option value="${k}" ${k === this._period ? "selected" : ""}>${v.label}</option>`)
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding-bottom: 8px; overflow: hidden; }
        .header {
          padding: 16px 16px 4px;
          font-size: var(--ha-card-header-font-size, 24px);
          font-weight: 400;
          color: var(--ha-card-header-color, var(--primary-text-color));
          line-height: 1.2;
        }
        .add {
          display: flex; gap: 8px; padding: 8px 16px;
        }
        .add input {
          flex: 1; min-width: 0;
          padding: 10px 12px;
          font: inherit; color: var(--primary-text-color);
          background: var(--secondary-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 10px;
        }
        .add input:focus-visible, button:focus-visible, select:focus-visible {
          outline: 2px solid var(--primary-color); outline-offset: 1px;
        }
        button {
          font: inherit; color: var(--primary-text-color);
          background: none; border: none; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 50%;
        }
        .add button {
          background: var(--primary-color); color: var(--text-primary-color, #fff);
          border-radius: 10px; padding: 0 14px; min-height: 40px; font-weight: 500;
        }
        .row {
          display: flex; align-items: center; gap: 12px;
          padding: 4px 8px 4px 16px; min-height: 48px;
        }
        .row + .row { border-top: 1px solid var(--divider-color); }
        .row.done { padding-right: 16px; }
        .row input[type=checkbox] {
          width: 22px; height: 22px; flex: none; margin: 0;
          accent-color: var(--primary-color); cursor: pointer;
        }
        .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        .row.done .name { text-decoration: line-through; color: var(--secondary-text-color); }
        .stepper {
          display: inline-flex; align-items: center;
          background: var(--secondary-background-color);
          border-radius: 999px; flex: none;
        }
        .stepper button { width: 32px; height: 32px; font-size: 20px; line-height: 1; }
        .stepper button:disabled { opacity: .3; cursor: default; }
        .stepper .n { min-width: 22px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 500; }
        .badge { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; flex: none; }
        .del { width: 36px; height: 36px; color: var(--secondary-text-color); flex: none; }
        .empty { padding: 12px 16px; color: var(--secondary-text-color); }
        .completed-head {
          display: flex; align-items: center; gap: 8px;
          padding: 12px 8px 4px 16px; margin-top: 4px;
          border-top: 1px solid var(--divider-color);
          color: var(--secondary-text-color); font-weight: 500;
        }
        .completed-head .title { flex: 1; }
        .completed-head select {
          font: inherit; color: var(--primary-text-color);
          background: var(--secondary-background-color);
          border: 1px solid var(--divider-color); border-radius: 8px; padding: 4px 8px;
        }
        .error {
          margin: 8px 16px; padding: 8px 12px; border-radius: 8px;
          background: var(--error-color); color: #fff; font-size: 14px;
        }
      </style>
      <ha-card>
        ${this._config.title ? `<div class="header">${esc(this._config.title)}</div>` : ""}
        <div id="error"></div>
        <div class="add">
          <input id="new" type="text" placeholder="Add item (e.g. 2x milk)" autocomplete="off" enterkeyhint="done" />
          <button id="add" type="button">Add</button>
        </div>
        <div id="active"></div>
        <div class="completed-head">
          <span class="title">Completed <span id="count"></span></span>
          ${
            this._config.show_period_selector
              ? `<select id="period" aria-label="Show completed items from">${periodOptions}</select>`
              : ""
          }
          ${
            this._config.show_clear_completed
              ? `<button id="clear" class="del" type="button" title="Remove all completed items" aria-label="Remove all completed items"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon></button>`
              : ""
          }
        </div>
        <div id="completed"></div>
      </ha-card>
    `;

    const root = this.shadowRoot;
    const input = root.getElementById("new");
    const submit = () => {
      const v = input.value;
      input.value = "";
      this._add(v);
    };
    root.getElementById("add").addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    const period = root.getElementById("period");
    if (period) {
      period.addEventListener("change", () => {
        this._period = period.value;
        this._savePref("period", this._period);
        this._render();
      });
    }
    const clear = root.getElementById("clear");
    if (clear) clear.addEventListener("click", () => this._clearCompleted());

    root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const uid = btn.closest("[data-uid]")?.dataset.uid;
      if (!uid) return;
      switch (btn.dataset.action) {
        case "inc": return this._changeQty(uid, 1);
        case "dec": return this._changeQty(uid, -1);
        case "del": return this._remove(uid);
      }
    });
    root.addEventListener("change", (e) => {
      const cb = e.target.closest('input[data-action="toggle"]');
      if (cb) this._toggle(cb.closest("[data-uid]").dataset.uid);
    });

    this._render();
  }

  _render() {
    const root = this.shadowRoot;
    if (!root.getElementById("active")) return;

    root.getElementById("error").innerHTML = this._error ? `<div class="error">${esc(this._error)}</div>` : "";

    const active = this._items.filter((i) => !i.done);
    const since = PERIODS[this._period].since();
    const completed = this._items
      .filter((i) => i.done && (this._stamps[i.uid] ?? 0) >= since)
      .sort((a, b) => (this._stamps[b.uid] ?? 0) - (this._stamps[a.uid] ?? 0));

    root.getElementById("active").innerHTML = active.length
      ? active
          .map(
            (i) => `
        <div class="row" data-uid="${esc(i.uid)}">
          <input type="checkbox" data-action="toggle" aria-label="Mark ${esc(i.name)} as done" />
          <span class="name">${esc(i.name)}</span>
          <div class="stepper">
            <button type="button" data-action="dec" aria-label="Decrease quantity" ${i.qty <= 1 ? "disabled" : ""}>−</button>
            <span class="n" aria-live="polite">${i.qty}</span>
            <button type="button" data-action="inc" aria-label="Increase quantity">+</button>
          </div>
          <button type="button" class="del" data-action="del" aria-label="Delete ${esc(i.name)}">
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>`
          )
          .join("")
      : `<div class="empty">${this._loaded ? "Nothing on the list. Add your first item above." : "Loading…"}</div>`;

    root.getElementById("completed").innerHTML = completed
      .map(
        (i) => `
        <div class="row done" data-uid="${esc(i.uid)}">
          <input type="checkbox" data-action="toggle" checked aria-label="Mark ${esc(i.name)} as not done" />
          <span class="name">${esc(i.name)}</span>
          ${i.qty > 1 ? `<span class="badge">× ${i.qty}</span>` : ""}
        </div>`
      )
      .join("");

    root.getElementById("count").textContent = this._period === "none" ? "" : `(${completed.length})`;
  }
}

customElements.define("simple-shopping-card", SimpleShoppingCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "simple-shopping-card",
  name: "Simple Shopping Card",
  description: "Shopping-list style todo card with item quantities and a completed-items time filter.",
});

console.info(`%c SIMPLE-SHOPPING-CARD %c v${CARD_VERSION} `, "background:#03a9f4;color:#fff", "background:#333;color:#fff");

class ChlorinatorTankCard extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Configuration manquante");
    this.config = {
      name: "Bidon de chlore",
      tank_capacity: 20,
      low_threshold: 25,
      critical_threshold: 10,
      empty_threshold: 5,
      ...config
    };
    if (!this.shadowRoot) this.attachShadow({mode: "open"});
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this.config) this.render();
  }

  getCardSize() { return 5; }

  _value(entity) {
    const s = this._hass?.states?.[entity];
    if (!s || ["unknown", "unavailable"].includes(s.state)) return null;
    const n = Number.parseFloat(s.state);
    return Number.isFinite(n) ? n : null;
  }

  render() {
    if (!this._hass) return;
    const c = this.config;
    const total = this._value(c.volume_total_entity);
    const baseline = this._value(c.refill_baseline_entity);
    const today = this._value(c.volume_today_entity);
    const yesterday = this._value(c.volume_yesterday_entity);
    const capacity = Number(c.tank_capacity) || 20;

    const consumed = total !== null && baseline !== null
      ? Math.max(0, total - baseline) : null;
    const remaining = consumed === null
      ? null : Math.max(0, Math.min(capacity, capacity - consumed));
    const percent = remaining === null
      ? null : Math.max(0, Math.min(100, remaining / capacity * 100));

    let level = "normal";
    if (percent === null) level = "unknown";
    else if (percent <= c.empty_threshold) level = "empty";
    else if (percent <= c.critical_threshold) level = "critical";
    else if (percent <= c.low_threshold) level = "low";

    const fmt = v => v === null ? "—" : `${v.toFixed(2)} L`;
    const pct = percent === null ? "—" : `${percent.toFixed(1)} %`;

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        ha-card{padding:16px;overflow:hidden}
        .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
        .title{font-size:1.15rem;font-weight:600}
        .content{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center}
        .tank-wrap{position:relative;width:120px;height:190px;margin:auto}
        .tank{position:absolute;inset:10px 12px 8px;border:3px solid var(--divider-color);
          border-radius:18px 18px 12px 12px;overflow:hidden;background:rgba(127,127,127,.08)}
        .neck{position:absolute;top:0;left:43px;width:34px;height:14px;border:3px solid var(--divider-color);
          border-bottom:0;border-radius:8px 8px 0 0}
        .liquid{position:absolute;left:0;right:0;bottom:0;height:${percent ?? 0}%;
          transition:height .9s ease;background:linear-gradient(to bottom,rgba(80,170,255,.72),rgba(35,105,210,.92))}
        .tank.low .liquid{background:linear-gradient(to bottom,#f5b642,#d98200)}
        .tank.critical .liquid{background:linear-gradient(to bottom,#ff6b5f,#d93025)}
        .tank.empty .liquid{background:#888}
        .tank.unknown .liquid{background:#777;opacity:.35}
        .stats{display:grid;gap:10px}
        .main{font-size:2rem;font-weight:700}
        .sub{opacity:.7}
        .row{display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--divider-color)}
        button{width:100%;margin-top:16px;border:0;border-radius:12px;padding:11px;background:var(--primary-color);
          color:var(--text-primary-color,#fff);font:inherit;font-weight:600;cursor:pointer}
      </style>
      <ha-card>
        <div class="header"><div class="title">${c.name}</div><ha-icon icon="mdi:flask"></ha-icon></div>
        <div class="content">
          <div class="tank-wrap"><div class="neck"></div><div class="tank ${level}">
            <div class="liquid"></div>
          </div></div>
          <div class="stats">
            <div><div class="main">${fmt(remaining)}</div><div class="sub">${pct} restant</div></div>
            <div class="row"><span>Capacité</span><span>${capacity.toFixed(0)} L</span></div>
            <div class="row"><span>Aujourd'hui</span><span>${fmt(today)}</span></div>
            <div class="row"><span>Hier</span><span>${fmt(yesterday)}</span></div>
          </div>
        </div>
        <button id="refill">🧴 Bidon rempli</button>
      </ha-card>`;

    this.shadowRoot.querySelector("#refill")?.addEventListener("click", () => {
      if (total === null || !c.refill_baseline_entity) return;
      this._hass.callService("input_number", "set_value", {
        entity_id: c.refill_baseline_entity,
        value: total
      });
    });
  }
}

customElements.define("chlorinator-tank-card", ChlorinatorTankCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "chlorinator-tank-card",
  name: "Chlorinator Tank Card",
  description: "Bidon de dosage avec niveau calculé depuis un volume cumulatif."
});

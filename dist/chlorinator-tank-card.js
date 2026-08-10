class ChlorinatorTankCard extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Configuration manquante");
    this.config = {
      name: "Bidon de chlore",
      icon: "mdi:flask",
      tank_capacity: 20,
      low_threshold: 25,
      critical_threshold: 10,
      empty_threshold: 5,
      // Entité optionnelle (ex: input_text ou input_datetime) pour mémoriser
      // la date de changement du bidon entre deux rechargements de la page.
      refill_date_entity: null,
      // Nombre de jours utilisés pour la moyenne glissante de consommation
      rolling_average_days: 7,
      ...config
    };
    if (!this.shadowRoot) this.attachShadow({mode: "open"});
    // Date locale de secours si aucune refill_date_entity n'est configurée
    this._localRefillDate = this._localRefillDate || null;
    // Cache de la moyenne glissante calculée depuis l'historique
    this._rollingAvg = this._rollingAvg ?? null;
    this._rollingAvgDays = this._rollingAvgDays ?? 0;
    this._historyFetchedAt = this._historyFetchedAt ?? 0;
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

  _formatDate(d) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  _currentRefillDate() {
    const c = this.config;
    // Priorité à l'entité HA si configurée (persiste entre rechargements)
    if (c.refill_date_entity) {
      const s = this._hass?.states?.[c.refill_date_entity];
      if (s && !["unknown", "unavailable", ""].includes(s.state)) {
        const d = new Date(s.state);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
    // Sinon, valeur locale mémorisée depuis le dernier clic dans cette session
    if (this._localRefillDate) return this._localRefillDate;
    return null;
  }

  _currentRefillDateLabel() {
    return this._formatDate(this._currentRefillDate());
  }

  _daysSince(date) {
    if (!date) return null;
    // On compare uniquement les dates calendaires (sans les heures) pour un compte "jours" cohérent
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffMs = today - start;
    return Math.max(0, Math.round(diffMs / 86400000));
  }

  _dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  // Récupère l'historique du capteur de volume journalier et calcule la
  // consommation moyenne sur les N derniers jours complets (jour en cours exclu,
  // car son compteur n'est pas encore terminé).
  async _fetchRollingAverage() {
    const c = this.config;
    const entity = c.volume_today_entity;
    if (!this._hass || !entity) return;

    const now = Date.now();
    // On ne rafraîchit l'historique qu'une fois par heure pour ne pas spammer l'API
    if (this._historyFetchedAt && now - this._historyFetchedAt < 3600000) return;
    this._historyFetchedAt = now;

    const days = Number(c.rolling_average_days) || 7;

    try {
      const start = new Date();
      start.setDate(start.getDate() - (days + 1));
      const url = `history/period/${start.toISOString()}?filter_entity_id=${entity}`;
      const result = await this._hass.callApi("GET", url);
      const entries = (result && result[0]) || [];

      // Le capteur remonte progressivement dans la journée puis repart de 0 :
      // on garde donc la valeur MAX observée pour chaque jour calendaire.
      const maxByDay = {};
      for (const entry of entries) {
        const v = Number.parseFloat(entry.state);
        if (!Number.isFinite(v)) continue;
        const ts = entry.last_changed || entry.last_updated;
        if (!ts) continue;
        const key = this._dayKey(new Date(ts));
        if (maxByDay[key] === undefined || v > maxByDay[key]) maxByDay[key] = v;
      }

      const todayKey = this._dayKey(new Date());
      const completedDays = Object.entries(maxByDay)
        .filter(([key, v]) => key !== todayKey && v > 0)
        .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // plus récent en premier
        .slice(0, days)
        .map(([, v]) => v);

      if (completedDays.length) {
        this._rollingAvg = completedDays.reduce((a, b) => a + b, 0) / completedDays.length;
        this._rollingAvgDays = completedDays.length;
      } else {
        this._rollingAvg = null;
        this._rollingAvgDays = 0;
      }
    } catch (err) {
      console.warn("chlorinator-tank-card: échec de récupération de l'historique", err);
    }

    this.render();
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

    // Estimation d'autonomie : on privilégie la moyenne glissante calculée depuis
    // l'historique (plus stable), avec repli sur la moyenne aujourd'hui/hier
    // tant que l'historique n'a pas encore été chargé.
    const dailySamples = [today, yesterday].filter(v => v !== null && v > 0);
    const fallbackAvg = dailySamples.length
      ? dailySamples.reduce((a, b) => a + b, 0) / dailySamples.length
      : null;
    const avgDaily = this._rollingAvg ?? fallbackAvg;
    const daysLeft = remaining !== null && avgDaily
      ? remaining / avgDaily
      : null;
    const daysLeftLabel = daysLeft === null
      ? "—"
      : daysLeft < 1
        ? "< 1 jour"
        : `≈ ${Math.round(daysLeft)} j`;
    const avgDailyLabel = this._rollingAvg !== null
      ? `${fmt(this._rollingAvg)}/j (moy. ${this._rollingAvgDays}j)`
      : fallbackAvg !== null
        ? `${fmt(fallbackAvg)}/j (approx.)`
        : "—";

    // Déclenche (au besoin) le rafraîchissement de l'historique en tâche de fond
    this._fetchRollingAverage();

    const refillDate = this._currentRefillDate();
    const refillDateLabel = this._formatDate(refillDate);
    const daysSince = this._daysSince(refillDate);
    const daysSinceLabel = daysSince === null
      ? ""
      : daysSince === 0
        ? " (aujourd'hui)"
        : daysSince === 1
          ? " (hier)"
          : ` (il y a ${daysSince} j)`;
    const buttonLabel = refillDateLabel
      ? `🧴 Bidon changé le ${refillDateLabel}${daysSinceLabel}`
      : `🧴 Bidon changé le`;

    const showWarning = level === "critical" || level === "empty";

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
        .icons{display:flex;align-items:center;gap:6px}
        .warning-badge{color:#d93025;display:flex;align-items:center}
        .warning-badge ha-icon{--mdc-icon-size:22px}
      </style>
      <ha-card>
        <div class="header">
          <div class="title">${c.name}</div>
          <div class="icons">
            ${showWarning ? `<span class="warning-badge" title="Niveau ${level === "empty" ? "vide" : "critique"}"><ha-icon icon="mdi:alert"></ha-icon></span>` : ""}
            <ha-icon icon="${c.icon}"></ha-icon>
          </div>
        </div>
        <div class="content">
          <div class="tank-wrap"><div class="neck"></div><div class="tank ${level}">
            <div class="liquid"></div>
          </div></div>
          <div class="stats">
            <div><div class="main">${fmt(remaining)}</div><div class="sub">${pct} restant</div></div>
            <div class="row"><span>Capacité</span><span>${capacity.toFixed(0)} L</span></div>
            <div class="row"><span>Aujourd'hui</span><span>${fmt(today)}</span></div>
            <div class="row"><span>Hier</span><span>${fmt(yesterday)}</span></div>
            <div class="row"><span>Conso. moyenne</span><span>${avgDailyLabel}</span></div>
            <div class="row"><span>Autonomie estimée</span><span>${daysLeftLabel}</span></div>
          </div>
        </div>
        <button id="refill">${buttonLabel}</button>
      </ha-card>`;

    this.shadowRoot.querySelector("#refill")?.addEventListener("click", () => {
      if (total === null || !c.refill_baseline_entity) return;
      const now = new Date();

      this._hass.callService("input_number", "set_value", {
        entity_id: c.refill_baseline_entity,
        value: total
      });

      if (c.refill_date_entity) {
        // Adapte le service selon le type d'entité utilisé pour stocker la date
        const domain = c.refill_date_entity.split(".")[0];
        if (domain === "input_datetime") {
          this._hass.callService("input_datetime", "set_datetime", {
            entity_id: c.refill_date_entity,
            date: now.toISOString().slice(0, 10)
          });
        } else {
          // input_text ou autre entité acceptant set_value
          this._hass.callService("input_text", "set_value", {
            entity_id: c.refill_date_entity,
            value: now.toISOString().slice(0, 10)
          });
        }
      } else {
        // Pas d'entité configurée : on mémorise localement (perdu au rechargement de la page)
        this._localRefillDate = now;
      }

      this.render();
    });
  }

  static getConfigForm() {
    return {
      schema: [
        { name: "name", selector: { text: {} } },
        { name: "icon", selector: { icon: {} } },
        { name: "tank_capacity", selector: { number: { mode: "box", unit_of_measurement: "L" } } },
        { name: "low_threshold", selector: { number: { mode: "box", unit_of_measurement: "%" } } },
        { name: "critical_threshold", selector: { number: { mode: "box", unit_of_measurement: "%" } } },
        { name: "empty_threshold", selector: { number: { mode: "box", unit_of_measurement: "%" } } },
        { name: "volume_total_entity", selector: { entity: {} } },
        { name: "refill_baseline_entity", selector: { entity: {} } },
        { name: "volume_today_entity", selector: { entity: {} } },
        { name: "volume_yesterday_entity", selector: { entity: {} } },
        { name: "refill_date_entity", selector: { entity: {} } },
        { name: "rolling_average_days", selector: { number: { mode: "box", unit_of_measurement: "j" } } }
      ]
    };
  }
}

customElements.define("chlorinator-tank-card", ChlorinatorTankCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "chlorinator-tank-card",
  name: "Chlorinator Tank Card",
  description: "Bidon de dosage avec niveau calculé depuis un volume cumulatif."
});

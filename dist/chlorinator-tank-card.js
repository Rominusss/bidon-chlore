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
      refill_date_entity: null,
      rolling_average_days: 7,

      // ---- Confirmation avant changement de bidon ----
      confirm_before_refill: true,
      confirm_message: "Confirmer le changement de bidon ?",

      // ---- Graphique d'historique au clic sur la carte ----
      show_history_on_tap: true,
      history_entity: null, // null = utilise volume_today_entity, sinon volume_total_entity

      // ---- Apparence : couleurs ----
      color_card_background: null, // null = couleur par défaut du thème HA
      color_title: "var(--primary-text-color)",
      color_label: "var(--secondary-text-color)",
      color_value: "var(--primary-text-color)",
      color_button_bg: "var(--primary-color)",
      color_button_text: "var(--text-primary-color, #fff)",
      color_tank_border: "var(--divider-color)",
      color_liquid_normal_top: "rgba(80,170,255,.72)",
      color_liquid_normal_bottom: "rgba(35,105,210,.92)",
      color_liquid_low: "#f5b642",
      color_liquid_critical: "#ff6b5f",
      color_liquid_empty: "#888",
      color_warning: "#d93025",

      // ---- Apparence : bouton ----
      button_icon: "🧴 ", // mets "" pour ne pas afficher d'icône devant le texte
      card_border_radius: null, // ex: "12px" ; null = valeur par défaut du thème

      // ---- Apparence : tailles ----
      size_title: 1.15,       // rem
      size_main_value: 2,     // rem
      size_row_text: 1,       // rem
      size_button: 1,         // rem
      size_icon: 24,          // px

      // ---- Apparence : réservoir ----
      tank_size: "custom", // small | medium | large | custom (utilise tank_width/tank_height)
      tank_width: 120,   // px (utilisé si tank_size = "custom")
      tank_height: 190,  // px (utilisé si tank_size = "custom")
      tank_position: "left", // left | right | top

      // ---- Visibilité des éléments ----
      show_header: true,
      show_icon: true,
      show_warning_badge: true,
      show_tank: true,
      show_main_value: true,
      show_capacity_row: true,
      show_today_row: true,
      show_yesterday_row: true,
      show_avg_row: true,
      show_autonomy_row: true,
      show_button: true,

      ...config
    };
    if (!this.shadowRoot) this.attachShadow({mode: "open"});
    this._localRefillDate = this._localRefillDate || null;
    this._rollingAvg = this._rollingAvg ?? null;
    this._rollingAvgDays = this._rollingAvgDays ?? 0;
    this._historyFetchedAt = this._historyFetchedAt ?? 0;

    // Si l'entité source ou le nombre de jours de moyenne change, on invalide
    // le cache pour forcer un nouveau calcul immédiat au lieu d'attendre
    // jusqu'à 1h (throttle) avec une ancienne valeur devenue incohérente.
    const fetchKey = `${this.config.volume_today_entity}|${this.config.rolling_average_days}`;
    if (this._fetchKey !== fetchKey) {
      this._fetchKey = fetchKey;
      this._historyFetchedAt = 0;
      this._rollingAvg = null;
      this._rollingAvgDays = 0;
    }

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
    if (c.refill_date_entity) {
      const s = this._hass?.states?.[c.refill_date_entity];
      if (s && !["unknown", "unavailable", ""].includes(s.state)) {
        const d = new Date(s.state);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
    if (this._localRefillDate) return this._localRefillDate;
    return null;
  }

  _daysSince(date) {
    if (!date) return null;
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffMs = today - start;
    return Math.max(0, Math.round(diffMs / 86400000));
  }

  _dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  async _fetchRollingAverage() {
    const c = this.config;
    const entity = c.volume_today_entity;
    if (!this._hass || !entity) return;

    const now = Date.now();
    if (this._historyFetchedAt && now - this._historyFetchedAt < 3600000) return;
    this._historyFetchedAt = now;

    const days = Number(c.rolling_average_days) || 7;
    // Marge de sécurité : si le tout premier point récupéré tombe en plein
    // milieu d'un cycle (pas au début), ce cycle-là sera partiel/faussé.
    // En allant chercher plus loin que nécessaire, ce cycle tronqué se
    // retrouve en tête de liste et n'est jamais retenu par le slice(-days) final.
    const lookbackDays = days + 3;

    try {
      const start = new Date();
      start.setDate(start.getDate() - lookbackDays);
      const url = `history/period/${start.toISOString()}?filter_entity_id=${entity}`;
      const result = await this._hass.callApi("GET", url);
      const entries = (result && result[0]) || [];

      const points = entries
        .map(e => ({
          v: Number.parseFloat(e.state),
          t: new Date(e.last_changed || e.last_updated).getTime()
        }))
        .filter(p => Number.isFinite(p.v) && Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t);

      // Ce capteur grimpe pendant la journée puis retombe brutalement à chaque
      // remise à zéro (voir le graphique en dents de scie). On détecte donc
      // directement chaque cycle en repérant ces chutes, plutôt que de
      // regrouper par date calendaire — ce qui colle exactement à la forme
      // réelle du signal, sans dépendre de l'heure exacte du reset ni du
      // fuseau horaire.
      const completedCycles = [];
      let cyclePeak = null;
      for (const p of points) {
        if (cyclePeak === null) {
          cyclePeak = p.v;
          continue;
        }
        if (p.v < cyclePeak * 0.5) {
          // Chute nette de valeur = reset détecté = fin d'un cycle complet
          if (cyclePeak > 0) completedCycles.push(cyclePeak);
          cyclePeak = p.v;
        } else if (p.v > cyclePeak) {
          cyclePeak = p.v;
        }
      }
      // Le cycle en cours (cyclePeak courant, pas encore retombé) n'est PAS
      // ajouté à completedCycles : c'est la journée non terminée.

      const usedCycles = completedCycles.slice(-days);

      if (usedCycles.length) {
        this._rollingAvg = usedCycles.reduce((a, b) => a + b, 0) / usedCycles.length;
        this._rollingAvgDays = usedCycles.length;
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
      ? `${c.button_icon}Bidon changé le ${refillDateLabel}${daysSinceLabel}`
      : `${c.button_icon}Bidon changé le`;

    const showWarning = c.show_warning_badge && (level === "critical" || level === "empty");

    // ---- Dimensions du réservoir (preset ou valeurs pixel personnalisées) ----
    const tankPresets = {
      small: { width: 80, height: 130 },
      medium: { width: 120, height: 190 },
      large: { width: 160, height: 250 }
    };
    const tankDims = tankPresets[c.tank_size] || { width: c.tank_width, height: c.tank_height };

    // ---- Entité utilisée pour l'historique affiché au clic sur la carte ----
    const historyEntity = c.history_entity || c.volume_today_entity || c.volume_total_entity;

    // ---- Layout du réservoir vs stats ----
    let flexDirection = "row";
    if (c.tank_position === "right") flexDirection = "row-reverse";
    else if (c.tank_position === "top") flexDirection = "column";

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}
        ha-card{padding:16px;overflow:hidden;
          ${c.show_history_on_tap && historyEntity ? "cursor:pointer;" : ""}
          ${c.color_card_background ? `background:${c.color_card_background};` : ""}
          ${c.card_border_radius ? `border-radius:${c.card_border_radius};` : ""}}
        .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
        .title{font-size:${c.size_title}rem;font-weight:600;color:${c.color_title}}
        .content{display:flex;flex-direction:${flexDirection};gap:18px;align-items:center}
        .tank-wrap{position:relative;width:${tankDims.width}px;height:${tankDims.height}px;flex-shrink:0;
          ${c.tank_position === "top" ? "margin:0 auto;" : "margin:auto;"}}
        .tank{position:absolute;inset:10px 12px 8px;border:3px solid ${c.color_tank_border};
          border-radius:18px 18px 12px 12px;overflow:hidden;background:rgba(127,127,127,.08)}
        .neck{position:absolute;top:0;left:calc(50% - 17px);width:34px;height:14px;border:3px solid ${c.color_tank_border};
          border-bottom:0;border-radius:8px 8px 0 0}
        .liquid{position:absolute;left:0;right:0;bottom:0;height:${percent ?? 0}%;
          transition:height .9s ease;background:linear-gradient(to bottom,${c.color_liquid_normal_top},${c.color_liquid_normal_bottom})}
        .tank.low .liquid{background:${c.color_liquid_low}}
        .tank.critical .liquid{background:${c.color_liquid_critical}}
        .tank.empty .liquid{background:${c.color_liquid_empty}}
        .tank.unknown .liquid{background:#777;opacity:.35}
        .stats{display:grid;gap:10px;flex:1;min-width:0}
        .main{font-size:${c.size_main_value}rem;font-weight:700;color:${c.color_value}}
        .sub{opacity:.7;color:${c.color_label};font-size:${c.size_row_text}rem}
        .row{display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--divider-color);
          font-size:${c.size_row_text}rem}
        .row span:first-child{color:${c.color_label}}
        .row span:last-child{color:${c.color_value}}
        button{width:100%;margin-top:16px;border:0;border-radius:12px;padding:11px;background:${c.color_button_bg};
          color:${c.color_button_text};font:inherit;font-size:${c.size_button}rem;font-weight:600;cursor:pointer}
        .icons{display:flex;align-items:center;gap:6px}
        .warning-badge{color:${c.color_warning};display:flex;align-items:center}
        .warning-badge ha-icon{--mdc-icon-size:${c.size_icon}px}
        .header ha-icon{--mdc-icon-size:${c.size_icon}px}
      </style>
      <ha-card>
        ${c.show_header ? `
        <div class="header">
          <div class="title">${c.name}</div>
          <div class="icons">
            ${showWarning ? `<span class="warning-badge" title="Niveau ${level === "empty" ? "vide" : "critique"}"><ha-icon icon="mdi:alert"></ha-icon></span>` : ""}
            ${c.show_icon ? `<ha-icon icon="${c.icon}"></ha-icon>` : ""}
          </div>
        </div>` : ""}
        <div class="content">
          ${c.show_tank ? `
          <div class="tank-wrap"><div class="neck"></div><div class="tank ${level}">
            <div class="liquid"></div>
          </div></div>` : ""}
          <div class="stats">
            ${c.show_main_value ? `<div><div class="main">${fmt(remaining)}</div><div class="sub">${pct} restant</div></div>` : ""}
            ${c.show_capacity_row ? `<div class="row"><span>Capacité</span><span>${capacity.toFixed(0)} L</span></div>` : ""}
            ${c.show_today_row ? `<div class="row"><span>Aujourd'hui</span><span>${fmt(today)}</span></div>` : ""}
            ${c.show_yesterday_row ? `<div class="row"><span>Hier</span><span>${fmt(yesterday)}</span></div>` : ""}
            ${c.show_avg_row ? `<div class="row"><span>Conso. moyenne</span><span>${avgDailyLabel}</span></div>` : ""}
            ${c.show_autonomy_row ? `<div class="row"><span>Autonomie estimée</span><span>${daysLeftLabel}</span></div>` : ""}
          </div>
        </div>
        ${c.show_button ? `<button id="refill">${buttonLabel}</button>` : ""}
      </ha-card>`;

    if (c.show_button) {
      this.shadowRoot.querySelector("#refill")?.addEventListener("click", (event) => {
        event.stopPropagation(); // évite de déclencher aussi l'ouverture de l'historique
        if (total === null || !c.refill_baseline_entity) return;

        if (c.confirm_before_refill && !window.confirm(c.confirm_message)) {
          return;
        }

        const now = new Date();

        this._hass.callService("input_number", "set_value", {
          entity_id: c.refill_baseline_entity,
          value: total
        });

        if (c.refill_date_entity) {
          const domain = c.refill_date_entity.split(".")[0];
          if (domain === "input_datetime") {
            this._hass.callService("input_datetime", "set_datetime", {
              entity_id: c.refill_date_entity,
              date: now.toISOString().slice(0, 10)
            });
          } else {
            this._hass.callService("input_text", "set_value", {
              entity_id: c.refill_date_entity,
              value: now.toISOString().slice(0, 10)
            });
          }
        } else {
          this._localRefillDate = now;
        }

        this.render();
      });
    }

    if (c.show_history_on_tap && historyEntity) {
      this.shadowRoot.querySelector("ha-card")?.addEventListener("click", () => {
        const event = new CustomEvent("hass-more-info", {
          detail: { entityId: historyEntity },
          bubbles: true,
          composed: true
        });
        this.dispatchEvent(event);
      });
    }
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
        { name: "rolling_average_days", selector: { number: { mode: "box", unit_of_measurement: "j" } } },
        { name: "confirm_before_refill", selector: { boolean: {} } },
        { name: "confirm_message", selector: { text: {} } },
        { name: "show_history_on_tap", selector: { boolean: {} } },
        { name: "history_entity", selector: { entity: {} } },

        { name: "color_card_background", selector: { text: {} } },
        { name: "card_border_radius", selector: { text: {} } },
        { name: "button_icon", selector: { text: {} } },
        { name: "color_title", selector: { text: {} } },
        { name: "color_label", selector: { text: {} } },
        { name: "color_value", selector: { text: {} } },
        { name: "color_button_bg", selector: { text: {} } },
        { name: "color_button_text", selector: { text: {} } },
        { name: "color_tank_border", selector: { text: {} } },
        { name: "color_liquid_normal_top", selector: { text: {} } },
        { name: "color_liquid_normal_bottom", selector: { text: {} } },
        { name: "color_liquid_low", selector: { text: {} } },
        { name: "color_liquid_critical", selector: { text: {} } },
        { name: "color_liquid_empty", selector: { text: {} } },
        { name: "color_warning", selector: { text: {} } },

        { name: "size_title", selector: { number: { mode: "box", step: 0.05, unit_of_measurement: "rem" } } },
        { name: "size_main_value", selector: { number: { mode: "box", step: 0.05, unit_of_measurement: "rem" } } },
        { name: "size_row_text", selector: { number: { mode: "box", step: 0.05, unit_of_measurement: "rem" } } },
        { name: "size_button", selector: { number: { mode: "box", step: 0.05, unit_of_measurement: "rem" } } },
        { name: "size_icon", selector: { number: { mode: "box", unit_of_measurement: "px" } } },

        { name: "tank_size", selector: { select: { options: ["small", "medium", "large", "custom"] } } },
        { name: "tank_width", selector: { number: { mode: "box", unit_of_measurement: "px" } } },
        { name: "tank_height", selector: { number: { mode: "box", unit_of_measurement: "px" } } },
        { name: "tank_position", selector: { select: { options: ["left", "right", "top"] } } },

        { name: "show_header", selector: { boolean: {} } },
        { name: "show_icon", selector: { boolean: {} } },
        { name: "show_warning_badge", selector: { boolean: {} } },
        { name: "show_tank", selector: { boolean: {} } },
        { name: "show_main_value", selector: { boolean: {} } },
        { name: "show_capacity_row", selector: { boolean: {} } },
        { name: "show_today_row", selector: { boolean: {} } },
        { name: "show_yesterday_row", selector: { boolean: {} } },
        { name: "show_avg_row", selector: { boolean: {} } },
        { name: "show_autonomy_row", selector: { boolean: {} } },
        { name: "show_button", selector: { boolean: {} } }
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

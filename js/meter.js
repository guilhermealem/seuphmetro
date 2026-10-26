/**
 * meter.js — Motor de simulação do pHmetro (sem DOM).
 *
 * Responsabilidades:
 *   - dinâmica do eletrodo (resposta de 1ª ordem, ruído, deriva);
 *   - sensor de temperatura (ATC) ou temperatura manual (MTC);
 *   - conversão mV → pH com a calibração ativa;
 *   - sessão de calibração em 2 ou 3 pontos com reconhecimento de tampão;
 *   - critério de estabilidade, diagnóstico de erros e histórico.
 *
 * A física/química está em chem.js; as soluções em solutions.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chem.js'), require('./solutions.js'));
  else root.PHMeter = factory(root.PHChem, root.PHSolutions);
})(typeof self !== 'undefined' ? self : this, function (Chem, Solutions) {
  'use strict';

  /**
   * Perfis de eletrodo — PARÂMETROS DIDÁTICOS do simulador, escolhidos dentro
   * de faixas plausíveis para eletrodos combinados de vidro:
   *   offsetMv: potencial de assimetria (E em pH 7)
   *   slopeFrac: eficiência da inclinação em relação a Nernst
   *   tauFactor: multiplicador do tempo de resposta
   *   noiseMv: ruído adicional (desvio-padrão)
   *   driftMvPerSqrtS: intensidade do passeio aleatório (deriva)
   *   kNa: coeficiente de seletividade H+/Na+ (erro alcalino)
   */
  const ELECTRODES = {
    new: { name: 'Novo', offsetMv: 4, slopeFrac: 0.99, tauFactor: 1, noiseMv: 0.02, driftMvPerSqrtS: 0.005, kNa: Math.pow(10, -12.5) },
    used: { name: 'Em uso (6 meses)', offsetMv: 19, slopeFrac: 0.935, tauFactor: 2, noiseMv: 0.05, driftMvPerSqrtS: 0.01, kNa: Math.pow(10, -12.2) },
    aged: { name: 'Envelhecido / membrana desgastada', offsetMv: 41, slopeFrac: 0.86, tauFactor: 4, noiseMv: 0.1, driftMvPerSqrtS: 0.02, kNa: Math.pow(10, -11.8) },
    clogged: { name: 'Diafragma entupido', offsetMv: 12, slopeFrac: 0.97, tauFactor: 3, noiseMv: 1.2, driftMvPerSqrtS: 0.6, kNa: Math.pow(10, -12.5) },
    disconnected: { name: 'Desconectado / cabo rompido', offsetMv: 0, slopeFrac: 1, tauFactor: 1, noiseMv: 0, driftMvPerSqrtS: 0, kNa: 0, disconnected: true },
  };

  const DISPLAY_RANGE_PH = [-2, 16];
  const DISPLAY_RANGE_MV = [-1999.9, 1999.9];
  const PROBE_TAU_S = 8; // constante de tempo do sensor de temperatura
  const FILTER_TAU_S = 0.8; // filtro digital (média móvel exponencial) do medidor
  const STABILITY_WINDOW_S = 5;
  const STABILITY_THRESHOLD_MV = 0.6;
  const STABILITY_THRESHOLD_C = 0.1; // a temperatura também precisa estar estável (como em medidores reais)
  const MAX_STEP_S = 0.1;

  class PHMeter {
    constructor(options = {}) {
      this.seed = options.seed ?? 20240607;
      this.reset();
    }

    /** Volta todo o estado ao inicial (inclusive histórico e calibração). */
    reset() {
      this.rng = Chem.mulberry32(this.seed);
      this.time = 0;
      this.solutionId = 'buffer7';
      this.bathTemp = 25;
      this.probeTemp = 25;
      this.tempMode = 'ATC';
      this.manualTemp = 25;
      this.electrodeId = 'new';
      this.displayMode = 'pH';
      this.calibration = null; // calibração aceita
      this.calEvaluation = null;
      this.calSession = null;
      this.lastRejected = null;
      this.history = [];
      this.message = { level: 'info', text: 'Medidor pronto. Calibre antes de medir.' };
      this.drift = 0;
      this.eRaw = this._targetPotential();
      this.eFilt = this.eRaw;
      this.samples = [];
      this.solutionChangedAt = 0;
      this.unstableFor = 0;
      return this;
    }

    // ------------------------------------------------------------------ entradas
    get electrode() {
      return ELECTRODES[this.electrodeId];
    }
    get solution() {
      return Solutions.byId[this.solutionId];
    }

    setSolution(id) {
      if (!Solutions.byId[id]) throw new Error('Solução desconhecida: ' + id);
      if (id === this.solutionId) return;
      this.solutionId = id;
      this.samples = [];
      this.solutionChangedAt = this.time;
      this.unstableFor = 0;
    }
    setBathTemperature(tC) {
      this.bathTemp = clamp(Number(tC), 0, 50);
    }
    setTempMode(mode) {
      this.tempMode = mode === 'MTC' ? 'MTC' : 'ATC';
      this.samples = [];
    }
    setManualTemperature(tC) {
      this.manualTemp = clamp(Number(tC), 0, 50);
      this.samples = [];
    }
    setElectrode(id) {
      if (!ELECTRODES[id]) throw new Error('Eletrodo desconhecido: ' + id);
      this.electrodeId = id;
      this.drift = 0;
      this.samples = [];
      this.solutionChangedAt = this.time;
      this.unstableFor = 0;
    }
    toggleDisplayMode() {
      this.displayMode = this.displayMode === 'pH' ? 'mV' : 'pH';
    }

    /** Temperatura usada pelo medidor nos cálculos (sensor ATC ou valor manual). */
    get meterTemp() {
      return this.tempMode === 'ATC' ? this.probeTemp : this.manualTemp;
    }

    // ------------------------------------------------------------------ dinâmica
    /** pH "verdadeiro" da solução na temperatura atual (conhecido só pelo simulador). */
    trueState() {
      return Solutions.trueState(this.solutionId, this.bathTemp);
    }

    /** Potencial de equilíbrio que o eletrodo atingiria na solução atual. */
    _targetPotential() {
      const el = this.electrode;
      if (el.disconnected) return NaN;
      const st = this.trueState();
      if (this.solution.source === 'none') return this.eRaw ?? 0; // ao ar: sem alvo definido
      return Chem.electrodePotential({
        pH: st.pH, tC: this.bathTemp, offsetMv: el.offsetMv, slopeFrac: el.slopeFrac, kNa: el.kNa, aNa: st.aNa,
      });
    }

    /** Avança a simulação dt segundos (em subpassos de até 0,1 s). */
    tick(dt) {
      let remaining = dt;
      while (remaining > 1e-9) {
        const h = Math.min(MAX_STEP_S, remaining);
        this._step(h);
        remaining -= h;
      }
    }

    _step(dt) {
      this.time += dt;
      const el = this.electrode;
      const sol = this.solution;

      // Sensor de temperatura: 1ª ordem em direção à temperatura do banho.
      this.probeTemp = Chem.firstOrderStep(this.probeTemp, this.bathTemp, dt, PROBE_TAU_S);

      if (el.disconnected) {
        this.eRaw = NaN;
        this.eFilt = NaN;
        this._pushSample(NaN, dt);
        return;
      }
      if (!Number.isFinite(this.eRaw)) this.eRaw = 0;
      if (!Number.isFinite(this.eFilt)) this.eFilt = this.eRaw;

      if (sol.source === 'none') {
        // Eletrodo fora da solução: circuito aberto, potencial flutua (passeio aleatório grande).
        this.eRaw += Chem.gaussian(this.rng) * 15 * Math.sqrt(dt);
        this.eRaw = clamp(this.eRaw, -600, 600);
      } else {
        const tau = sol.tau * el.tauFactor;
        this.eRaw = Chem.firstOrderStep(this.eRaw, this._targetPotential(), dt, tau);
      }

      // Deriva (passeio aleatório) e ruído branco (solução + eletrodo).
      this.drift += Chem.gaussian(this.rng) * el.driftMvPerSqrtS * Math.sqrt(dt);
      const noiseSd = Math.hypot(sol.noiseMv, el.noiseMv);
      const measured = this.eRaw + this.drift + Chem.gaussian(this.rng) * noiseSd;

      // Filtro digital do medidor.
      this.eFilt = Chem.firstOrderStep(this.eFilt, measured, dt, FILTER_TAU_S);
      this._pushSample(this.eFilt, dt);
    }

    _pushSample(v, dt) {
      this.samples.push({ t: this.time, v, T: this.meterTemp });
      const cutoff = this.time - STABILITY_WINDOW_S - 0.5;
      while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
      if (this.isStable()) this.unstableFor = 0;
      else this.unstableFor += dt;
    }

    /** Estável = potencial E temperatura do medidor estáveis na janela de 5 s. */
    isStable() {
      if (!Chem.isStable(this.samples, STABILITY_WINDOW_S, STABILITY_THRESHOLD_MV)) return false;
      const temps = this.samples.map((s) => ({ t: s.t, v: s.T }));
      return Chem.isStable(temps, STABILITY_WINDOW_S, STABILITY_THRESHOLD_C);
    }

    // ------------------------------------------------------------------ leitura
    activeCalibration() {
      return this.calibration || Chem.THEORETICAL_CALIBRATION;
    }

    /** Leitura completa, com diagnósticos. Não altera o estado. */
    reading() {
      const tMeter = this.meterTemp;
      const mV = this.eFilt;
      const pH = Number.isFinite(mV) ? Chem.mvToPh(mV, tMeter, this.activeCalibration()) : NaN;
      const stable = this.isStable();
      const settling = this.time - this.solutionChangedAt < 60;
      const stability = stable ? 'stable' : settling ? 'settling' : 'unstable';
      const truth = this.trueState();
      const errors = [];
      const warnings = [];
      const el = this.electrode;
      const sol = this.solution;

      if (el.disconnected) {
        errors.push({ code: 'E1', text: 'Eletrodo não detectado: verifique o conector BNC e o cabo.' });
      } else if (sol.source === 'none') {
        errors.push({ code: 'E2', text: 'Eletrodo fora da solução: leitura flutuante. Mergulhe o bulbo e o diafragma.' });
      }
      const outOfRange = Number.isFinite(pH) && (pH < DISPLAY_RANGE_PH[0] || pH > DISPLAY_RANGE_PH[1]);
      if (outOfRange) errors.push({ code: 'E3', text: 'Leitura fora da faixa do instrumento (−2,00 a 16,00).' });

      if (!this.calibration) {
        warnings.push({ code: 'W1', text: 'Sem calibração: usando eletrodo ideal (0 mV, 100 %). Resultado não confiável.' });
      } else if (this.calEvaluation && this.calEvaluation.level === 'ok') {
        warnings.push({ code: 'W2', text: 'Calibração aceitável, mas fora do ideal: limpe/regenere o eletrodo.' });
      }
      if (this.tempMode === 'MTC' && Math.abs(this.manualTemp - this.bathTemp) > 2) {
        warnings.push({ code: 'W3', text: 'Temperatura manual difere da amostra: compensação incorreta.' });
      }
      // Tolerância proporcional ao tempo de resposta esperado (mín. 60 s).
      const maxUnstable = Math.max(60, 6 * sol.tau * el.tauFactor);
      if (!el.disconnected && sol.source !== 'none' && this.unstableFor > maxUnstable) {
        errors.push({ code: 'E4', text: 'Leitura não estabiliza: verifique diafragma, eletrólito e aterramento.' });
      }
      if (this.calibration && Number.isFinite(pH)) {
        const pts = this.calibration.points.map((p) => p.pH);
        const lo = Math.min(...pts);
        const hi = Math.max(...pts);
        if (pH < lo - 1 || pH > hi + 1) {
          warnings.push({ code: 'W4', text: `Medição fora da faixa calibrada (${fmt(lo)}–${fmt(hi)}): resultado extrapolado.` });
        }
      }
      if (sol.lowIonic) {
        warnings.push({ code: 'W5', text: 'Baixa força iônica: resposta lenta e ruidosa; use eletrodo apropriado.' });
      }
      if (Number.isFinite(truth.pH) && truth.pH > 12 && truth.aNa > 0.01) {
        warnings.push({ code: 'W6', text: 'pH alto com Na⁺: possível erro alcalino (leitura abaixo do real).' });
      }
      for (const w of truth.warnings) warnings.push({ code: 'W7', text: w });

      return {
        time: this.time,
        mV,
        pH,
        outOfRange,
        meterTemp: tMeter,
        probeTemp: this.probeTemp,
        sampleTemp: this.bathTemp,
        tempMode: this.tempMode,
        stable,
        stability,
        errors,
        warnings,
        truePH: truth.pH,
        source: truth.source,
      };
    }

    // ------------------------------------------------------------------ calibração
    /**
     * Inicia uma sessão de calibração.
     * buffers: lista de tampões nominais (ex.: [4, 7] ou [4, 7, 10]); method: 'linear' | 'segmented'.
     */
    startCalibration(buffers = [4, 7, 10], method = 'linear') {
      const set = [...new Set(buffers.map(Number))].filter((b) => [4, 7, 10].includes(b)).sort((a, b) => a - b);
      if (set.length < 2) throw new Error('A calibração exige 2 ou 3 tampões distintos.');
      // Ordem recomendada: pH 7 (ponto zero) primeiro, depois os demais.
      const order = [7, ...set.filter((b) => b !== 7)].filter((b) => set.includes(b));
      this.calSession = { buffers: set, order, method: method === 'segmented' ? 'segmented' : 'linear', points: [] };
      this.message = { level: 'info', text: `Calibração em ${set.length} pontos iniciada. Mergulhe o eletrodo no tampão pH ${fmt(order[0])}.` };
      return this.calSession;
    }

    cancelCalibration() {
      if (!this.calSession) return;
      this.calSession = null;
      this.message = { level: 'info', text: 'Calibração cancelada. Calibração anterior mantida.' };
    }

    /** Próximo tampão sugerido na sessão. */
    nextBuffer() {
      if (!this.calSession) return null;
      const used = this.calSession.points.map((p) => p.nominal);
      return this.calSession.order.find((b) => !used.includes(b)) ?? null;
    }

    /**
     * Tenta aceitar o ponto atual. Retorna { ok, done?, message }.
     * Regras (como em medidores reais): exige leitura estável; o tampão é
     * reconhecido pelo potencial; o valor de pH atribuído vem da tabela do
     * tampão na temperatura do MEDIDOR (ATC ou manual).
     */
    confirmCalibrationPoint() {
      const s = this.calSession;
      if (!s) return this._msg(false, 'error', 'Nenhuma calibração em andamento.');
      if (this.electrode.disconnected) return this._msg(false, 'error', 'E1: eletrodo não detectado.');
      if (this.solution.source === 'none') return this._msg(false, 'error', 'E2: eletrodo fora da solução.');
      if (!this.isStable()) return this._msg(false, 'warn', 'Aguarde a estabilização da leitura antes de confirmar.');

      const tC = this.meterTemp;
      const mV = this.eFilt;
      const remaining = s.buffers.filter((b) => !s.points.some((p) => p.nominal === b));
      const rec = Chem.recognizeBuffer(mV, tC, s.buffers);
      if (rec.nominal === null) {
        return this._msg(false, 'error', `Tampão não reconhecido (pH estimado ${fmt(rec.guess)}). Use os tampões ${s.buffers.map(fmt).join(', ')}.`);
      }
      if (!remaining.includes(rec.nominal)) {
        return this._msg(false, 'error', `Tampão pH ${fmt(rec.nominal)} já foi usado nesta calibração. Troque de tampão.`);
      }
      const point = { nominal: rec.nominal, pH: Chem.bufferPH(rec.nominal, tC), mV, tC };
      s.points.push(point);

      if (s.points.length < s.buffers.length) {
        return this._msg(true, 'info', `Ponto pH ${fmt(point.pH)} aceito (${point.mV.toFixed(1)} mV a ${point.tC.toFixed(1)} °C). Lave o eletrodo e mergulhe no tampão pH ${fmt(this.nextBuffer())}.`);
      }
      return this._finishCalibration();
    }

    _finishCalibration() {
      const s = this.calSession;
      const cal = Chem.calibrate(s.points, s.method);
      cal.date = new Date().toISOString();
      cal.time = this.time;
      const ev = Chem.evaluateCalibration(cal);
      this.calSession = null;
      const summary = `inclinação ${(cal.slopeFrac * 100).toFixed(1)} %, offset ${cal.offsetMv.toFixed(1)} mV`;
      if (ev.level === 'error') {
        this.lastRejected = { cal, evaluation: ev };
        return { ...this._msg(false, 'error', `Calibração rejeitada (${summary}): ${ev.reasons.join('; ')}. Calibração anterior mantida.`), done: true, rejected: true };
      }
      this.calibration = cal;
      this.calEvaluation = ev;
      this.lastRejected = null;
      const quality = ev.level === 'good' ? 'Eletrodo em bom estado' : 'Aceitável — recomenda-se limpeza';
      return { ...this._msg(true, ev.level === 'good' ? 'ok' : 'warn', `Calibração concluída: ${summary}. ${quality}.`), done: true };
    }

    _msg(ok, level, text) {
      this.message = { level, text };
      return { ok, message: text };
    }

    // ------------------------------------------------------------------ histórico
    record(note = '') {
      const r = this.reading();
      const entry = {
        n: this.history.length + 1,
        simTime: this.time,
        wallTime: new Date().toISOString(),
        sampleId: this.solutionId,
        sampleName: this.solution.name,
        source: r.source,
        pH: r.outOfRange ? NaN : r.pH,
        mV: r.mV,
        meterTemp: r.meterTemp,
        sampleTemp: r.sampleTemp,
        tempMode: r.tempMode,
        stability: r.stability,
        calibrated: !!this.calibration,
        calSummary: this.calibration
          ? `${this.calibration.points.length} pts, ${(this.calibration.slopeFrac * 100).toFixed(1)} %`
          : 'sem calibração',
        truePH: r.truePH,
        codes: [...r.errors, ...r.warnings].map((e) => e.code),
        note,
      };
      this.history.push(entry);
      this.message = { level: r.stable ? 'ok' : 'warn', text: `Leitura nº ${entry.n} registrada${r.stable ? '' : ' (INSTÁVEL)'}.` };
      return entry;
    }

    clearHistory() {
      this.history = [];
    }
  }

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }
  function fmt(v, d = 2) {
    return Number(v).toFixed(d).replace('.', ',');
  }

  PHMeter.ELECTRODES = ELECTRODES;
  PHMeter.DISPLAY_RANGE_PH = DISPLAY_RANGE_PH;
  PHMeter.DISPLAY_RANGE_MV = DISPLAY_RANGE_MV;
  PHMeter.STABILITY_WINDOW_S = STABILITY_WINDOW_S;
  PHMeter.STABILITY_THRESHOLD_MV = STABILITY_THRESHOLD_MV;
  return PHMeter;
});

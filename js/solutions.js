/**
 * solutions.js — Catálogo de soluções do simulador (sem DOM).
 *
 * Cada solução declara a ORIGEM do seu valor de pH:
 *   'buffer'   → tabela pH × temperatura do tampão padrão (chem.bufferPH)
 *   'model'    → calculado por equilíbrio químico (chem.solveEquilibrium)
 *   'didactic' → VALOR DIDÁTICO fixo, representativo de uma faixa típica;
 *                amostras reais variam e não há dependência com a temperatura.
 *   'none'     → sem solução (eletrodo ao ar)
 *
 * Os parâmetros de resposta (tau, ruído) são parâmetros didáticos do
 * simulador, escolhidos para reproduzir comportamentos qualitativos reais
 * (ex.: água pura responde devagar e com ruído por ter baixa força iônica).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chem.js'));
  else root.PHSolutions = factory(root.PHChem);
})(typeof self !== 'undefined' ? self : this, function (Chem) {
  'use strict';

  // Constantes termodinâmicas a 25 °C e entalpias de ionização (ΔH°, J/mol):
  // Goldberg, Kishore & Lennen (2002), J. Phys. Chem. Ref. Data 31, 231.
  const PKA = {
    acetic: { pK: 4.756, dH: -410 },
    ammonium: { pK: 9.245, dH: 51950 },
    carbonic1: { pK: 6.351, dH: 9150 },
    carbonic2: { pK: 10.329, dH: 14700 },
  };

  const PCO2_AIR = 420e-6; // atm (~420 ppm, ar atmosférico atual)

  const SOLUTIONS = [
    // ---- Tampões padrão -------------------------------------------------------
    { id: 'buffer4', group: 'Tampões padrão', name: 'Tampão pH 4,00', source: 'buffer', nominal: 4, color: '#e0524f', tau: 3, noiseMv: 0.03,
      description: 'Tampão técnico (tipicamente biftalato de potássio). pH a outras temperaturas pela tabela do tampão.' },
    { id: 'buffer7', group: 'Tampões padrão', name: 'Tampão pH 7,00', source: 'buffer', nominal: 7, color: '#e8c840', tau: 3, noiseMv: 0.03,
      description: 'Tampão técnico (tipicamente fosfato). pH a outras temperaturas pela tabela do tampão.' },
    { id: 'buffer10', group: 'Tampões padrão', name: 'Tampão pH 10,00', source: 'buffer', nominal: 10, color: '#4a86e0', tau: 3, noiseMv: 0.03,
      description: 'Tampão técnico (tipicamente carbonato/borato). pH a outras temperaturas pela tabela do tampão.' },

    // ---- Amostras calculadas por modelo -----------------------------------------
    { id: 'hcl001', group: 'Amostras calculadas (modelo)', name: 'HCl 0,010 mol/L', source: 'model', color: '#f4f1ea', tau: 4, noiseMv: 0.04,
      // O H+ do ácido forte é a própria incógnita do balanço de carga: basta o contra-íon Cl−.
      spec: { ions: [{ z: -1, c: 0.01 }] },
      description: 'Ácido forte totalmente dissociado. pH = −log(γ·c) com γ de Davies.' },
    { id: 'acetic01', group: 'Amostras calculadas (modelo)', name: 'Ácido acético 0,10 mol/L', source: 'model', color: '#f4f1ea', tau: 4, noiseMv: 0.04,
      spec: { acids: [{ c: 0.1, z0: 0, pKa: [PKA.acetic] }] },
      description: 'Ácido fraco, pKa = 4,756 (25 °C).' },
    { id: 'acetate', group: 'Amostras calculadas (modelo)', name: 'Tampão acetato 0,10/0,10 mol/L', source: 'model', color: '#f4f1ea', tau: 4, noiseMv: 0.04,
      spec: { ions: [{ z: 1, c: 0.1, isNa: true }], acids: [{ c: 0.2, z0: 0, pKa: [PKA.acetic] }] },
      description: 'Ácido acético 0,10 mol/L + acetato de sódio 0,10 mol/L. Henderson–Hasselbalch corrigido por atividade.' },
    { id: 'nahco3', group: 'Amostras calculadas (modelo)', name: 'NaHCO₃ 0,10 mol/L', source: 'model', color: '#f4f1ea', tau: 4, noiseMv: 0.04,
      spec: { ions: [{ z: 1, c: 0.1, isNa: true }], acids: [{ c: 0.1, z0: 0, pKa: [PKA.carbonic1, PKA.carbonic2] }] },
      description: 'Anfólito (sistema fechado, sem perda de CO₂). pH ≈ (pKa1 + pKa2)/2.' },
    { id: 'nh3', group: 'Amostras calculadas (modelo)', name: 'NH₃ 0,10 mol/L', source: 'model', color: '#f4f1ea', tau: 4, noiseMv: 0.04,
      // Par NH4+/NH3 (z0 = +1). NH3 dissolvido não traz contra-íon: o balanço de carga
      // é [H+] + [NH4+] = [OH−].
      spec: { acids: [{ c: 0.1, z0: 1, pKa: [PKA.ammonium] }] },
      description: 'Base fraca, pKa(NH₄⁺) = 9,245 (25 °C), forte dependência com a temperatura.' },
    { id: 'naoh001', group: 'Amostras calculadas (modelo)', name: 'NaOH 0,010 mol/L', source: 'model', color: '#f4f1ea', tau: 4, noiseMv: 0.04,
      spec: { ions: [{ z: 1, c: 0.01, isNa: true }] },
      description: 'Base forte. pH = pKw − pOH; pKw depende da temperatura.' },
    { id: 'naoh01', group: 'Amostras calculadas (modelo)', name: 'NaOH 0,10 mol/L (erro alcalino)', source: 'model', color: '#f4f1ea', tau: 5, noiseMv: 0.05,
      spec: { ions: [{ z: 1, c: 0.1, isNa: true }] },
      description: 'Base forte com Na⁺ elevado: o eletrodo de vidro lê pH menor que o real (erro alcalino / de sódio).' },
    { id: 'water', group: 'Amostras calculadas (modelo)', name: 'Água deionizada (equilibrada com o ar)', source: 'model', color: '#eef6fb', tau: 30, noiseMv: 0.35, lowIonic: true,
      spec: { openCO2: { pCO2: PCO2_AIR } },
      description: 'CO₂ atmosférico dissolvido (≈420 ppm) acidifica a água: pH ≈ 5,6. Baixa força iônica → leitura lenta e ruidosa.' },

    // ---- Amostras com valores didáticos ----------------------------------------
    { id: 'lemon', group: 'Amostras didáticas (valor ilustrativo)', name: 'Suco de limão', source: 'didactic', pH25: 2.3, range: '2,0–2,6', color: '#f3f0b0', tau: 6, noiseMv: 0.1 },
    { id: 'cola', group: 'Amostras didáticas (valor ilustrativo)', name: 'Refrigerante de cola', source: 'didactic', pH25: 2.5, range: '2,3–2,7', color: '#4a2a1a', tau: 6, noiseMv: 0.1 },
    { id: 'coffee', group: 'Amostras didáticas (valor ilustrativo)', name: 'Café coado', source: 'didactic', pH25: 5.0, range: '4,8–5,2', color: '#5b3a22', tau: 6, noiseMv: 0.1 },
    { id: 'milk', group: 'Amostras didáticas (valor ilustrativo)', name: 'Leite de vaca', source: 'didactic', pH25: 6.7, range: '6,5–6,8', color: '#fbfaf3', tau: 8, noiseMv: 0.1 },
    { id: 'seawater', group: 'Amostras didáticas (valor ilustrativo)', name: 'Água do mar', source: 'didactic', pH25: 8.1, range: '7,9–8,3', color: '#9fd3e0', tau: 5, noiseMv: 0.06 },

    // ---- Sem solução --------------------------------------------------------------
    { id: 'air', group: 'Outros', name: 'Nenhuma — eletrodo ao ar', source: 'none', color: null, tau: 2, noiseMv: 6 },
  ];

  const byId = Object.fromEntries(SOLUTIONS.map((s) => [s.id, s]));

  /**
   * Estado "verdadeiro" da solução na temperatura tC (o que o simulador sabe,
   * mas o medidor não). Retorna { pH, aNa, I, source, warnings }.
   */
  function trueState(id, tC) {
    const s = byId[id];
    if (!s) throw new Error('Solução desconhecida: ' + id);
    switch (s.source) {
      case 'buffer':
        // aNa: hipótese didática (tampões contêm Na⁺/K⁺ em ~0,05 mol/L; erro alcalino desprezível até pH 10)
        return { pH: Chem.bufferPH(s.nominal, tC), aNa: 0.05, I: null, source: s.source, warnings: [] };
      case 'model': {
        const r = Chem.solveEquilibrium(s.spec, tC);
        return { pH: r.pH, aNa: r.activities.Na, I: r.I, source: s.source, warnings: r.warnings };
      }
      case 'didactic':
        return { pH: s.pH25, aNa: 0.01, I: null, source: s.source, warnings: [] };
      default:
        return { pH: NaN, aNa: 0, I: 0, source: 'none', warnings: [] };
    }
  }

  const SOURCE_LABELS = {
    buffer: 'Tabela do tampão',
    model: 'Calculado (modelo de equilíbrio)',
    didactic: 'Valor didático',
    none: '—',
  };

  return { SOLUTIONS, byId, trueState, SOURCE_LABELS, PKA, PCO2_AIR };
});

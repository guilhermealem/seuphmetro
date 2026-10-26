/**
 * chem.js — Núcleo de cálculos físico-químicos do simulador de pHmetro.
 *
 * Este módulo NÃO acessa a interface (DOM). Pode ser usado no navegador
 * (expõe `window.PHChem`) ou no Node.js (`require('./chem.js')`), o que
 * permite testá-lo isoladamente (ver tests/chem.test.js).
 *
 * Fórmulas, hipóteses e fontes estão documentadas em docs/MODELO.md.
 * Resumo:
 *  - Equação de Nernst para o eletrodo de vidro:
 *        E = E0 − k · S(T) · (pH − 7),   S(T) = (R·T·ln10)/F
 *    (pH 7 é tratado como ponto isopotencial ideal).
 *  - Erro alcalino (sódio) pela equação de Nikolsky–Eisenman:
 *        pH_aparente = −log10(a_H + K_H,Na · a_Na)
 *  - Coeficientes de atividade pela equação de Davies (válida até I ≈ 0,1–0,5 mol/L).
 *  - Equilíbrios ácido-base resolvidos por balanço de carga (bisseção),
 *    com constantes de equilíbrio corrigidas por van 't Hoff (ΔH constante).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PHChem = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constantes físicas (CODATA 2018, valores exatos no SI revisado)
  // ---------------------------------------------------------------------------
  const R = 8.314462618; // J·mol⁻¹·K⁻¹
  const F = 96485.33212; // C·mol⁻¹
  const LN10 = Math.LN10;
  const T0 = 273.15; // K

  const celsiusToKelvin = (tC) => tC + T0;

  /**
   * Inclinação teórica de Nernst, em mV por unidade de pH.
   * S(T) = 1000 · R · T · ln(10) / F   → 59,16 mV/pH a 25 °C.
   */
  function nernstSlope(tC) {
    return (1000 * R * celsiusToKelvin(tC) * LN10) / F;
  }

  // ---------------------------------------------------------------------------
  // Utilidades numéricas
  // ---------------------------------------------------------------------------

  /** Interpolação linear em tabela [[x, y], ...] ordenada por x (com extrapolação nas bordas). */
  function interpolate(table, x) {
    if (x <= table[0][0]) {
      const [[x0, y0], [x1, y1]] = table;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    for (let i = 1; i < table.length; i++) {
      if (x <= table[i][0]) {
        const [x0, y0] = table[i - 1];
        const [x1, y1] = table[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    const [x0, y0] = table[table.length - 2];
    const [x1, y1] = table[table.length - 1];
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }

  /** Gerador pseudoaleatório determinístico (mulberry32) — torna a simulação reprodutível. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Amostra normal padrão N(0,1) pelo método de Box–Muller. */
  function gaussian(rng) {
    let u = 0;
    while (u === 0) u = rng();
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Resposta de primeira ordem (decaimento exponencial) para um passo dt:
   *   x(t+dt) = alvo + (x(t) − alvo) · exp(−dt/τ)
   * Modelo usual para a resposta de eletrodos de vidro e sensores de temperatura.
   */
  function firstOrderStep(current, target, dt, tau) {
    if (!(tau > 0)) return target;
    return target + (current - target) * Math.exp(-dt / tau);
  }

  // ---------------------------------------------------------------------------
  // Propriedades da água
  // ---------------------------------------------------------------------------

  /**
   * pKw da água (escala de atividades) em função da temperatura.
   * Valores tabelados (CRC Handbook of Chemistry and Physics, "Ionization
   * constant of water", à pressão de saturação). Interpolação linear.
   */
  const PKW_TABLE = [
    [0, 14.947], [5, 14.734], [10, 14.535], [15, 14.346], [20, 14.167],
    [25, 13.995], [30, 13.836], [35, 13.685], [40, 13.535], [45, 13.396],
    [50, 13.275], [60, 13.017],
  ];
  const pKw = (tC) => interpolate(PKW_TABLE, tC);

  /**
   * Constante dielétrica relativa da água (Malmberg & Maryott, 1956):
   *   ε = 87,740 − 0,40008·t + 9,398·10⁻⁴·t² − 1,410·10⁻⁶·t³   (t em °C, 0–100 °C)
   */
  function waterDielectric(tC) {
    return 87.74 - 0.40008 * tC + 9.398e-4 * tC ** 2 - 1.41e-6 * tC ** 3;
  }

  /**
   * Constante A de Debye–Hückel (base 10, kg^½·mol^-½):
   *   A = 1,82483·10⁶ · √ρ / (ε·T)^{3/2}
   * Com ρ ≈ 0,997 kg/L. Resulta A ≈ 0,511 a 25 °C.
   */
  function debyeHuckelA(tC) {
    const T = celsiusToKelvin(tC);
    const rho = 0.997; // hipótese: densidade constante (efeito < 0,5 % em A entre 0 e 50 °C)
    return (1.82483e6 * Math.sqrt(rho)) / Math.pow(waterDielectric(tC) * T, 1.5);
  }

  /**
   * Equação de Davies para o coeficiente de atividade de um íon de carga z:
   *   log10 γ = −A · z² · ( √I / (1 + √I) − 0,3·I )
   * Válida aproximadamente até I ≈ 0,1–0,5 mol/L.
   */
  function daviesLogGamma(z, I, tC) {
    if (z === 0 || I <= 0) return 0;
    const sI = Math.sqrt(I);
    return -debyeHuckelA(tC) * z * z * (sI / (1 + sI) - 0.3 * I);
  }
  const DAVIES_MAX_I = 0.5;

  /**
   * Correção de van 't Hoff para pK com ΔH° constante:
   *   pK(T) = pK(T_ref) + (ΔH° / (R·ln10)) · (1/T − 1/T_ref)
   * ΔH em J/mol.
   */
  function vantHoffPK(pKref, dH, tC, tRefC = 25) {
    const T = celsiusToKelvin(tC);
    const Tref = celsiusToKelvin(tRefC);
    return pKref + (dH / (R * LN10)) * (1 / T - 1 / Tref);
  }

  /**
   * Constante de Henry do CO2 (mol·L⁻¹·atm⁻¹):
   *   KH(T) = 0,034 · exp( 2400 · (1/T − 1/298,15) )   (Sander, compilação de constantes de Henry)
   */
  function henryCO2(tC) {
    const T = celsiusToKelvin(tC);
    return 0.034 * Math.exp(2400 * (1 / T - 1 / 298.15));
  }

  // ---------------------------------------------------------------------------
  // Solver de equilíbrio ácido-base (balanço de carga)
  // ---------------------------------------------------------------------------

  /**
   * Calcula o pH (= −log10 a_H+) de uma solução aquosa.
   *
   * spec = {
   *   ions:  [{ z, c }]  íons fortes (totalmente dissociados): Na⁺ (z=+1), Cl⁻ (z=−1)...
   *   acids: [{ c, z0, pKa: [{pK, dH}] }]  sistemas ácido-base fracos;
   *          z0 = carga da forma totalmente protonada (ex.: HAc → 0; NH4⁺ → +1)
   *   openCO2: { pCO2 } (atm) — água em equilíbrio com o ar (sistema aberto)
   * }
   *
   * Incógnita: x = a_H+. Para cada x, as espécies são obtidas pelas constantes
   * termodinâmicas corrigidas por γ (Davies). A carga líquida é decrescente em
   * pH, então a raiz é encontrada por bisseção. A força iônica é atualizada por
   * iteração de ponto fixo até convergir.
   *
   * Retorna { pH, I, gamma1, activities: { Na }, warnings: [] }.
   */
  function solveEquilibrium(spec, tC) {
    const ions = spec.ions || [];
    const acids = (spec.acids || []).map((a) => ({
      c: a.c,
      z0: a.z0,
      Ka: a.pKa.map((k) => Math.pow(10, -vantHoffPK(k.pK, k.dH || 0, tC))),
    }));
    const Kw = Math.pow(10, -pKw(tC));
    let co2 = null;
    if (spec.openCO2) {
      const K1 = Math.pow(10, -vantHoffPK(6.351, 9150, tC));
      const K2 = Math.pow(10, -vantHoffPK(10.329, 14700, tC));
      co2 = { c: henryCO2(tC) * spec.openCO2.pCO2, K1, K2 };
    }

    let I = 0;
    let result = null;

    for (let iter = 0; iter < 60; iter++) {
      const g = (z) => Math.pow(10, daviesLogGamma(z, I, tC));

      // Concentrações das espécies para uma dada atividade x de H+
      const speciate = (x) => {
        const list = []; // {z, c}
        list.push({ z: 1, c: x / g(1) }); // H+
        list.push({ z: -1, c: Kw / (x * g(-1)) }); // OH-
        for (const ion of ions) list.push({ z: ion.z, c: ion.c });
        for (const a of acids) {
          // razões [j+1]/[j] = Ka_j · γ_j / (x · γ_{j+1})
          const rel = [1];
          for (let j = 0; j < a.Ka.length; j++) {
            const zj = a.z0 - j;
            rel.push((rel[j] * a.Ka[j] * g(zj)) / (x * g(zj - 1)));
          }
          const sum = rel.reduce((s, v) => s + v, 0);
          rel.forEach((r, j) => list.push({ z: a.z0 - j, c: (a.c * r) / sum }));
        }
        if (co2) {
          const hco3 = (co2.K1 * co2.c) / (x * g(-1));
          const co3 = (hco3 * co2.K2 * g(-1)) / (x * g(-2));
          list.push({ z: 0, c: co2.c }, { z: -1, c: hco3 }, { z: -2, c: co3 });
        }
        return list;
      };
      const charge = (pH) => speciate(Math.pow(10, -pH)).reduce((s, sp) => s + sp.z * sp.c, 0);

      // Bisseção em pH ∈ [−2, 16]: carga(pH) é estritamente decrescente.
      let lo = -2;
      let hi = 16;
      for (let k = 0; k < 200; k++) {
        const mid = (lo + hi) / 2;
        if (charge(mid) > 0) lo = mid;
        else hi = mid;
        if (hi - lo < 1e-12) break;
      }
      const pH = (lo + hi) / 2;
      const species = speciate(Math.pow(10, -pH));
      const newI = 0.5 * species.reduce((s, sp) => s + sp.c * sp.z * sp.z, 0);
      result = { pH, I: newI, gamma1: g(1) };
      if (Math.abs(newI - I) < 1e-12 * Math.max(1, newI)) break;
      I = newI;
    }

    const gammaFinal = Math.pow(10, daviesLogGamma(1, result.I, tC));
    const naConc = ions.filter((i) => i.isNa).reduce((s, i) => s + i.c, 0);
    const warnings = [];
    if (result.I > DAVIES_MAX_I) {
      warnings.push('Força iônica acima do limite de validade da equação de Davies; pH aproximado.');
    }
    return {
      pH: result.pH,
      I: result.I,
      gamma1: gammaFinal,
      activities: { Na: naConc * gammaFinal },
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Soluções-tampão padrão (pH 4,00 / 7,00 / 10,00 a 25 °C)
  // ---------------------------------------------------------------------------

  /**
   * Tabela pH × temperatura de tampões técnicos comerciais de pH nominal
   * 4,00, 7,00 e 10,00 (valores a 25 °C). Os valores a outras temperaturas
   * são TÍPICOS de tabelas de fabricantes (biftalato, fosfato e
   * carbonato/borato); cada lote traz sua própria tabela no certificado,
   * que deve prevalecer em uso real.
   */
  const BUFFER_TABLE = {
    4: [[0, 4.01], [5, 4.01], [10, 4.0], [15, 4.0], [20, 4.0], [25, 4.0], [30, 4.01], [35, 4.02], [40, 4.03], [45, 4.04], [50, 4.06]],
    7: [[0, 7.12], [5, 7.09], [10, 7.06], [15, 7.04], [20, 7.02], [25, 7.0], [30, 6.99], [35, 6.98], [40, 6.97], [45, 6.97], [50, 6.97]],
    10: [[0, 10.32], [5, 10.25], [10, 10.18], [15, 10.12], [20, 10.06], [25, 10.0], [30, 9.95], [35, 9.91], [40, 9.87], [45, 9.84], [50, 9.81]],
  };
  const BUFFER_T_RANGE = [0, 50];

  /** pH do tampão nominal (4, 7 ou 10) na temperatura tC, por interpolação na tabela. */
  function bufferPH(nominal, tC) {
    const table = BUFFER_TABLE[nominal];
    if (!table) throw new Error('Tampão desconhecido: ' + nominal);
    const t = Math.min(BUFFER_T_RANGE[1], Math.max(BUFFER_T_RANGE[0], tC));
    return interpolate(table, t);
  }

  // ---------------------------------------------------------------------------
  // Eletrodo de vidro
  // ---------------------------------------------------------------------------

  /**
   * Potencial de um eletrodo combinado de vidro (mV).
   *   E = E0 − k · S(T) · (pH_ef − 7)
   *   pH_ef = −log10( a_H + K_H,Na · a_Na )   (Nikolsky–Eisenman; erro alcalino)
   * params: { pH, tC, offsetMv (E0), slopeFrac (k), kNa, aNa }
   */
  function electrodePotential({ pH, tC, offsetMv = 0, slopeFrac = 1, kNa = 0, aNa = 0 }) {
    const aH = Math.pow(10, -pH);
    const pHeff = -Math.log10(aH + kNa * aNa);
    return offsetMv - slopeFrac * nernstSlope(tC) * (pHeff - 7);
  }

  /** Erro alcalino (pH_aparente − pH_real), sempre ≤ 0. */
  function alkalineError(pH, kNa, aNa) {
    const aH = Math.pow(10, -pH);
    return -Math.log10(aH + kNa * aNa) - pH;
  }

  // ---------------------------------------------------------------------------
  // Calibração do medidor
  // ---------------------------------------------------------------------------

  /** Calibração "de fábrica"/teórica: E0 = 0 mV, inclinação 100 %. */
  const THEORETICAL_CALIBRATION = Object.freeze({
    method: 'theoretical',
    offsetMv: 0,
    slopeFrac: 1,
    points: [],
    segments: null,
  });

  /**
   * Ajuste linear por mínimos quadrados do modelo
   *   E_i = E0 + k · x_i,   x_i = −S(T_i) · (pH_i − 7)
   * Usar x_i normalizado por S(T_i) permite combinar pontos medidos a
   * temperaturas diferentes. Para 2 pontos o ajuste é exato.
   */
  function fitLine(points) {
    const n = points.length;
    if (n < 2) throw new Error('São necessários pelo menos 2 pontos de calibração.');
    const xs = points.map((p) => -nernstSlope(p.tC) * (p.pH - 7));
    const ys = points.map((p) => p.mV);
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (xs[i] - mx) ** 2;
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (sxx === 0) throw new Error('Pontos de calibração com o mesmo pH.');
    const slopeFrac = sxy / sxx;
    const offsetMv = my - slopeFrac * mx;
    let ssRes = 0;
    for (let i = 0; i < n; i++) ssRes += (ys[i] - (offsetMv + slopeFrac * xs[i])) ** 2;
    return { offsetMv, slopeFrac, rmsResidualMv: Math.sqrt(ssRes / n) };
  }

  /**
   * Calcula a calibração.
   * method = 'linear'    → uma reta para todos os pontos (regressão)
   *          'segmented' → retas entre pontos adjacentes (exige ≥ 3 pontos)
   */
  function calibrate(points, method = 'linear') {
    const sorted = [...points].sort((a, b) => a.pH - b.pH);
    const global = fitLine(sorted);
    const result = {
      method: method === 'segmented' && sorted.length >= 3 ? 'segmented' : 'linear',
      offsetMv: global.offsetMv,
      slopeFrac: global.slopeFrac,
      rmsResidualMv: global.rmsResidualMv,
      points: sorted.map((p) => ({ ...p })),
      segments: null,
    };
    if (result.method === 'segmented') {
      result.segments = [];
      for (let i = 0; i < sorted.length - 1; i++) {
        const seg = fitLine([sorted[i], sorted[i + 1]]);
        result.segments.push({ pHmin: sorted[i].pH, pHmax: sorted[i + 1].pH, offsetMv: seg.offsetMv, slopeFrac: seg.slopeFrac });
      }
    }
    return result;
  }

  /** Inverte o modelo do eletrodo: pH = 7 + (E0 − E) / (k · S(T)). */
  function lineToPh(mV, tC, offsetMv, slopeFrac) {
    return 7 + (offsetMv - mV) / (slopeFrac * nernstSlope(tC));
  }

  /** Converte o potencial medido (mV) em pH, usando a calibração e a temperatura do medidor. */
  function mvToPh(mV, tC, cal = THEORETICAL_CALIBRATION) {
    if (cal.method === 'segmented' && cal.segments && cal.segments.length) {
      // Escolhe o segmento cujo intervalo de pH contém o resultado; fora da faixa,
      // usa o segmento da extremidade (extrapolação).
      for (const seg of cal.segments) {
        const pH = lineToPh(mV, tC, seg.offsetMv, seg.slopeFrac);
        if (pH <= seg.pHmax) return pH;
      }
      const last = cal.segments[cal.segments.length - 1];
      return lineToPh(mV, tC, last.offsetMv, last.slopeFrac);
    }
    return lineToPh(mV, tC, cal.offsetMv, cal.slopeFrac);
  }

  /**
   * Critérios de aceitação da calibração (típicos de manuais de fabricantes;
   * cada fabricante define os seus):
   *   bom:        95 % ≤ inclinação ≤ 105 %  e  |E0| ≤ 15 mV
   *   aceitável:  90 % ≤ inclinação ≤ 105 %  e  |E0| ≤ 35 mV  (recomenda-se limpar o eletrodo)
   *   rejeitada:  fora desses limites
   * Para calibração segmentada, cada segmento é avaliado.
   */
  const CAL_LIMITS = { goodSlope: [0.95, 1.05], okSlope: [0.9, 1.05], goodOffset: 15, okOffset: 35 };

  function evaluateCalibration(cal) {
    const slopes = cal.segments ? cal.segments.map((s) => s.slopeFrac) : [cal.slopeFrac];
    const offset = Math.abs(cal.offsetMv);
    const within = (v, [a, b]) => v >= a && v <= b;
    const reasons = [];
    let level = 'good';
    for (const s of slopes) {
      if (!within(s, CAL_LIMITS.okSlope)) {
        level = 'error';
        reasons.push(`Inclinação ${(s * 100).toFixed(1)} % fora de 90–105 %`);
      } else if (!within(s, CAL_LIMITS.goodSlope) && level !== 'error') {
        level = 'ok';
        reasons.push(`Inclinação ${(s * 100).toFixed(1)} % abaixo de 95 %`);
      }
    }
    if (offset > CAL_LIMITS.okOffset) {
      level = 'error';
      reasons.push(`Offset ${cal.offsetMv.toFixed(1)} mV fora de ±35 mV`);
    } else if (offset > CAL_LIMITS.goodOffset && level !== 'error') {
      level = 'ok';
      reasons.push(`Offset ${cal.offsetMv.toFixed(1)} mV acima de ±15 mV`);
    }
    return { level, reasons };
  }

  /**
   * Reconhecimento automático de tampão: o medidor estima o pH supondo um
   * eletrodo ideal (E0 = 0, 100 %) e escolhe o tampão nominal mais próximo
   * dentro de uma janela de tolerância. O medidor NÃO sabe qual solução está
   * de fato no béquer — isto é responsabilidade do operador.
   */
  const RECOGNITION_WINDOW_PH = 1.2;
  function recognizeBuffer(mV, tC, candidates) {
    const guess = 7 - mV / nernstSlope(tC);
    let best = null;
    for (const nominal of candidates) {
      const d = Math.abs(guess - bufferPH(nominal, tC));
      if (d <= RECOGNITION_WINDOW_PH && (!best || d < best.distance)) best = { nominal, distance: d };
    }
    return { guess, nominal: best ? best.nominal : null };
  }

  // ---------------------------------------------------------------------------
  // Estabilidade da leitura
  // ---------------------------------------------------------------------------

  /**
   * Critério de estabilidade: a leitura é estável quando, numa janela de
   * `windowSec` segundos, a variação (máx − mín) do sinal filtrado é menor
   * que `thresholdMv`. 0,6 mV ≈ 0,01 pH a 25 °C.
   * samples: [{ t, v }] em ordem cronológica.
   */
  function isStable(samples, windowSec = 5, thresholdMv = 0.6) {
    if (!samples.length) return false;
    const tEnd = samples[samples.length - 1].t;
    if (tEnd - samples[0].t < windowSec - 1e-9) return false;
    let min = Infinity;
    let max = -Infinity;
    for (const s of samples) {
      if (tEnd - s.t > windowSec + 1e-9) continue;
      if (!Number.isFinite(s.v)) return false;
      if (s.v < min) min = s.v;
      if (s.v > max) max = s.v;
    }
    return max - min < thresholdMv;
  }

  return {
    R, F, LN10,
    celsiusToKelvin, nernstSlope, interpolate, mulberry32, gaussian, firstOrderStep,
    pKw, waterDielectric, debyeHuckelA, daviesLogGamma, DAVIES_MAX_I, vantHoffPK, henryCO2,
    solveEquilibrium,
    BUFFER_TABLE, BUFFER_T_RANGE, bufferPH,
    electrodePotential, alkalineError,
    THEORETICAL_CALIBRATION, fitLine, calibrate, mvToPh, CAL_LIMITS, evaluateCalibration,
    RECOGNITION_WINDOW_PH, recognizeBuffer,
    isStable,
  };
});

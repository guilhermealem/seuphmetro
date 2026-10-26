// Testes dos cálculos químicos. Executar: node --test tests/
// Os valores esperados vêm de cálculos independentes ou de valores de literatura
// (indicados em cada teste); tolerâncias refletem a incerteza dos modelos.
const test = require('node:test');
const assert = require('node:assert/strict');
const Chem = require('../js/chem.js');
const Solutions = require('../js/solutions.js');

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} esperado ${expected} ± ${tol}, obtido ${actual}`);

test('inclinação de Nernst: 59,16 mV/pH a 25 °C; 54,20 a 0 °C; 64,12 a 50 °C', () => {
  near(Chem.nernstSlope(25), 59.16, 0.01);
  near(Chem.nernstSlope(0), 54.2, 0.01);
  near(Chem.nernstSlope(50), 64.12, 0.01);
});

test('constante A de Debye–Hückel ≈ 0,51 a 25 °C e cresce com T', () => {
  near(Chem.debyeHuckelA(25), 0.511, 0.003);
  assert.ok(Chem.debyeHuckelA(50) > Chem.debyeHuckelA(25));
  assert.ok(Chem.debyeHuckelA(0) < Chem.debyeHuckelA(25));
});

test('pKw tabelado e interpolado', () => {
  near(Chem.pKw(25), 13.995, 1e-9);
  near(Chem.pKw(22.5), (14.167 + 13.995) / 2, 1e-9);
});

test('van t Hoff: ΔH = 0 não altera pK; ΔH > 0 reduz pK com aquecimento', () => {
  near(Chem.vantHoffPK(4.756, 0, 40), 4.756, 1e-12);
  assert.ok(Chem.vantHoffPK(9.245, 51950, 40) < 9.245);
  // NH4+: dpKa/dT ≈ −0,031 K⁻¹ perto de 25 °C
  near(Chem.vantHoffPK(9.245, 51950, 26) - 9.245, -0.0305, 0.001);
});

test('água pura (sem CO2) é neutra: pH = pKw/2', () => {
  for (const t of [10, 25, 40]) near(Chem.solveEquilibrium({}, t).pH, Chem.pKw(t) / 2, 1e-6, `T=${t}`);
});

test('HCl 0,010 mol/L → pH ≈ 2,04 (correção de atividade de 0,04)', () => {
  near(Solutions.trueState('hcl001', 25).pH, 2.045, 0.005);
});

test('NaOH 0,010 mol/L → pH ≈ 11,95 a 25 °C e menor a quente (pKw diminui)', () => {
  near(Solutions.trueState('naoh001', 25).pH, 11.95, 0.01);
  assert.ok(Solutions.trueState('naoh001', 40).pH < 11.6);
});

test('ácido acético 0,10 mol/L → pH ≈ 2,88', () => {
  near(Solutions.trueState('acetic01', 25).pH, 2.88, 0.01);
});

test('tampão acetato 0,1/0,1 → pH ≈ pKa − 0,11 (atividade) ≈ 4,65', () => {
  near(Solutions.trueState('acetate', 25).pH, 4.65, 0.01);
});

test('NH3 0,10 mol/L → pH ≈ 11,12', () => {
  near(Solutions.trueState('nh3', 25).pH, 11.12, 0.02);
});

test('NaHCO3 0,10 mol/L (sistema fechado, Davies) → pH ≈ 8,12', () => {
  // (pK1 + pK2)/2 = 8,34 sem atividade; com γ de Davies em I ≈ 0,1 → ≈ 8,12.
  near(Solutions.trueState('nahco3', 25).pH, 8.12, 0.02);
});

test('água equilibrada com CO2 atmosférico (420 ppm) → pH ≈ 5,60', () => {
  near(Solutions.trueState('water', 25).pH, 5.6, 0.03);
});

test('solver satisfaz o balanço de carga do tampão acetato', () => {
  const t = 25;
  const r = Chem.solveEquilibrium({ ions: [{ z: 1, c: 0.1, isNa: true }], acids: [{ c: 0.2, z0: 0, pKa: [{ pK: 4.756 }] }] }, t);
  const g = r.gamma1;
  const x = 10 ** -r.pH;
  const Ka = 10 ** -4.756;
  const ac = (0.2 * (Ka / (x * g))) / (1 + Ka / (x * g));
  const balance = x / g + 0.1 - 1e-14 / (x * g) - ac;
  near(balance, 0, 1e-10);
});

test('tabela de tampões: valores nominais a 25 °C e variação típica com T', () => {
  near(Chem.bufferPH(4, 25), 4.0, 1e-9);
  near(Chem.bufferPH(7, 25), 7.0, 1e-9);
  near(Chem.bufferPH(10, 25), 10.0, 1e-9);
  near(Chem.bufferPH(10, 37.5), (9.91 + 9.87) / 2, 1e-9);
  assert.ok(Chem.bufferPH(10, 10) > Chem.bufferPH(10, 40));
});

test('mvToPh inverte exatamente o modelo do eletrodo', () => {
  const cal = { method: 'linear', offsetMv: 12, slopeFrac: 0.97 };
  for (const t of [5, 25, 45]) {
    for (const pH of [1, 4, 7, 10, 13]) {
      const E = Chem.electrodePotential({ pH, tC: t, offsetMv: 12, slopeFrac: 0.97 });
      near(Chem.mvToPh(E, t, cal), pH, 1e-9);
    }
  }
});

test('calibração em 2 pontos recupera E0 e k mesmo com temperaturas diferentes', () => {
  const pts = [
    { pH: 7.0, tC: 25, mV: Chem.electrodePotential({ pH: 7.0, tC: 25, offsetMv: -8, slopeFrac: 0.965 }) },
    { pH: 4.0, tC: 30, mV: Chem.electrodePotential({ pH: 4.0, tC: 30, offsetMv: -8, slopeFrac: 0.965 }) },
  ];
  const cal = Chem.calibrate(pts);
  near(cal.offsetMv, -8, 1e-9);
  near(cal.slopeFrac, 0.965, 1e-12);
});

test('calibração em 3 pontos: regressão com ruído e segmentada exata nos pontos', () => {
  const pts = [4, 7, 10].map((pH, i) => ({ pH, tC: 25, mV: Chem.electrodePotential({ pH, tC: 25, offsetMv: 5, slopeFrac: 0.98 }) + [0.3, -0.2, 0.4][i] }));
  const lin = Chem.calibrate(pts, 'linear');
  near(lin.slopeFrac, 0.98, 0.01);
  assert.ok(lin.rmsResidualMv > 0);
  const seg = Chem.calibrate(pts, 'segmented');
  assert.equal(seg.segments.length, 2);
  for (const p of pts) near(Chem.mvToPh(p.mV, p.tC, seg), p.pH, 1e-9);
  // continuidade no ponto pH 7
  const e7 = pts[1].mV;
  near(Chem.mvToPh(e7 + 1e-6, 25, seg), Chem.mvToPh(e7 - 1e-6, 25, seg), 1e-6);
});

test('segmentada com 2 pontos cai para linear', () => {
  const pts = [{ pH: 4, tC: 25, mV: 177 }, { pH: 7, tC: 25, mV: 0 }];
  assert.equal(Chem.calibrate(pts, 'segmented').method, 'linear');
});

test('critérios de aceitação da calibração', () => {
  assert.equal(Chem.evaluateCalibration({ slopeFrac: 0.99, offsetMv: 5 }).level, 'good');
  assert.equal(Chem.evaluateCalibration({ slopeFrac: 0.93, offsetMv: 5 }).level, 'ok');
  assert.equal(Chem.evaluateCalibration({ slopeFrac: 0.99, offsetMv: 20 }).level, 'ok');
  assert.equal(Chem.evaluateCalibration({ slopeFrac: 0.88, offsetMv: 5 }).level, 'error');
  assert.equal(Chem.evaluateCalibration({ slopeFrac: 1.08, offsetMv: 5 }).level, 'error');
  assert.equal(Chem.evaluateCalibration({ slopeFrac: 0.99, offsetMv: -40 }).level, 'error');
});

test('erro alcalino: negativo, desprezível em pH 7 e relevante em pH ~13 com Na+', () => {
  const k = 10 ** -12.5;
  near(Chem.alkalineError(7, k, 0.1), 0, 1e-6);
  const e13 = Chem.alkalineError(12.9, k, 0.078);
  assert.ok(e13 < -0.05 && e13 > -0.15, `erro ${e13}`);
});

test('reconhecimento de tampão por janela de pH', () => {
  assert.equal(Chem.recognizeBuffer(0, 25, [4, 7, 10]).nominal, 7);
  assert.equal(Chem.recognizeBuffer(177, 25, [4, 7, 10]).nominal, 4);
  assert.equal(Chem.recognizeBuffer(-177, 25, [4, 7, 10]).nominal, 10);
  assert.equal(Chem.recognizeBuffer(-177, 25, [4, 7]).nominal, null);
  assert.equal(Chem.recognizeBuffer(290, 25, [4, 7, 10]).nominal, null); // pH ≈ 2
});

test('critério de estabilidade', () => {
  const flat = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.1, v: 100 + (i % 2) * 0.1 }));
  assert.equal(Chem.isStable(flat), true);
  const ramp = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.1, v: 100 + i * 0.05 }));
  assert.equal(Chem.isStable(ramp), false);
  assert.equal(Chem.isStable(flat.slice(0, 20)), false); // janela incompleta
});

test('resposta de primeira ordem atinge 63,2 % em t = τ', () => {
  near(Chem.firstOrderStep(0, 100, 5, 5), 100 * (1 - Math.exp(-1)), 1e-9);
});

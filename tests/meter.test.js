// Testes do motor de simulação (sem navegador). Executar: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const PHMeter = require('../js/meter.js');

const near = (a, e, tol, msg) => assert.ok(Math.abs(a - e) <= tol, `${msg || ''} esperado ${e} ± ${tol}, obtido ${a}`);

/** Troca a solução e espera a leitura estabilizar (máx. maxS segundos simulados). */
function settle(m, id, maxS = 300) {
  if (id) m.setSolution(id);
  let t = 0;
  while (!m.isStable() && t < maxS) { m.tick(0.1); t += 0.1; }
  return t;
}

function calibrate(m, buffers = [4, 7, 10], method = 'linear') {
  m.startCalibration(buffers, method);
  let r;
  while (m.nextBuffer() !== null) {
    settle(m, 'buffer' + m.nextBuffer());
    r = m.confirmCalibrationPoint();
    assert.ok(r.ok || r.done, r.message);
  }
  return r;
}

test('a leitura se aproxima gradualmente (não instantaneamente) do valor final', () => {
  const m = new PHMeter();
  calibrate(m);
  settle(m, 'buffer7');
  m.setSolution('buffer4');
  m.tick(1);
  const after1s = m.reading().pH;
  assert.ok(after1s > 5, `após 1 s ainda deve estar longe de 4 (obtido ${after1s})`);
  assert.equal(m.reading().stable, false);
  const t = settle(m);
  assert.ok(t > 8 && t < 60, `tempo de estabilização plausível (${t} s)`);
  near(m.reading().pH, 4.0, 0.02);
});

test('calibração em 3 pontos com eletrodo novo: boa, inclinação ≈ 99 %', () => {
  const m = new PHMeter();
  const r = calibrate(m);
  assert.ok(r.done && !r.rejected);
  assert.equal(m.calEvaluation.level, 'good');
  near(m.calibration.slopeFrac, 0.99, 0.01);
  near(m.calibration.offsetMv, 4, 1.5);
  for (const b of [4, 7, 10]) { settle(m, 'buffer' + b); near(m.reading().pH, b, 0.02, `tampão ${b}`); }
});

test('calibração em 2 pontos (4–7) e segmentada em 3 pontos', () => {
  const m = new PHMeter();
  calibrate(m, [4, 7]);
  assert.equal(m.calibration.points.length, 2);
  const m2 = new PHMeter();
  calibrate(m2, [4, 7, 10], 'segmented');
  assert.equal(m2.calibration.method, 'segmented');
  assert.equal(m2.calibration.segments.length, 2);
});

test('amostras medidas após calibração concordam com o modelo (eletrodo novo)', () => {
  const m = new PHMeter();
  calibrate(m);
  for (const id of ['hcl001', 'acetate', 'nahco3', 'naoh001']) {
    settle(m, id);
    const r = m.reading();
    near(r.pH, r.truePH, 0.03, id);
  }
});

test('erro alcalino: NaOH 0,10 mol/L lido abaixo do valor real', () => {
  const m = new PHMeter();
  calibrate(m);
  settle(m, 'naoh01');
  const r = m.reading();
  assert.ok(r.truePH - r.pH > 0.04, `diferença ${r.truePH - r.pH}`);
  assert.ok(r.warnings.some((w) => w.code === 'W6'));
});

test('eletrodo envelhecido: calibração rejeitada e calibração anterior mantida', () => {
  const m = new PHMeter();
  calibrate(m);
  const before = m.calibration;
  m.setElectrode('aged');
  const r = calibrate(m);
  assert.ok(r.rejected);
  assert.equal(m.calibration, before);
  assert.ok(m.lastRejected.cal.slopeFrac < 0.9);
});

test('eletrodo em uso: calibração aceitável com aviso W2', () => {
  const m = new PHMeter();
  m.setElectrode('used');
  calibrate(m);
  assert.equal(m.calEvaluation.level, 'ok');
  assert.ok(m.reading().warnings.some((w) => w.code === 'W2'));
});

test('não aceita ponto instável, tampão repetido ou solução não reconhecida', () => {
  const m = new PHMeter();
  settle(m, 'buffer7');
  m.startCalibration([4, 7, 10]);
  m.setSolution('buffer4');
  m.tick(0.5);
  assert.equal(m.confirmCalibrationPoint().ok, false); // instável
  settle(m, 'buffer7');
  assert.equal(m.confirmCalibrationPoint().ok, true);
  settle(m, 'buffer7', 30);
  assert.match(m.confirmCalibrationPoint().message, /já foi usado/);
  settle(m, 'hcl001');
  assert.match(m.confirmCalibrationPoint().message, /não reconhecido/);
  m.cancelCalibration();
  assert.equal(m.calSession, null);
});

test('compensação: ATC usa tabela do tampão na temperatura; MTC errado gera aviso e erro', () => {
  const m = new PHMeter();
  m.setBathTemperature(35);
  m.tick(60); // sensor de temperatura entra em equilíbrio
  calibrate(m);
  settle(m, 'buffer10');
  near(m.reading().pH, 9.91, 0.03, 'tampão 10 a 35 °C');

  m.setTempMode('MTC');
  m.setManualTemperature(15);
  settle(m);
  const r = m.reading();
  assert.ok(r.warnings.some((w) => w.code === 'W3'));
  assert.ok(Math.abs(r.pH - 9.91) > 0.03, 'compensação errada deve afetar a leitura longe de pH 7');
});

test('eletrodo desconectado (E1), ao ar (E2) e entupido (E4)', () => {
  const m = new PHMeter();
  m.setElectrode('disconnected');
  m.tick(1);
  assert.ok(m.reading().errors.some((e) => e.code === 'E1'));
  assert.ok(Number.isNaN(m.reading().pH));

  const a = new PHMeter();
  a.setSolution('air');
  a.tick(5);
  assert.ok(a.reading().errors.some((e) => e.code === 'E2'));

  const c = new PHMeter();
  c.setElectrode('clogged');
  c.tick(120);
  assert.ok(c.reading().errors.some((e) => e.code === 'E4'));
});

test('sem calibração emite W1; histórico registra e reinício limpa tudo', () => {
  const m = new PHMeter();
  m.tick(10);
  assert.ok(m.reading().warnings.some((w) => w.code === 'W1'));
  const e = m.record();
  assert.equal(e.n, 1);
  assert.equal(m.history.length, 1);
  calibrate(m);
  m.reset();
  assert.equal(m.history.length, 0);
  assert.equal(m.calibration, null);
  assert.equal(m.time, 0);
});

test('simulação determinística para a mesma semente', () => {
  const run = () => { const m = new PHMeter({ seed: 7 }); m.setSolution('water'); m.tick(20); return m.reading().mV; };
  assert.equal(run(), run());
});

test('ponto de calibração exige temperatura estável (sensor ATC ainda aquecendo)', () => {
  const m = new PHMeter();
  settle(m, 'buffer7');
  m.startCalibration([4, 7]);
  m.setBathTemperature(40);
  m.tick(3); // sensor (τ = 8 s) ainda longe de 40 °C
  assert.equal(m.isStable(), false);
  assert.equal(m.confirmCalibrationPoint().ok, false);
  settle(m);
  near(m.probeTemp, 40, 0.2); // critério: variação < 0,1 °C em 5 s
  const r = m.confirmCalibrationPoint();
  assert.ok(r.ok, r.message);
  near(m.calSession.points[0].pH, 6.97, 0.005, 'pH do tampão 7 a 40 °C pela tabela');
});


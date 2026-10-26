/**
 * ui.js — Camada de interface. Lê o estado de PHMeter e o desenha no DOM;
 * nenhum cálculo químico é feito aqui.
 */
(function () {
  'use strict';

  const Chem = window.PHChem;
  const Solutions = window.PHSolutions;
  const PHMeter = window.PHMeter;

  const TICK_MS = 100;
  const meter = new PHMeter();
  let speed = 1;
  let lastHistoryLength = -1;
  let lastCalKey = '';

  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : '—');
  const fmtSigned = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '−') + fmt(Math.abs(v), d) : '—');
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------ preenchimento inicial
  function populateSelects() {
    const sel = $('sel-solution');
    sel.innerHTML = '';
    const groups = {};
    for (const s of Solutions.SOLUTIONS) {
      if (!groups[s.group]) {
        groups[s.group] = document.createElement('optgroup');
        groups[s.group].label = s.group;
        sel.appendChild(groups[s.group]);
      }
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.source === 'didactic' ? `${s.name} — didático` : s.name;
      groups[s.group].appendChild(opt);
    }
    const el = $('sel-electrode');
    el.innerHTML = '';
    for (const [id, e] of Object.entries(PHMeter.ELECTRODES)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = e.name;
      el.appendChild(opt);
    }
  }

  function syncControlsFromMeter() {
    $('sel-solution').value = meter.solutionId;
    $('sel-electrode').value = meter.electrodeId;
    $('rng-temp').value = meter.bathTemp;
    $('num-manual').value = meter.manualTemp;
    $('num-manual').disabled = meter.tempMode !== 'MTC';
    document.querySelectorAll('input[name="tmode"]').forEach((r) => { r.checked = r.value === meter.tempMode; });
    renderSolutionInfo();
  }

  // ------------------------------------------------------------ ações
  function changeSolution(id) {
    if (id === meter.solutionId) return;
    meter.setSolution(id);
    $('sel-solution').value = id;
    // Animação: retirar, "lavar" e mergulhar o eletrodo.
    const probes = $('probes');
    probes.classList.add('lifted');
    if (id !== 'air') setTimeout(() => { if (meter.solutionId !== 'air') probes.classList.remove('lifted'); }, 700);
    renderSolutionInfo();
  }

  function startCalibration() {
    const buffers = $('sel-calpoints').value.split(',').map(Number);
    const fallback = $('sel-calmethod').value === 'segmented' && buffers.length < 3;
    meter.startCalibration(buffers, fallback ? 'linear' : $('sel-calmethod').value);
    if (fallback) meter.message = { level: 'warn', text: `${meter.message.text} (Segmentada exige 3 pontos: usando regressão linear.)` };
    render();
  }

  function onEnter() {
    if (meter.calSession) meter.confirmCalibrationPoint();
    else meter.record();
    render();
  }

  function resetSimulation() {
    const hasWork = meter.history.length > 0 || meter.calibration;
    if (hasWork && !window.confirm('Reiniciar a simulação? Calibração e histórico serão apagados.')) return;
    meter.reset();
    speed = 1;
    $('speed').value = '1';
    $('probes').classList.remove('lifted');
    syncControlsFromMeter();
    lastHistoryLength = -1;
    lastCalKey = '';
    render();
  }

  function exportCsv() {
    if (!meter.history.length) return;
    const header = ['n', 'tempo_s', 'amostra', 'pH', 'mV', 'T_medidor_C', 'T_amostra_C', 'compensacao', 'estabilidade', 'calibracao', 'pH_referencia_simulador', 'origem_referencia', 'alertas', 'data_hora'];
    const rows = meter.history.map((h) => [
      h.n, fmt(h.simTime, 1), h.sampleName, fmt(h.pH, 2), fmt(h.mV, 1), fmt(h.meterTemp, 1), fmt(h.sampleTemp, 1),
      h.tempMode, stabilityLabel(h.stability), h.calSummary, fmt(h.truePH, 3), Solutions.SOURCE_LABELS[h.source], h.codes.join(' '), h.wallTime,
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'historico-phmetro.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function bindEvents() {
    $('sel-solution').addEventListener('change', (e) => changeSolution(e.target.value));
    $('sel-electrode').addEventListener('change', (e) => { meter.setElectrode(e.target.value); render(); });
    $('rng-temp').addEventListener('input', (e) => { meter.setBathTemperature(e.target.value); renderSolutionInfo(); });
    document.querySelectorAll('input[name="tmode"]').forEach((r) => r.addEventListener('change', (e) => {
      meter.setTempMode(e.target.value);
      $('num-manual').disabled = meter.tempMode !== 'MTC';
    }));
    $('num-manual').addEventListener('change', (e) => { meter.setManualTemperature(e.target.value); e.target.value = meter.manualTemp; });
    $('speed').addEventListener('change', (e) => { speed = Number(e.target.value) || 1; });

    $('key-cal').addEventListener('click', () => { if (!meter.calSession) startCalibration(); });
    $('key-mode').addEventListener('click', () => { meter.toggleDisplayMode(); render(); });
    $('key-enter').addEventListener('click', onEnter);
    $('key-exit').addEventListener('click', () => { meter.cancelCalibration(); render(); });

    $('btn-cal-start').addEventListener('click', startCalibration);
    $('btn-cal-confirm').addEventListener('click', () => { meter.confirmCalibrationPoint(); render(); });
    $('btn-cal-cancel').addEventListener('click', () => { meter.cancelCalibration(); render(); });
    $('btn-cal-insert').addEventListener('click', () => {
      const b = meter.nextBuffer();
      if (b !== null) changeSolution('buffer' + b);
    });

    $('btn-record').addEventListener('click', () => { meter.record(); render(); });
    $('btn-csv').addEventListener('click', exportCsv);
    $('btn-clear').addEventListener('click', () => {
      if (meter.history.length && window.confirm('Apagar todo o histórico?')) { meter.clearHistory(); render(); }
    });
    $('btn-reset').addEventListener('click', resetSimulation);
  }

  // ------------------------------------------------------------ renderização
  function stabilityLabel(s) {
    return { stable: 'Estável', settling: 'Estabilizando', unstable: 'Instável' }[s] || s;
  }

  function renderSolutionInfo() {
    const s = meter.solution;
    let desc = s.description || '';
    if (s.source === 'didactic') desc = `VALOR DIDÁTICO: pH ${fmt(s.pH25)} representa a faixa típica ${s.range}. Amostras reais variam; sem dependência com a temperatura.`;
    if (s.source === 'none') desc = 'Eletrodo exposto ao ar: a membrana não tem contato elétrico com a referência.';
    $('solution-desc').textContent = desc;
    $('bench-sample').textContent = s.name;
    const badge = $('bench-source');
    badge.textContent = Solutions.SOURCE_LABELS[s.source];
    badge.className = 'badge' + (s.source === 'didactic' ? ' badge-didactic' : s.source === 'model' ? ' badge-model' : '');
    const liquid = $('liquid');
    if (s.color) { liquid.style.fill = s.color; liquid.classList.remove('empty'); } else liquid.classList.add('empty');
    if (s.source === 'none') $('probes').classList.add('lifted');
    $('out-temp').textContent = `${fmt(meter.bathTemp, 1)} °C`;
    $('bath-label').textContent = `${fmt(meter.bathTemp, 1)} °C`;
  }

  function renderLcd(r) {
    const value = $('lcd-value');
    const unit = $('lcd-unit');
    let text;
    if (meter.electrode.disconnected) text = '----';
    else if (meter.displayMode === 'pH') text = r.outOfRange ? (r.pH > 0 ? 'Or ' : '-Or') : r.pH.toFixed(2);
    else {
      const [lo, hi] = PHMeter.DISPLAY_RANGE_MV;
      text = r.mV < lo || r.mV > hi ? 'Or' : r.mV.toFixed(1);
    }
    value.textContent = text;
    unit.textContent = meter.displayMode;
    value.classList.toggle('blink', r.errors.length > 0);

    $('lcd-mode').textContent = meter.calSession ? `CAL ${meter.calSession.points.length + 1}/${meter.calSession.buffers.length}` : 'MEAS';
    const stab = $('lcd-stab');
    stab.textContent = r.stable ? 'STB' : '~~';
    stab.classList.toggle('off', !r.stable);
    unit.classList.toggle('blink', !r.stable && !meter.electrode.disconnected);

    const calBufs = meter.calibration ? meter.calibration.points.map((p) => p.nominal) : [];
    const sessBufs = meter.calSession ? meter.calSession.points.map((p) => p.nominal) : [];
    document.querySelectorAll('#lcd-bufs span').forEach((sp) => {
      const b = Number(sp.dataset.b);
      sp.classList.toggle('on', meter.calSession ? sessBufs.includes(b) : calBufs.includes(b));
    });
    const level = meter.calEvaluation ? meter.calEvaluation.level : null;
    const bars = !meter.calibration ? 0 : level === 'good' ? 3 : level === 'ok' ? 2 : 1;
    document.querySelectorAll('#lcd-electrode i').forEach((bar, i) => bar.classList.toggle('on', i < bars));

    $('lcd-temp').textContent = `${r.meterTemp.toFixed(1)} °C`;
    $('lcd-atc').textContent = r.tempMode;
    $('lcd-err').textContent = r.errors.length ? 'Err' + r.errors[0].code.slice(1) : '';

    const led = $('led');
    led.className = 'meter-led' + (r.errors.length ? ' err' : r.warnings.length ? ' warn' : '');
    const msg = $('meter-msg');
    msg.textContent = meter.message.text;
    msg.className = 'meter-msg ' + meter.message.level;
  }

  function renderStatus(r) {
    $('st-reading').textContent = meter.electrode.disconnected ? '—' : r.outOfRange ? 'fora da faixa' : `pH ${fmt(r.pH)}`;
    $('st-mv').textContent = Number.isFinite(r.mV) ? `${fmtSigned(r.mV, 1)} mV` : '—';
    const stab = $('st-stab');
    stab.textContent = stabilityLabel(r.stability);
    stab.className = 'pill ' + (r.stable ? 'ok' : r.stability === 'settling' ? 'warn' : 'err');

    const cal = $('st-cal');
    if (meter.calSession) { cal.textContent = 'Em andamento'; cal.className = 'pill warn'; }
    else if (!meter.calibration) { cal.textContent = 'Não calibrado'; cal.className = 'pill err'; }
    else {
      const ok = meter.calEvaluation.level === 'good';
      cal.textContent = `${meter.calibration.points.length} pts · ${fmt(meter.calibration.slopeFrac * 100, 1)} %`;
      cal.className = 'pill ' + (ok ? 'ok' : 'warn');
    }
    $('st-tsample').textContent = `${fmt(r.sampleTemp, 1)} °C`;
    $('st-tmeter').textContent = `${fmt(r.meterTemp, 1)} °C (${r.tempMode})`;

    // Barra de estabilidade: fração da janela de 5 s dentro do critério.
    const samples = meter.samples;
    let fill = 0;
    if (samples.length > 1 && Number.isFinite(r.mV)) {
      const recent = samples.filter((s) => r.time - s.t <= PHMeter.STABILITY_WINDOW_S);
      const vals = recent.map((s) => s.v);
      const range = Math.max(...vals) - Math.min(...vals);
      const span = recent.length ? r.time - recent[0].t : 0;
      fill = Math.min(1, span / PHMeter.STABILITY_WINDOW_S) * Math.min(1, PHMeter.STABILITY_THRESHOLD_MV / Math.max(range, 1e-6));
    }
    const sf = $('stab-fill');
    sf.style.width = `${Math.round((r.stable ? 1 : Math.min(fill, 0.95)) * 100)}%`;
    sf.classList.toggle('ok', r.stable);

    const diag = $('diag');
    const items = [
      ...r.errors.map((e) => ({ cls: 'err', code: e.code, text: e.text })),
      ...r.warnings.map((w) => ({ cls: 'warn', code: w.code, text: w.text })),
    ];
    if (!items.length) items.push({ cls: 'ok', code: 'OK', text: 'Nenhum problema detectado.' });
    const html = items.map((i) => `<li class="${i.cls}"><b>${i.code}</b><span>${escapeHtml(i.text)}</span></li>`).join('');
    if (diag.innerHTML !== html) diag.innerHTML = html;

    // Painel do instrutor
    $('tr-ph').textContent = Number.isFinite(r.truePH) ? `pH ${fmt(r.truePH, 3)}` : '—';
    $('tr-src').textContent = Solutions.SOURCE_LABELS[r.source];
    const err = r.pH - r.truePH;
    $('tr-err').textContent = Number.isFinite(err) && !r.outOfRange ? `${fmtSigned(err, 3)} pH` : '—';
    $('tr-slope').textContent = `${fmt(Chem.nernstSlope(r.sampleTemp), 2)} mV/pH`;
  }

  function renderCalibration() {
    const s = meter.calSession;
    $('cal-wizard').hidden = !s;
    $('cal-start-row').hidden = !!s;
    $('sel-calpoints').disabled = !!s;
    $('sel-calmethod').disabled = !!s;
    if (s) {
      const next = meter.nextBuffer();
      const steps = s.order.map((b) => {
        const p = s.points.find((pt) => pt.nominal === b);
        if (p) return `<li class="done">pH ${fmt(b)} ✓ — ${fmt(p.mV, 1)} mV, ${fmt(p.tC, 1)} °C (pH do tampão: ${fmt(p.pH)})</li>`;
        return `<li class="${b === next ? 'current' : ''}">Tampão pH ${fmt(b)}${b === next ? ' — aguarde STB e confirme' : ''}</li>`;
      });
      $('cal-steps').innerHTML = steps.join('');
      $('btn-cal-insert').textContent = next !== null ? `Colocar no tampão pH ${fmt(next)}` : 'Colocar no próximo tampão';
      $('btn-cal-confirm').disabled = !meter.isStable();
    }

    const cal = meter.calibration;
    const rej = meter.lastRejected;
    const key = JSON.stringify([cal && cal.time, rej && rej.cal.time]);
    if (key === lastCalKey) return;
    lastCalKey = key;
    let html = '';
    if (rej) {
      html += `<p class="pill err">Última tentativa rejeitada: inclinação ${fmt(rej.cal.slopeFrac * 100, 1)} %, offset ${fmtSigned(rej.cal.offsetMv, 1)} mV</p>
        <p class="hint">${escapeHtml(rej.evaluation.reasons.join('; '))}</p>`;
    }
    if (cal) {
      const ev = meter.calEvaluation;
      const segs = cal.segments
        ? cal.segments.map((g) => `<li>pH ${fmt(g.pHmin)}–${fmt(g.pHmax)}: ${fmt(g.slopeFrac * 100, 1)} %, E₀ ${fmtSigned(g.offsetMv, 1)} mV</li>`).join('')
        : '';
      html += `<h3>Calibração ativa</h3>
        <p><span class="pill ${ev.level === 'good' ? 'ok' : 'warn'}">${ev.level === 'good' ? 'Bom' : 'Aceitável'}</span>
        Inclinação <b>${fmt(cal.slopeFrac * 100, 1)} %</b> · Offset <b>${fmtSigned(cal.offsetMv, 1)} mV</b>
        · ${cal.method === 'segmented' ? 'segmentada' : 'regressão linear'}${cal.points.length > 2 ? ` · resíduo RMS ${fmt(cal.rmsResidualMv, 2)} mV` : ''}</p>
        ${segs ? `<ul class="hint">${segs}</ul>` : ''}
        <table><thead><tr><th>Tampão</th><th>pH (T)</th><th>mV</th><th>T (°C)</th></tr></thead><tbody>
        ${cal.points.map((p) => `<tr><td>${fmt(p.nominal)}</td><td>${fmt(p.pH)}</td><td>${fmt(p.mV, 1)}</td><td>${fmt(p.tC, 1)}</td></tr>`).join('')}
        </tbody></table>`;
    } else if (!rej) {
      html = '<p class="hint">Medidor não calibrado. Recomenda-se calibrar com tampões que englobem a faixa das amostras.</p>';
    }
    $('cal-report').innerHTML = html;
  }

  function renderHistory() {
    if (meter.history.length === lastHistoryLength) return;
    lastHistoryLength = meter.history.length;
    $('history-empty').hidden = meter.history.length > 0;
    $('btn-csv').disabled = meter.history.length === 0;
    $('history-body').innerHTML = meter.history.slice().reverse().map((h) => `
      <tr class="${h.stability === 'stable' ? '' : 'unstable'}">
        <td class="num">${h.n}</td>
        <td class="num">${fmt(h.simTime, 1)}</td>
        <td>${escapeHtml(h.sampleName)}</td>
        <td class="num"><b>${fmt(h.pH)}</b></td>
        <td class="num">${fmtSigned(h.mV, 1)}</td>
        <td class="num">${fmt(h.meterTemp, 1)}</td>
        <td>${h.tempMode}</td>
        <td>${stabilityLabel(h.stability)}</td>
        <td>${escapeHtml(h.calSummary)}</td>
        <td class="num" title="${escapeHtml(Solutions.SOURCE_LABELS[h.source])}">${fmt(h.truePH, 3)}${h.source === 'didactic' ? ' *' : ''}</td>
        <td>${h.codes.join(' ') || '—'}</td>
      </tr>`).join('');
  }

  function render() {
    const r = meter.reading();
    renderLcd(r);
    renderStatus(r);
    renderCalibration();
    renderHistory();
  }

  // ------------------------------------------------------------ laço principal
  function loop() {
    meter.tick((TICK_MS / 1000) * speed);
    render();
  }

  populateSelects();
  syncControlsFromMeter();
  bindEvents();
  render();
  setInterval(loop, TICK_MS);

  // Exposto para depuração e testes automatizados no navegador.
  window.__phmeter = meter;
})();

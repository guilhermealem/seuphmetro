// Teste de interface no navegador (Playwright + Chromium).
// Executar: npm run test:browser   (requer `npm install` para obter o Playwright)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const SHOTS = process.env.SCREENSHOT_DIR;

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function openPage(viewport = { width: 1366, height: 900 }, colorScheme = 'light') {
  const page = await browser.newPage({ viewport, colorScheme, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(URL);
  await page.waitForFunction(() => window.__phmeter);
  return { page, errors };
}

/** Espera o medidor estabilizar (com a simulação acelerada). */
const waitStable = (page) => page.waitForFunction(() => window.__phmeter.isStable(), null, { timeout: 30000 });

test('fluxo completo: calibração 3 pontos, medição, histórico, CSV, mV e reinício', async () => {
  const { page, errors } = await openPage();
  await page.selectOption('#speed', '10');

  // Calibração pela interface
  await page.click('#btn-cal-start');
  assert.equal(await page.isVisible('#cal-wizard'), true);
  for (let i = 0; i < 3; i++) {
    await page.click('#btn-cal-insert');
    await waitStable(page);
    await page.waitForFunction(() => !document.getElementById('btn-cal-confirm').disabled);
    await page.click('#btn-cal-confirm');
  }
  assert.equal(await page.isHidden('#cal-wizard'), true);
  assert.match(await page.textContent('#cal-report'), /Calibração ativa/);
  assert.match(await page.textContent('#st-cal'), /3 pts/);
  assert.equal(await page.locator('#lcd-bufs span.on').count(), 3);

  // Medição de amostra calculada
  await page.selectOption('#sel-solution', 'acetate');
  await page.waitForTimeout(300);
  const early = parseFloat(await page.textContent('#lcd-value'));
  await waitStable(page);
  const final = parseFloat(await page.textContent('#lcd-value'));
  assert.ok(Math.abs(final - 4.65) < 0.03, `acetato: ${final}`);
  assert.ok(Math.abs(early - final) > 0.1, 'leitura deve variar gradualmente');
  assert.match(await page.textContent('#lcd-stab'), /STB/);

  // Registro (botão e tecla READ)
  await page.click('#btn-record');
  await page.selectOption('#sel-solution', 'milk');
  await waitStable(page);
  await page.click('#key-enter');
  assert.equal(await page.locator('#history-body tr').count(), 2);
  assert.match(await page.textContent('#history-body'), /Leite de vaca/);
  assert.match(await page.textContent('#bench-source'), /didático/i);

  // Exportar CSV
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-csv')]);
  assert.equal(download.suggestedFilename(), 'historico-phmetro.csv');

  // pH/mV
  await page.click('#key-mode');
  assert.equal(await page.textContent('#lcd-unit'), 'mV');
  await page.click('#key-mode');

  // Erros de eletrodo
  await page.selectOption('#sel-electrode', 'disconnected');
  await page.waitForTimeout(250);
  assert.equal(await page.textContent('#lcd-value'), '----');
  assert.match(await page.textContent('#diag'), /E1/);
  await page.selectOption('#sel-electrode', 'new');
  await page.selectOption('#sel-solution', 'air');
  await page.waitForTimeout(250);
  assert.match(await page.textContent('#diag'), /E2/);

  // Compensação manual
  await page.check('input[name="tmode"][value="MTC"]');
  assert.equal(await page.isEnabled('#num-manual'), true);
  await page.fill('#num-manual', '10');
  await page.dispatchEvent('#num-manual', 'change');
  await page.waitForTimeout(250);
  assert.match(await page.textContent('#diag'), /W3/);

  // Reiniciar
  await page.click('#btn-reset');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#history-body tr').count(), 0);
  assert.match(await page.textContent('#st-cal'), /Não calibrado/);
  assert.equal(await page.inputValue('#sel-solution'), 'buffer7');
  assert.equal(await page.isChecked('input[name="tmode"][value="ATC"]'), true);

  assert.deepEqual(errors, []);
  await page.close();
});

test('calibração rejeitada com eletrodo envelhecido aparece na interface', async () => {
  const { page } = await openPage();
  await page.selectOption('#speed', '10');
  await page.selectOption('#sel-electrode', 'aged');
  await page.selectOption('#sel-calpoints', '4,7');
  await page.click('#btn-cal-start');
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-cal-insert');
    await waitStable(page);
    await page.waitForFunction(() => !document.getElementById('btn-cal-confirm').disabled);
    await page.click('#btn-cal-confirm');
  }
  assert.match(await page.textContent('#cal-report'), /rejeitada/);
  assert.match(await page.textContent('#meter-msg'), /rejeitada/);
  await page.close();
});

for (const [w, h, scheme] of [[360, 780, 'light'], [768, 1024, 'dark'], [1280, 800, 'light'], [1920, 1080, 'dark']]) {
  test(`responsividade ${w}×${h} (${scheme}): sem rolagem horizontal`, async () => {
    const { page, errors } = await openPage({ width: w, height: h }, scheme);
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `rolagem horizontal de ${overflow}px`);
    for (const id of ['#lcd-value', '#key-enter', '#sel-solution', '#btn-reset', '#btn-record']) {
      assert.equal(await page.isVisible(id), true, id);
      const box = await page.locator(id).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= w + 0.5, `${id} fora da tela`);
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `ui-${w}-${scheme}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  });
}

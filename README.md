# Simulador de pHmetro

Simulador web interativo de um pHmetro de laboratório, escrito em **HTML, CSS e
JavaScript puro**, sem backend, sem banco de dados e sem etapa de build.

## Funcionalidades

- Medidor com visor LCD, teclas **CAL**, **pH/mV**, **READ/ENTER** e **EXIT**, LED de
  estado, indicador de estabilidade (STB), tampões calibrados e condição do eletrodo.
- Bancada com béquer, eletrodo de vidro, sensor de temperatura e banho termostático (0–50 °C).
- Calibração em **2 pontos** (4/7, 7/10 ou 4/10) ou **3 pontos** (4/7/10), por regressão
  linear ou segmentada, com reconhecimento automático do tampão e critérios de aceitação.
- Leitura que **estabiliza gradualmente** (resposta de 1ª ordem, ruído e deriva).
- Compensação de temperatura automática (ATC) ou manual (MTC).
- Soluções-tampão, amostras **calculadas por modelo de equilíbrio** e amostras com
  **valor didático**, que aparecem identificadas como tal na interface.
- Diagnóstico de eletrodo: desconectado, ao ar, entupido, envelhecido, erro alcalino,
  baixa força iônica, extrapolação, entre outros.
- Histórico de medições em tabela, com exportação para CSV (abre no Excel em português).
- Painel do instrutor com o pH de referência do modelo e o erro da leitura.
- Botão **Reiniciar simulação**, velocidade de 1× a 10×, tema claro e escuro, layout responsivo.

## Como executar localmente

**Opção 1: abrir o arquivo.** Dê um duplo clique em `index.html`. Tudo funciona
direto do disco, sem servidor.

**Opção 2: servidor local** (recomendado para desenvolvimento):

```bash
# com Python
python3 -m http.server 8080
# ou com Node.js
npx serve -l 8080 .
```

Depois, acesse <http://localhost:8080>.

## Testes

```bash
npm test                 # cálculos químicos e motor do medidor (Node ≥ 18, sem dependências)
npm install              # instala o Playwright (só para o teste de navegador)
npx playwright install chromium
npm run test:browser     # controles, fluxo completo e responsividade no Chromium
```

## Como publicar na internet

O projeto é estático, então qualquer hospedagem de arquivos serve.

**GitHub Pages**
1. Crie um repositório no GitHub e envie os arquivos:
   ```bash
   git add . && git commit -m "Simulador de pHmetro"
   git remote add origin https://github.com/SEU_USUARIO/seuphmetro.git
   git push -u origin main
   ```
2. No repositório, abra **Settings → Pages → Build and deployment** e escolha
   *Deploy from a branch*, depois `main` / `(root)`.
3. Em cerca de um minuto, o site estará em `https://SEU_USUARIO.github.io/seuphmetro/`.

**Netlify (sem conta Git)**: acesse <https://app.netlify.com/drop> e arraste a pasta do projeto.

**Vercel / Cloudflare Pages**: importe o repositório. Não há comando de build, e o
diretório de saída é a raiz (`.`).

## Estrutura

```
index.html          interface
css/style.css       estilos (tokens de cor, tema escuro, responsivo)
js/chem.js          cálculos físico-químicos puros (sem DOM)
js/solutions.js     catálogo de soluções e origem de cada valor de pH
js/meter.js         motor do instrumento: dinâmica, calibração, erros, histórico
js/ui.js            camada de interface (DOM)
docs/MODELO.md      fórmulas, hipóteses, fontes e limitações
tests/              testes unitários (node:test) e de navegador (Playwright)
```

## Rigor dos valores

- Leis físicas (Nernst, Davies, van 't Hoff) e constantes tabeladas com fonte estão em `docs/MODELO.md`.
- Os tampões usam uma **tabela típica** de fabricantes. Em uso real, vale o certificado do lote.
- As amostras **didáticas** (limão, cola, café, leite, água do mar) usam valores
  ilustrativos fixos, marcados como tais.
- Tempos de resposta, ruído e perfis de eletrodo são **parâmetros didáticos**.

Este simulador é educacional e não substitui procedimentos operacionais padrão.

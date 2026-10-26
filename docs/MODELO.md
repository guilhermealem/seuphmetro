# Modelo físico-químico do simulador

Este documento descreve **todas** as fórmulas, hipóteses e parâmetros usados pelo
simulador, e classifica cada valor quanto à sua origem:

| Origem | Significado |
|---|---|
| **Física** | Constante física ou lei física (Nernst, Davies, van 't Hoff). |
| **Literatura** | Constante tabelada (pKa, ΔH°, pKw, KH), com fonte indicada. |
| **Tabela de tampão** | Valores típicos de fabricantes; o certificado do lote prevalece. |
| **Modelo** | pH calculado a partir das constantes acima. |
| **Didático** | Valor escolhido para ilustrar um comportamento; não é medida real. |

O código está separado em camadas:

| Arquivo | Conteúdo | Usa DOM? |
|---|---|---|
| `js/chem.js` | fórmulas físico-químicas, calibração e estabilidade | não |
| `js/solutions.js` | catálogo de soluções e a origem de cada pH | não |
| `js/meter.js` | estado do instrumento: dinâmica, calibração, erros e histórico | não |
| `js/ui.js` | desenho da interface e eventos | sim |

---

## 1. Eletrodo de vidro: equação de Nernst

Potencial do eletrodo combinado (vidro + referência), em mV:

```
E = E0 − k · S(T) · (pH_ef − 7)
S(T) = 1000 · R · T · ln(10) / F      [mV/pH]
```

* `R = 8,314462618 J·mol⁻¹·K⁻¹`, `F = 96485,33212 C·mol⁻¹` (CODATA 2018, **física**).
* `S(25 °C) = 59,16 mV/pH`, `S(0 °C) = 54,20`, `S(50 °C) = 64,12`.
* `E0` (offset ou potencial de assimetria) e `k` (eficiência da inclinação) são propriedades do eletrodo.

**Hipóteses**

1. O ponto isopotencial é ideal: pH 7 e 0 mV (mais o offset), independente de T.
   Eletrodos reais têm ponto isopotencial ligeiramente diferente, o que gera pequenos
   erros quando se calibra e mede em temperaturas diferentes. Esse efeito não é simulado.
2. O potencial de junção líquida é constante, e por isso fica incorporado ao `E0`.
3. O erro ácido (pH < 1) não é simulado.

### 1.1 Erro alcalino (sódio): equação de Nikolsky–Eisenman

```
pH_ef = −log10( a_H + K_H,Na · a_Na )
```

Em pH alto com Na⁺ abundante, o vidro responde também ao sódio e lê um pH **menor**
que o real. `K_H,Na` é um **parâmetro didático** de cada perfil de eletrodo
(10⁻¹²·⁵ no eletrodo novo), escolhido para gerar um erro de ≈ 0,08 pH em NaOH 0,1 mol/L.
Esse valor fica na faixa típica de eletrodos de uso geral, mas o valor real depende do vidro.

## 2. Conversão mV → pH pelo medidor

O medidor inverte o modelo com os parâmetros obtidos na calibração e com a temperatura
que **ele** conhece (sensor ATC ou valor manual MTC):

```
pH = 7 + (E0 − E) / (k · S(T_medidor))
```

Sem calibração, o medidor usa `E0 = 0 mV` e `k = 100 %` e emite o aviso W1.

**Compensação de temperatura (ATC/MTC)**: corrige apenas `S(T)`, a resposta do eletrodo.
Ela **não** corrige a variação real do pH da amostra com a temperatura, que é química
e foi simulada separadamente (seção 4). Se o valor manual (MTC) difere da temperatura
real, a leitura erra, e o erro cresce com a distância a pH 7.

## 3. Calibração

Cada ponto registra `(pH_i, E_i, T_i)`. O valor `pH_i` vem da **tabela do tampão** na
temperatura do medidor, como fazem os medidores reais. Como os pontos podem ter
temperaturas diferentes, o ajuste é feito na variável normalizada:

```
E_i = E0 + k · x_i ,   x_i = −S(T_i) · (pH_i − 7)
```

* **Regressão linear**: mínimos quadrados de `(E0, k)` sobre todos os pontos. Com 2 pontos, a solução é exata.
  O resíduo RMS (mV) é informado.
* **Segmentada** (3 pontos): uma reta por par de tampões adjacentes (4–7 e 7–10). A reta
  é escolhida pelo intervalo de pH, a função é contínua no tampão 7 e as extremidades são extrapoladas.

**Reconhecimento de tampão**: o medidor estima o pH supondo um eletrodo ideal e aceita o
tampão nominal mais próximo dentro de ±1,2 pH. O ponto só é aceito com leitura estável.
O medidor **não** sabe qual líquido está no béquer. Por isso, uma amostra de pH 4,65 seria
"reconhecida" como tampão 4, como num instrumento real. Evitar isso é tarefa do operador.

**Critérios de aceitação** (típicos de manuais de fabricantes; cada um define os seus):

| Resultado | Inclinação | \|Offset\| |
|---|---|---|
| Bom | 95–105 % | ≤ 15 mV |
| Aceitável (limpar eletrodo) | 90–95 % | 15–35 mV |
| Rejeitada (mantém a calibração anterior) | < 90 % ou > 105 % | > 35 mV |

### 3.1 Tabela dos tampões (pH × T)

Valores **típicos** de tampões técnicos comerciais. Cada lote tem a sua própria tabela
no certificado, que deve prevalecer em uso real. Entre os pontos, o pH é interpolado linearmente.

| T (°C) | 0 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pH 4 | 4,01 | 4,01 | 4,00 | 4,00 | 4,00 | 4,00 | 4,01 | 4,02 | 4,03 | 4,04 | 4,06 |
| pH 7 | 7,12 | 7,09 | 7,06 | 7,04 | 7,02 | 7,00 | 6,99 | 6,98 | 6,97 | 6,97 | 6,97 |
| pH 10 | 10,32 | 10,25 | 10,18 | 10,12 | 10,06 | 10,00 | 9,95 | 9,91 | 9,87 | 9,84 | 9,81 |

## 4. pH das amostras calculadas (modelo de equilíbrio)

O pH (= −log a_H⁺) é a raiz do **balanço de carga**:

```
Σ z_i · c_i = 0      (H⁺, OH⁻, íons fortes e espécies ácido-base)
```

* Para os pares ácido-base: `[A_{j+1}]/[A_j] = Ka_j · γ_j / (a_H · γ_{j+1})`.
* `[OH⁻] = Kw / (a_H · γ_OH)`.
* A raiz é encontrada por bisseção em pH ∈ [−2, 16], porque a carga líquida é decrescente em pH.
  A força iônica `I = ½ Σ c_i z_i²` é atualizada por iteração até convergir.

**Coeficientes de atividade (Davies)**

```
log10 γ = −A · z² · ( √I / (1 + √I) − 0,3 · I )
A(T) = 1,82483·10⁶ · √ρ / (ε·T)^{3/2}
ε(T) = 87,740 − 0,40008 t + 9,398·10⁻⁴ t² − 1,410·10⁻⁶ t³    (Malmberg & Maryott, 1956)
```

`A(25 °C) ≈ 0,511`. A equação de Davies é razoável até I ≈ 0,1 mol/L e aproximada até
≈ 0,5 mol/L, acima do que o simulador emite um aviso. Hipóteses: densidade constante, e
molalidade igual a molaridade.

**Dependência com a temperatura**

* `pKw(T)`: tabela do CRC Handbook (ex.: 14,535 a 10 °C; 13,995 a 25 °C; 13,535 a 40 °C), com interpolação linear.
* `pKa(T)`: equação de van 't Hoff com ΔH° constante:
  `pK(T) = pK(25 °C) + ΔH°/(R ln10) · (1/T − 1/298,15)`.
* Henry do CO₂: `KH(T) = 0,034 · exp(2400 · (1/T − 1/298,15))` mol·L⁻¹·atm⁻¹ (compilação de Sander).

| Par | pKa (25 °C) | ΔH° (kJ/mol) | Fonte |
|---|---|---|---|
| CH₃COOH / CH₃COO⁻ | 4,756 | −0,41 | Goldberg et al., *J. Phys. Chem. Ref. Data* 31, 231 (2002) |
| NH₄⁺ / NH₃ | 9,245 | 51,95 | idem |
| H₂CO₃* / HCO₃⁻ | 6,351 | 9,15 | idem |
| HCO₃⁻ / CO₃²⁻ | 10,329 | 14,70 | idem |

**Resultados a 25 °C** (verificados em `tests/chem.test.js`):

| Amostra | pH do modelo | Comentário |
|---|---|---|
| HCl 0,010 mol/L | 2,045 | 2,00 sem atividade. A diferença de 0,045 é o efeito de γ. |
| Ácido acético 0,10 mol/L | 2,88 | |
| Tampão acetato 0,10/0,10 | 4,65 | pKa − 0,11 (atividade do acetato) |
| NaHCO₃ 0,10 mol/L | 8,12 | 8,34 sem atividade. Sistema fechado. Não inclui pares iônicos (NaCO₃⁻) nem perda de CO₂, que elevam o pH medido em amostras reais. |
| NH₃ 0,10 mol/L | 11,12 | Forte dependência com T (ΔH° grande) |
| NaOH 0,010 mol/L | 11,95 | pH = pKw − pOH, portanto cai ≈ 0,46 de 25 para 40 °C |
| NaOH 0,10 mol/L | 12,89 | Com o erro alcalino, o eletrodo novo lê ≈ 12,81 |
| Água em equilíbrio com o ar | 5,60 | pCO₂ = 420 µatm (sistema aberto) |

## 5. Amostras didáticas

Suco de limão (2,3), refrigerante de cola (2,5), café (5,0), leite (6,7) e água do mar (8,1)
são **valores ilustrativos fixos**, escolhidos dentro de faixas típicas que aparecem na
interface. Amostras reais variam bastante. Não há modelo químico por trás desses valores e,
por hipótese, eles não variam com a temperatura. A interface os marca como "didático".

## 6. Dinâmica do instrumento (parâmetros didáticos)

| Grandeza | Modelo | Valores |
|---|---|---|
| Resposta do eletrodo | 1ª ordem: `E(t+Δt) = E∞ + (E − E∞)·e^{−Δt/τ}` | τ = τ_solução × fator do eletrodo. Tampões: 3 s. Amostras: 4–8 s. Água deionizada: 30 s. |
| Sensor de temperatura | 1ª ordem | τ = 8 s |
| Ruído | gaussiano (Box–Muller), semente fixa | 0,02–1,2 mV conforme solução e eletrodo |
| Deriva | passeio aleatório | 0,005–0,6 mV/√s |
| Filtro do medidor | média móvel exponencial | τ = 0,8 s |
| Estabilidade | variação (máx − mín) em 5 s < 0,6 mV (≈ 0,01 pH) | |
| Eletrodo ao ar | passeio aleatório de 15 mV/√s | |

**Consequência verificada do critério de estabilidade**: na resposta de 1ª ordem, a
taxa de variação é `(E∞ − E)/τ`. O critério (0,12 mV/s) é atingido quando ainda restam
`≈ 0,12 · τ` mV até o equilíbrio. Para tampões (τ = 3 s), isso dá < 0,01 pH. Para a água
deionizada (τ = 30 s), dá ≈ 3,6 mV ≈ 0,06 pH. O indicador STB aparece, mas a leitura ainda
deriva lentamente. Esse "falso ponto final" acontece em amostras de baixa força iônica e é
mantido de propósito, com o aviso W5.

Perfis de eletrodo (**didáticos**):

| Perfil | E0 (mV) | k | τ × | Ruído (mV) | Resultado esperado |
|---|---|---|---|---|---|
| Novo | +4 | 99,0 % | 1 | 0,02 | calibração "bom" |
| Em uso | +19 | 93,5 % | 2 | 0,05 | calibração "aceitável" (W2) |
| Envelhecido | +41 | 86,0 % | 4 | 0,10 | calibração rejeitada |
| Diafragma entupido | +12 | 97,0 % | 3 | 1,2 + deriva | não estabiliza (E4) |
| Desconectado | — | — | — | — | E1, visor "----" |

## 7. Códigos de diagnóstico

| Código | Condição |
|---|---|
| E1 | Eletrodo não detectado |
| E2 | Eletrodo fora da solução (ao ar) |
| E3 | Leitura fora da faixa do visor (−2 a 16 pH) |
| E4 | Leitura não estabiliza por mais de max(60 s, 6τ) |
| W1 | Medidor sem calibração |
| W2 | Calibração aceitável, mas fora do ideal |
| W3 | Temperatura manual difere da amostra em mais de 2 °C |
| W4 | Medição fora da faixa calibrada (extrapolação > 1 pH) |
| W5 | Amostra de baixa força iônica |
| W6 | pH > 12 com Na⁺: possível erro alcalino |
| W7 | Força iônica acima do limite da equação de Davies |

## 8. O que o simulador **não** representa

* Ponto isopotencial diferente de pH 7, histerese, memória do eletrodo, contaminação
  entre amostras (o enxágue entre soluções é considerado perfeito).
* Efeito da agitação, potenciais de junção variáveis e efeito de suspensão.
* Variação de pH das amostras didáticas com a temperatura.
* Coeficientes de atividade em força iônica alta (> 0,5 mol/L).

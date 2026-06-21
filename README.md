# UPRO Buy The Dip — Backtest Engine (V6)

Application web **quasi-monofichier** (`public/index.html`) qui simule une stratégie *"Buy The Dip"* sur l'ETF levier x3 **UPRO** (S&P 500 ×3), avec gestion DCA, filtre de tendance/régime, hedge par puts (Black‑Scholes), coûts réels (frais, spread, slippage, fiscalité) et comparaison vs Buy & Hold (SPY / UPRO).

Tout tourne **dans le navigateur** : le moteur de calcul est écrit en Python et exécuté via **Pyodide** (Python compilé en WebAssembly) — aucun serveur ni backend nécessaire pour le calcul lui‑même. Un unique Cloudflare Worker (`src/worker.js`) sert ce fichier statique et fait aussi office de proxy CORS pour le téléchargement Yahoo Finance.

## Fichiers du dossier

| Fichier | Rôle |
|---|---|
| `public/index.html` | L'application complète (UI + moteur Python Pyodide + graphiques Chart.js + export Excel) |
| `src/worker.js` | Cloudflare Worker : sert `public/` comme site statique et proxy `/api/yahoo` (CORS) pour Yahoo Finance |
| `wrangler.jsonc` | Config Cloudflare (`name`, `assets.directory`, `main`) utilisée par `wrangler deploy` |
| `lancer_backtest.bat` | Lanceur Windows *legacy* pour un usage 100 % local hors-ligne (démarre un proxy CORS local puis ouvre `public/index.html`) — inutile une fois le site déployé sur Cloudflare |

## Hébergement (Cloudflare Workers) — recommandé

Le site est déployé sur **Cloudflare Workers** (mode "Workers + static assets"), connecté à ce repo GitHub : chaque `git push` sur `main` redéploie automatiquement via `npx wrangler deploy`. L'URL obtenue (`https://backtest-levrage.<compte>.workers.dev`, ou un domaine personnalisé) peut être ouverte depuis n'importe quel appareil/navigateur, sans rien installer ni lancer localement — y compris le téléchargement Yahoo Finance, géré par `src/worker.js` (voir ci-dessous).

## Lancement 100 % local (`lancer_backtest.bat`) — optionnel

Pour un usage hors-ligne sans passer par l'URL hébergée, double-clic sur le `.bat` :

1. Démarre un **proxy CORS local sur `localhost:8080`** via `node -e "..."` (serveur Node inline, sans dépendance). Il relaie n'importe quelle URL passée en paramètre (`http://localhost:8080/<url>`) vers Yahoo Finance et ajoute les en-têtes `Access-Control-Allow-Origin: *`.
2. Attend 1 seconde puis ouvre `public/index.html` dans le navigateur par défaut.

Pré-requis : **Node.js installé**. Ce script n'est plus nécessaire si vous utilisez l'URL Cloudflare — il ne sert qu'à titre de filet de secours local.

## Sources de données

Trois façons d'alimenter le backtest (panneau "Données historiques" en haut de page) :

1. **Chargement automatique Yahoo Finance** — bouton qui récupère UPRO (ou `3USL.L`, version listée à Londres), SPY et ^VIX via l'API `query1.finance.yahoo.com/v8/finance/chart/...`, sur la période choisie. La requête passe d'abord par `/api/yahoo` (le Worker, fiable, sous contrôle), puis par `corsproxy.io` et `allorigins` en fallback (utile si la page est ouverte en local sans être déployée).
2. **Upload manuel de CSV** — format export standard Yahoo Finance pour UPRO, SPY, VIX, et optionnellement un CSV de puts historiques réels (colonnes `date, strike, expiration, bid, ask, last`).
3. **Simulation GBM (fallback)** — si aucune donnée réelle n'est chargée, génère un mouvement brownien géométrique avec régimes bull/bear pour SPY, puis dérive UPRO via `3 × rendement SPY − TER`.

Le VIX réel (si fourni) remplace le proxy de volatilité réalisée à la fois pour le filtre de régime et pour le pricing Black-Scholes des puts.

## Logique de la stratégie

### Signal d'entrée / scaling ("Buy The Dip")
- Calcul d'un **rolling max** du prix UPRO sur une fenêtre glissante (`Fenêtre sommet`, 10–90 jours, défaut 30j), décalé d'un jour pour éviter le look-ahead bias.
- **Entrée initiale** : dès que le prix UPRO chute de plus de `Seuil d'entrée` (défaut −5 %) sous ce rolling max, ET que le filtre de tendance est validé.
- **Scaling (renforcement)** : si la position est déjà ouverte et le prix continue de baisser de `Seuil de scaling` depuis le dernier prix d'entrée, une nouvelle tranche est ajoutée (jusqu'à 5 tranches).
- Allocation par tranche (% du portefeuille) :
  - Stratégie **Base** : `20% / 15% / 15% / 15% / 15%` (max cumulé 80 %)
  - Stratégie **Améliorée** : `15% / 12% / 12% / 12% / 12%`

### Sortie de position
Trois mécanismes, évalués chaque jour :
- **Take Profit** : déclenché si le *plus haut du jour* (High) atteint le prix cible (`+Seuil de sortie`, par tranche si **TP adaptatif** configuré). Exécution simulée à un ordre limite intraday au prix cible exact.
- **Stop-loss** (optionnel, 0 = désactivé) : sortie au marché si la perte dépasse le seuil.
- **Timeout adaptatif** : durée de détention maximale, configurable **par nombre de tranches** (1 / 2 / 3 / 4-5 tranches) — plus on a renforcé, plus le timeout se resserre ("ratchet" : le timeout effectif est le minimum atteint parmi toutes les tranches activées). Comportement au timeout configurable : sortie au marché, uniquement si en profit, ou seulement si la perte dépasse le stop-loss.

### Filtre de tendance
Optionnel — n'autorise une nouvelle entrée que si SPY est au-dessus de sa moyenne mobile (MA 50 / 100 / 200 jours, ou aucun filtre).

### Filtre de régime de marché (volatilité)
Quand la volatilité réalisée de SPY (rolling, fenêtre configurable) dépasse un seuil annualisé, applique une action :
- **Bloquer** les nouvelles entrées
- **Réduire l'allocation ÷2**
- **Satellite seulement** (bloque le renforcement principal mais autorise la position satellite)

### Position satellite ⭐
Permet d'ouvrir une **2ème position indépendante** quand un nouveau signal BTD apparaît alors qu'une position principale est déjà ouverte (au lieu de l'ignorer). Allocation et take-profit dédiés, plus courts que la position principale, pour libérer rapidement du capital.

### DCA (Dollar Cost Averaging)
Injection périodique de cash (montant et fréquence configurables : mensuelle / trimestrielle / semestrielle / annuelle), comptabilisée à la fois dans la stratégie et dans les benchmarks Buy & Hold (pour une comparaison équitable).

### Hedge Put (protection drawdown)
Achat optionnel d'un **put OTM sur UPRO** comme couverture :
- **Mode** : off / auto (déclenché à partir d'une tranche seuil T2–T5) / toujours (dès T1).
- **Strike** : % sous le prix de revient (cost basis) de la position, ex. −35 %.
- **Pricing** : modèle **Black-Scholes** (`P = K·e^-rT·N(-d₂) − S·N(-d₁)`), volatilité = VIX réel si disponible (×beta UPRO/SPY rolling 60j, clampé [1.5, 5]), sinon volatilité réalisée SPY — ou prix issus d'un CSV de puts réels (strike le plus proche disponible).
- **Renouvellement automatique** à expiration si la position est toujours ouverte.
- **Revente automatique** possible si le take-profit principal est atteint avant l'expiration (récupère la valeur résiduelle via Black-Scholes).
- Nombre de contrats : auto (`⌈actions détenues / 100⌉`) ou manuel.

### Coûts réels
Modélisés et soustraits du résultat : commission fixe ($/ordre), commission %, spread bid/ask, slippage, surcoût de financement du levier (TER UPRO ~0.91 %/an appliqué quotidiennement au cash), taxe sur les plus-values (PFU France 30 %, etc.). Presets rapides : Zéro frais, IBKR Retail, Degiro, France réel, Pessimiste.

### Taux sans risque
Le cash non investi rapporte un taux journalier basé sur les **taux Fed effectifs réels par année** (2010–2026, table codée en dur dans le moteur).

## Paramètres principaux (panneau de configuration)

| Paramètre | Plage | Défaut |
|---|---|---|
| Capital initial | 100 – 100 000 $ | 600 $ |
| Période du backtest | dates début/fin | depuis 2026-03-01 |
| DCA — montant / fréquence | 0–10 000 $ | 1 000 $ / trimestriel |
| Fenêtre sommet (rolling max) | 10–90 j | 30 j |
| Seuil d'entrée initiale | 3–25 % | 5 % |
| Seuil de scaling | 3–25 % | 5 % |
| Seuil de sortie (TP) | 5–60 % | 30 % |
| Stop-loss | 0 (off) – 60 % | off |
| Filtre tendance (MA) | aucun / 50 / 100 / 200j | aucun |
| Stratégie | Base / Améliorée | Base |
| Timeout adaptatif par tranche | 0–500 j selon tranche | off |
| TP adaptatif par tranche | 0 (défaut) – 60 % | off (presets progressif/agressif) |
| Position satellite | 0–20 % alloc, TP 5–40 % | off |
| Filtre régime volatilité | 0–80 %/an, action bloc/½/satellite | off |
| Coûts (commission, spread, slippage, levier, taxe) | voir presets | tous à 0 sauf levier 0.91 % |
| Hedge put | off / auto / toujours, strike, expiration, renouvellement | off |

## Résultats & onglets

Après exécution (`▶ LANCER LE BACKTEST`), 13 onglets affichent les résultats :

1. **Performance** — courbe de valeur du portefeuille vs SPY B&H vs UPRO B&H, métriques clés (CAGR, drawdown max, Sharpe, rendement total).
2. **Trades** — liste des 50 derniers trades (entrée/sortie, durée, P&L, raison de sortie).
3. **Drawdown** — courbe de drawdown de la stratégie.
4. **Distribution** — histogramme de distribution des P&L par trade.
5. **Comparaison** — tableau comparatif stratégie / SPY / UPRO Buy & Hold.
6. **📋 Journal** — journal jour par jour de tout le backtest (prix, signaux, position, cash, événements), filtrable et triable.
7. **🔄 DCA** — détail des versements DCA effectués.
8. **💸 Coûts** — détail des frais, spread, slippage, surcoût levier et taxes payés.
9. **💰 Cash & Taux** — agrégation mensuelle/annuelle des intérêts perçus sur le cash non investi.
10. **⏱ Timeout** — statistiques sur les sorties déclenchées par timeout.
11. **🛡️ Hedge** — journal des puts achetés/expirés/exercés/revendus, coût total vs gain total.
12. **🔬 Analyse V5** — insights combinés sur satellite, régime de volatilité, TP/timeout adaptatifs.
13. **Analyse Critique** — page statique de mise en garde (voir ci-dessous).

Un bouton **📥 Exporter en Excel** génère un classeur `.xlsx` complet (toutes les feuilles/résultats) via la librairie `xlsx.js`.

## Avertissements méthodologiques (page "Analyse Critique")

L'outil documente lui-même ses limites :

- **Survivorship bias** : UPRO existe depuis 2009 ; les ETF leviérés ayant fait faillite ont disparu des séries de prix disponibles.
- **Look-ahead** : le rolling max n'utilise que le passé, mais les seuils par défaut (entrée/scaling/sortie) ont été calibrés *a posteriori* avec connaissance de l'historique.
- **Volatility decay** : un ETF x3 perd de la valeur en marché sans tendance à cause du rebalancement quotidien (~6 %/an de decay pour une vol SPY de 20 %).
- **Bull market bias** : la période 2010–2024 est un cycle haussier exceptionnel ; la stratégie aurait été catastrophique sur 2000–2009 (deux crashs majeurs avec un levier x3).
- **Liquidité** : les spreads réels sur UPRO réduiraient le CAGR de ~1–2 % vs un backtest sans coûts.
- **Fiscalité** : chaque sortie déclenche un événement imposable, ce qui détruit l'avantage fiscal différé d'un Buy & Hold pur.

→ Ces avertissements justifient l'existence des modules **filtre de tendance MA200**, **filtre de régime de volatilité**, **stop-loss**, **hedge put** et **coûts réels** : ils permettent de tester la robustesse de la stratégie au-delà du backtest "brut" optimiste.

## Stack technique

- **Pyodide** (`v0.25.0`) — exécute le moteur de backtest, écrit en Python (`pandas`, `numpy`, `scipy.stats.norm` si dispo sinon approximation Abramowitz & Stegun pour Black-Scholes), directement dans le navigateur.
- **Chart.js 4 + chartjs-plugin-annotation** — graphiques (performance, drawdown, distribution, VIX, etc.).
- **xlsx.js (SheetJS)** — export du classeur Excel complet.
- Aucune dépendance serveur pour le calcul lui-même : seul l'**auto-fetch Yahoo Finance** a besoin d'un proxy CORS — assuré par `src/worker.js` (Cloudflare Worker) une fois le site déployé, avec fallback sur `corsproxy.io`/`allorigins`, et sur `lancer_backtest.bat` (Node local) pour un usage 100 % hors-ligne.

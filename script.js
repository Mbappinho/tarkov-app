const API_URL = 'https://api.tarkov.dev/graphql';

let allBartersData = []; 
let allCashData = []; 
let traderResetTimes = {}; // NOUVEAU : Stocke les heures de reset
let currentTab = 'all'; 
let showFavoritesOnly = false;
let favorites = JSON.parse(localStorage.getItem('tarkovFavorites')) || [];
let blacklist = JSON.parse(localStorage.getItem('tarkovBlacklist')) || [];

let rateUSD = 145; 
let rateEUR = 158; 

let searchTimeout;
let timerInterval; // Pour le compte à rebours

const query = `
{
    currencies: items(ids: ["5696686a4bdc2da3298b456a", "569668774bdc2da2298b4568"]) {
        name
        buyFor { price source }
    }

    # On récupère les infos globales des marchands (dont le resetTime)
    traders {
        name
        resetTime
        cashOffers {
            item {
                name
                iconLink
                wikiLink
                basePrice
                avg24hPrice
                lastLowPrice
                buyFor { price source }
                sellFor { price source }
            }
            price
            currency
            minTraderLevel
            buyLimit
        }
    }

    barters(limit: 500) {
        trader { name }
        level
        buyLimit
        rewardItems {
            item {
                name
                iconLink
                wikiLink
                basePrice
                avg24hPrice
                lastLowPrice
                buyFor { price source }
                sellFor { price source }
            }
            count
        }
        requiredItems {
            item {
                name
                buyFor { price source }
            }
            count
        }
    }
}
`;

// --- UTILITAIRES ---

function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function sanitizeUrl(url) {
    if (!url) return '#';
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? url : '#';
    } catch (e) { return '#'; }
}

function isFlea(sourceName) { return sourceName.toLowerCase().includes('flea'); }
function isFence(sourceName) { return sourceName.toLowerCase().includes('fence'); }

function calculateFleaTax(basePrice, unitAskPrice, totalCount) {
    if (!basePrice || !unitAskPrice || unitAskPrice === 0) return 0;
    const Pi = Math.log10(unitAskPrice / basePrice);
    let tax = 0;
    if (unitAskPrice >= basePrice) {
        const factor = Math.pow(4, Pi);
        tax = basePrice * 0.05 * factor + unitAskPrice * 0.05 * factor;
    } else {
        const Pr = Math.log10(basePrice / unitAskPrice);
        const factor = Math.pow(4, Pr);
        tax = basePrice * 0.05 * factor + unitAskPrice * 0.05 * factor;
    }
    return Math.round(tax * totalCount);
}

// NOUVEAU : Calcul du temps restant
// MODIFICATION : Calcul précis avec secondes
function getTimeUntilReset(traderName) {
    const resetTimeStr = traderResetTimes[traderName];
    if (!resetTimeStr) return { text: "Inconnu", urgency: 'normal' };

    const now = new Date();
    const reset = new Date(resetTimeStr);
    const diffMs = reset - now;

    if (diffMs <= 0) return { text: "Reset en cours...", urgency: 'critical' };

    const diffSecs = Math.floor((diffMs / 1000) % 60);
    const diffMins = Math.floor((diffMs / 1000 / 60) % 60);
    const diffHours = Math.floor(diffMs / 1000 / 60 / 60);

    // Formatage avec zéros (05s au lieu de 5s)
    const s = diffSecs.toString().padStart(2, '0');
    const m = diffMins.toString().padStart(2, '0');

    if (diffHours > 0) {
        return { text: `${diffHours}h ${m}m`, urgency: 'normal' };
    } else {
        // Moins d'une heure : on affiche les secondes !
        const urgency = diffMins < 10 ? 'warning' : 'normal';
        return { text: `${diffMins}m ${s}s`, urgency: urgency };
    }
}

// NOUVEAU : Met à jour tous les timers de la page
function startGlobalTimer() {
    if (timerInterval) clearInterval(timerInterval);
    
    // Mise à jour immédiate
    updateAllTimersDOM();

    // Mise à jour toutes les minutes (suffisant pour un reset timer)
    timerInterval = setInterval(() => {
        updateAllTimersDOM();
    }, 1000); 
}

// MODIFICATION : Gestion de l'affichage et couleurs
let lastAutoRefresh = 0; // Anti-spam pour ne pas refresh 10 fois par seconde

function updateAllTimersDOM() {
    const badges = document.querySelectorAll('.js-reset-timer');
    let needsRefresh = false;

    badges.forEach(badge => {
        const trader = badge.dataset.trader;
        const info = getTimeUntilReset(trader);
        
        badge.innerText = `🕒 ${info.text}`;
        
        // Gestion des couleurs
        if (info.urgency === 'warning') {
            badge.style.color = '#ff5252'; 
            badge.style.fontWeight = 'bold';
        } else if (info.urgency === 'critical') {
            badge.style.color = '#4caf50'; 
            badge.style.fontWeight = 'bold';
            badge.classList.add('blink');
            
            // DÉTECTION DU RESET !
            // Si on voit "Reset en cours...", on signale qu'il faut rafraichir
            needsRefresh = true;
        } else {
            badge.style.color = '#888'; 
            badge.style.fontWeight = 'normal';
            badge.classList.remove('blink');
        }
    });

    // LOGIQUE AUTO-REFRESH
    if (needsRefresh) {
        const now = Date.now();
        // On ne refresh que si on ne l'a pas déjà fait il y a moins de 60 secondes
        // (L'API Tarkov peut mettre 1 ou 2 min à mettre à jour les timers)
        if (now - lastAutoRefresh > 60000) {
            console.log("Reset détecté ! Mise à jour des données...");
            lastAutoRefresh = now;
            
            // On appelle fetchData en mode FORCE (true) et SILENCIEUX (true)
            // L'utilisateur ne verra rien, mais les timers vont se mettre à jour tout seuls
            fetchData(true, true);
        }
    }
}

function updateRates(currencies) {
    const usd = currencies.find(c => c.name === "Dollars");
    const eur = currencies.find(c => c.name === "Euros");
    if (usd && usd.buyFor) {
        const best = usd.buyFor.find(o => o.source === 'peacekeeper');
        if (best) rateUSD = best.price;
    }
    if (eur && eur.buyFor) {
        const best = eur.buyFor.find(o => o.source === 'skier');
        if (best) rateEUR = best.price;
    }
}

function getBuyPrice(item) {
    if (item.buyFor) {
        let minPrice = Infinity;
        item.buyFor.forEach(offer => {
            if (!isFence(offer.source) && offer.price < minPrice) minPrice = offer.price;
        });
        if (minPrice !== Infinity) return minPrice;
    }
    return 0;
}

function getFleaPrice(item) {
    if (item.buyFor) {
        const fleaOffer = item.buyFor.find(o => isFlea(o.source));
        if (fleaOffer) return fleaOffer.price;
    }
    return 0;
}

function getSafeFleaPrice(item) {
    let currentFlea = Infinity;
    let hasActiveOffer = false;
    
    if (item.buyFor) {
        item.buyFor.forEach(offer => {
            if (isFlea(offer.source)) {
                hasActiveOffer = true; 
                if (offer.price < currentFlea) {
                    currentFlea = offer.price;
                }
            }
        });
    }

    if (!hasActiveOffer || currentFlea === Infinity) return 0;
    if (!item.avg24hPrice || item.avg24hPrice === 0) return 0;

    const avg24 = item.avg24hPrice || Infinity;
    const lastLow = item.lastLowPrice || Infinity;

    const candidates = [currentFlea, avg24, lastLow].filter(p => p > 0 && p !== Infinity);
    return Math.min(...candidates);
}

function getBestTraderBuyback(item) {
    if (!item.sellFor) return { price: 0, traderName: "Personne" };
    let bestPrice = 0;
    let bestName = "Personne";
    item.sellFor.forEach(offer => {
        if (!isFlea(offer.source) && !isFence(offer.source) && offer.price > bestPrice) {
            bestPrice = offer.price;
            bestName = offer.source.charAt(0).toUpperCase() + offer.source.slice(1);
        }
    });
    return { price: bestPrice, traderName: bestName };
}

function toggleFavorite(itemName) {
    if (favorites.includes(itemName)) {
        favorites = favorites.filter(name => name !== itemName);
    } else {
        favorites.push(itemName);
    }
    localStorage.setItem('tarkovFavorites', JSON.stringify(favorites));
    filtrerEtAfficher();
}

function toggleBlacklist(itemName) {
    if (confirm("Masquer cet item définitivement ?")) {
        blacklist.push(itemName);
        localStorage.setItem('tarkovBlacklist', JSON.stringify(blacklist));
        filtrerEtAfficher();
    }
}

function toggleShowFavorites() {
    showFavoritesOnly = !showFavoritesOnly;
    const btn = document.getElementById('fav-filter-btn');
    if (showFavoritesOnly) {
        btn.classList.add('active');
        btn.innerText = "❤️ Voir Tout";
    } else {
        btn.classList.remove('active');
        btn.innerText = "❤️ Voir Favoris";
    }
    filtrerEtAfficher();
}

function changerOnglet(onglet) {
    currentTab = onglet;
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if(btn.getAttribute('onclick').includes(onglet)) btn.classList.add('active');
    });
    filtrerEtAfficher();
}

// --- FETCH & INIT ---
const CACHE_KEY = 'tarkovDataCache';
const CACHE_DURATION = 5 * 60 * 1000;

// MODIFICATION : Ajout du paramètre 'silent'
async function fetchData(forceRefresh = false, silent = false) {
    const container = document.getElementById('barter-list');
    const loading = document.getElementById('loading');
    
    // Si pas silencieux, on affiche le loader
    if (!silent) {
        loading.innerHTML = '<div class="spinner"></div><p style="text-align:center; color:#888;">Récupération des prix en direct...</p>';
        loading.style.display = 'block';
    }

    // Gestion du Cache (identique à avant)
    if (!forceRefresh) {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Date.now() - parsed.timestamp < CACHE_DURATION) {
                    processData(parsed.data);
                    return;
                }
            } catch (e) { localStorage.removeItem(CACHE_KEY); }
        }
    }

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: query })
        });
        const data = await response.json();

        if (data.errors) throw new Error(data.errors[0].message);

        // Mise en cache
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                timestamp: Date.now(),
                data: data 
            }));
        } catch (e) { console.warn("Cache error"); }

        processData(data);

    } catch (error) {
        console.error("Erreur API :", error);
        if (!silent) {
            loading.style.display = 'none';
            container.innerHTML = `
                <div class="error-message">
                    <h3>⚠️ Erreur de connexion</h3>
                    <p>${escapeHtml(error.message)}</p>
                    <button onclick="fetchData(true)" class="input-style" style="margin-top:10px; cursor:pointer; background:#d4a04d; color:black; border:none; font-weight:bold;">
                        ↻ Réessayer
                    </button>
                </div>`;
        }
    }
}

function processData(data) {
    const loading = document.getElementById('loading');
    
    updateRates(data.data.currencies);
    
    // NOUVEAU : Stockage des resets
    traderResetTimes = {};
    data.data.traders.forEach(t => {
        traderResetTimes[t.name] = t.resetTime;
    });

    allBartersData = data.data.barters;
    allCashData = [];
    data.data.traders.forEach(trader => {
        trader.cashOffers.forEach(offer => {
            offer.traderName = trader.name;
            allCashData.push(offer);
        });
    });

    loading.style.display = 'none';
    filtrerEtAfficher();
}

function handleSearchInput() {
    const container = document.getElementById('barter-list');
    if (container) container.classList.add('searching-state');
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        filtrerEtAfficher();
    }, 300);
}

function filtrerEtAfficher() {
    const container = document.getElementById('barter-list');
    const loading = document.getElementById('loading');
    const countDiv = document.getElementById('result-count');
    
    const userLevel = parseInt(document.getElementById('level-select').value);
    const selectedTrader = document.getElementById('trader-select').value;
    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    
    // Récupération du Slider (déjà présent dans ton HTML)
    const minProfit = parseInt(document.getElementById('profit-slider').value) || 0;
    document.getElementById('profit-value').innerText = new Intl.NumberFormat('fr-FR').format(minProfit) + " ₽";

    loading.style.display = 'none';
    container.classList.remove('searching-state');
    container.innerHTML = ''; 

    let bonsPlans = [];

    const isValidItem = (item, traderName, level) => {
        if (!item) return false;
        if (level > userLevel) return false;
        if (selectedTrader !== 'all' && traderName !== selectedTrader) return false;
        if (traderName === 'Ref' || traderName === 'Fence') return false;
        if (!item.name.toLowerCase().includes(searchTerm)) return false;
        if (showFavoritesOnly && !favorites.includes(item.name)) return false;
        if (blacklist.includes(item.name)) return false;
        return true;
    };

    // BARTERS
    allBartersData.forEach(barter => {
        if (!barter.rewardItems[0] || !barter.rewardItems[0].item) return;
        const mainReward = barter.rewardItems[0];
        const mainItem = mainReward.item;
        
        if (!isValidItem(mainItem, barter.trader.name, barter.level)) return;

        let coutCraft = 0;
        let ingredients = [];
        let missingPrice = false;
        barter.requiredItems.forEach(req => {
            const prixUnit = getBuyPrice(req.item);
            if (prixUnit === 0) missingPrice = true;
            coutCraft += (prixUnit * req.count);
            ingredients.push(`${req.count}x ${req.item.name}`);
        });

        if (missingPrice || coutCraft === 0) return;

        let totalFleaRevenue = 0;
        let totalTraderRevenue = 0;
        let bestTraderName = "";
        let totalRewardCount = 0;

        barter.rewardItems.forEach(reward => {
            const qty = reward.count;
            totalRewardCount += qty;
            const unitSafe = getSafeFleaPrice(reward.item);
            totalFleaRevenue += (unitSafe * qty);
            const bestTrader = getBestTraderBuyback(reward.item);
            totalTraderRevenue += (bestTrader.price * qty);
            if(!bestTraderName) bestTraderName = bestTrader.traderName;
        });

        processItemLogic({
            list: bonsPlans,
            mainItem: mainItem,
            cout: coutCraft,
            ingredients: ingredients,
            traderName: barter.trader.name,
            level: barter.level,
            limit: barter.buyLimit,
            type: 'BARTER',
            totalFleaRevenue: totalFleaRevenue,
            totalTraderRevenue: totalTraderRevenue,
            bestTraderName: bestTraderName,
            totalRewardCount: totalRewardCount,
            minProfit: minProfit // On passe le filtre ici
        });
    });

    // CASH
    allCashData.forEach(offer => {
        if (!isValidItem(offer.item, offer.traderName, offer.minTraderLevel)) return;
        
        let coutAchat = offer.price;
        let devise = "₽";
        if (offer.currency === 'USD') { coutAchat = offer.price * rateUSD; devise = "$"; }
        else if (offer.currency === 'EUR') { coutAchat = offer.price * rateEUR; devise = "€"; }

        const ingredients = [`ACHAT DIRECT: ${offer.price} ${devise}`];
        const unitSafe = getSafeFleaPrice(offer.item);
        const bestTrader = getBestTraderBuyback(offer.item);

        processItemLogic({
            list: bonsPlans,
            mainItem: offer.item,
            cout: coutAchat,
            ingredients: ingredients,
            traderName: offer.traderName,
            level: offer.minTraderLevel,
            limit: offer.buyLimit,
            type: 'CASH',
            originalCurrency: devise,
            originalPrice: offer.price,
            totalFleaRevenue: unitSafe * 1,
            totalTraderRevenue: bestTrader.price * 1,
            bestTraderName: bestTrader.traderName,
            totalRewardCount: 1,
            minProfit: minProfit
        });
    });

    // ... (tout le code avant reste pareil)

    // TRI AVANCÉ (Feature #7)
    const sortMode = document.getElementById('sort-select').value;

    bonsPlans.sort((a, b) => {
        if (sortMode === 'total') {
            return b.totalPotentialProfit - a.totalPotentialProfit; // Du plus gros au plus petit
        } 
        else if (sortMode === 'unit') {
            return b.profit - a.profit; // Profit par item
        } 
        else if (sortMode === 'roi') {
            // Calcul du ROI : (Profit / Coût) * 100
            const roiA = (a.profit / a.cout) * 100;
            const roiB = (b.profit / b.cout) * 100;
            return roiB - roiA; // Les meilleurs % en premier
        } 
        else if (sortMode === 'cost') {
            return a.cout - b.cout; // Les moins chers en premier (pour les pauvres :D)
        }
    });
    
    // Mise à jour du compteur
    countDiv.innerText = `${bonsPlans.length} plans trouvés`;

    // ... (Affichage)
    // ✅ AJOUT : Boucle d'affichage des cartes
    bonsPlans.forEach(plan => {
        afficherCarte(container, plan);
        
    });
    startGlobalTimer();
}

function processItemLogic(params) {
    const { list, mainItem, cout, ingredients, traderName, level, limit, type, 
            totalFleaRevenue, totalTraderRevenue, bestTraderName, totalRewardCount, 
            originalCurrency, originalPrice, minProfit } = params;

    const avgUnitRevenue = totalFleaRevenue / (totalRewardCount || 1);
    const totalTax = calculateFleaTax(mainItem.basePrice, avgUnitRevenue, totalRewardCount);

    const profitFlea = totalFleaRevenue - totalTax - cout; 
    const profitMarchand = totalTraderRevenue - cout;
    
    const safeLimit = (limit > 0) ? limit : 1;
    let totalPotentialProfit = 0;
    let strategie = ""; 

    let isRisky = false;
    let unitFleaPrice = getFleaPrice(mainItem);
    if (unitFleaPrice > 0 && mainItem.avg24hPrice > 0 && unitFleaPrice > (mainItem.avg24hPrice * 2)) {
        isRisky = true;
    }

    if (totalFleaRevenue === 0 && profitMarchand < 0) return;

    // FILTRE SUR LE PROFIT MINIMUM (C'est ici qu'il agit)
    if (profitFlea > profitMarchand && profitFlea >= minProfit && totalFleaRevenue > 0) {
        strategie = "FLEA";
        totalPotentialProfit = profitFlea * safeLimit;
    } else if (profitMarchand > profitFlea && profitMarchand >= minProfit) {
        strategie = "MARCHAND";
        totalPotentialProfit = profitMarchand * safeLimit;
    } else {
        const economie = totalFleaRevenue - cout;
        // Pour "JOUER", on est plus tolérant (50% du filtre) car une économie est toujours bonne à prendre
        if (economie >= (minProfit / 2) && totalFleaRevenue > 0) {
            strategie = "JOUER";
            totalPotentialProfit = economie * safeLimit;
        }
    }

    if (currentTab !== 'all' && strategie !== currentTab) return;

    if (strategie !== "") {
        list.push({
            nom: mainItem.name,
            img: mainItem.iconLink,
            lien: mainItem.wikiLink,
            avgPrice: mainItem.avg24hPrice,
            trader: traderName,
            niveau: level,
            limite: limit,
            cout: cout,
            ingredients: ingredients,
            type: type,
            originalPrice: originalPrice,
            originalCurrency: originalCurrency,
            safeFleaPrice: totalFleaRevenue, 
            unitFleaPrice: unitFleaPrice, 
            tax: totalTax,
            prixMarchand: totalTraderRevenue,
            nomMarchandAcheteur: bestTraderName,
            profit: (strategie === "MARCHAND") ? profitMarchand : profitFlea,
            totalPotentialProfit: totalPotentialProfit,
            strategie: strategie,
            isRisky: isRisky
        });
    }
}

function afficherCarte(container, plan) {
    const div = document.createElement('div');
    div.className = 'card';
    
    const displaySafeName = escapeHtml(plan.nom);
    const safeLink = sanitizeUrl(plan.lien);
    const fallbackImage = "https://placehold.co/64x64/333/888?text=?"; 

    const isFav = favorites.includes(plan.nom); 
    const heartIcon = isFav ? "❤️" : "🤍";
    const format = (num) => new Intl.NumberFormat('fr-FR').format(parseInt(num));
    
    // --- NOUVEAU : CALCUL DU ROI ---
    // Si le coût est 0, on met un ROI infini pour éviter la division par zéro
    const roi = plan.cout > 0 ? Math.round((plan.profit / plan.cout) * 100) : 0;
    
    // On décide de la couleur du ROI (Plus c'est haut, plus c'est vert/feu)
    let roiColor = '#888'; // Gris par défaut
    let roiIcon = '';
    if (roi > 100) { roiColor = '#4caf50'; roiIcon = '🔥'; } // Super rentable
    else if (roi > 50) { roiColor = '#ff9800'; } // Très bien
    
    const roiHTML = `<span style="color:${roiColor}; font-size:0.8em; margin-left:8px;">(${roiIcon} ${roi}% ROI)</span>`;
    // -------------------------------

    let typeBadge = (plan.type === 'CASH') 
        ? `<span style="background:#2196f3; color:white; padding:2px 6px; border-radius:4px; font-size:0.7em;">ACHAT</span>` 
        : `<span style="background:#ff9800; color:white; padding:2px 6px; border-radius:4px; font-size:0.7em;">TROC</span>`;

    const safeLimit = (plan.limite > 0) ? plan.limite : 1;
    const total = plan.profit * safeLimit;
    const colorClass = (plan.strategie === "JOUER") ? "text-blue" : "text-gold";

    // J'ai ajouté ${roiHTML} juste après le profit unitaire
    let bigNumberHTML = (plan.limite > 1) 
        ? `<div style="font-size:1.4em; font-weight:bold; margin-bottom:5px;" class="${colorClass}">+${format(total)} ₽ <span style="font-size:0.5em; color:#888;">(Total ${plan.limite}x)</span></div><div style="font-size:0.8em; color:#aaa;">Unitaire : +${format(plan.profit)} ₽ ${roiHTML}</div>`
        : `<div style="font-size:1.4em; font-weight:bold; margin-bottom:5px;" class="${colorClass}">+${format(plan.profit)} ₽ ${roiHTML}</div>`;

    // ... (Le reste de la fonction est identique) ...
    // Je remets le reste pour que tu puisses copier-coller facilement

    const img = document.createElement('img');
    img.alt = displaySafeName;
    img.src = sanitizeUrl(plan.img);
    img.onerror = function() { this.onerror = null; this.src = fallbackImage; };

    const resetTimeInfo = `<div style="font-size:0.8em; color:#888; margin-top:2px;" class="js-reset-timer" data-trader="${plan.trader}">🕒 ...</div>`;

    div.innerHTML = `
        <button class="card-fav-icon js-fav-btn icon-btn-reset" aria-label="${isFav ? 'Retirer' : 'Ajouter'}">${heartIcon}</button>
        <button class="js-ban-btn icon-btn-reset" style="position:absolute; top:10px; left:10px; font-size:1.2em; opacity:0.5;" aria-label="Masquer">✖</button>

        <a href="${safeLink}" target="_blank" rel="noopener noreferrer" style="text-decoration:none; color:inherit; display:block;">
            <div class="card-header" style="margin-left:20px;">
                <div class="header-text" style="display:flex; flex-direction:column;">
                    <span class="item-name">${displaySafeName}</span>
                    <div style="margin-top:2px;">${typeBadge}</div>
                </div>
            </div>
            
            <div style="background:#111; padding:10px; border-radius:5px; text-align:center; margin-bottom:10px; border:1px solid #333;">
                ${bigNumberHTML}
            </div>

            <div style="display:flex; justify-content:space-between; font-size:0.85em; margin: 10px 0; color:#aaa; border-bottom:1px solid #333; padding-bottom:5px;">
                <span>${plan.trader} (LL${plan.niveau})</span>
                ${resetTimeInfo}
            </div>

            <div style="font-size: 0.85em; margin: 10px 0; color: #ccc; line-height: 1.6;">
                <div style="display:flex; justify-content:space-between;"><span>Coût :</span> <b style="color:#f44336">${format(plan.cout)} ₽</b></div>
                <div style="display:flex; justify-content:space-between;"><span>Revenu (Safe) :</span> <b>${format(plan.safeFleaPrice)} ₽</b></div>
            </div>
            <div class="ingredients"><small>${plan.ingredients.join(', ')}</small></div>
            <div class="${(plan.strategie === 'FLEA' || plan.strategie === 'MARCHAND') ? 'profit-box cash' : 'profit-box savings'}">
                ${plan.strategie === 'FLEA' ? `<div>📈 <b>VENDRE FLEA</b></div><div style="font-size:0.8em; opacity:0.8;">Taxe: -${format(plan.tax)} ₽</div>` : 
                  plan.strategie === 'MARCHAND' ? `<div>🤝 VENDRE <b>${plan.nomMarchandAcheteur.toUpperCase()}</b></div>` : 
                  `<div>🛡️ JOUER / GARDER</div>`}
            </div>
        </a>
    `;

    const header = div.querySelector('.card-header');
    header.insertBefore(img, header.firstChild);

    const favBtn = div.querySelector('.js-fav-btn');
    if (favBtn) favBtn.dataset.nom = plan.nom; 
    const banBtn = div.querySelector('.js-ban-btn');
    if (banBtn) banBtn.dataset.nom = plan.nom; 

    container.appendChild(div);
}

document.getElementById('barter-list').addEventListener('click', function(e) {
    const favBtn = e.target.closest('.js-fav-btn');
    if (favBtn) {
        e.preventDefault(); e.stopPropagation();
        toggleFavorite(favBtn.dataset.nom);
        return;
    }
    const banBtn = e.target.closest('.js-ban-btn');
    if (banBtn) {
        e.preventDefault(); e.stopPropagation();
        toggleBlacklist(banBtn.dataset.nom);
        return;
    }
});

document.getElementById('search-input').addEventListener('input', handleSearchInput);
document.getElementById('level-select').addEventListener('change', filtrerEtAfficher);
document.getElementById('trader-select').addEventListener('change', filtrerEtAfficher);
document.getElementById('profit-slider').addEventListener('input', handleSearchInput); 
document.getElementById('sort-select').addEventListener('change', filtrerEtAfficher);

fetchData();

// content.js - The Spy: Extracts search result data and injects the badge.

console.log("[CS Start] Content Script loaded on Google search page.");

// Mevcut host'u belirleme
const isGoogleScholar = window.location.hostname === 'scholar.google.com';

// --- 1. Badge & Tooltip UI Setup ---

/**
 * Verilen sonuca bir Yükleme Göstergesi veya Rozet eklemek için ana konteyneri bulur/oluşturur.
 * @param {string} id - Sonucun benzersiz ID'si.
 * @returns {HTMLElement | null} Rozetin ekleneceği div elementini döndürür.
 */
function getOrCreateBadgeContainer(id) {
    const resultElement = document.querySelector(`[data-compass-id="${id}"]`);
    if (!resultElement) return null;

    let badgeContainer = resultElement.querySelector('.compass-badge-container');

    if (!badgeContainer) {
        badgeContainer = document.createElement('div');
        badgeContainer.className = 'compass-badge-container';
        badgeContainer.style.cssText = `
            display: inline-flex;
            align-items: center;
            margin-left: 10px;
            cursor: pointer;
            position: relative;
            z-index: 1000;
            min-height: 40px;
            min-width: 150px;
            overflow: hidden;
        `;

        // *** YENİ EKLENEN DÜZELTME ***
        // Normal Google arama sayfasındaki dikey ters çevirme (scaleY) sorununu düzeltir.
        if (!isGoogleScholar) {
            badgeContainer.style.transform = 'scaleY(-1)';
        }

        // Google Search ve Scholar için farklı enjeksiyon noktaları
        if (isGoogleScholar) {
            // Scholar'da başlık ve link genellikle aynı 'h3' içinde.
            const linkElement = resultElement.querySelector('.gs_rt a');
            if (linkElement) {
                linkElement.after(badgeContainer);
            } else {
                resultElement.prepend(badgeContainer); // fallback
            }
        } else {
            // --- GOOGLE SEARCH ---
            const titleElement = resultElement.querySelector('h3');
            if (titleElement) {
                const parent = titleElement.parentElement;
                if (parent && parent.tagName === 'A') {
                    // 🔽 YENİ: "Üç nokta menü" (⋮) ikonunu tespit et ve rozeti ondan önce yerleştir
                    const menuButton = resultElement.querySelector('.mWyH1d');
                    if (menuButton) {
                        menuButton.before(badgeContainer);
                    } else {
                        parent.after(badgeContainer);
                    }
                } else {
                    titleElement.after(badgeContainer);
                }
            } else {
                resultElement.prepend(badgeContainer);
            }
        }
    }

    return badgeContainer;
}

/**
 * Yükleme göstergesini arama sonucuna enjekte eder.
 * @param {string} id - Sonucun benzersiz ID'si.
 */
function injectLoadingIndicator(id) {
    const container = getOrCreateBadgeContainer(id);
    if (!container) return;

    container.innerHTML = `
        <div class="compass-loading-state" style="display: flex; align-items: center; padding: 5px 10px; border-radius: 8px; background-color: #f3f4f6; color: #4b5563; font-size: 0.85rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); font-family: 'Inter', sans-serif;">
            <div class="loading-spinner" style="
                border: 3px solid rgba(0, 0, 0, 0.1);
                border-top-color: #3b82f6;
                border-radius: 50%;
                width: 16px;
                height: 16px;
                animation: spin 1s linear infinite;
            "></div>
            <span style="margin-left: 8px; font-weight: 500;">Analyzing...</span>
        </div>
    `;

    console.log(`[CS Loading] Added loading indicator for result ${id}.`);
}

/**
 * Puanı ve gerekçeyi arama sonucuna ekler.
 * @param {string} id - Sonucun benzersiz ID'si.
 * @param {number} score - Trust Score (0-100).
 * @param {string} reasoningSummary - Gerekçelendirme özeti.
 * @param {string} badgeUrl - Rozetin Data URL'si (SVG/PNG).
 */
function injectBadge(id, score, reasoningSummary, badgeUrl) {
    const badgeContainer = getOrCreateBadgeContainer(id);
    if (!badgeContainer) return;

    // Yükleme göstergesini temizle
    badgeContainer.innerHTML = '';

    // 1. Rozet (Badge)
    const badgeImage = document.createElement('img');
    badgeImage.src = badgeUrl;
    badgeImage.alt = `Trust Score: ${score}`;
    badgeImage.style.cssText = `
        width: 25px;
        height: 25px;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    `;

    // 2. Tooltip (body içine eklenecek)
    const existingTooltip = document.querySelector(`.compass-tooltip[data-result-id="${id}"]`);
    if (existingTooltip) existingTooltip.remove();

    const tooltip = document.createElement('div');
    tooltip.className = 'compass-tooltip';
    tooltip.setAttribute('data-result-id', id);
    tooltip.innerHTML = `
        <h4 style="font-weight: bold; margin-bottom: 5px; color: #1f2937;">Trust Score: ${score}/100</h4>
        <p style="font-size: 0.9rem; color: #4b5563;">${reasoningSummary}</p>
    `;
    tooltip.style.cssText = `
        visibility: hidden;
        opacity: 0;
        transition: opacity 0.3s, visibility 0.3s;
        width: 300px;
        background-color: #ffffff;
        color: #333;
        text-align: left;
        border-radius: 8px;
        padding: 12px;
        position: fixed;
        z-index: 999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        border: 1px solid #e5e7eb;
        pointer-events: none;
    `;
    document.body.appendChild(tooltip);

    // Hover eventleri
    badgeContainer.addEventListener('mouseenter', (e) => {
        const rect = badgeContainer.getBoundingClientRect();
        tooltip.style.visibility = 'visible';
        tooltip.style.opacity = '0';

        let top = rect.top - tooltip.offsetHeight - 10;
        if (top < 0) top = rect.bottom + 10;

        let left = rect.left + rect.width / 2 - tooltip.offsetWidth / 2;
        if (left < 0) left = 5;
        if (left + tooltip.offsetWidth > window.innerWidth) {
            left = window.innerWidth - tooltip.offsetWidth - 5;
        }

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
        tooltip.style.opacity = '1';
    });

    badgeContainer.addEventListener('mouseleave', () => {
        tooltip.style.visibility = 'hidden';
        tooltip.style.opacity = '0';
    });

    badgeContainer.appendChild(badgeImage);

    console.log(`[CS Badge Added] Score injected for the result ID ${id}: ${score}`);
}

// --- 2. Result Extraction and Message Sending ---

/**
 * Arama sonuçlarını bulur ve Service Worker'a analiz için gönderir.
 */
function analyzeAllResults() {
    let resultElements;
    let resultType;

    if (isGoogleScholar) {
        resultElements = document.querySelectorAll('div.gs_r.gs_or.gs_scl');
        resultType = 'article';
        console.log("[CS Scholar] Analyzing Google Scholar results...");
    } else {
        resultElements = document.querySelectorAll('div.g, div.rc, .yuRUbf, .gG0TJb');
        resultType = 'news';
        console.log("[CS Search] Analyzing Google Search results...");
    }

    let processedCount = 0;

    resultElements.forEach(resultElement => {
        const isAd = Array.from(resultElement.querySelectorAll('span'))
            .some(span => span.textContent.includes('Reklam'));

        if (resultElement.hasAttribute('data-compass-id') || isAd) return;

        let titleElement, linkElement, descriptionElement;

        if (isGoogleScholar) {
            titleElement = resultElement.querySelector('.gs_rt a');
            linkElement = titleElement;
            descriptionElement = resultElement.querySelector('.gs_rs');
        } else {
            titleElement = resultElement.querySelector('h3');
            linkElement = resultElement.querySelector('a');
            descriptionElement = resultElement.querySelector('.VwiC3b, .k8XOCe span');
        }

        if (titleElement && linkElement && linkElement.href && linkElement.href.length > 5) {
            const title = titleElement.innerText;
            const url = linkElement.href;
            const description = descriptionElement ? descriptionElement.innerText : '';

            const id = `cc-${resultType}-${processedCount}-${Date.now()}`;
            resultElement.setAttribute('data-compass-id', id);

            processedCount++;

            console.log(`[Sending CS Message] Result found and sent for analysis: ID=${id} | URL=${url.substring(0, 30)}...`);

            chrome.runtime.sendMessage({
                type: "ANALYZE_RESULT",
                data: { id, title, url, description, resultType }
            });
        }
    });

    if (processedCount > 0) {
        console.log(`[CS İşlendi] ${processedCount} new ${resultType} result(s) found and sent for analysis.`);
    }
}

// --- 3. Message Listener for Badge Injection ---

chrome.runtime.onMessage.addListener((request) => {
    if (request.type === "INJECT_BADGE") {
        const { id, score, reasoningSummary, badgeUrl } = request.data;
        injectBadge(id, score, reasoningSummary, badgeUrl);
    } else if (request.type === "SHOW_LOADING") {
        injectLoadingIndicator(request.data.id);
    }
});

// --- 4. Initialization ---

analyzeAllResults();
setInterval(analyzeAllResults, 500);

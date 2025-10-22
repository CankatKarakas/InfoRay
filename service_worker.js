// service_worker.js - The Brain: Handles background tasks, API calls, and logic.

console.log("[SW Start] Service Worker successfully loaded. Using Grounding for content extraction.");


const API_KEY = "";

// --- 1. Utility Functions: Caching ---

const CACHE_PREFIX = 'cc_score_';
const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Önbellekten güvenilirlik verisini alır. Süresi dolmuşsa null döndürür.
 * @param {string} url - Önbellek anahtarı olarak kullanılacak URL.
 * @returns {Promise<{score: number, summary: string} | null>} Puan verisi veya null.
 */
async function getFromCache(url) {
    const key = CACHE_PREFIX + url;
    const result = await chrome.storage.local.get(key);
    const cachedData = result[key];

    if (cachedData && (Date.now() - cachedData.timestamp < CACHE_LIFETIME_MS)) {
        console.log(`[SW Cache] Cache hit ${url}`);
        return cachedData.data; // {score, summary}
    }
    console.log(`[SW Cache] Cache miss or expired ${url}`);
    return null;
}

/**
 * Yeni hesaplanan güvenilirlik verisini önbelleğe kaydeder.
 * @param {string} url - Önbellek anahtarı olarak kullanılacak URL.
 * @param {object} scoreData - {score, summary} nesnesi.
 */
async function saveToCache(url, scoreData) {
    const key = CACHE_PREFIX + url;
    const data = {
        data: scoreData,
        timestamp: Date.now()
    };
    try {
        await chrome.storage.local.set({ [key]: data });
        console.log(`[SW Cache] Result saved in cache: ${url}`);
    } catch (e) {
        console.error(`[SW Cache ERROR] Caching failed:`, e);
    }
}

// --- 2. Utility Functions: API & Visuals ---

/**
 * API çağrısını üstel geri çekilme (exponential backoff) ile dener.
 * @param {object} payload - API'ye gönderilecek JSON yükü.
 * @param {string} modelUrl - API'nin tam URL'si (ör. Gemini veya FactCheck).
 * @param {number} maxRetries - Maksimum deneme sayısı.
 * @param {number} delay - Başlangıç gecikmesi (ms).
 * @returns {Promise<object>} API yanıtı JSON olarak.
 */
async function callApiWithRetry(payload, modelUrl, maxRetries = 5, delay = 2000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(modelUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                return await response.json();
            } else {
                const errorBody = await response.json();
                console.warn(`[API WARNING] Attempt ${i + 1} failed. HTTP Status: ${response.status} | Detail: ${JSON.stringify(errorBody)}`);
                if (response.status === 429 || response.status >= 500) {
                    await new Promise(resolve => setTimeout(resolve, delay * (2 ** i)));
                } else {
                    throw new Error(`[API ERROR] HTTP Status: ${response.status} | Detay: ${JSON.stringify(errorBody)}`);
                }
            }
        } catch (error) {
            if (error.message.startsWith('[API ERROR]')) {
                throw error;
            }
            console.error(`Network error or unexpected error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delay * (2 ** i)));
        }
    }
    throw new Error(`[API CRITICAL ERROR] API call failed after all retries.`);
}

/**
 * Fact Check Tools API'sını kullanarak bir URL için teyit edilmiş sonuçları arar.
 * @param {string} url - Kontrol edilecek URL.
 * @returns {Promise<string>} Teyit sonuçlarını özetleyen bir string veya boş string.
 */
async function callFactCheckApi(url) {
    const apiUrl = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(url)}&key=${API_KEY}`;

    try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
            console.warn(`[FactCheckTools] API failed for URL: ${url}. Status: ${response.status}`);
            return "EXTERNAL_FACT_CHECK_ERROR: Fact Check Tools API call failed or returned empty. Reliance on Gemini's search grounding is increased.";
        }

        const data = await response.json();

        if (data.claims && data.claims.length > 0) {
            const claimsSummary = data.claims.map(claim => {
                const review = claim.claimReview[0];
                const claimantHostname = claim.claimant ? new URL(claim.claimant).hostname : "Unknown Claimant";
                return `- Claim: "${claim.text}" (Source: ${claimantHostname}). Verdict: ${review.textualRating} (Source: ${review.publisher.name})`;
            }).join('\n');

            return `EXTERNAL_FACT_CHECK_DATA:\n${claimsSummary}`;
        }

        return "EXTERNAL_FACT_CHECK_DATA: No pre-existing fact-check claims were found for this URL/article.";

    } catch (e) {
        console.error("[FactCheckTools] General error:", e);
        return "EXTERNAL_FACT_CHECK_ERROR: An exception occurred during Fact Check Tools API processing.";
    }
}


function getScoreColor(score) {
    if (score >= 70) return '#10B981'; // Green
    if (score >= 40) return '#F59E0B'; // Yellow/Orange
    return '#EF4444'; // Red
}

function createBadgeSvg(score) {
    const color = getScoreColor(score);
    const scoreText = score >= 0 ? score.toString() : 'X';

    const svgContent = `
        <svg width="25" height="25" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="48" fill="${color}" stroke="#FFFFFF" stroke-width="4"/>
            <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial, sans-serif" font-size="50" fill="#FFFFFF" font-weight="bold">${scoreText}</text>
        </svg>
    `.trim();

    return `data:image/svg+xml;base64,${btoa(svgContent)}`;
}

// --- 3. Core Logic ---

async function generateScore(url, title, description, resultType) {
    console.log(`[SW DIAGNOSTIC] Running score generation for ${resultType} with Fact Check Tools integration.`);

    let externalFactCheckData = "EXTERNAL_FACT_CHECK_DATA: Not applicable for this content type or no specific tools integrated.";
    let systemPrompt = "";
    let userQuery = "";

    if (resultType === 'news') {
        externalFactCheckData = await callFactCheckApi(url); // Fact Check API for News
        systemPrompt = `
You are a highly skilled and ethical Reliability Analyst specializing in news content trust scoring. Use ONLY the provided EXTERNAL_FACT_CHECK_DATA and the provided Google Search results / SERP snippets (do not fabricate or "imagine" full article text). Always follow these rules exactly.

1) TASK
- Produce a Trust Score (0-100) and a concise summary for the given URL, synthesizing:
  - FACTOR A: EXTERNAL VERIFICATION (fact-checks)
  - FACTOR B: JOURNALISM PRINCIPLES COMPLIANCE (content quality)

2) WEIGHTING (default)
- Default weighting: FactorA 50% / FactorB 50%.
- Rule-based adjustments:
  - If FactorA contains a definitive debunk from ≥2 credible fact-checkers within the last 24 months -> FactorA:70 FactorB:30.
  - If no external verification exists within 24 months -> reduce FactorA effective weight by 30% (i.e., FactorA:35 FactorB:65).

3) FACTOR A — EXTERNAL VERIFICATION (how to evaluate)
- Use EXTERNAL_FACT_CHECK_DATA first.
- Then use the provided Google Search results (prioritize reputable sites listed: teyit.org, dogrulukpayi.com, factcheckingturkey.com, politifact.com, snopes.com, apnews.com, reuters.com).
- If fact-checks conflict: prefer (1) most recent, then (2) higher-credibility source, then (3) majority.
- Map external verdicts to FactorA_score (0–100) using explicit mapping:
  - Definitive debunk → 5–20
  - Mostly false/mixture against claim → 21–39
  - No decisive fact-check (no evidence found) → 40–60
  - Supported / confirmed → 61–85
  - Strong independent verification + multiple sources → 86–100

4) FACTOR B — JOURNALISM PRINCIPLES (how to evaluate)
- Determine article language and scope (local vs global). State which you used.
- Based on provided text/snippets, evaluate the 10 principles: Accuracy, Honesty, Editorial Independence, Objectivity, Impartiality, Humanity (Do No Harm), Courage, Solutions Journalism practice, Verification, Accountability.
- Assign a FactorB_score (0–100). If only SERP snippets available, explicitly note "based on snippet" and reduce FactorB score by 10–20% to reflect uncertainty.
- Adjust scoring based on content type:
  - If article labeled/opinion/editorial: apply a relaxed standard for balance but require transparent labeling.

5) RECENCY
- Prefer fact-checks and corroborating evidence within last 24 months. Older evidence reduces weight as specified.

6) OUTPUT: format required
- Primary (machine & UI friendly) plain text output EXACTLY as:
  SCORE:X SUMMARY:Y
  Where X is integer 0–100, Y is a concise summary (max 2 sentences) that mentions: primary external verdict(s) and 1–2 key journalism principle findings.
- Additionally (for developer use), produce a JSON block AFTER the required plain text (on a new line) with fields:
  {"score":X,"factorA_score":A,"factorB_score":B,"confidence":C,"top_citations":[{"url":"...","date":"YYYY-MM-DD","role":"fact-check/source"}],"notes":"..."}
  - Confidence = float between 0.0 and 1.0.

7) CITATIONS & TRANSPARENCY
- In SUMMARY include up to 3 short citations (domain or short URL) and publication dates when they materially affected the verdict.
- Never invent URLs or fact-checks. If nothing is found, write "No external verification found".

8) SAFETY & HALLUCINATION GUARDS
- If you cannot verify a claim, explicitly say so. Do not fabricate any source or claim.

9) SOURCE EXCLUSIONS
- Explicitly AVOID using user-generated content, forums, or social aggregators as primary sources for fact-checking or analysis. This includes, but is not limited to, sites like onedio.com, eksisozluk.com, reddit.com, and quora.com. Information from these sites should not be used in the summary or cited as evidence.

END PROMPT.
        `;
        userQuery = `
            Please perform a comprehensive reliability analysis for the article at the provided URL and title, strictly following the two-factor analysis (External Verification & Journalism Principles Compliance).

            URL: ${url}
            Title: ${title}
            Description/Snippet: ${description}

            --- EXTERNAL FACT CHECK DATA (From Google Fact Check Tools) ---
            ${externalFactCheckData}
            --- END OF FACT CHECK DATA ---
        `;
    } else if (resultType === 'article') {
        // Google Scholar makaleleri için özel prompt
        systemPrompt = `
You are a highly skilled and ethical Academic Research Analyst specializing in scientific article credibility scoring. Use ONLY the provided search results / SERP snippets (do not fabricate or "imagine" full article text). Always follow these rules exactly.

1) TASK
- Produce a Trust Score (0-100) and a concise summary for the given academic article, synthesizing:
  - FACTOR A: ACADEMIC REPUTATION (author, journal, citations, h-index)
  - FACTOR B: METHODOLOGICAL RIGOR & PEER REVIEW (study design, data, peer review status)

2) WEIGHTING (default)
- Default weighting: FactorA 60% / FactorB 40%.
- Rule-based adjustments:
  - If FactorA includes highly cited author (h-index > 50) AND top-tier journal (e.g., Nature, Science, Lancet) -> FactorA:75 FactorB:25.
  - If FactorA indicates a predatory journal or unknown author/publisher -> FactorA:30 FactorB:70 (if enough data for B).
  - If no clear author/journal info (e.g., preprint) -> FactorA effective weight reduced by 40% (i.e., FactorA:36 FactorB:64).

3) FACTOR A — ACADEMIC REPUTATION (how to evaluate)
- Use the provided Google Scholar snippets and Google Search results (through the tool).
- Prioritize information on:
  - Author(s) expertise, affiliations, h-index, total citations (if available in snippets).
  - Journal/Conference reputation, impact factor, peer-review process (if indicated).
  - Number of citations for THIS specific article.
  - Avoid using personal blogs, forums, or unverified sources for reputation assessment.
- Map reputation to FactorA_score (0–100):
  - Highly reputable author/journal, high citations → 80-100
  - Solid reputation, good citations → 60-79
  - Established but not top-tier, moderate citations → 40-59
  - New/unknown author/journal, low/no citations → 20-39
  - Predatory journal/unverified source → 0-19

4) FACTOR B — METHODOLOGICAL RIGOR & PEER REVIEW (how to evaluate)
- Based on provided article title and snippet, infer:
  - Study design (e.g., randomized controlled trial, meta-analysis, case study, review).
  - Data sources and methodology description.
  - Indication of peer review status (e.g., "preprint", "peer-reviewed journal").
  - General scientific soundness.
- Assign a FactorB_score (0–100). If only snippets available, explicitly note "based on snippet" and reduce FactorB score by 10-20% to reflect uncertainty.

5) RECENCY
- Note the publication date. Very old articles might be foundational but less relevant for "current" assessments, though their historical credibility might be high. Adjust score contextually.

6) OUTPUT: format required
- Primary (machine & UI friendly) plain text output EXACTLY as:
  SCORE:X SUMMARY:Y
  Where X is integer 0–100, Y is a concise summary (max 2 sentences) that mentions: primary findings on author/journal reputation, citation impact, and methodological inference.
- Additionally (for developer use), produce a JSON block AFTER the required plain text (on a new line) with fields:
  {"score":X,"factorA_score":A,"factorB_score":B,"confidence":C,"top_citations":[{"url":"...","date":"YYYY-MM-DD","role":"author_profile/journal_info/citation_link"}],"notes":"..."}
  - Confidence = float between 0.0 and 1.0.

7) CITATIONS & TRANSPARENCY
- In SUMMARY, include up to 3 short citations (domain or short URL) and publication dates when they materially affected the verdict. This could include author profiles or journal homepages.
- Never invent URLs or academic data. If nothing is found, write "No specific academic data found in snippets".

8) SAFETY & HALLUCINATION GUARDS
- If you cannot verify a claim, explicitly say so. Do not fabricate any source or claim.

9) SOURCE EXCLUSIONS
- Explicitly AVOID using non-academic sources for academic credibility assessment where academic sources are expected. This includes general news sites (unless reporting on the academic work), blogs, or social media for core academic metrics.

END PROMPT.
        `;
        userQuery = `
            Please perform a comprehensive academic reliability analysis for the article, strictly following the two-factor analysis (Academic Reputation & Methodological Rigor).

            URL: ${url}
            Title: ${title}
            Description/Snippet (from Google Scholar): ${description}

            (Use Google Search tool if needed to find author H-index, journal impact, or additional citations for the specific article or author profile pages.)
        `;
    } else {
        throw new Error("Unsupported resultType. Cannot generate score.");
    }


    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        tools: [{ "google_search": {} }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
    };

    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${API_KEY}`;

    try {
        const responseJson = await callApiWithRetry(payload, geminiApiUrl);
        const text = responseJson.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
            throw new Error("Empty response from Gemini API.");
        }

        const lines = text.trim().split('\n').filter(line => line.trim().length > 0);
        const plainTextLine = lines[0] || "";
        const jsonLine = lines.length > 1 ? lines.find(line => line.trim().startsWith('{') && line.trim().endsWith('}')) : null;

        const scoreMatch = plainTextLine.match(/SCORE\s*:\s*(\d+)/i);
        const summaryMatch = plainTextLine.match(/SUMMARY\s*:\s*(.*)$/i);

        if (scoreMatch && summaryMatch) {
            const score = parseInt(scoreMatch[1], 10);

            let summary = summaryMatch[1].trim();
            const lastSummaryIndex = summary.toLowerCase().lastIndexOf("summary:");
            if (lastSummaryIndex !== -1) {
                summary = summary.substring(lastSummaryIndex + "summary:".length).trim();
            }

            const finalScore = Math.max(0, Math.min(100, score));

            if (jsonLine) {
                try {
                    const devData = JSON.parse(jsonLine);
                    console.log("[SW DIAGNOSTIC] Parsed Developer JSON Data:", devData);
                } catch (e) {
                    console.warn("[SW WARNING] Failed to parse developer JSON block:", e);
                }
            }

            return { score: finalScore, summary: summary };
        } else {
            console.error("Error in generateScore: Gemini response was not in the required format. Raw output:", text);
            return { score: 0, summary: "Analysis format error. Detailed analysis could not be completed. (LLM Format)" };
        }

    } catch (error) {
        console.error("Error in generateScore:", error.message);
        throw new Error("API analysis failed after all retries.");
    }
}

// --- 4. Message Listener (Cache Integration) ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type !== "ANALYZE_RESULT") {
        return false;
    }

    const { id, title, url, description, resultType } = request.data;

    (async () => {
        try {
            // 1. Check the cache
            let scoreData = await getFromCache(url);

            if (!scoreData) {

                // Send a message to Content Script for showing "Loading" status
                try {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        type: "SHOW_LOADING",
                        data: { id: id }
                    });
                } catch (e) {
                    console.warn("[SW WARNING] Failed to send loading message. Tab might be closed.");
                    return; // End the process if tab is closed.
                }

                
                scoreData = await generateScore(url, title, description, resultType);

                // 3. Save trust point into the cache
                if (scoreData.score > 0 && !scoreData.summary.toLowerCase().includes("error")) {
                       await saveToCache(url, scoreData);
                }
            }

            
            const source = scoreData.fromCache ? "Cached" : "API";
            console.log(`[SW RESULT] Analysis completed for result ID ${id}. Source: ${source} | Score: ${scoreData.score}`);

            
            const badgeUrl = createBadgeSvg(scoreData.score);

            
            chrome.tabs.sendMessage(sender.tab.id, {
                type: "INJECT_BADGE",
                data: {
                    id: id,
                    score: scoreData.score,
                    reasoningSummary: scoreData.summary,
                    badgeUrl: badgeUrl
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn("[SW WARNING] Could not send final score to content script. It might have been closed. Error:", chrome.runtime.lastError.message);
                }
            });

        } catch (error) {
            console.error(`[SW CRITICAL] Final error for ID ${id} after all retries. The UI will remain in the loading state. Error:`, error.message);
        }
    })();

    return true;
});
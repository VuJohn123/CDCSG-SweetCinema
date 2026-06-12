import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getDatabase, ref, push, onValue, get } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyAqeNDOXZTXKNYbx80SGZqASjgXX69OAIg",
    authDomain: "cdcsg-sweetcinema.firebaseapp.com",
    databaseURL: "https://cdcsg-sweetcinema-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "cdcsg-sweetcinema",
    storageBucket: "cdcsg-sweetcinema.firebasestorage.app",
    messagingSenderId: "235832513140",
    appId: "1:235832513140:web:6e6c5b2323679bb69e7721"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const patternsRef = ref(db, 'patterns');

const TOTAL = 16, MISS = 4, GRID = 4;
let gridState = new Array(TOTAL).fill(0);
let historyStack = [];
let clickMode = 'hit';
let allPatterns = [];
let validPatterns = [];
let communityMissCounts = new Array(TOTAL).fill(0);
let communityTotal = 0;
let cells = [];

// Biến giới hạn
let lastSubmitTime = 0;
const SUBMIT_COOLDOWN = 5000; // 5 giây
const MAX_IMPORT_PATTERNS = 50;
let recaptchaWidgetId = null;
let pendingMisses = null; // lưu tạm pattern khi mở modal

/* ========== CÁC HÀM GAME (giữ nguyên như trước) ========== */
function generateAllMissCombos() {
    const combos = [];
    const combine = (start, cur) => {
        if (cur.length === MISS) { combos.push(new Set(cur)); return; }
        for (let i = start; i < TOTAL; i++) { cur.push(i); combine(i + 1, cur); cur.pop(); }
    };
    combine(0, []);
    return combos;
}

function computeWeights(missSets, communityData) {
    if (!communityData || communityData.total === 0) return missSets.map(s => ({ missSet: s, weight: 1 }));
    const { counts, total } = communityData;
    return missSets.map(s => {
        let w = 1;
        for (let i = 0; i < TOTAL; i++) {
            const c = counts[i] || 0;
            w *= s.has(i) ? (1 + c) : (1 + total - c);
        }
        return { missSet: s, weight: w };
    });
}

function refreshPatterns() {
    const baseCombos = generateAllMissCombos();
    allPatterns = computeWeights(baseCombos, { counts: communityMissCounts, total: communityTotal });
    validPatterns = filterPatterns(gridState);
}

function filterPatterns(state) {
    return allPatterns.filter(p => {
        for (let i = 0; i < TOTAL; i++) {
            if (state[i] === 1 && p.missSet.has(i)) return false;
            if (state[i] === 2 && !p.missSet.has(i)) return false;
        }
        return true;
    });
}

function probs() {
    const prob = new Array(TOTAL).fill(0);
    const totalW = validPatterns.reduce((s, p) => s + p.weight, 0);
    if (totalW === 0) return prob;
    validPatterns.forEach(p => {
        const w = p.weight / totalW;
        p.missSet.forEach(i => prob[i] += w);
    });
    return prob;
}

function entropy(pats) {
    const totalW = pats.reduce((s, p) => s + p.weight, 0);
    if (!totalW) return 0;
    return pats.reduce((h, p) => {
        const prob = p.weight / totalW;
        return prob > 0 ? h - prob * Math.log2(prob) : h;
    }, 0);
}

function findBest() {
    if (validPatterns.length <= 1) return -1;
    const curEnt = entropy(validPatterns);
    let best = -1, bestIG = -1;
    for (let i = 0; i < TOTAL; i++) {
        if (gridState[i] !== 0) continue;
        const missPats = [], hitPats = [];
        validPatterns.forEach(p => p.missSet.has(i) ? missPats.push(p) : hitPats.push(p));
        const totalW = validPatterns.reduce((s, p) => s + p.weight, 0);
        const pMiss = missPats.reduce((s, p) => s + p.weight, 0) / totalW;
        const pHit = 1 - pMiss;
        const expEnt = (missPats.length ? pMiss * entropy(missPats) : 0) + (hitPats.length ? pHit * entropy(hitPats) : 0);
        const ig = curEnt - expEnt;
        if (ig > bestIG) { bestIG = ig; best = i; }
    }
    return best;
}

function buildGrid() {
    const gridEl = document.getElementById('gridContainer');
    gridEl.innerHTML = '';
    cells = [];
    for (let i = 0; i < TOTAL; i++) {
        const div = document.createElement('div');
        div.className = 'cell state-unknown';
        div.dataset.idx = i;
        div.addEventListener('click', () => cellClick(i));
        div.addEventListener('contextmenu', e => { e.preventDefault(); cellRightClick(i); });
        gridEl.appendChild(div);
        cells.push(div);
    }
}

function pushHistory() { historyStack.push([...gridState]); if (historyStack.length > 50) historyStack.shift(); }
function cellClick(i) {
    pushHistory();
    if (gridState[i] === 0) gridState[i] = clickMode === 'hit' ? 1 : 2;
    else gridState[i] = 0;
    update();
}
function cellRightClick(i) {
    pushHistory();
    gridState[i] = gridState[i] === 2 ? 0 : 2;
    update();
}
function undo() {
    if (!historyStack.length) { showToast('Không có gì để undo', 'warning'); return; }
    gridState = historyStack.pop();
    update();
}
function reset() {
    if (gridState.every(s => s === 0)) return;
    pushHistory();
    gridState.fill(0);
    update();
}

function update() {
    validPatterns = filterPatterns(gridState);
    const p = probs();
    const missCount = gridState.filter(s => s === 2).length;
    document.getElementById('statValid').textContent = validPatterns.length;
    document.getElementById('statMiss').textContent = `${missCount} / ${MISS}`;
    document.getElementById('statHit').textContent = gridState.filter(s => s === 1).length;

    cells.forEach((cell, i) => {
        cell.classList.remove('state-hit', 'state-miss', 'state-unknown', 'best-suggest');
        cell.innerHTML = `<span class="coord">(${Math.floor(i / GRID)},${i % GRID})</span>`;
        if (gridState[i] === 1) { cell.classList.add('state-hit'); cell.innerHTML += '✔'; }
        else if (gridState[i] === 2) { cell.classList.add('state-miss'); cell.innerHTML += '✘'; }
        else {
            cell.classList.add('state-unknown');
            cell.innerHTML += `<span class="prob-text">${(p[i] * 100).toFixed(1)}%</span>`;
        }
    });

    const bestIdx = findBest();
    if (bestIdx >= 0 && gridState[bestIdx] === 0) {
        cells[bestIdx].classList.add('best-suggest');
        cells[bestIdx].innerHTML += '<div class="best-badge">BEST</div>';
        document.getElementById('bestCellInfo').style.display = 'block';
        document.getElementById('bestCoord').textContent = `(${Math.floor(bestIdx / GRID)},${bestIdx % GRID})`;
        const curEnt = entropy(validPatterns);
        const missPats = validPatterns.filter(p => p.missSet.has(bestIdx));
        const hitPats = validPatterns.filter(p => !p.missSet.has(bestIdx));
        const totalW = validPatterns.reduce((s, p) => s + p.weight, 0);
        const pMiss = missPats.reduce((s, p) => s + p.weight, 0) / totalW;
        const pHit = 1 - pMiss;
        const expEnt = (missPats.length ? pMiss * entropy(missPats) : 0) + (hitPats.length ? pHit * entropy(hitPats) : 0);
        document.getElementById('bestIG').textContent = (curEnt - expEnt).toFixed(3) + ' bit';
    } else {
        document.getElementById('bestCellInfo').style.display = 'none';
    }

    const list = document.getElementById('miniProbList');
    list.innerHTML = '';
    for (let i = 0; i < TOTAL; i++) {
        if (gridState[i] !== 0) continue;
        const pct = (p[i] * 100).toFixed(1);
        const cls = pct >= 75 ? 'pct-high' : (pct >= 50 ? 'pct-mid' : 'pct-low');
        const item = document.createElement('div');
        item.className = 'mini-prob-item';
        item.innerHTML = `<span>(${Math.floor(i / GRID)},${i % GRID})</span><span class="${cls}">${pct}%</span>`;
        item.addEventListener('click', () => cells[i].scrollIntoView({ behavior: 'smooth', block: 'center' }));
        list.appendChild(item);
    }

    document.getElementById('singleAlert').style.display = validPatterns.length === 1 ? 'block' : 'none';
    renderGallery();
    document.getElementById('btnSavePattern').disabled = !(validPatterns.length === 1 || (missCount === MISS && validPatterns.length >= 1));
}

function renderGallery() {
    const gal = document.getElementById('galleryGrid');
    document.getElementById('galleryCount').textContent = `Hiển thị ${validPatterns.length} pattern`;
    gal.innerHTML = '';
    validPatterns.slice(0, 150).forEach(p => {
        const mini = document.createElement('div');
        mini.className = 'mini-grid';
        for (let i = 0; i < TOTAL; i++) {
            const mc = document.createElement('div');
            mc.className = 'mini-cell';
            if (p.missSet.has(i)) mc.classList.add('miss');
            mini.appendChild(mc);
        }
        mini.addEventListener('click', () => {
            const misses = Array.from(p.missSet);
            if (misses.some(i => gridState[i] === 1)) { showToast('Pattern xung đột với Hit đã đánh dấu', 'warning'); return; }
            pushHistory();
            misses.forEach(i => { if (gridState[i] === 0) gridState[i] = 2; });
            update();
        });
        gal.appendChild(mini);
    });
}

function renderHeatmap() {
    const div = document.getElementById('heatmapContainer');
    if (!communityTotal) {
        div.innerHTML = '<div style="text-align:center; color:var(--text2);">Chưa có dữ liệu cộng đồng. Hãy là người đầu tiên gửi pattern!</div>';
        return;
    }
    let html = '<div style="display:grid; grid-template-columns:repeat(4, 60px); gap:6px; justify-content:center;">';
    for (let i = 0; i < TOTAL; i++) {
        const pct = ((communityMissCounts[i] || 0) / communityTotal * 100).toFixed(0);
        const color = pct > 50 ? '#ff5252' : (pct > 25 ? '#ffa726' : '#66bb6a');
        html += `<div style="background:#1e1e38; border-radius:10px; padding:8px; text-align:center; font-weight:700; color:${color}; border:1px solid ${color};">
            ${pct}%<br><small style="font-size:0.6rem;">${communityMissCounts[i] || 0} lần</small>
        </div>`;
    }
    html += `</div><div style="text-align:center; margin-top:10px; font-weight:600;">📊 Tổng: <span style="color:var(--gold);">${communityTotal}</span> pattern đã được cộng đồng gửi</div>`;
    div.innerHTML = html;
}

/* ========== FIREBASE DATA ========== */
function submitPatternToCommunity(missArray) {
    const now = Date.now();
    if (now - lastSubmitTime < SUBMIT_COOLDOWN) {
        showToast('Vui lòng đợi 5 giây trước khi gửi lại.', 'warning');
        return;
    }
    lastSubmitTime = now;
    push(patternsRef, { misses: missArray, timestamp: now })
        .then(() => showToast('✅ Đã gửi pattern lên đám mây! Cảm ơn bạn! 🌍'))
        .catch(err => showToast('Lỗi gửi pattern: ' + err.message, 'warning'));
}

function listenCommunityData() {
    onValue(patternsRef, (snapshot) => {
        const data = snapshot.val();
        const counts = new Array(TOTAL).fill(0);
        let total = 0;
        if (data) {
            Object.values(data).forEach(entry => {
                if (entry.misses && Array.isArray(entry.misses)) {
                    entry.misses.forEach(idx => { if (idx >= 0 && idx < TOTAL) counts[idx]++; });
                    total++;
                }
            });
        }
        communityMissCounts = counts;
        communityTotal = total;
        refreshPatterns();
        update();
        renderHeatmap();
    });
}

function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + type;
    setTimeout(() => t.classList.remove('show'), 2000);
}

/* ========== MODAL + RECAPTCHA ========== */
function openConfirmModal(missArray) {
    pendingMisses = missArray;
    document.getElementById('confirmModal').style.display = 'flex';
    document.getElementById('btnConfirmSend').disabled = true; // sẽ bật khi reCAPTCHA solved

    // Nếu chưa render reCAPTCHA thì render
    if (!recaptchaWidgetId) {
        recaptchaWidgetId = grecaptcha.render('recaptchaContainer', {
            'sitekey': 'YOUR_SITE_KEY',  // <-- THAY BẰNG SITE KEY CỦA BẠN
            'callback': onRecaptchaSuccess,
            'expired-callback': onRecaptchaExpired
        });
    } else {
        grecaptcha.reset(recaptchaWidgetId);
    }
}

function onRecaptchaSuccess() {
    document.getElementById('btnConfirmSend').disabled = false;
}

function onRecaptchaExpired() {
    document.getElementById('btnConfirmSend').disabled = true;
}

function closeConfirmModal() {
    document.getElementById('confirmModal').style.display = 'none';
    grecaptcha.reset(recaptchaWidgetId);
    pendingMisses = null;
}

function confirmedSubmit() {
    if (!pendingMisses) return;
    submitPatternToCommunity(pendingMisses);
    closeConfirmModal();
}

/* ========== IMPORT / EXPORT (có giới hạn) ========== */
function exportData() {
    get(patternsRef).then((snapshot) => {
        const data = snapshot.val();
        const patterns = [];
        if (data) {
            Object.values(data).forEach(entry => {
                if (entry.misses && Array.isArray(entry.misses) && entry.misses.length === MISS) {
                    patterns.push(entry.misses.slice().sort((a,b)=>a-b));
                }
            });
        }
        const json = JSON.stringify({ patterns }, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'sweet-cinema-export.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('📤 Đã export ' + patterns.length + ' pattern!', 'success');
    }).catch(err => showToast('Lỗi khi export: ' + err.message, 'warning'));
}

async function importData(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const json = JSON.parse(e.target.result);
            if (!json.patterns || !Array.isArray(json.patterns)) throw new Error('Sai định dạng');
            let newPatterns = json.patterns.filter(p => Array.isArray(p) && p.length === MISS && p.every(n => n >= 0 && n < TOTAL));
            if (newPatterns.length > MAX_IMPORT_PATTERNS) {
                showToast(`⚠️ Chỉ được import tối đa ${MAX_IMPORT_PATTERNS} pattern/lần.`, 'warning');
                newPatterns = newPatterns.slice(0, MAX_IMPORT_PATTERNS);
            }
            const pushPromises = newPatterns.map(p => {
                const sortedMisses = p.slice().sort((a, b) => a - b);
                return push(patternsRef, { misses: sortedMisses, timestamp: Date.now() });
            });
            const results = await Promise.allSettled(pushPromises);
            const successCount = results.filter(r => r.status === 'fulfilled').length;
            const failCount = results.filter(r => r.status === 'rejected').length;
            if (failCount > 0) {
                results.forEach((r, i) => { if (r.status === 'rejected') console.error(`Import lỗi pattern ${i}:`, r.reason); });
                showToast(`⚠️ Đã import ${successCount}/${newPatterns.length} pattern. ${failCount} lỗi (xem console)`, 'warning');
            } else {
                showToast(`📥 Đã import thành công ${successCount} pattern vào cộng đồng!`, 'success');
            }
        } catch (err) {
            showToast('❌ File không đúng định dạng JSON', 'warning');
            console.error(err);
        }
    };
    reader.readAsText(file);
}

function testDatabaseConnection() {
    // Sau khi rule mới chặn /testConnection, nút này có thể không cần, nhưng vẫn giữ để test rule
    const testRef = ref(db, 'testConnection');
    push(testRef, { msg: 'test', timestamp: Date.now() })
        .then(() => showToast('✅ Kết nối Firebase hoạt động!', 'success'))
        .catch(err => showToast('❌ Lỗi kết nối: ' + err.message, 'warning'));
}

/* ========== EVENT LISTENERS ========== */
function setupEvents() {
    document.getElementById('btnModeHit').addEventListener('click', () => {
        clickMode = 'hit';
        document.getElementById('btnModeHit').style.background = 'var(--accent)';
        document.getElementById('btnModeHit').style.color = '#fff';
        document.getElementById('btnModeMiss').style.background = 'transparent';
        document.getElementById('btnModeMiss').style.color = 'var(--text2)';
    });
    document.getElementById('btnModeMiss').addEventListener('click', () => {
        clickMode = 'miss';
        document.getElementById('btnModeMiss').style.background = 'var(--accent)';
        document.getElementById('btnModeMiss').style.color = '#fff';
        document.getElementById('btnModeHit').style.background = 'transparent';
        document.getElementById('btnModeHit').style.color = 'var(--text2)';
    });
    document.getElementById('btnSuggest').addEventListener('click', () => {
        const best = findBest();
        if (best >= 0 && gridState[best] === 0) {
            cells[best].scrollIntoView({ behavior: 'smooth', block: 'center' });
            showToast(`💡 Gợi ý: ô (${Math.floor(best / GRID)},${best % GRID})`);
        } else {
            showToast('Không còn ô nào để gợi ý', 'warning');
        }
    });
    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('btnReset').addEventListener('click', reset);

    // Nút "Lưu & Gửi" mở modal reCAPTCHA thay vì gửi trực tiếp
    document.getElementById('btnSavePattern').addEventListener('click', () => {
        let misses;
        if (validPatterns.length === 1) {
            misses = Array.from(validPatterns[0].missSet).sort((a, b) => a - b);
        } else {
            misses = gridState.reduce((arr, s, i) => { if (s === 2) arr.push(i); return arr; }, []).sort((a, b) => a - b);
        }
        if (misses.length !== MISS) {
            showToast('Cần xác định chính xác 4 ô XỊT', 'warning');
            return;
        }
        openConfirmModal(misses);
    });

    // Modal events
    document.getElementById('btnCancelSend').addEventListener('click', closeConfirmModal);
    document.getElementById('btnConfirmSend').addEventListener('click', confirmedSubmit);

    document.getElementById('btnExport').addEventListener('click', exportData);
    document.getElementById('btnImport').addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput').addEventListener('change', (e) => {
        if (e.target.files[0]) {
            importData(e.target.files[0]);
            e.target.value = '';
        }
    });
    document.getElementById('btnTestConnection').addEventListener('click', testDatabaseConnection);

    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
    });
}

// Khởi tạo
buildGrid();
listenCommunityData();
refreshPatterns();
update();
setupEvents();

// Castle Hassle frontend — talks to the JSON API in src/server.js.

// A stable per-browser voter token so votes can be de-duplicated without login.
const voterToken = (() => {
  let t = localStorage.getItem('ch_voter_token');
  if (!t) {
    t = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('ch_voter_token', t);
  }
  return t;
})();

// Remember how this browser voted so buttons can show active state.
const myVotes = JSON.parse(localStorage.getItem('ch_my_votes') || '{}');
function rememberVote(id, value) {
  myVotes[id] = value;
  localStorage.setItem('ch_my_votes', JSON.stringify(myVotes));
}

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- Today's horror --------------------------------------------------------
async function loadToday() {
  const el = $('#today-body');
  try {
    const { day, horror } = await api('/api/today');
    $('#today-date').textContent = `· ${day}`;
    el.innerHTML = `
      <img class="today-img" src="${esc(horror.image_url)}" alt="${esc(horror.title)}" loading="lazy" />
      <div class="today-caption">
        <div class="title">${esc(horror.title)}</div>
        ${horror.source_url ? `<a href="${esc(horror.source_url)}" target="_blank" rel="noopener">source</a>` : ''}
        ${horror.credit ? `<div class="muted">${esc(horror.credit)}</div>` : ''}
      </div>`;
  } catch (err) {
    el.innerHTML = `<p class="muted">No horror yet — ${esc(err.message)}. Try seeding the catalog.</p>`;
  }
}

// --- Candidates / voting ---------------------------------------------------
async function loadCandidates() {
  const wrap = $('#candidates');
  try {
    const { candidates } = await api('/api/candidates');
    if (!candidates.length) {
      wrap.innerHTML = '<p class="muted">No candidates yet. Submit one below!</p>';
      return;
    }
    wrap.innerHTML = candidates.map(renderCandidate).join('');
    wrap.querySelectorAll('[data-vote]').forEach((btn) => {
      btn.addEventListener('click', () => castVote(btn));
    });
  } catch (err) {
    wrap.innerHTML = `<p class="muted">Couldn't load candidates: ${esc(err.message)}</p>`;
  }
}

function renderCandidate(c) {
  const mine = myVotes[c.id];
  return `
    <div class="tile" data-id="${c.id}">
      <img src="${esc(c.image_url)}" alt="${esc(c.title)}" loading="lazy" />
      <div class="body">
        <div class="t-title">${esc(c.title)}</div>
        <div class="vote-row">
          <button class="btn-vote ${mine === 1 ? 'active' : ''}" data-vote="1" data-id="${c.id}" title="Horrifying">👍</button>
          <span class="score" id="score-${c.id}">${c.score ?? 0}</span>
          <button class="btn-vote ${mine === -1 ? 'active' : ''}" data-vote="-1" data-id="${c.id}" title="Not scary enough">👎</button>
        </div>
      </div>
    </div>`;
}

async function castVote(btn) {
  const id = Number(btn.dataset.id);
  const value = Number(btn.dataset.vote);
  try {
    const { score } = await api(`/api/candidates/${id}/vote`, {
      method: 'POST',
      body: JSON.stringify({ voter_token: voterToken, value }),
    });
    rememberVote(id, value);
    $(`#score-${id}`).textContent = score;
    document.querySelectorAll(`.tile[data-id="${id}"] .btn-vote`).forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.vote) === value);
    });
  } catch (err) {
    alert(err.message);
  }
}

// --- History ---------------------------------------------------------------
async function loadHistory() {
  const wrap = $('#history');
  try {
    const { history } = await api('/api/history');
    wrap.innerHTML = history.length
      ? history.map((h) => `
          <div class="tile">
            <img src="${esc(h.image_url)}" alt="${esc(h.title)}" loading="lazy" />
            <div class="body">
              <div class="day-badge">${esc(h.day)}</div>
              <div class="t-title">${esc(h.title)}</div>
            </div>
          </div>`).join('')
      : '<p class="muted">No past horrors yet — today is day one.</p>';
  } catch {
    wrap.innerHTML = '';
  }
}

// --- Submit form -----------------------------------------------------------
$('#submit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#submit-msg');
  const form = e.target;
  const body = {
    title: form.title.value.trim(),
    image_url: form.image_url.value.trim(),
    source_url: form.source_url.value.trim() || undefined,
    credit: form.credit.value.trim() || undefined,
    submitted_by: voterToken,
  };
  try {
    const res = await api('/api/submit', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = res.message;
    msg.className = 'msg ok';
    form.reset();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  }
});

// --- Wallpaper URL widget --------------------------------------------------
const wallpaperUrl = `${location.origin}/api/wallpaper/today.jpg`;
$('#wallpaper-url').textContent = wallpaperUrl;
$('#copy-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(wallpaperUrl);
    $('#copy-url').textContent = 'Copied!';
    setTimeout(() => ($('#copy-url').textContent = 'Copy URL'), 1500);
  } catch {
    /* clipboard may be blocked; the URL is visible anyway */
  }
});

// Kick everything off.
loadToday();
loadCandidates();
loadHistory();

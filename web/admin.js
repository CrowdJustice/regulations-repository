// The admin page. It reads the repository straight from GitHub and makes every change by running the
// "Admin action" workflow, so the rules in agent/ apply to an admin's edits exactly as they do to the assistant's.
(function () {
  'use strict';

  /* TRACKER-CONFIG:START. Filled in by agent/build-page.mjs. */
  var CONFIG = { repo: 'franciscoporragas-ops/regulation-changes', branch: 'main' };
  /* TRACKER-CONFIG:END */

  /* TRACKER-CHECKS:START. agent/lib/checks.mjs is placed here by the build, so the form applies the same rules as the server. */
  /* TRACKER-CHECKS:END */

  var REPO = CONFIG.repo;
  var BRANCH = new URLSearchParams(location.search).get('branch') || CONFIG.branch;
  var API = 'https://api.github.com';
  var RAW = 'https://raw.githubusercontent.com';
  var TOKEN_KEY = 'tracker-admin-token';
  var CACHE_KEY = 'tracker-admin-files';
  var LOG_DAYS = 21;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var STAGE = { proposed: 'Proposed', decided: 'Decided', in_force: 'In force', guidance: 'Guidance' };
  var KIND = { needs: 'Needs you', 'new': 'New', updated: 'Updated', inforce: 'In force', ignored: 'Ignored', problem: 'Problem' };
  var ORDER = ['needs', 'problem', 'updated', 'new', 'inforce', 'ignored', 'quiet'];

  var data = { commit: null, cfg: null, sources: {}, records: [], reviews: [], logs: [] };
  var state = { c: null, tab: 'activity', filter: 'all', q: '', show: 'live', adding: false, draft: null, confirm: null, panel: null, lastFocus: null, pending: {}, error: null, loaded: false, checking: false };
  var toastTimer = null;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  // Only ever link to a web address. Anything else, such as "javascript:", becomes no link at all.
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }
  function today() { return new Date().toISOString().slice(0, 10); }
  // The date where the country is, which is what the server checks dates against.
  function todayIn(country) {
    var zone = data.cfg && data.cfg.countries[country] && data.cfg.countries[country].timezone;
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'UTC' }).format(new Date()); } catch (e) { return today(); }
  }
  function fmt(d) {
    var p = String(d || '').split('-');
    if (p.length === 1) return p[0];
    if (p.length === 2) return MONTHS[+p[1] - 1] + ' ' + p[0];
    return (+p[2]) + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  }
  function dayLabel(d) {
    var diff = Math.round((Date.parse(today()) - Date.parse(d)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    var date = new Date(d + 'T00:00:00Z');
    return DAYS[date.getUTCDay()] + ' ' + date.getUTCDate() + ' ' + MONTHS[date.getUTCMonth()] + (date.getUTCFullYear() !== new Date().getUTCFullYear() ? ' ' + date.getUTCFullYear() : '');
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /* Sign-in: a GitHub token kept in this browser only. */
  function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(value) { try { if (value) localStorage.setItem(TOKEN_KEY, value); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* private window: stays signed out */ } }

  /* GitHub */
  async function gh(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/vnd.github+json' };
    var t = opts.token != null ? opts.token : token();
    if (t) headers.Authorization = 'Bearer ' + t;
    if (opts.body) headers['Content-Type'] = 'application/json';
    var res = await fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    if (res.status === 204) return null;
    var body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      var err = new Error((body && body.message) || 'GitHub answered ' + res.status);
      err.status = res.status;
      throw err;
    }
    return body;
  }
  function friendly(e) {
    if (e.status === 401) return 'GitHub did not accept the token. Connect again.';
    if (e.status === 403 && /rate limit/i.test(e.message)) return 'GitHub is limiting requests from this network. Connect, or try again in an hour.';
    if (e.status === 403 || e.status === 404) return 'This token cannot run actions on the repository. It needs “Actions: Read and write”.';
    if (e.status === 422) return 'GitHub refused the request: ' + e.message;
    return e.message || 'Something went wrong.';
  }

  /* Reading the repository. Files are kept by their content id, so only what changed is fetched again. */
  var files = {};
  try { files = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { files = {}; }
  async function fetchFiles(entries, commit) {
    var out = {};
    var queue = entries.slice();
    async function worker() {
      for (;;) {
        var entry = queue.shift();
        if (!entry) return;
        if (!(entry.sha in files)) {
          var res = await fetch(RAW + '/' + REPO + '/' + commit + '/' + entry.path.split('/').map(encodeURIComponent).join('/'));
          if (!res.ok) throw new Error('Could not read ' + entry.path + ' (' + res.status + ')');
          files[entry.sha] = await res.json();
        }
        out[entry.path] = files[entry.sha];
      }
    }
    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(worker));
    var keep = {};
    entries.forEach(function (entry) { keep[entry.sha] = files[entry.sha]; });
    files = keep;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(files)); } catch (e) { /* too big or unavailable: fetch again next time */ }
    return out;
  }
  // Returns true when the repository has changed since the last read.
  async function loadRepo() {
    var branch = await gh('/repos/' + REPO + '/branches/' + BRANCH.split('/').map(encodeURIComponent).join('/'));
    var commit = branch.commit.sha;
    if (commit === data.commit) return false;
    var tree = await gh('/repos/' + REPO + '/git/trees/' + branch.commit.commit.tree.sha + '?recursive=1');
    var blobs = tree.tree.filter(function (e) { return e.type === 'blob'; });
    var logs = blobs.filter(function (e) { return /^data\/log\/\d{4}-\d{2}-\d{2}\.json$/.test(e.path); })
      .sort(function (a, b) { return a.path < b.path ? 1 : -1; }).slice(0, LOG_DAYS);
    var wanted = blobs.filter(function (e) {
      return e.path === 'agent/config.json' || /^sources\/[a-z]{2}\.json$/.test(e.path) || /^data\/[a-z]{2}\/[^/]+\.json$/.test(e.path) || /^review\/[^/]+\.json$/.test(e.path);
    }).concat(logs);
    var content = await fetchFiles(wanted, commit);
    var next = { commit: commit, cfg: content['agent/config.json'], sources: {}, records: [], reviews: [], logs: [] };
    Object.keys(content).forEach(function (path) {
      var m;
      if ((m = path.match(/^sources\/([a-z]{2})\.json$/))) next.sources[m[1]] = content[path];
      else if (/^data\/[a-z]{2}\//.test(path)) next.records.push(content[path]);
      else if ((m = path.match(/^review\/(.+)\.json$/))) next.reviews.push(Object.assign({ name: m[1] }, content[path]));
      else if ((m = path.match(/^data\/log\/(.+)\.json$/))) next.logs.push({ date: m[1], runs: content[path] });
    });
    next.logs.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    data = next;
    if (!state.c || !data.cfg.countries[state.c]) state.c = Object.keys(data.cfg.countries)[0];
    return true;
  }
  async function refresh(untilChanged) {
    for (var i = 0; i < (untilChanged ? 8 : 1); i++) {
      if (await loadRepo()) break;
      if (untilChanged) await new Promise(function (r) { setTimeout(r, 1500); });
    }
    state.error = null;
    state.loaded = true;
    render();
  }

  /* Working out what to show */
  function record(id) { return data.records.filter(function (r) { return r.id === id; })[0]; }
  function review(name) { return data.reviews.filter(function (r) { return r.name === name; })[0]; }
  function sourceCountry(id) {
    return Object.keys(data.sources).filter(function (c) { return data.sources[c].some(function (s) { return s.id === id; }); })[0] || null;
  }
  function reviewCountry(rv) {
    return (rv.proposed_record && rv.proposed_record.country) || (rv.current_record && rv.current_record.country) || sourceCountry(rv.item && rv.item.source);
  }
  // Which country a line of the run log belongs to. Newer logs say so; older ones are worked out from the id or the source.
  function entryCountry(e) {
    return e.country || (e.id ? e.id.slice(0, 2) : null) || sourceCountry(e.source) || (/^recheck ([a-z]{2})-/.exec(e.source || '') || [])[1] || null;
  }
  function activity() {
    var c = state.c;
    var items = [];
    data.reviews.forEach(function (rv) {
      if (reviewCountry(rv) !== c) return;
      var rec = rv.proposed_record;
      items.push({ kind: 'needs', day: rv.held_on, key: 'review:' + rv.name, review: rv.name, title: (rec && rec.title) || (rv.item && rv.item.title) || 'Untitled item',
        detail: 'Held: ' + (rv.reasons || []).join('; '), url: rv.item && rv.item.url });
    });
    data.logs.forEach(function (log) {
      (log.runs || []).forEach(function (run, n) {
        var before = items.length;
        var mine = function (list) { return (list || []).filter(function (e) { return entryCountry(e) === c; }); };
        mine(run.published).forEach(function (e) {
          items.push({ kind: 'new', day: log.date, key: e.id, record: e.id, title: e.title, detail: e.regulator + ' · ' + STAGE[e.stage], url: e.source });
        });
        mine(run.updated).forEach(function (e) {
          items.push({ kind: 'updated', day: log.date, key: e.id, record: e.id, title: e.title, detail: (e.event || '') + ' Changed: ' + (e.what_changed || []).join('; ') + '.', url: e.source });
        });
        mine(run.now_in_force).forEach(function (e) {
          items.push({ kind: 'inforce', day: log.date, key: e.id, record: e.id, title: e.title, detail: 'Came into force on ' + fmt(e.date) + '.' });
        });
        mine(run.ignored).forEach(function (e, i) {
          items.push({ kind: 'ignored', day: log.date, key: 'ignored:' + e.url, title: e.title || e.url, detail: e.reason, url: e.url });
        });
        mine(run.source_problems).forEach(function (e) {
          items.push({ kind: 'problem', day: log.date, key: 'problem:' + log.date + n + e.source + e.url, title: e.source === 'assistant' ? 'The AI could not process a page' : e.source + ' could not be read', detail: e.problem, url: e.url });
        });
        if (run.stopped_early) items.push({ kind: 'problem', day: log.date, key: 'stopped:' + log.date + n, title: 'The check stopped early', detail: run.stopped_early });
        var covered = !run.countries || run.countries.indexOf(c) !== -1;
        if (items.length === before && covered && run.countries) items.push({ kind: 'quiet', day: log.date, detail: 'Nothing new. ' + (run.already_seen || 0) + ' pages listed had been seen before.' });
      });
    });
    return items.sort(function (a, b) {
      if (a.day !== b.day) return a.day < b.day ? 1 : -1;
      return ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind);
    });
  }
  // The latest day anything ran, with that day's runs added together.
  function lastDay() {
    for (var i = 0; i < data.logs.length; i++) {
      var runs = data.logs[i].runs || [];
      if (!runs.length) continue;
      var all = function (key) { return runs.reduce(function (list, run) { return list.concat(run[key] || []); }, []); };
      return { date: data.logs[i].date, published: all('published'), updated: all('updated'), ignored: all('ignored') };
    }
    return null;
  }
  function sourceHealth(s) {
    if (!s.enabled) return { text: 'Off', cls: ' off' };
    for (var i = 0; i < data.logs.length; i++) {
      var runs = (data.logs[i].runs || []).slice().reverse();
      for (var j = 0; j < runs.length; j++) {
        var problem = (runs[j].source_problems || []).filter(function (p) { return p.source === s.id; })[0];
        if (problem) return { text: 'Failed ' + fmt(data.logs[i].date) + ': ' + problem.problem, cls: ' bad' };
        var stat = (runs[j].sources || []).filter(function (x) { return x.id === s.id; })[0];
        if (stat) return { text: 'Read ' + fmt(data.logs[i].date) + ' · ' + stat.listed + ' listed', cls: '' };
      }
    }
    return { text: 'Not read yet', cls: ' off' };
  }
  function address(s) {
    if (s.how === 'govuk') return 'GOV.UK search: ' + s.organisation + (s.query ? ', “' + s.query + '”' : '');
    return s.url || '';
  }

  /* Header */
  function renderHead() {
    var countries = data.cfg ? data.cfg.countries : {};
    $('country-name').textContent = countries[state.c] ? countries[state.c].name : '';
    $('country-menu').innerHTML = Object.keys(countries).map(function (c) {
      return '<button type="button" role="menuitemradio" aria-checked="' + (c === state.c) + '" data-country="' + esc(c) + '">' + esc(countries[c].name) +
        '<svg class="tick" style="visibility:' + (c === state.c ? 'visible' : 'hidden') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg></button>';
    }).join('');
    $('connect-btn').textContent = token() ? 'Connected' : 'Connect';
    $('connect-btn').classList.toggle('btn-dark', !token());
    if (!state.loaded) {
      $('headline').textContent = state.error ? 'Could not load the tracker' : 'Loading…';
      $('subline').textContent = state.error || '';
      $('tabs').innerHTML = '';
      return;
    }
    var needs = data.reviews.filter(function (rv) { return reviewCountry(rv) === state.c; }).length;
    $('headline').textContent = needs ? needs + (needs === 1 ? ' change needs' : ' changes need') + ' your decision' : 'Nothing needs you';
    var last = lastDay();
    if (!last) $('subline').textContent = 'No check has run yet.';
    else {
      var mine = function (list) { return list.filter(function (e) { return entryCountry(e) === state.c; }).length; };
      var stale = Math.round((Date.parse(today()) - Date.parse(last.date)) / 864e5) > 2;
      $('subline').textContent = 'Last check ' + dayLabel(last.date).toLowerCase() + ': ' + mine(last.published) + ' new, ' + mine(last.updated) + ' updated, ' + mine(last.ignored) + ' ignored.' +
        (stale ? ' No automatic check has run since.' : '');
    }
    $('run-now').disabled = state.checking;
    $('run-now').textContent = state.checking ? 'Check running…' : 'Run a check now';
    var tabs = [['activity', 'Activity'], ['changes', 'Changes'], ['sources', 'Sources']];
    $('tabs').innerHTML = tabs.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' + t[1] + (t[0] === 'activity' && needs ? '<span class="count">' + needs + '</span>' : '') + '</button>';
    }).join('');
  }

  /* A row's buttons: normal, waiting for a reason, or busy. */
  function actions(key, buttons) {
    if (state.pending[key]) return '<span class="working"><i></i>' + esc(state.pending[key]) + '</span>';
    if (state.confirm && state.confirm.key === key) {
      return '<form class="why" data-why="1"><input class="input" id="why" placeholder="Why? Optional. The assistant follows it." aria-label="Reason" maxlength="200">' +
        '<button type="submit" class="btn btn-dark">' + esc(state.confirm.verb) + '</button><button type="button" class="btn" data-cancel-why="1">Cancel</button></form>';
    }
    return buttons;
  }
  function ask(el) {
    return ' data-ask="' + esc(el.command) + '" data-target="' + esc(el.target) + '" data-key="' + esc(el.key) + '" data-verb="' + esc(el.verb) + '" data-busy="' + esc(el.busy) + '" data-done="' + esc(el.done) + '"';
  }

  /* Activity */
  function activityRow(a) {
    if (a.kind === 'quiet') return '<div class="quiet">' + esc(a.detail) + '</div>';
    var buttons = '';
    if (a.kind === 'needs') {
      buttons = '<button type="button" class="btn btn-dark" data-review="' + esc(a.review) + '">Review</button>' +
        '<button type="button" class="btn"' + ask({ command: 'dismiss', target: a.review, key: a.key, verb: 'Dismiss', busy: 'Dismissing…', done: 'Dismissed. The assistant will not raise it again.' }) + '>Dismiss</button>';
    } else if ((a.kind === 'updated' || a.kind === 'new' || a.kind === 'inforce') && record(a.record)) {
      var rec = record(a.record);
      buttons = '<button type="button" class="btn" data-edit="' + esc(a.record) + '">View</button>';
      if (a.kind === 'updated') buttons += '<button type="button" class="btn"' + ask({ command: 'revert', target: a.record, key: a.key, verb: 'Undo update', busy: 'Undoing…', done: 'Update undone. The assistant will not apply it again.' }) + '>Undo update</button>';
      else if (a.kind === 'new' && rec.status === 'live') buttons += '<button type="button" class="btn"' + ask({ command: 'archive', target: a.record, key: a.key, verb: 'Remove', busy: 'Removing…', done: 'Removed from the page. The assistant will not add it again.' }) + '>Remove</button>';
    } else if (a.kind === 'ignored' && a.url) {
      buttons = '<button type="button" class="btn" data-include="' + esc(a.url) + '" data-key="' + esc(a.key) + '">Add anyway</button>';
    } else if (a.kind === 'problem') {
      buttons = '<button type="button" class="btn" data-tab="sources">Open sources</button>';
    }
    var src = safeUrl(a.url) ? ' <a href="' + esc(safeUrl(a.url)) + '" target="_blank" rel="noopener noreferrer">Source</a>' : '';
    var gone = (a.kind === 'new' || a.kind === 'updated') && record(a.record) && record(a.record).status === 'archived';
    return '<div class="row' + (gone ? ' done' : '') + '"><span class="pill ' + (a.kind === 'inforce' ? 'in_force' : a.kind) + '"><span class="dot"></span>' + KIND[a.kind] + '</span>' +
      '<div class="main"><h3>' + esc(a.title) + '</h3><p>' + esc(a.detail) + src + '</p>' + (gone ? '<span class="result">Removed from the page.</span>' : '') + '</div>' +
      '<div class="acts">' + actions(a.key, buttons) + '</div></div>';
  }
  function renderActivity() {
    var all = activity();
    var match = { all: function () { return true; }, needs: function (a) { return a.kind === 'needs'; }, published: function (a) { return a.kind === 'new' || a.kind === 'updated' || a.kind === 'inforce'; }, ignored: function (a) { return a.kind === 'ignored'; }, problem: function (a) { return a.kind === 'problem'; } };
    var chips = [['all', 'All'], ['needs', 'Needs you'], ['published', 'Published'], ['ignored', 'Ignored'], ['problem', 'Problems']];
    var list = all.filter(function (a) { return state.filter === 'all' || (a.kind !== 'quiet' && match[state.filter](a)); });
    var html = '<div class="bar"><div class="chips" role="group" aria-label="Show">' + chips.map(function (c) {
      var n = c[0] === 'all' ? '' : ' ' + all.filter(function (a) { return a.kind !== 'quiet' && match[c[0]](a); }).length;
      return '<button type="button" class="chip" data-filter="' + c[0] + '" aria-pressed="' + (state.filter === c[0]) + '">' + c[1] + n + '</button>';
    }).join('') + '</div></div>';
    if (!list.length) html += '<div class="panel"><div class="empty">' + (all.length ? 'Nothing here.' : 'No checks have run for ' + esc(data.cfg.countries[state.c].name) + ' yet.') + '</div></div>';
    else {
      var days = [];
      list.forEach(function (a) { if (days.indexOf(a.day) === -1) days.push(a.day); });
      html += '<div class="panel">' + days.map(function (d) {
        return '<div class="day">' + esc(dayLabel(d)) + '</div>' + list.filter(function (a) { return a.day === d; }).map(activityRow).join('');
      }).join('') + '</div>';
    }
    $('view').innerHTML = html;
  }

  /* Changes */
  function lastChanged(r) { var h = r.history || []; return h.length ? h[h.length - 1].date : r.last_checked; }
  function matching() {
    var words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.records.filter(function (r) {
      if (r.country !== state.c || r.status !== state.show) return false;
      var h = (r.title + ' ' + r.regulator + ' ' + r.topic + ' ' + r.summary + ' ' + r.id).toLowerCase();
      return words.every(function (w) { return h.indexOf(w) !== -1; });
    }).sort(function (a, b) { return lastChanged(a) < lastChanged(b) ? 1 : -1; });
  }
  function changeRows(list) {
    if (!list.length) return '<div class="empty">' + (state.show === 'archived' ? 'Nothing is archived.' : 'No changes match.') + '</div>';
    return list.map(function (r) {
      var archived = r.status === 'archived';
      var toggle = archived
        ? '<button type="button" class="btn"' + ask({ command: 'restore', target: r.id, key: r.id, verb: 'Restore', busy: 'Restoring…', done: 'Restored. It is back on the page.' }) + '>Restore</button>'
        : '<button type="button" class="btn"' + ask({ command: 'archive', target: r.id, key: r.id, verb: 'Archive', busy: 'Archiving…', done: 'Archived. It is off the page.' }) + '>Archive</button>';
      return '<div class="row"><span class="pill ' + (archived ? 'archived' : esc(r.stage)) + '"><span class="dot"></span>' + (archived ? 'Archived' : STAGE[r.stage]) + '</span>' +
        '<div class="main"><h3>' + esc(r.title) + '</h3><p>' + esc(r.regulator) + ' · ' + esc(r.topic) + ' · last changed ' + esc(fmt(lastChanged(r))) + '</p></div>' +
        '<div class="acts">' + actions(r.id, '<button type="button" class="btn" data-edit="' + esc(r.id) + '">Edit</button>' + toggle) + '</div></div>';
    }).join('');
  }
  function renderChanges() {
    var mine = data.records.filter(function (r) { return r.country === state.c; });
    var n = function (s) { return mine.filter(function (r) { return r.status === s; }).length; };
    $('view').innerHTML = '<div class="bar"><div class="chips" role="group" aria-label="Show">' +
      '<button type="button" class="chip" data-show="live" aria-pressed="' + (state.show === 'live') + '">On the page ' + n('live') + '</button>' +
      '<button type="button" class="chip" data-show="archived" aria-pressed="' + (state.show === 'archived') + '">Archived ' + n('archived') + '</button></div>' +
      '<label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
      '<input type="search" id="search" placeholder="Search changes" autocomplete="off" aria-label="Search changes" value="' + esc(state.q) + '"></label></div>' +
      '<div class="panel" id="change-list">' + changeRows(matching()) + '</div>';
  }

  /* Sources */
  function renderSources() {
    var list = data.sources[state.c] || [];
    var html = '<div class="bar"><span class="hint">' + list.filter(function (s) { return s.enabled; }).length + ' of ' + list.length + ' sources are on. Official sites only.</span>' +
      (state.pending['add-source'] ? '<span class="working"><i></i>' + esc(state.pending['add-source']) + '</span>' : '<button type="button" class="btn" id="add-source">Add a source</button>') + '</div><div class="panel">';
    if (state.adding) {
      html += '<form class="add-form" id="add-form"><input class="input" id="new-name" placeholder="Regulator name" aria-label="Regulator name" maxlength="40" required>' +
        '<input class="input" id="new-url" type="url" placeholder="https://… the page that lists its news or consultations" aria-label="Address" required>' +
        '<button type="submit" class="btn btn-dark">Add</button><button type="button" class="btn" id="cancel-add">Cancel</button></form>';
    }
    if (!list.length && !state.adding) html += '<div class="empty">No sources yet.</div>';
    html += list.map(function (s) {
      var key = 'source:' + s.id;
      var health = sourceHealth(s);
      return '<div class="row src-row"><div class="main"><h3>' + esc(s.regulator) + '</h3><p>' + esc(s.covers) + '</p><span class="addr">' + esc(address(s)) + '</span>' +
        (s.note ? '<p class="src-note">' + esc(s.note) + '</p>' : '') + '</div>' +
        '<span class="health' + health.cls + '"><i></i>' + esc(health.text) + '</span>' +
        (state.pending[key] ? '<span class="working"><i></i>' + esc(state.pending[key]) + '</span>'
          : '<button type="button" class="switch" role="switch" aria-checked="' + !!s.enabled + '" aria-label="Watch ' + esc(s.regulator) + ': ' + esc(s.covers) + '" data-switch="' + esc(s.id) + '"></button>') + '</div>';
    }).join('') + '</div>';
    html += '<form class="older" id="older-form"><label for="older-date">Load older changes, back to</label>' +
      '<input class="input" id="older-date" type="date" max="' + today() + '" required>' +
      '<button type="submit" class="btn"' + (state.checking ? ' disabled' : '') + '>Start</button>' +
      '<span class="hint">Reads older pages from every source that is on, for both countries. It can take several hours and continues by itself.</span></form>';
    $('view').innerHTML = html;
  }

  function render() {
    renderHead();
    if (!state.loaded) { $('view').innerHTML = state.error ? '<div class="panel"><div class="empty"><button type="button" class="btn" id="retry">Try again</button></div></div>' : ''; return; }
    if (state.tab === 'activity') renderActivity();
    else if (state.tab === 'changes') renderChanges();
    else renderSources();
    var why = $('why');
    if (why) why.focus();
  }

  function toast(message, link) {
    clearTimeout(toastTimer);
    $('toast').innerHTML = '<span>' + esc(message) + '</span>' + (safeUrl(link) ? '<a href="' + esc(safeUrl(link)) + '" target="_blank" rel="noopener noreferrer">Details</a>' : '');
    $('toast').hidden = false;
    toastTimer = setTimeout(function () { $('toast').hidden = true; }, link ? 15000 : 6000);
  }

  /* Doing things. Every action is one run of a workflow; the page waits for it and then reads the repository again. */
  async function waitForRun(workflow, request, minutes) {
    var deadline = Date.now() + minutes * 60000;
    var pause = minutes > 10 ? 15000 : 3000;
    while (Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, pause); });
      var list = await gh('/repos/' + REPO + '/actions/workflows/' + workflow + '/runs?event=workflow_dispatch&per_page=20');
      var run = (list.workflow_runs || []).filter(function (r) { return (r.display_title || r.name || '').indexOf('[' + request + ']') !== -1; })[0];
      if (run && run.status === 'completed') return run;
    }
    throw new Error('It is taking longer than expected. Check back in a few minutes.');
  }
  async function jobOf(run) {
    var jobs = await gh('/repos/' + REPO + '/actions/runs/' + run.id + '/jobs');
    return (jobs.jobs || [])[0] || null;
  }
  async function failureOf(run) {
    try {
      var job = await jobOf(run);
      var notes = job ? await gh('/repos/' + REPO + '/check-runs/' + job.id + '/annotations') : [];
      var own = notes.filter(function (n) { return n.annotation_level === 'failure' && !/^Process completed with exit code/.test(n.message); })[0];
      if (own) return own.message;
    } catch (e) { /* fall through to the plain message */ }
    return 'The action did not go through.';
  }
  async function act(a) {
    if (!token()) { openPanel('connect'); return; }
    var request = Math.random().toString(16).slice(2, 10);
    state.pending[a.key] = a.busy;
    state.confirm = null;
    render();
    try {
      await gh('/repos/' + REPO + '/actions/workflows/admin.yml/dispatches', { method: 'POST', body: { ref: BRANCH, inputs: {
        command: a.command, target: a.target, reason: a.reason || '', payload: a.payload ? JSON.stringify(a.payload) : '', request: request } } });
      var run = await waitForRun('admin.yml', request, 6);
      if (run.conclusion !== 'success') { var failed = new Error(await failureOf(run)); failed.link = run.html_url; throw failed; }
      delete state.pending[a.key];
      await refresh(true);
      toast(a.done);
    } catch (e) {
      delete state.pending[a.key];
      render();
      toast(e.status ? friendly(e) : e.message, e.link);
    }
  }
  // Runs the daily check now. "include" asks for one ignored page to be added; "since" reads further back than usual.
  async function check(include, since) {
    if (!token()) { openPanel('connect'); return; }
    var request = Math.random().toString(16).slice(2, 10);
    state.checking = true;
    render();
    try {
      await gh('/repos/' + REPO + '/actions/workflows/daily.yml/dispatches', { method: 'POST', body: { ref: BRANCH, inputs: { include: include || '', since: since || '', request: request } } });
      toast(include ? 'Asked the assistant to add it. This takes a few minutes.' : since ? 'Started. Older changes appear here as they are found.' : 'Check started. Results appear here when it finishes.');
      var run = await waitForRun('daily.yml', request, 345);
      var job = await jobOf(run).catch(function () { return null; });
      var skipped = job && (job.steps || []).some(function (s) { return s.name === 'Run the assistant' && s.conclusion === 'skipped'; });
      state.checking = false;
      await refresh(true);
      if (skipped) toast('The check did not run: no AI credential is set for the repository yet.', run.html_url);
      else if (run.conclusion !== 'success') toast('The check finished with a problem.', run.html_url);
      else toast('Check finished.');
    } catch (e) {
      state.checking = false;
      render();
      toast(e.status ? friendly(e) : e.message);
    }
  }

  /* The side panel: edit a change, review a held one, or connect. */
  function openPanel(kind, id) {
    state.lastFocus = document.activeElement;
    state.panel = kind;
    if (kind === 'edit') state.draft = { mode: 'edit', rec: clone(record(id)) };
    else if (kind === 'review') {
      var rv = review(id);
      state.draft = { mode: 'review', name: rv.name, reasons: rv.reasons || [], current: rv.current_record, item: rv.item, rec: rv.proposed_record ? clone(rv.proposed_record) : null };
    }
    if (state.draft && state.draft.rec) state.draft.rec.dates = state.draft.rec.dates || {};
    renderPanel();
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    document.body.classList.add('locked');
    var first = $('drawer').querySelector('input, textarea, button.btn-dark');
    if (first) first.focus();
  }
  function closePanel() {
    $('drawer').hidden = true;
    $('scrim').hidden = true;
    document.body.classList.remove('locked');
    state.draft = null;
    state.panel = null;
    if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus();
  }
  var X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  function bar(title) { return '<div class="drawer-bar"><span id="d-title">' + esc(title) + '</span><button type="button" class="icon-btn" id="close" aria-label="Close">' + X + '</button></div>'; }
  function renderPanel() {
    if (state.panel === 'connect') return renderConnect();
    var d = state.draft;
    var r = d.rec;
    var top = '';
    if (d.mode === 'review') {
      top = '<div class="note"><strong>Held because:</strong> ' + esc(d.reasons.join('; ')) + '</div>' +
        (d.current ? '<p class="hint">This would update “' + esc(d.current.title) + '”.</p>' : '');
      if (!r) {
        $('drawer').innerHTML = bar('Held for review') + '<div class="drawer-body">' + top + '<p class="hint">The assistant could not draft a record for this page, so it can only be dismissed.</p></div>' +
          '<div class="drawer-foot">' + sourceLink(d.item && d.item.url) + '<div class="right"><button type="button" class="btn" id="cancel">Close</button><button type="button" class="btn btn-dark" id="dismiss">Dismiss</button></div></div>';
        return;
      }
    }
    var lim = data.cfg.limits;
    var keys = data.cfg.applies_to[r.country] || {};
    var count = function (value, max) { return '<span class="n' + (value.length > max ? ' over' : '') + '">' + value.length + ' / ' + max + '</span>'; };
    var dateField = function (k, label, hint) {
      return '<div class="field"><label for="f-' + k + '">' + label + '</label><input class="input" id="f-' + k + '" data-date="' + k + '" value="' + esc(r.dates[k] || '') + '" placeholder="' + hint + '"></div>';
    };
    $('drawer').innerHTML = bar((d.mode === 'review' ? 'Held for review · ' : 'Edit change · ') + r.regulator) +
      '<div class="drawer-body">' + top +
        '<div class="field"><label for="f-title">Title <span id="c-title">' + count(r.title, lim.title) + '</span></label><input class="input" id="f-title" value="' + esc(r.title) + '"></div>' +
        '<div class="field"><label for="f-summary">Summary <span id="c-summary">' + count(r.summary, lim.summary) + '</span></label><textarea id="f-summary">' + esc(r.summary) + '</textarea></div>' +
        '<div class="field"><span class="lab">What changes <span class="n">' + r.what_changes.length + ' / ' + lim.what_changes_max_items + ' points, ' + lim.what_changes_item + ' characters each</span></span>' +
          r.what_changes.map(function (p, i) {
            return '<div class="point"><input class="input" data-point="' + i + '" aria-label="Point ' + (i + 1) + '" value="' + esc(p) + '">' +
              '<button type="button" class="icon-btn" data-drop="' + i + '" aria-label="Remove point ' + (i + 1) + '">' + X + '</button></div>';
          }).join('') +
          (r.what_changes.length < lim.what_changes_max_items ? '<div><button type="button" class="link" id="add-point">Add a point</button></div>' : '') + '</div>' +
        '<div class="field"><label for="f-who">Who it applies to <span id="c-who">' + count(r.who_it_applies_to, lim.who_it_applies_to) + '</span></label><textarea id="f-who" style="min-height:64px">' + esc(r.who_it_applies_to) + '</textarea></div>' +
        '<div class="field"><span class="lab">Applies to</span><div class="chips">' + Object.keys(keys).map(function (k) {
          return '<button type="button" class="chip" data-key="' + esc(k) + '" aria-pressed="' + (r.applies_to.indexOf(k) !== -1) + '">' + esc(keys[k].label) + '</button>';
        }).join('') + '</div></div>' +
        '<div class="two"><div class="field"><label for="f-stage">Stage</label><select id="f-stage">' + Object.keys(STAGE).map(function (s) { return '<option value="' + s + '"' + (s === r.stage ? ' selected' : '') + '>' + STAGE[s] + '</option>'; }).join('') + '</select></div>' +
          '<div class="field"><label for="f-topic">Topic</label><select id="f-topic">' + data.cfg.topics.map(function (t) { return '<option' + (t === r.topic ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div></div>' +
        (r.stage === 'guidance' ? dateField('published', 'Issued', 'YYYY-MM-DD')
          : '<div class="three">' + dateField('proposed', 'Proposed', 'YYYY-MM-DD') + dateField('decided', 'Decided', 'YYYY-MM-DD') + dateField('in_force', 'In force', 'YYYY-MM-DD') + '</div>' +
            (r.stage === 'in_force' ? '' : dateField('in_force_text', 'Start date in words, if not exact', 'early 2027'))) +
        ((r.history || []).length ? '<div><h4 class="sub-h">History</h4><ul class="hist" style="margin-top:8px">' + r.history.map(function (h) { return '<li><time>' + esc(fmt(h.date)) + '</time>' + esc(h.event) + '</li>'; }).join('') + '</ul></div>' : '') +
        ((r.admin_notes || []).length ? '<div><h4 class="sub-h">Admin notes the assistant follows</h4>' + r.admin_notes.map(function (n) { return '<p class="note" style="margin-top:8px">' + esc(n) + '</p>'; }).join('') + '</div>' : '') +
        '<div class="problems" id="problems" hidden></div>' +
      '</div>' +
      '<div class="drawer-foot">' + sourceLink(d.mode === 'review' ? d.item && d.item.url : r.source && r.source.url) +
        '<div class="right">' + (d.mode === 'review'
          ? '<button type="button" class="btn" id="dismiss">Dismiss</button><button type="button" class="btn btn-dark" id="save">Publish</button>'
          : '<button type="button" class="btn" id="cancel">Cancel</button><button type="button" class="btn btn-dark" id="save">Save</button>') + '</div></div>';
    checkDraft();
  }
  function sourceLink(url) { return safeUrl(url) ? '<a class="link" href="' + esc(safeUrl(url)) + '" target="_blank" rel="noopener noreferrer">Open the source</a>' : '<span></span>'; }
  // The fields an admin may change, cleaned up the way the server stores them.
  function edited(r) {
    var dates = {};
    var wanted = r.stage === 'guidance' ? ['published'] : r.stage === 'in_force' ? ['proposed', 'decided', 'in_force'] : ['proposed', 'decided', 'in_force', 'in_force_text'];
    wanted.forEach(function (k) { if ((r.dates[k] || '').trim()) dates[k] = r.dates[k].trim(); });
    return { title: r.title.trim(), summary: r.summary.trim(), what_changes: r.what_changes.map(function (p) { return p.trim(); }), applies_to: r.applies_to,
      who_it_applies_to: r.who_it_applies_to.trim(), topic: r.topic, stage: r.stage, dates: dates };
  }
  function problemsOf(r) {
    var rec = Object.assign({}, r, edited(r));
    if (typeof validateRecord === 'function') return validateRecord(rec, data.cfg, todayIn(rec.country));
    return rec.title && rec.summary && rec.who_it_applies_to && rec.applies_to.length && rec.what_changes.length ? [] : ['Something is empty.'];
  }
  function checkDraft() {
    if (!state.draft || !state.draft.rec || !$('save')) return;
    var problems = problemsOf(state.draft.rec);
    $('save').disabled = problems.length > 0;
    $('problems').hidden = !problems.length;
    $('problems').innerHTML = problems.length ? '<strong>Fix before saving</strong><ul>' + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '';
  }
  function renderConnect() {
    var connected = !!token();
    $('drawer').innerHTML = bar('Connect to GitHub') + '<div class="drawer-body">' +
      (connected
        ? '<p>This browser is connected. Every action you take here is saved to the repository under your GitHub account.</p>'
        : '<p>Every action here is saved to the repository, so GitHub needs to know it is you. You do this once per browser.</p>' +
          '<ol class="steps"><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub’s new token page</a>.</li>' +
          '<li>Under <strong>Repository access</strong>, choose <strong>Only select repositories</strong> and pick <strong>' + esc(REPO.split('/')[1]) + '</strong>.</li>' +
          '<li>Under <strong>Permissions</strong>, set <strong>Actions</strong> to <strong>Read and write</strong>.</li>' +
          '<li>Generate the token, copy it and paste it below.</li></ol>' +
          '<form id="connect-form" class="field"><label for="f-token">Token</label><input class="input" id="f-token" type="password" autocomplete="off" placeholder="github_pat_…" required>' +
          '<p class="hint" id="connect-error" hidden></p></form>' +
          '<p class="hint">The token is kept in this browser only. It is never saved in the repository.</p>') +
      '</div><div class="drawer-foot"><span></span><div class="right"><button type="button" class="btn" id="cancel">Close</button>' +
      (connected ? '<button type="button" class="btn" id="disconnect">Disconnect</button>' : '<button type="submit" form="connect-form" class="btn btn-dark" id="connect-save">Connect</button>') + '</div></div>';
  }

  /* Events */
  $('drawer').addEventListener('input', function (e) {
    if (!state.draft || !state.draft.rec) return;
    var r = state.draft.rec;
    var t = e.target;
    var lim = data.cfg.limits;
    var count = function (value, max) { return '<span class="n' + (value.length > max ? ' over' : '') + '">' + value.length + ' / ' + max + '</span>'; };
    if (t.id === 'f-title') { r.title = t.value; $('c-title').innerHTML = count(r.title, lim.title); }
    else if (t.id === 'f-summary') { r.summary = t.value; $('c-summary').innerHTML = count(r.summary, lim.summary); }
    else if (t.id === 'f-who') { r.who_it_applies_to = t.value; $('c-who').innerHTML = count(r.who_it_applies_to, lim.who_it_applies_to); }
    else if (t.hasAttribute('data-point')) r.what_changes[+t.getAttribute('data-point')] = t.value;
    else if (t.hasAttribute('data-date')) r.dates[t.getAttribute('data-date')] = t.value;
    checkDraft();
  });
  $('drawer').addEventListener('change', function (e) {
    if (!state.draft || !state.draft.rec) return;
    if (e.target.id === 'f-stage') { state.draft.rec.stage = e.target.value; renderPanel(); }
    else if (e.target.id === 'f-topic') { state.draft.rec.topic = e.target.value; checkDraft(); }
  });
  $('drawer').addEventListener('submit', async function (e) {
    if (e.target.id !== 'connect-form') return;
    e.preventDefault();
    var value = $('f-token').value.trim();
    $('connect-save').disabled = true;
    try {
      await gh('/repos/' + REPO + '/actions/workflows/admin.yml', { token: value });
      setToken(value);
      closePanel();
      render();
      toast('Connected.');
    } catch (err) {
      $('connect-save').disabled = false;
      $('connect-error').hidden = false;
      $('connect-error').textContent = err.status === 401 ? 'GitHub did not accept that token.' : 'That token cannot see the repository’s actions. Check steps 2 and 3.';
    }
  });
  $('scrim').addEventListener('click', closePanel);
  $('country-btn').addEventListener('click', function (e) { e.stopPropagation(); $('country-menu').hidden = !$('country-menu').hidden; });
  $('connect-btn').addEventListener('click', function () { openPanel('connect'); });
  $('run-now').addEventListener('click', function () { check(); });

  $('view').addEventListener('input', function (e) {
    if (e.target.id !== 'search') return;
    state.q = e.target.value;
    $('change-list').innerHTML = changeRows(matching());
  });
  $('view').addEventListener('submit', function (e) {
    e.preventDefault();
    if (e.target.id === 'add-form') {
      var name = $('new-name').value.trim();
      var url = $('new-url').value.trim();
      state.adding = false;
      act({ command: 'source-add', target: state.c, payload: { regulator: name, url: url }, key: 'add-source', busy: 'Checking the address…', done: name + ' added. It will be read on the next check.' });
    } else if (e.target.id === 'older-form') {
      check(null, $('older-date').value);
    } else if (e.target.hasAttribute('data-why') && state.confirm) {
      var c = state.confirm;
      act({ command: c.command, target: c.target, reason: $('why').value.trim(), key: c.key, busy: c.busy, done: c.done });
    }
  });

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest('.country')) $('country-menu').hidden = true;
    var el;
    if (t.closest('#retry')) { start(); return; }
    if ((el = t.closest('[data-country]'))) { state.c = el.getAttribute('data-country'); state.filter = 'all'; state.q = ''; state.adding = false; state.confirm = null; $('country-menu').hidden = true; render(); return; }
    if ((el = t.closest('[data-tab]'))) { state.tab = el.getAttribute('data-tab'); state.confirm = null; render(); return; }
    if ((el = t.closest('[data-filter]'))) { state.filter = el.getAttribute('data-filter'); render(); return; }
    if ((el = t.closest('[data-show]'))) { state.show = el.getAttribute('data-show'); render(); return; }
    if ((el = t.closest('[data-edit]'))) { openPanel('edit', el.getAttribute('data-edit')); return; }
    if ((el = t.closest('[data-review]'))) { openPanel('review', el.getAttribute('data-review')); return; }
    if ((el = t.closest('[data-include]'))) { check(el.getAttribute('data-include')); return; }
    if ((el = t.closest('[data-ask]'))) {
      if (!token()) { openPanel('connect'); return; }
      state.confirm = { command: el.getAttribute('data-ask'), target: el.getAttribute('data-target'), key: el.getAttribute('data-key'), verb: el.getAttribute('data-verb'), busy: el.getAttribute('data-busy'), done: el.getAttribute('data-done') };
      render();
      return;
    }
    if (t.closest('[data-cancel-why]')) { state.confirm = null; render(); return; }
    if ((el = t.closest('[data-switch]'))) {
      var s = (data.sources[state.c] || []).filter(function (x) { return x.id === el.getAttribute('data-switch'); })[0];
      act({ command: s.enabled ? 'source-off' : 'source-on', target: state.c + '/' + s.id, key: 'source:' + s.id, busy: s.enabled ? 'Turning off…' : 'Turning on…',
        done: s.regulator + (s.enabled ? ' is off.' : ' is on. It will be read on the next check.') });
      return;
    }
    if (t.closest('#add-source')) { if (!token()) { openPanel('connect'); return; } state.adding = true; render(); $('new-name').focus(); return; }
    if (t.closest('#cancel-add')) { state.adding = false; render(); return; }

    if (!state.panel) return;
    if (t.closest('#close') || t.closest('#cancel')) { closePanel(); return; }
    if (t.closest('#disconnect')) { setToken(''); closePanel(); render(); toast('Disconnected.'); return; }
    var d = state.draft;
    if (!d) return;
    if (t.closest('#dismiss')) {
      var name = d.name;
      closePanel();
      state.confirm = { command: 'dismiss', target: name, key: 'review:' + name, verb: 'Dismiss', busy: 'Dismissing…', done: 'Dismissed. The assistant will not raise it again.' };
      state.tab = 'activity';
      render();
      return;
    }
    if (!d.rec) return;
    if ((el = t.closest('[data-key]')) && el.closest('#drawer')) {
      var k = el.getAttribute('data-key');
      var list = d.rec.applies_to;
      var i = list.indexOf(k);
      if (k === 'all') d.rec.applies_to = i === -1 ? ['all'] : [];
      else { if (i === -1) list.push(k); else list.splice(i, 1); d.rec.applies_to = list.filter(function (x) { return x !== 'all'; }); }
      renderPanel();
      return;
    }
    if ((el = t.closest('[data-drop]'))) { d.rec.what_changes.splice(+el.getAttribute('data-drop'), 1); renderPanel(); return; }
    if (t.closest('#add-point')) { d.rec.what_changes.push(''); renderPanel(); var inputs = document.querySelectorAll('[data-point]'); inputs[inputs.length - 1].focus(); return; }
    if (t.closest('#save') && !$('save').disabled) {
      var payload = edited(d.rec);
      var job = d.mode === 'review'
        ? { command: 'publish', target: d.name, payload: payload, key: 'review:' + d.name, busy: 'Publishing…', done: 'Published.' }
        : { command: 'edit', target: d.rec.id, payload: payload, key: d.rec.id, busy: 'Saving…', done: 'Saved.' };
      closePanel();
      act(job);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    $('country-menu').hidden = true;
    if (state.panel) closePanel();
    else if (state.confirm) { state.confirm = null; render(); }
  });

  async function start() {
    state.error = null;
    render();
    try { await refresh(false); }
    catch (e) { state.loaded = false; state.error = e.status ? friendly(e) : e.message; render(); }
  }
  start();
})();

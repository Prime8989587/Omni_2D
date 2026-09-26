// The "What's new" screen: the app's version and every release it has had,
// newest first (changelog.js holds the data and the version rule).
//
// It opens OVER whatever screen asked for it -- Home, Settings, the rig
// workspace -- and closing it simply uncovers that screen again, so it
// needs no knowledge of where it was opened from.

import { RELEASES, APP_VERSION } from './changelog.js';
import { playEnter, transitionScreens } from './transitions.js';
import { createIcon } from './pixelIcons.js';

const els = {};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const KIND_LABEL = { minor: 'New', patch: 'Fix', first: 'First release' };

function render() {
  els.body.replaceChildren();

  const intro = document.createElement('div');
  intro.className = 'changelog-intro';
  const now = document.createElement('p');
  now.className = 'changelog-intro__version';
  now.textContent = `Omni 2D ${APP_VERSION}`;
  const scheme = document.createElement('p');
  scheme.className = 'settings-field__hint';
  scheme.textContent = 'Versions count like an odometer: a fix adds 0.0.1 and a new feature 0.1.0, '
    + 'and each digit rolls over at 9 — 1.0.9 → 1.1.0, 1.9.0 → 2.0.0.';
  intro.append(now, scheme);
  els.body.appendChild(intro);

  RELEASES.forEach((release, index) => {
    const item = document.createElement('article');
    item.className = `changelog-entry${index === 0 ? ' changelog-entry--latest' : ''}`;
    item.dataset.version = release.version;
    const head = document.createElement('header');
    head.className = 'changelog-entry__head';
    const version = document.createElement('span');
    version.className = 'changelog-entry__version';
    version.textContent = release.version;
    const kind = document.createElement('span');
    kind.className = `changelog-entry__kind changelog-entry__kind--${release.kind}`;
    kind.textContent = KIND_LABEL[release.kind];
    const date = document.createElement('span');
    date.className = 'changelog-entry__date';
    date.textContent = formatDate(release.date);
    head.append(version, kind, date);
    const title = document.createElement('h3');
    title.className = 'changelog-entry__title';
    title.textContent = release.title;
    const list = document.createElement('ul');
    list.className = 'changelog-entry__notes';
    for (const note of release.notes) {
      const li = document.createElement('li');
      li.append(createIcon('diamond'), document.createTextNode(note));
      list.appendChild(li);
    }
    item.append(head, title, list);
    els.body.appendChild(item);
  });
}

export function openChangelog() {
  if (!els.screen) return;
  render();
  els.screen.hidden = false;
  els.body.scrollTop = 0;
  playEnter(els.screen);
}

export function closeChangelog() {
  if (!els.screen || els.screen.hidden) return;
  transitionScreens({ from: els.screen, to: null, hide: (el) => { el.hidden = true; } });
}

export function isChangelogOpen() {
  return Boolean(els.screen) && !els.screen.hidden;
}

export function initChangelogUI() {
  els.screen = document.getElementById('changelogScreen');
  els.body = document.getElementById('changelogBody');
  els.version = document.getElementById('changelogVersion');
  if (!els.screen) return;
  els.version.textContent = `v${APP_VERSION}`;
  document.getElementById('changelogBackBtn').addEventListener('click', closeChangelog);
  // Every "What's new" link in the app, wherever it is.
  document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('[data-open-changelog]');
    if (link) openChangelog();
  });
  for (const el of document.querySelectorAll('[data-app-version]')) el.textContent = `v${APP_VERSION}`;
}
